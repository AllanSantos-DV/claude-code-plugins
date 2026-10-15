'use strict';
/**
 * retrieve-core.js — shared adaptive retrieval (vector + relevance gate + title dedup).
 *
 * Used by the brain-server `brain_retrieve_context` MCP tool so the embedder runs
 * WARM in the persistent server (~11ms) instead of cold-loading in an ephemeral
 * hook (~600ms). Pure-ish: does the cheap keyword pre-filter → embed → vector
 * search → relevance gate (raw cosine) → title-dedup, and returns the entries +
 * a formatted context string. The CALLER owns side-effects (e.g. the retrieval
 * journal), so this stays testable.
 *
 * Behavior is identical to the (now retired) brain-retrieve-prompt.js hook.
 */
const embedder = require('../brain-embedder.js');
const store = require('../brain-store.js');
const backend = require('../brain-backend.js');
const brainConfig = require('./brain-config.js');
const recallHealth = require('./recall-health.js');
const { extractKeywords } = require('./text-utils.js');
const { searchTwoPass } = require('./scope-search.js');
const { USER_SENTINEL } = require('./scope-sanitizer.js');

/**
 * 2.29.1 — timeout (ms) override for the PROJECT arm (`search_memory` filtered by the
 * project chain + `__user__`). The arm now runs IN PARALLEL with compose, so by default
 * it shares compose's `timeoutMs` (0 here = "use cc.timeoutMs"). Env-tunable via
 * CCB_ANCESTOR_TIMEOUT_MS (name kept for compatibility with existing setups).
 */
const ANCESTOR_TIMEOUT_MS = Number.parseInt(process.env.CCB_ANCESTOR_TIMEOUT_MS, 10) || 0;

/**
 * Cap the recall query: the server's compose cost grows with the query length (see
 * brain-config `maxQueryChars`). The head of the prompt carries the intent. `max<=0` = off.
 */
function capQuery(prompt, max) {
  const s = typeof prompt === 'string' ? prompt : '';
  return max > 0 && s.length > max ? s.slice(0, max) : s;
}

/**
 * 2.29.1 — ids the PROJECT arm searches: the focus, its ancestor spine, and the
 * `__user__` scope (on mcp-memory only docs imported by brain-migrate carry it —
 * saveMcp writes scope:"user" under the handshake project; see BACKLOG). Deduped,
 * focus first. Home (no project_id) stays with compose.
 */
function projectArmIds(project, ancestorIds) {
  const out = [];
  for (const id of [project, ...(Array.isArray(ancestorIds) ? ancestorIds : []), USER_SENTINEL]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Circuit breaker for a down mcp-memory daemon. Without this, every single
 * UserPromptSubmit pays the full `cc.timeoutMs` (default 8000ms) waiting on a
 * daemon that is already known to be unreachable — recall-health.js only
 * OBSERVES outcomes, it never gates the next call. Module-level state is
 * correct here: retrieve-core runs inside the persistent brain-server daemon,
 * and daemon-down is a condition shared by every session/project using it.
 * Resets to closed on the next successful (or honest no-match) compose.
 */
let circuitOpenUntil = 0;
const CIRCUIT_COOLDOWN_MS = Number.parseInt(process.env.CCB_MCP_MEMORY_CIRCUIT_MS, 10) || 15000;

/**
 * Run `run(signal)` with a deadline (ms<=0 disables). At the deadline the signal aborts —
 * the HTTP request is destroyed, not left running for the client's 60 s timeout while the
 * next prompt queues behind it — and the promise rejects with a timeout error.
 */
function withDeadline(run, ms, label) {
  if (!ms || ms <= 0) return run(undefined);
  const ac = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([run(ac.signal), expired]).finally(() => clearTimeout(timer));
}

/**
 * Failure-rate breaker for ONE recall arm. The old breaker was a 15 s cooldown, useless
 * with prompts minutes apart, and it never opened while the other arm answered — so a
 * compose that timed out 13 times in a row cost 8 s on every one of those prompts.
 * Opens when at least `minFailures` of the last `window` calls failed and the latest
 * did; while open it skips `skip` calls, then lets one probe through. A probe that
 * answers closes it.
 */
function createArmBreaker({ window = 10, minFailures = 5, skip = 4 } = {}) {
  let outcomes = [];
  let skipLeft = 0;
  let open = false;
  return {
    allow() {
      if (!open) return true;
      if (skipLeft > 0) { skipLeft--; return false; }
      return true; // probe
    },
    result(ok) {
      if (open) {
        if (ok) { open = false; outcomes = []; } else skipLeft = skip;
        return;
      }
      outcomes.push(!!ok);
      if (outcomes.length > window) outcomes.shift();
      if (!ok && outcomes.filter((x) => !x).length >= minFailures) { open = true; skipLeft = skip; }
    },
    state() { return { open, skipLeft, failures: outcomes.filter((x) => !x).length, calls: outcomes.length }; },
  };
}
const armBreakers = { compose: createArmBreaker(), project: createArmBreaker() };

/**
 * Choose what actually gets injected from a compose result: optionally drop the
 * home spine, dedup facts by title, cap to topK, and respect a total char budget
 * (facts carry inline text ≤1024 each — an unbounded set would bloat the prompt).
 * Always keeps at least the top fact. Pure → unit-testable.
 */
function pickInjectable(facts, caps, { topK, maxChars, includeHomeSpine }) {
  let f = Array.isArray(facts) ? facts : [];
  let c = Array.isArray(caps) ? caps : [];
  if (!includeHomeSpine) {
    f = f.filter((x) => x && x.scope !== 'home');
    c = c.filter((x) => x && x.scope !== 'home');
  }
  const seen = new Set();
  const outFacts = [];
  let used = 0;
  for (const x of f) {
    const key = (x.title || '').trim().toLowerCase();
    if (key && seen.has(key)) continue;
    seen.add(key);
    const cost = (x.summary || '').length;
    if (outFacts.length > 0 && used + cost > maxChars) break;
    outFacts.push(x);
    used += cost;
    if (outFacts.length >= topK) break;
  }
  return { facts: outFacts, capabilities: c.slice(0, topK) };
}

/**
 * Map raw `search_memory` hits (the PROJECT arm) to the compose FACT shape so
 * pickInjectable can budget the merged list uniformly. Hits below `minScore` are
 * dropped: the arm always returns topK hits, and unrelated prompts still score
 * ~0.5–0.63 on the hybrid scale (relevant ones ~0.65–0.77, measured 2026-09-25).
 * Tagged scope 'project' (non-home → survives the home-spine filter).
 */
function armHitsToFacts(hits, minScore = 0) {
  return (Array.isArray(hits) ? hits : [])
    .filter((h) => (h.score || 0) >= minScore)
    .map((h) => ({
      id: h.id || h.documentId || '',
      title: h.title || '',
      type: h.type || 'memory',
      scope: 'project',
      summary: h.summary || '',
      text: h.summary || '',
      score: h.score || 0,
    }));
}

/**
 * Merge compose facts with the PROJECT-arm hits into ONE list, project first:
 * compose NON-home facts (the focus's composable docs), THEN arm hits by DESCENDING
 * score, THEN compose HOME facts (the global spine — relevant to any project, so it
 * fills the budget last instead of pushing project hits out). DEDUP by documentId —
 * a doc present in BOTH keeps the COMPOSE occurrence (inline grounding text + scope).
 * Pure → unit-testable. pickInjectable still applies topK/maxChars/title-dedup.
 */
function mergeFactsSpine(composeFacts, armFacts) {
  const cf = Array.isArray(composeFacts) ? composeFacts.filter(Boolean) : [];
  const af = (Array.isArray(armFacts) ? armFacts.slice() : [])
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const composeIds = new Set(cf.map((f) => f.id).filter(Boolean));
  const seen = new Set();
  const out = [];
  const push = (f) => {
    const id = f && f.id;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    out.push(f);
  };
  for (const f of cf) if (f.scope !== 'home') push(f);
  for (const f of af) if (!(f.id && composeIds.has(f.id))) push(f); // a doc in BOTH keeps the COMPOSE occurrence
  for (const f of cf) if (f.scope === 'home') push(f);
  return out;
}

/**
 * Remote brain (Native Java daemon): compose_recall is the REQUIRED two-level
 * recall path on mcp-memory (breaking change: no silent flat fallback). Degrades
 * fail-loud (empty context + recorded health) so a bad daemon never breaks a turn.
 *
 * 2.29.1 — TWO arms IN PARALLEL over a capped query (`maxQueryChars`):
 *   - compose_recall: the typed blocks (procedural/knowledge/skill + the home spine);
 *   - PROJECT arm: `search_memory` filtered by project_id IN (focus, ancestors,
 *     `__user__`), all types, `includeHome:false`. Compose only reads composable types,
 *     and Boss-written projects hold lessons/patterns/decisions — without this arm the
 *     project's own memory never reached the prompt (spike S0, 2026-09-25).
 * Merged project-first (see mergeFactsSpine). Each arm degrades on its own: a failed
 * compose still injects the arm's hits (and records the compose reason); a failed arm
 * records 'project-arm-timeout'/'project-arm-error'. ONE health record per turn.
 *
 * `deps` is a test seam (inject a fake backend/recallHealth); production passes none.
 * @returns {Promise<{entries:object[], capabilities:object[], keywords:string[], project:string, reason?:string}>}
 */
async function retrieveRemote(prompt, { project, ancestorIds, topK, keywords }, deps = {}) {
  const backendRef = deps.backend || backend;
  const healthRef = deps.recallHealth || recallHealth;
  const cc = brainConfig.getRecallCompose();
  const startedAt = Date.now();
  const isTimeout = (err) => /timed out|timeout/i.test((err && err.message) || '');
  // Checks BOTH this function's own fast breaker AND brain-backend.js's shared
  // one (feature-detected — test fakes for backendRef don't implement it, and
  // must keep working unchanged) so a search/save/getRelated failure elsewhere
  // also short-circuits this per-turn recall, not just a prior compose timeout.
  if (Date.now() < circuitOpenUntil || (backendRef.circuitOpen && backendRef.circuitOpen())) {
    healthRef.record('circuit-open');
    return { entries: [], capabilities: [], keywords, project, reason: 'circuit-open' };
  }
  try {
    await backendRef.init({ project, skipEmbedder: true });
    const query = capQuery(prompt, cc.maxQueryChars);
    // Pool-warming (ADR-017): fire a home-federated search IN PARALLEL with compose
    // so ingested HOME docs accumulate recall signal and graduate (async Dreaming).
    // Best-effort, NOT injected, result DISCARDED — and fire-and-forget: retrieve-core
    // runs in the persistent brain-server daemon, so the search completes in the
    // background without adding its latency (up to timeoutMs) to this per-turn recall.
    if (cc.poolWarming && backendRef.warmPool) {
      withDeadline((signal) => backendRef.warmPool(query, { topK, signal }), cc.timeoutMs, 'pool-warming')
        .catch((err) => { console.error(`[retrieve-core] pool-warming skipped: ${err.message}`); });
    }
    const hasCompose = !!(backendRef.hasCompose && backendRef.hasCompose());
    if (!hasCompose) {
      console.error('[retrieve-core] compose_recall unavailable on mcp-memory daemon — typed/home recall skipped (requires memory-server >=2.18)');
    }
    const armIds = projectArmIds(project, ancestorIds);
    const breakers = deps.armBreakers || armBreakers;
    const arms = {};
    const timed = (name, p) => {
      const t0 = Date.now();
      return p.then(
        (v) => { arms[name] = { ms: Date.now() - t0 }; return v; },
        (e) => { arms[name] = { ms: Date.now() - t0, reason: (e && e.reason) || (isTimeout(e) ? 'timeout' : 'error') }; throw e; },
      );
    };
    const skipped = (reason) => Promise.reject(Object.assign(new Error(`${reason} (breaker open: recent calls failed)`), { reason }));
    const runCompose = hasCompose && breakers.compose.allow();
    const runArm = !!backendRef.search && breakers.project.allow();
    const [composeRes, armRes] = await Promise.allSettled([
      !hasCompose
        ? Promise.reject(Object.assign(new Error('compose_recall unavailable'), { reason: 'no-compose' }))
        : runCompose
          ? timed('compose', withDeadline((signal) => backendRef.compose(query, { ...(cc.overlay ? { metadata: cc.overlay } : {}), signal }), cc.timeoutMs, 'compose'))
          : skipped('compose-skipped'),
      !backendRef.search
        ? Promise.resolve([])
        : runArm
          ? timed('project', withDeadline((signal) => backendRef.search(query, { projectIds: armIds, includeHome: false, topK: topK + 4, signal }), ANCESTOR_TIMEOUT_MS || cc.timeoutMs, 'project arm'))
          : skipped('project-arm-skipped'),
    ]);
    if (runCompose) breakers.compose.result(composeRes.status === 'fulfilled');
    if (runArm) breakers.project.result(armRes.status === 'fulfilled');
    let composeReason;
    let composed = { facts: [], capabilities: [] };
    if (composeRes.status === 'fulfilled') composed = composeRes.value || composed;
    else {
      const err = composeRes.reason;
      composeReason = (err && err.reason) || (isTimeout(err) ? 'timeout' : 'remote-error');
      if (composeReason !== 'no-compose') console.error(`[retrieve-core] compose failed (${composeReason}) — project arm only: ${err && err.message}`);
    }
    let armReason;
    let armFacts = [];
    if (armRes.status === 'fulfilled') armFacts = armHitsToFacts(armRes.value, cc.projectArmMinScore);
    else {
      armReason = (armRes.reason && armRes.reason.reason) || (isTimeout(armRes.reason) ? 'project-arm-timeout' : 'project-arm-error');
      console.error(`[retrieve-core] project arm failed (${armReason}): ${armRes.reason && armRes.reason.message}`);
    }
    const merged = mergeFactsSpine(composed.facts, armFacts);
    const { facts, capabilities } = pickInjectable(merged, composed.capabilities, {
      topK, maxChars: cc.maxInjectChars, includeHomeSpine: cc.includeHomeSpine,
    });
    // One record per turn: a failed compose outranks a failed arm, which outranks an honest miss.
    const reason = composeReason || armReason || (facts.length ? undefined : 'no-match');
    healthRef.record(reason, undefined, Date.now() - startedAt, arms);
    // Breaker: the daemon answered if compose, or a REAL project-arm search (a backend
    // without search() resolves [] locally — no evidence), settled fulfilled. Only a
    // transport failure of compose (timeout/remote-error — not 'no-compose', which is
    // an old daemon that IS up) with no such answer treats the daemon as down.
    const composeDown = composeReason === 'timeout' || composeReason === 'remote-error';
    const armAnswered = runArm && armRes.status === 'fulfilled';
    if (composeDown && !armAnswered) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      if (backendRef.reportMcpFailure) backendRef.reportMcpFailure(composeRes.reason);
    } else {
      circuitOpenUntil = 0;
      if (backendRef.reportMcpSuccess) backendRef.reportMcpSuccess();
    }
    return { entries: facts, capabilities, keywords, project, reason: facts.length && !composeReason ? undefined : reason };
  } catch (err) {
    const reason = isTimeout(err) ? 'timeout' : 'remote-error';
    console.error(`[retrieve-core] remote retrieve failed (${reason}): ${err.message}`);
    healthRef.record(reason, undefined, Date.now() - startedAt);
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    if (backendRef.reportMcpFailure) backendRef.reportMcpFailure(err);
    return { entries: [], capabilities: [], keywords, project, reason };
  }
}

/**
 * @param {string} prompt
 * @param {{project?:string, ancestorIds?:string[]}} opts
 *   ancestorIds (F2, mcp-memory only) — the ancestor-spine project_ids (DEEPEST→shallow,
 *   focus first). retrieveRemote's project arm searches them together with `__user__`.
 * @param {{store?:object, backend?:object, recallHealth?:object}} deps
 *   deps.store — same seam as getKB()/recordLessonMetric() in mcp-server.js: the http
 *   daemon passes kbWorker.storeClient here so the local (non mcp-memory) search below
 *   runs its synchronous better-sqlite3 work in the kb-worker thread instead of blocking
 *   this process's main thread (the same class of /health-freeze bug that kb-worker.js
 *   exists to fix). Defaults to the direct require (stdio mode / tests, no shared daemon).
 * @returns {Promise<{entries:object[], keywords:string[], project:string, reason?:string}>}
 *   reason (when entries is empty): 'short' | 'no-embedder' | 'no-match' | 'remote-error'.
 */
async function retrieve(prompt, opts = {}, deps = {}) {
  const project = opts.project || 'default';
  const ancestorIds = Array.isArray(opts.ancestorIds) ? opts.ancestorIds : [];
  const keywords = extractKeywords(prompt || '', { minLen: 4, maxTokens: 15 });
  // Cheap pre-filter: skip trivial/short prompts (don't even touch the model).
  if (keywords.length < 3) return { entries: [], keywords, project, reason: 'short' };

  const { topK, minScore } = brainConfig.getRetrievalFast();

  // Remote backend → the external daemon owns embeddings + search.
  if (backend.peekMode() === 'mcp-memory') {
    return retrieveRemote(prompt, { project, ancestorIds, topK, keywords }, deps);
  }

  const storeRef = deps.store || store;
  await storeRef.init({ project });
  if (!embedder.getStatus().ready) await embedder.init();
  const vector = await embedder.embed(prompt);
  if (!vector) return { entries: [], keywords, project, reason: 'no-embedder' };

  // minScore is applied to RAW cosine (relevance gate) before rerank.
  // Over-fetch + dedup by title: the KB can hold duplicate-title entries that
  // would otherwise waste topK slots.
  // Federate project + __user__ scopes (parity with brain_search) so global
  // lessons (workflow/preferences) are retrievable, not just project-local ones.
  const raw = await searchTwoPass(storeRef, project, vector, { topK: topK + 4, minScore });
  const seenTitles = new Set();
  const entries = [];
  for (const e of raw) {
    const t = (e.title || '').trim().toLowerCase();
    if (t && seenTitles.has(t)) continue;
    seenTitles.add(t);
    entries.push(e);
    if (entries.length >= topK) break;
  }
  return { entries, keywords, project, reason: entries.length ? undefined : 'no-match' };
}

/**
 * Format retrieved memory as the injected context string (empty when none).
 * Two sections (compose two-level, ADR-015): ① FACTS carry inline grounding text;
 * ② CAPABILITIES are name/description pointers (progressive disclosure). The flat
 * local path passes only `entries` → just the facts section (label unchanged).
 */
function formatContext(entries, capabilities) {
  const facts = entries || [];
  const caps = capabilities || [];
  const parts = [];
  if (facts.length) {
    const lines = facts.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);
    parts.push(`[BRAIN] ${facts.length} relevant lesson(s):\n${lines.join('\n')}`);
  }
  if (caps.length) {
    const lines = caps.map((c) => `- ${c.name}${c.description ? ' — ' + c.description : ''}`);
    parts.push(`[BRAIN·SKILLS] ${caps.length} available capability pointer(s):\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Filter entries down to the INJECTABLE set, dropping any whose type is listed
 * in kb.retrieval.contextExcludeTypes (config-driven; default [] = keep all).
 * Pure: does not touch retrieval or scoring — only what actually gets injected,
 * so retrieval efficacy stays measured on the full result set by the caller.
 */
function filterInjectableEntries(entries) {
  if (!entries || !entries.length) return entries || [];
  const ex = new Set(brainConfig.getContextExcludeTypes());
  if (!ex.size) return entries;
  return entries.filter((e) => !ex.has(String((e && e.type) || '').toLowerCase()));
}

module.exports = {
  retrieve, formatContext, filterInjectableEntries, pickInjectable, ANCESTOR_TIMEOUT_MS,
  // F2 test seam: retrieveRemote accepts an injected fake backend/recallHealth via its
  // 3rd `deps` arg; mergeFactsSpine is pure (order/dedup assertions).
  __testHooks: { retrieveRemote, mergeFactsSpine, capQuery, projectArmIds, armHitsToFacts, createArmBreaker, withDeadline, resetCircuit: () => { circuitOpenUntil = 0; armBreakers.compose = createArmBreaker(); armBreakers.project = createArmBreaker(); } },
};
