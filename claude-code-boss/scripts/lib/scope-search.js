'use strict';

const fs = require('fs');
const path = require('path');
const { USER_SENTINEL } = require('./scope-sanitizer.js');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(require('os').homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

function userDbExists() {
  return fs.existsSync(path.join(STORE_DIR, 'brain', USER_SENTINEL, 'brain.db'));
}

function splitTopK(topK) {
  const k = Math.max(1, topK || 5);
  const projectK = Math.max(1, Math.round(k * 0.6));
  const userK = Math.max(0, k - projectK);
  return { projectK, userK };
}

function mergeResults(projectResults, userResults, topK) {
  const byId = new Map();
  for (const r of projectResults) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r, scope: r.scope || 'project' });
  }
  for (const r of userResults) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r, scope: r.scope || 'user' });
  }
  return [...byId.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, Math.max(1, topK || 5));
}

async function searchTwoPass(store, currentProject, queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const { projectK, userK } = splitTopK(topK);

  // Project pass: the shared singleton, already init'd to currentProject by the caller.
  const projectResults = await store.search(queryVector, { ...opts, topK: projectK });

  // User pass: a THROWAWAY connection to the __user__ DB — never close()/init() the
  // shared singleton mid-search. On the long-lived MCP server the old close/init
  // dance corrupted singleton state across concurrent tool calls, silently zeroing
  // out retrieval. searchIsolated leaves _db/_project untouched.
  const needUser = (userK > 0 || projectResults.length < projectK) && userDbExists();
  let userResults = [];
  if (needUser) {
    const want = userK + Math.max(0, projectK - projectResults.length);
    userResults = await store.searchIsolated(USER_SENTINEL, queryVector, { ...opts, topK: want });
  }

  return mergeResults(projectResults, userResults, topK);
}

module.exports = {
  splitTopK,
  mergeResults,
  searchTwoPass,
  userDbExists,
};
