#!/usr/bin/env node
'use strict';
/**
 * brain-prune.js — rehearse and apply the prune of one project's local memory.
 *
 *   brain-prune.js [preview]  how many entries a prune would archive (nothing is changed)
 *   brain-prune.js apply      archive them (the rows move to `entries_archive`, so they stay recoverable)
 *
 * Options: --project <id> (default: the project of the working directory), --cwd <dir>,
 * --data-dir <dir>, --json. Only the local backend has a store to prune: a server-backed
 * memory is left to its server.
 */

const fs = require('fs');

/**
 * @param {string[]} argv
 * @returns {{cmd: string, project: string|null, cwd: string, dataDir: string|null, json: boolean}}
 */
function parseArgs(argv) {
  const a = { cmd: 'preview', project: null, cwd: process.cwd(), dataDir: null, json: false };
  const rest = argv[0] && !argv[0].startsWith('--') ? (a.cmd = argv[0], argv.slice(1)) : argv;
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i];
    if (v === '--json') a.json = true;
    else if (v === '--project') a.project = rest[++i];
    else if (v === '--cwd') a.cwd = rest[++i];
    else if (v === '--data-dir') a.dataDir = rest[++i];
    else throw new Error(`unknown argument: ${v}`);
  }
  return a;
}

/**
 * @param {string[]} argv
 * @param {{store?: object, peekMode?: () => string, dataDir?: string, resolveProject?: (cwd: string) => string|null}} [deps]
 * @returns {Promise<{code: number, out: string, data: object}>}
 */
async function run(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.cmd !== 'preview' && args.cmd !== 'apply') return { code: 2, out: 'usage: brain-prune.js [preview|apply] [--project <id>] [--cwd <dir>] [--data-dir <dir>] [--json]', data: { ok: false } };
  const store = deps.store || require('../engine/brain-store.js');
  const mode = (deps.peekMode || require('../engine/brain-backend.js').peekMode)();
  if (mode !== 'local') return { code: 0, out: `skipped: the memory backend is ${mode}, and only the local store is pruned here`, data: { ok: true, skipped: 'backend-not-local' } };
  const dataDir = args.dataDir || deps.dataDir || require('../engine/lib/data-dir.js').dataDir();
  const resolve = deps.resolveProject || ((cwd) => require('../engine/lib/project-id.js').tryResolveProjectId({ cwd }));
  const project = args.project || resolve(args.cwd);
  if (!project) return { code: 1, out: 'FAILED: no project id for this directory; pass --project <id>', data: { ok: false } };

  const before = store.prunePreview(project, { dataDir });
  if (!before) return { code: 0, out: `no local memory database for project ${project}: nothing to prune`, data: { ok: true, project, skipped: 'no-database' } };
  const plan = `${before.total} of ${before.entries} entries would be archived (${before.stale} never used, seen once, older than ${before.archiveAfterDays} days; ${before.overCap} over the ${before.maxEntries} cap)`;
  if (args.cmd === 'preview') return { code: 0, out: `${project}: ${plan} — rehearsal, nothing was archived. Run "apply" to archive.`, data: { ok: true, project, mode: 'preview', ...before } };

  await store.init({ project, dataDir });
  try {
    const res = await store.prune({ project });
    return {
      code: 0,
      out: `${project}: archived ${res.archivedStale + res.archivedOverCap} (${res.archivedStale} stale, ${res.archivedOverCap} over the cap), ${res.remaining} remain. Archived rows stay in the project's entries_archive table.`,
      data: { ok: true, project, mode: 'apply', ...res },
    };
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((res) => {
    let args = { json: false };
    try { args = parseArgs(process.argv.slice(2)); } catch (err) { void err; /* run() already reported it */ }
    fs.writeSync(res.code ? 2 : 1, `${args.json ? JSON.stringify(res.data, null, 2) : res.out}\n`);
    process.exit(res.code);
  }).catch((err) => { console.error(`[brain-prune] ${err.message}`); process.exit(1); });
}

module.exports = { run, parseArgs };
