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

/**
 * F2 — timeout (ms) for the AUXILIARY ancestor-spine `search_memory` arm. Deliberately
 * short (default 500ms) and separate from the compose timeout: the ancestor union is a
 * best-effort ENRICHMENT, so it must never stall the per-turn recall — on timeout we
 * degrade to compose-only. Env-tunable via CCB_ANCESTOR_TIMEOUT_MS.
 */
const ANCESTOR_TIMEOUT_MS = Number.parseInt(process.env.CCB_ANCESTOR_TIMEOUT_MS, 10) || 500;

/** Race a promise against a timeout (ms<=0 disables). Rejects with a timeout error. */
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`compose timed out after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

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
 * F2 — map raw `search_memory` hits (the ancestor arm) to the compose FACT shape so
 * pickInjectable can budget the merged list uniformly. Hits carry no block `scope`, so
 * they are tagged 'ancestor' (non-home → survive the home-spine filter): they are the
 * project-hierarchy signal, not the home spine (which compose already federates).
 */
function ancestorHitsToFacts(hits) {
  return (Array.isArray(hits) ? hits : []).map((h) => ({
    id: h.id || h.documentId || '',
    title: h.title || '',
    type: h.type || 'memory',
    scope: 'ancestor',
    summary: h.summary || '',
    text: h.summary || '',
    score: h.score || 0,
  }));
}

/**
 * F2 — merge the CWD focus (compose facts) with the ancestor-spine hits into ONE list,
 * weighting the CWD highest: compose facts come FIRST (positions 1..K), THEN ancestor
 * hits by DESCENDING score. DEDUP by documentId — a doc present in BOTH keeps the
 * COMPOSE occurrence (its inline grounding text + scope). Pure → unit-testable. The
 * caller still runs pickInjectable on the result, so the SAME topK/maxChars budget and
 * title-dedup apply to the merged list.
 */
function mergeFactsSpine(composeFacts, ancestorFacts) {
  const cf = Array.isArray(composeFacts) ? composeFacts.slice() : [];
  const af = (Array.isArray(ancestorFacts) ? ancestorFacts.slice() : [])
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const seen = new Set();
  const out = [];
  for (const f of cf) {                 // compose FIRST — the CWD focus, highest relevance
    const id = f && f.id;
    if (id) seen.add(id);
    out.push(f);
  }
  for (const f of af) {                 // ancestors appended by score, skipping compose dups
    const id = f && f.id;
    if (id && seen.has(id)) continue;   // a doc in BOTH keeps the COMPOSE occurrence
    if (id) seen.add(id);
    out.push(f);
  }
  return out;
}

/**
 * Remote brain (Native Java daemon): compose_recall is the REQUIRED two-level
 * recall path on mcp-memory (breaking change: no silent flat fallback). Degrades
 * fail-loud (empty context + recorded health) so a bad daemon never breaks a turn.
 *
 * F2 — HIERARCHICAL ancestor-spine: compose recalls the CWD focus (its handshake scope
 * = `project`); when `ancestorIds` carries ids BEYOND the focus, a SEPARATE
 * `search_memory` unions those ancestor scopes (server-side IN(...)), and the two are
 * merged CWD-first. The ancestor arm is best-effort — on timeout/error it degrades to
 * compose-only, never failing the turn.
 *
 * `deps` is a test seam (inject a fake backend/recallHealth); production passes none.
 * @returns {Promise<{entries:object[], capabilities:object[], keywords:string[], project:string, reason?:string}>}
 */
async function retrieveRemote(prompt, { project, ancestorIds, topK, keywords }, deps = {}) {
  const backendRef = deps.backend || backend;
  const healthRef = deps.recallHealth || recallHealth;
  const cc = brainConfig.getRecallCompose();
  try {
    await backendRef.init({ project, skipEmbedder: true });
    if (!backendRef.hasCompose || !backendRef.hasCompose()) {
      console.error('[retrieve-core] compose_recall unavailable on mcp-memory daemon — recall degraded to empty (requires memory-server >=2.18)');
      healthRef.record('no-compose');
      return { entries: [], capabilities: [], keywords, project, reason: 'no-compose' };
    }
    // Pool-warming (ADR-017): fire a home-federated search IN PARALLEL with compose
    // so ingested HOME docs accumulate recall signal and graduate (async Dreaming).
    // Best-effort, NOT injected, result DISCARDED — and fire-and-forget: retrieve-core
    // runs in the persistent brain-server daemon, so the search completes in the
    // background without adding its latency (up to timeoutMs) to this per-turn recall.
    if (cc.poolWarming && backendRef.warmPool) {
      withTimeout(backendRef.warmPool(prompt, { topK }), cc.timeoutMs)
        .catch((err) => { console.error(`[retrieve-core] pool-warming skipped: ${err.message}`); });
    }
    const composed = await withTimeout(
      backendRef.compose(prompt, cc.overlay ? { metadata: cc.overlay } : {}),
      cc.timeoutMs,
    );
    // F2 ancestor arm (LAZY): only when there are ancestor ids DISTINCT from the focus
    // (`project`). Union those scopes via search_memory (still includeHome so the home
    // spine federates). Degrade to compose-only on timeout/error — visible, never fatal.
    let ancestorFacts = [];
    const ancestorIdsOnly = (Array.isArray(ancestorIds) ? ancestorIds : []).filter((id) => id && id !== project);
    if (ancestorIdsOnly.length && backendRef.search) {
      try {
        const hits = await withTimeout(
          backendRef.search(prompt, { projectIds: ancestorIdsOnly, includeHome: true, topK }),
          ANCESTOR_TIMEOUT_MS,
        );
        ancestorFacts = ancestorHitsToFacts(hits);
      } catch (err) {
        const areason = /timed out|timeout/i.test(err.message || '') ? 'ancestor-timeout' : 'ancestor-error';
        console.error(`[retrieve-core] ancestor-spine recall degraded (${areason}) — compose-only: ${err.message}`);
        healthRef.record(areason); // partial degradation (compose still returned) — visible in byReason
        ancestorFacts = [];
      }
    }
    const merged = mergeFactsSpine(composed.facts, ancestorFacts);
    const { facts, capabilities } = pickInjectable(merged, composed.capabilities, {
      topK, maxChars: cc.maxInjectChars, includeHomeSpine: cc.includeHomeSpine,
    });
    healthRef.record(facts.length ? undefined : 'no-match');
    return { entries: facts, capabilities, keywords, project, reason: facts.length ? undefined : 'no-match' };
  } catch (err) {
    const reason = /timed out|timeout/i.test(err.message || '') ? 'timeout' : 'remote-error';
    console.error(`[retrieve-core] remote retrieve failed (${reason}): ${err.message}`);
    healthRef.record(reason);
    return { entries: [], capabilities: [], keywords, project, reason };
  }
}

/**
 * @param {string} prompt
 * @param {{project?:string, ancestorIds?:string[]}} opts
 *   ancestorIds (F2, mcp-memory only) — the ancestor-spine project_ids (DEEPEST→shallow,
 *   focus first). When it carries ids beyond `project`, retrieveRemote unions them.
 * @returns {Promise<{entries:object[], keywords:string[], project:string, reason?:string}>}
 *   reason (when entries is empty): 'short' | 'no-embedder' | 'no-match' | 'remote-error'.
 */
async function retrieve(prompt, opts = {}) {
  const project = opts.project || 'default';
  const ancestorIds = Array.isArray(opts.ancestorIds) ? opts.ancestorIds : [];
  const keywords = extractKeywords(prompt || '', { minLen: 4, maxTokens: 15 });
  // Cheap pre-filter: skip trivial/short prompts (don't even touch the model).
  if (keywords.length < 3) return { entries: [], keywords, project, reason: 'short' };

  const { topK, minScore } = brainConfig.getRetrievalFast();

  // Remote backend → the external daemon owns embeddings + search.
  if (backend.peekMode() === 'mcp-memory') {
    return retrieveRemote(prompt, { project, ancestorIds, topK, keywords });
  }

  await store.init({ project });
  if (!embedder.getStatus().ready) await embedder.init();
  const vector = await embedder.embed(prompt);
  if (!vector) return { entries: [], keywords, project, reason: 'no-embedder' };

  // minScore is applied to RAW cosine (relevance gate) before rerank.
  // Over-fetch + dedup by title: the KB can hold duplicate-title entries that
  // would otherwise waste topK slots.
  // Federate project + __user__ scopes (parity with brain_search) so global
  // lessons (workflow/preferences) are retrievable, not just project-local ones.
  const raw = await searchTwoPass(store, project, vector, { topK: topK + 4, minScore });
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
  __testHooks: { retrieveRemote, mergeFactsSpine },
};
