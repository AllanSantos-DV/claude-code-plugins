#!/usr/bin/env node
// Usage:
//   node scripts/scope-bulk-reclassify.js <project>            # dry-run
//   node scripts/scope-bulk-reclassify.js <project> --commit   # apply
//   node scripts/scope-bulk-reclassify.js <project> --type=lesson --commit
//   node scripts/scope-bulk-reclassify.js --undo <move-id>...  # undo moves (also those made from the dashboard)
//   node scripts/scope-bulk-reclassify.js --undo --all         # undo every active move

'use strict';
const store = require('../engine/brain-store.js');
const index = require('../engine/brain-index.js');
const graph = require('../engine/brain-graph.js');
const { inferDefaultScope, prepareForUserScope, USER_SENTINEL } = require('../engine/lib/scope-sanitizer.js');
const { safeTags } = require('./lib/lesson-promotion.js');
const { recordMove, undoMoves } = require('./lib/scope-move.js');
const crypto = require('crypto');

/** @returns {{project:string, commit:boolean, type:string, undo:boolean, undoAll:boolean, ids:string[]}} */
function parseArgs(argv) {
  const args = { project: '', commit: false, type: '', undo: false, undoAll: false, ids: [] };
  for (const a of argv.slice(2)) {
    if (a === '--commit') args.commit = true;
    else if (a === '--undo') args.undo = true;
    else if (a === '--all') args.undoAll = true;
    else if (a.startsWith('--type=')) args.type = a.slice('--type='.length);
    else if (!a.startsWith('--')) {
      args.ids.push(a);
      if (!args.project) args.project = a;
    }
  }
  return args;
}

/**
 * The entry written to the user scope: title/summary/detail from the sanitizer, tags filtered like the automatic promotion
 * (never one naming the source project), and NEVER `content.files` (paths of the source project) or its `source`.
 */
function toUserEntry(e, safeText, project) {
  const safe = {
    ...e,
    title: safeText.title,
    summary: safeText.summary,
    content: { detail: safeText.detail },
    tags: safeTags([e], [project]),
    source: {},
    scope: 'user',
    project: USER_SENTINEL,
  };
  delete safe.id;
  return safe;
}

/**
 * Move one entry to the user scope: record it so it can be undone, delete the original, save the sanitized copy.
 * @param {object} e  the entry as stored (store.getRaw)
 * @param {string} project  its source project
 * @param {{dataDir?:string}} [opts]
 * @returns {Promise<{status:'promoted'|'rejected', reason?:string, moveId?:string}>}
 */
async function moveToUserScope(e, project, { dataDir } = {}) {
  const detail = (e.content && e.content.detail) || e.detail || '';
  const prep = prepareForUserScope(
    { title: e.title, summary: e.summary, detail },
    project
  );
  if (prep.rejected) return { status: 'rejected', reason: prep.reason };
  const safe = toUserEntry(e, prep.safe, project);
  safe.id = crypto.randomUUID();
  const moveId = recordMove(dataDir || require('../engine/lib/data-dir.js').dataDir(), { original: e, fromProject: project, toProject: USER_SENTINEL, toId: safe.id });

  await store.init({ project });
  await index.init({ project });
  await graph.init({ project });
  await store.delete({ id: e.id });
  index.deindex(e.id);
  await graph.unregisterNode(e.id);

  await store.init({ project: USER_SENTINEL });
  await index.init({ project: USER_SENTINEL });
  await graph.init({ project: USER_SENTINEL });
  await store.save(safe);
  await index.index(safe);
  await graph.registerNode(safe);
  return { status: 'promoted', moveId };
}

/** Dry-run / commit of the bulk promotion to the user scope, or `--undo` of recorded moves. */
async function main() {
  const { project, commit, type, undo, undoAll, ids } = parseArgs(process.argv);
  if (undo) {
    if (!undoAll && !ids.length) {
      console.error('Usage: scope-bulk-reclassify.js --undo <move-id>... | --undo --all');
      process.exit(2);
    }
    const results = await undoMoves({ dataDir: require('../engine/lib/data-dir.js').dataDir(), store, index, graph }, undoAll ? 'all' : ids);
    for (const r of results) console.log(`${r.id}: ${r.ok ? r.note : `FAILED ${r.error}`}`);
    if (!results.length) console.log('no active moves to undo');
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  if (!project) {
    console.error('Usage: scope-bulk-reclassify.js <project> [--type=lesson] [--commit]');
    process.exit(2);
  }
  if (project === USER_SENTINEL) {
    console.error('Refusing: source cannot be __user__');
    process.exit(2);
  }

  await store.init({ project });
  // store.list() is a LOSSY projection (no content/tags/scope/source/recurrence).
  // Re-read each via getRaw (SELECT *) so scope/tag inference sees real values AND
  // the promoted copy keeps its body — otherwise --commit deletes the original and
  // writes an empty-bodied entry to __user__ (unrecoverable data loss).
  const listed = await store.list(type || undefined);
  const all = [];
  for (const it of listed) {
    const full = store.getRaw(it.id);
    if (full) all.push(full);
  }

  const proposals = [];
  for (const e of all) {
    const currentScope = e.scope || 'project';
    if (currentScope === 'user') continue;
    const inferred = inferDefaultScope(e.type, e.tags || []);
    if (inferred === 'user') proposals.push(e);
  }

  console.log(`source project: ${project}`);
  console.log(`scanned: ${all.length} entries${type ? ` (type=${type})` : ''}`);
  console.log(`proposed promotions to user scope: ${proposals.length}`);
  for (const e of proposals.slice(0, 50)) {
    console.log(`  - [${e.type}] ${e.id.slice(0, 8)} ${(e.title || '').slice(0, 70)}`);
  }
  if (proposals.length > 50) console.log(`  ... +${proposals.length - 50} more`);

  if (!commit) {
    console.log('\n(dry-run; pass --commit to apply)');
    return;
  }

  let promoted = 0, rejected = 0, failed = 0;
  const moveIds = [];
  for (const e of proposals) {
    try {
      const r = await moveToUserScope(e, project);
      if (r.status === 'rejected') {
        console.warn(`  rejected ${e.id.slice(0, 8)}: ${r.reason}`);
        rejected++;
        continue;
      }
      moveIds.push(r.moveId);
      promoted++;
    } catch (err) {
      console.error(`  failed ${e.id.slice(0, 8)}: ${err.message}`);
      failed++;
    }
  }
  await store.init({ project });
  console.log(`\npromoted=${promoted} rejected=${rejected} failed=${failed}`);
  if (moveIds.length) console.log(`undo: node scripts/scope-bulk-reclassify.js --undo ${moveIds.length <= 3 ? moveIds.join(' ') : '--all'}`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { toUserEntry, moveToUserScope, parseArgs };
