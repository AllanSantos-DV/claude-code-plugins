'use strict';
/**
 * scope-search.js — Plan #7. Two-pass scope-aware retrieval.
 *
 * Brain-store is a singleton holding ONE per-project brain.db, so reading
 * the global __user__ DB in the same call requires close + re-init.
 * Restore failure MUST propagate — silently leaving the store on the wrong
 * project would poison every subsequent write/read in the session.
 */

const fs = require('fs');
const path = require('path');
const { USER_SENTINEL } = require('./scope-sanitizer.js');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(require('os').homedir(), '.claude', 'plugins', 'data', 'claude-code-boss-inline');

function userDbExists() {
  return fs.existsSync(path.join(STORE_DIR, 'brain', USER_SENTINEL, 'brain.db'));
}

function splitTopK(topK, userProjectRatio) {
  const k = Math.max(1, topK || 5);
  const r = Math.min(1, Math.max(0, Number.isFinite(userProjectRatio) ? userProjectRatio : 0.6));
  const projectK = Math.max(1, Math.round(k * r));
  const userK = Math.max(0, k - projectK);
  return { projectK, userK };
}

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

async function searchTwoPass(store, currentProject, queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const { projectK, userK } = splitTopK(topK, opts.userProjectRatio);

  let projectResults = [];
  try {
    projectResults = await store.search(queryVector, { ...opts, topK: projectK });
  } catch (err) {
    console.error(`[scope-search] project pass failed: ${err.message}`);
  }
  const projectTrimmed = (projectResults || []).slice(0, projectK);

  // Skip the user pass entirely when nothing's there yet — avoids the
  // close+reopen churn on every retrieval before any user-scope entry exists.
  const needUser = (userK > 0 || projectTrimmed.length < projectK) && userDbExists();
  let userResults = [];
  if (needUser) {
    try {
      await store.close();
      await store.init({ project: USER_SENTINEL, skipEmbedder: true });
      const want = userK + Math.max(0, projectK - projectTrimmed.length);
      userResults = await store.search(queryVector, { ...opts, topK: want });
    } catch (err) {
      console.error(`[scope-search] user pass failed: ${err.message}`);
    } finally {
      try { await store.close(); } catch { /* noop */ }
      await store.init({ project: currentProject, skipEmbedder: true });
    }
  }

  return mergeResults(projectTrimmed, userResults, topK);
}

module.exports = {
  splitTopK,
  mergeResults,
  searchTwoPass,
  userDbExists,
  USER_SENTINEL,
};
