#!/usr/bin/env node
// scripts/scope-bulk-reclassify.js — Plan #7. Heuristic batch promotion of
// existing project entries to scope=user when type+tags match the
// inferDefaultScope rules. Idempotent: dry-run by default.
//
// Usage:
//   node scripts/scope-bulk-reclassify.js <project>            # dry-run
//   node scripts/scope-bulk-reclassify.js <project> --commit   # actually move
//   node scripts/scope-bulk-reclassify.js <project> --type=lesson --commit
//
// Strategy: load every entry from the source project, run inferDefaultScope.
// If the inferred scope is 'user' AND the entry isn't already user-scoped,
// emit a proposal. With --commit, the move is performed via the same
// sanitize+save+unregister-on-source path as the dashboard endpoint.

'use strict';
const path = require('path');
const store = require('./brain-store.js');
const index = require('./brain-index.js');
const graph = require('./brain-graph.js');
const { inferDefaultScope, prepareForUserScope, USER_SENTINEL } = require('./lib/scope-sanitizer.js');

function parseArgs(argv) {
  const args = { project: '', commit: false, type: '' };
  for (const a of argv.slice(2)) {
    if (a === '--commit') args.commit = true;
    else if (a.startsWith('--type=')) args.type = a.slice('--type='.length);
    else if (!args.project && !a.startsWith('--')) args.project = a;
  }
  return args;
}

async function main() {
  const { project, commit, type } = parseArgs(process.argv);
  if (!project) {
    console.error('Usage: scope-bulk-reclassify.js <project> [--type=lesson] [--commit]');
    process.exit(2);
  }
  if (project === USER_SENTINEL) {
    console.error('Refusing: source cannot be __user__');
    process.exit(2);
  }

  store.init({ project });
  const all = await store.list(type || undefined);

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
  for (const e of proposals) {
    try {
      const detail = (e.content && e.content.detail) || e.detail || '';
      const prep = prepareForUserScope(
        { title: e.title, summary: e.summary, detail },
        project
      );
      if (prep.rejected) {
        console.warn(`  rejected ${e.id.slice(0, 8)}: ${prep.reason}`);
        rejected++;
        continue;
      }
      const safe = {
        ...e,
        title: prep.safe.title,
        summary: prep.safe.summary,
        content: { ...(e.content || {}), detail: prep.safe.detail },
        scope: 'user',
        project: USER_SENTINEL,
      };
      delete safe.id;

      store.init({ project });
      index.init({ project });
      graph.init({ project });
      store.delete(e.id);
      index.deindex(e.id);
      await graph.unregisterNode(e.id);

      store.init({ project: USER_SENTINEL });
      index.init({ project: USER_SENTINEL });
      graph.init({ project: USER_SENTINEL });
      await store.save(safe);
      await index.index(safe);
      await graph.registerNode(safe);
      promoted++;
    } catch (err) {
      console.error(`  failed ${e.id.slice(0, 8)}: ${err.message}`);
      failed++;
    }
  }
  store.init({ project });
  console.log(`\npromoted=${promoted} rejected=${rejected} failed=${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
