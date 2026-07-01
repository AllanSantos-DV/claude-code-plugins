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
const { extractKeywords } = require('./text-utils.js');
const { searchTwoPass } = require('./scope-search.js');

/**
 * Remote brain (Native Java daemon): delegate retrieval to the backend dispatcher,
 * which embeds + searches server-side. No local embedder is loaded in this path.
 * @returns {Promise<{entries:object[], keywords:string[], project:string, reason?:string}>}
 */
async function retrieveRemote(prompt, { project, topK, keywords }) {
  try {
    await backend.init({ project, skipEmbedder: true });
    const hits = await backend.search(prompt, { topK: topK + 4 });
    const seenTitles = new Set();
    const entries = [];
    for (const h of hits) {
      const t = (h.title || '').trim().toLowerCase();
      if (t && seenTitles.has(t)) continue;
      seenTitles.add(t);
      entries.push({ id: h.id, title: h.title, type: h.type || 'memory', summary: h.summary || '' });
      if (entries.length >= topK) break;
    }
    return { entries, keywords, project, reason: entries.length ? undefined : 'no-match' };
  } catch (err) {
    console.error(`[retrieve-core] remote retrieve failed: ${err.message}`);
    return { entries: [], keywords, project, reason: 'remote-error' };
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

/** Format retrieved entries as the injected context string (empty when none). */
function formatContext(entries) {
  if (!entries || !entries.length) return '';
  const lines = entries.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);
  return `[BRAIN] ${entries.length} relevant lesson(s):\n${lines.join('\n')}`;
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

module.exports = { retrieve, formatContext, filterInjectableEntries };
