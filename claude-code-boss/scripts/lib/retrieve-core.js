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
 * Remote brain (Native Java daemon): compose_recall is the REQUIRED two-level
 * recall path on mcp-memory (breaking change: no silent flat fallback). Degrades
 * fail-loud (empty context + recorded health) so a bad daemon never breaks a turn.
 * @returns {Promise<{entries:object[], capabilities:object[], keywords:string[], project:string, reason?:string}>}
 */
async function retrieveRemote(prompt, { project, topK, keywords }) {
  const cc = brainConfig.getRecallCompose();
  try {
    await backend.init({ project, skipEmbedder: true });
    if (!backend.hasCompose || !backend.hasCompose()) {
      console.error('[retrieve-core] compose_recall unavailable on mcp-memory daemon — recall degraded to empty (requires memory-server >=2.18)');
      recallHealth.record('no-compose');
      return { entries: [], capabilities: [], keywords, project, reason: 'no-compose' };
    }
    // Pool-warming (ADR-017): fire a home-federated search IN PARALLEL with compose
    // so ingested HOME docs accumulate recall signal and graduate (async Dreaming).
    // Best-effort, NOT injected — the user context stays pure compose; never breaks recall.
    const warmP = (cc.poolWarming && backend.warmPool)
      ? withTimeout(backend.warmPool(prompt, { topK }), cc.timeoutMs)
        .catch((err) => { console.error(`[retrieve-core] pool-warming skipped: ${err.message}`); })
      : Promise.resolve();
    const composed = await withTimeout(
      backend.compose(prompt, cc.overlay ? { metadata: cc.overlay } : {}),
      cc.timeoutMs,
    );
    await warmP; // let the signal call finish (persistent server), but its result is discarded
    const { facts, capabilities } = pickInjectable(composed.facts, composed.capabilities, {
      topK, maxChars: cc.maxInjectChars, includeHomeSpine: cc.includeHomeSpine,
    });
    recallHealth.record(facts.length ? undefined : 'no-match');
    return { entries: facts, capabilities, keywords, project, reason: facts.length ? undefined : 'no-match' };
  } catch (err) {
    const reason = /timed out|timeout/i.test(err.message || '') ? 'timeout' : 'remote-error';
    console.error(`[retrieve-core] remote retrieve failed (${reason}): ${err.message}`);
    recallHealth.record(reason);
    return { entries: [], capabilities: [], keywords, project, reason };
  }
}

/**
 * @param {string} prompt
 * @param {{project?:string}} opts
 * @returns {Promise<{entries:object[], keywords:string[], project:string, reason?:string}>}
 *   reason (when entries is empty): 'short' | 'no-embedder' | 'no-match' | 'remote-error'.
 */
async function retrieve(prompt, opts = {}) {
  const project = opts.project || 'default';
  const keywords = extractKeywords(prompt || '', { minLen: 4, maxTokens: 15 });
  // Cheap pre-filter: skip trivial/short prompts (don't even touch the model).
  if (keywords.length < 3) return { entries: [], keywords, project, reason: 'short' };

  const { topK, minScore } = brainConfig.getRetrievalFast();

  // Remote backend → the external daemon owns embeddings + search.
  if (backend.peekMode() === 'mcp-memory') {
    return retrieveRemote(prompt, { project, topK, keywords });
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

module.exports = { retrieve, formatContext, filterInjectableEntries, pickInjectable };
