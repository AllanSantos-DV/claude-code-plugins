#!/usr/bin/env node
'use strict';
// Smoke: scope-bulk-reclassify --commit must PRESERVE the entry body+tags when it
// promotes a project entry to user scope. Guards the data-loss bug where a lossy
// store.list() read caused the original to be deleted and an empty-bodied copy saved.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \u2713 ${n}`); pass++; };
const bad = (n, m) => { console.log(`  \u2717 ${n}\n      \u2192 ${m}`); fail++; };

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', (code) => resolve({ code, out, err }));
    c.on('error', reject);
  });
}

function finish() {
  console.log(`\n${'\u2500'.repeat(60)}`);
  console.log(`Smoke scope-reclassify: ${pass} passed  ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-smoke-reclass-'));
  console.log(`smoke-scope-reclassify.js — DATA=${dataDir}\n`);
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: dataDir };
  const srcProject = 'reclass-src';
  const BODY = 'IMPORTANT-BODY-KEEP-ME';

  const storePath = JSON.stringify(path.join(ROOT, 'scripts', 'brain-store.js'));
  const indexPath = JSON.stringify(path.join(ROOT, 'scripts', 'brain-index.js'));
  const graphPath = JSON.stringify(path.join(ROOT, 'scripts', 'brain-graph.js'));

  // Seed a reference-type entry (inferDefaultScope -> 'user') WITH a body + tags.
  const seed = await run('node', ['-e', `
    process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(dataDir)};
    const store = require(${storePath});
    const index = require(${indexPath});
    const graph = require(${graphPath});
    (async () => {
      await store.init({ project: ${JSON.stringify(srcProject)} });
      await index.init({ project: ${JSON.stringify(srcProject)} });
      await graph.init({ project: ${JSON.stringify(srcProject)} });
      const e = { id: 'reclass-1', type: 'reference', title: 'Ref title', summary: 'ref summary', content: { detail: ${JSON.stringify(BODY)} }, tags: ['alpha', 'beta'], scope: 'project', project: ${JSON.stringify(srcProject)}, confidence: 0.8, created_at: new Date().toISOString() };
      await store.save(e); await index.index(e); await graph.registerNode(e);
    })().catch(err => { console.error(err); process.exit(1); });
  `], env);
  if (seed.code !== 0) { bad('seed', seed.err || seed.out); return finish(); }
  ok('seed reference entry with body+tags');

  // Run the destructive promotion.
  const r = await run('node', [path.join(ROOT, 'scripts', 'scope-bulk-reclassify.js'), srcProject, '--commit'], env);
  if (r.code !== 0) { bad('reclassify --commit', r.err || r.out); return finish(); }
  if (!/promoted=1/.test(r.out)) bad('reclassify promoted=1', r.out);
  else ok('reclassify --commit → promoted=1');

  // The promoted __user__ copy must keep its body + tags (the data-loss guard).
  const chk = await run('node', ['-e', `
    process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(dataDir)};
    const store = require(${storePath});
    (async () => {
      await store.init({ project: '__user__' });
      const list = await store.list();
      const full = list.map(x => store.getRaw(x.id)).find(x => x && x.content && x.content.detail === ${JSON.stringify(BODY)});
      console.log(JSON.stringify({ found: !!full, tags: full && full.tags, scope: full && full.scope }));
    })().catch(err => { console.error(err); process.exit(1); });
  `], env);
  let res = {};
  try { res = JSON.parse((chk.out.trim().split('\n').pop()) || '{}'); }
  catch (e) { void e; /* leave res empty → assertion below fails with context */ }
  if (!res.found) bad('body preserved', `promoted entry lost its body: out=${chk.out} err=${chk.err}`);
  else if (!Array.isArray(res.tags) || res.tags.length === 0) bad('tags preserved', `tags lost: ${JSON.stringify(res.tags)}`);
  else if (res.scope !== 'user') bad('scope set', `scope not user: ${res.scope}`);
  else ok('promoted entry kept body + tags + user scope (no data loss)');

  finish();
}

main().catch(err => { console.error(err); process.exit(1); });
