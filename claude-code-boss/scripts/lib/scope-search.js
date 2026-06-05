'use strict';
/**
 * scope-search.js — Plan #7. Two-pass scope-aware retrieval.
 *
 * Brain-store is a singleton: each instance opens ONE per-project brain.db.
 * To merge results from the current project AND the global __user__ project
 * in a single call, we close + re-init the store between passes (same
 * pattern the dashboard uses for cross-project aggregation).
 *
 * Trade-off: extra open/close per retrieval, but no concurrent DB instances
 * (better-sqlite3 is sync; concurrency would require a separate Database
 * handle anyway). For typical hook retrieval (1-2 calls per turn) the cost
 * is negligible.
 *
 * Strategy: top-K slots split via `userProjectRatio` (default 0.6 project,
 * 0.4 user). Dedup by entry id (project wins on tie). Final sort by score.
 * If either side returns fewer than its slot, the other side absorbs the
 * leftover budget (gap-fill).
 */

const { USER_SENTINEL } = require('./scope-sanitizer.js');

function splitTopK(topK, userProjectRatio) {
  const k = Math.max(1, topK || 5);
  const r = Math.min(1, Math.max(0, Number.isFinite(userProjectRatio) ? userProjectRatio : 0.6));
  const projectK = Math.max(1, Math.round(k * r));
  const userK = Math.max(0, k - projectK);
  return { projectK, userK };
}

/**
 * Merge two scored result arrays by id (project wins) and sort by score desc.
 * Caps at topK. Pure function.
 */
function mergeResults(projectResults, userResults, topK) {
  const byId = new Map();
  for (const r of projectResults || []) {
    if (r && r.id && !byId.has(r.id)) byId.set(r.id, { ...r, scope: r.scope || 'project' });
  }
  for (const r of userResults || []) {
    if (r && r.id && !byId.has(r.id)) byId.set(r.id, { ...r, scope: r.scope || 'user' });
  }
  return [...byId.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, Math.max(1, topK || 5));
}

/**
 * Run a two-pass search across the current project and __user__.
 * `store` is the brain-store module (singleton). `currentProject` is the
 * project we want to land on at the end (restored before return).
 *
 * Options:
 *   - topK (default 5)
 *   - userProjectRatio (default 0.6 → 60% project / 40% user)
 *   - minScore, type, ...passed through to store.search
 *
 * Returns: merged scored result array (length ≤ topK).
 */
async function searchTwoPass(store, currentProject, queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const { projectK, userK } = splitTopK(topK, opts.userProjectRatio);

  let projectResults = [];
  let userResults = [];

  // Pass 1 — current project (singleton already on this project).
  try {
    projectResults = await store.search(queryVector, { ...opts, topK: topK });
    // Cap projectK; remaining slots flow to user (gap-fill).
  } catch (err) {
    console.error(`[scope-search] project pass failed: ${err.message}`);
  }
  const projectTrimmed = (projectResults || []).slice(0, projectK);

  // Pass 2 — __user__ project. Switch DBs via close + re-init.
  if (userK > 0 || projectTrimmed.length < projectK) {
    try {
      await store.close();
      await store.init({ project: USER_SENTINEL, skipEmbedder: true });
      // Ask for enough to cover both the user slot and any gap-fill the project missed.
      const want = userK + Math.max(0, projectK - projectTrimmed.length);
      userResults = await store.search(queryVector, { ...opts, topK: want });
    } catch (err) {
      console.error(`[scope-search] user pass failed: ${err.message}`);
    } finally {
      try { await store.close(); } catch { /* noop */ }
      try { await store.init({ project: currentProject, skipEmbedder: true }); } catch (err) {
        console.error(`[scope-search] restore failed: ${err.message}`);
      }
    }
  }

  return mergeResults(projectTrimmed, userResults, topK);
}

module.exports = {
  splitTopK,
  mergeResults,
  searchTwoPass,
  USER_SENTINEL,
};
