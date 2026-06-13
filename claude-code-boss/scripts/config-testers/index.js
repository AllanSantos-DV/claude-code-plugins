'use strict';
/**
 * config-testers/index.js — registry + dispatcher.
 *
 * Public API:
 *   list() → ['embedder','mcp-memory','curation','hooks']
 *   run(domain, input) → Promise<{ok, details?, error?, ms}>
 */
const testers = {
  embedder: require('./embedder.js'),
  'mcp-memory': require('./mcp-memory.js'),
  curation: require('./curation.js'),
  hooks: require('./hooks.js'),
};

function list() { return Object.keys(testers); }

async function run(domain, input) {
  const t = testers[domain];
  if (!t) return { ok: false, error: `Unknown domain: ${domain}. Known: ${list().join(', ')}`, ms: 0 };
  try {
    const out = await t.test(input || {});
    if (!out || typeof out !== 'object') return { ok: false, error: 'tester returned no object', ms: 0 };
    if (typeof out.ok !== 'boolean') return { ok: false, error: 'tester missing ok:boolean', ms: 0 };
    if (typeof out.ms !== 'number') out.ms = 0;
    return out;
  } catch (err) {
    const error = err.message;
    return { ok: false, error, ms: 0 };
  }
}

module.exports = { list, run, testers };
