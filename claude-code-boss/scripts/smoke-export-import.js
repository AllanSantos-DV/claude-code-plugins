#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'scripts', 'dashboard.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  \u2713 ${name}`); pass++; }
function bad(name, msg) { console.log(`  \u2717 ${name}\n      \u2192 ${msg}`); fail++; }

function fetchJson(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: {
        'x-dashboard-token': token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-smoke-eximport-'));
  console.log(`smoke-export-import.js — DATA=${dataDir}\n`);

  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: dataDir, DASHBOARD_NO_OPEN: '1', DASHBOARD_PORT: '0' };

  const child = spawn('node', [DASHBOARD], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let port = 0, token = '';
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/http:\/\/localhost:(\d+)\s+\(token:\s+([a-f0-9]+)\)/);
      if (m) { port = Number(m[1]); token = m[2]; resolve(); }
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => reject(new Error(`dashboard exited early code=${code}`)));
    setTimeout(() => reject(new Error('dashboard did not start in 8s')), 8000);
  });

  try {
    await ready;

    // Seed source project via brain-store (direct)
    const srcProject = `smoke-src-${Date.now()}`;
    const dstProject = `smoke-dst-${Date.now()}`;
    {
      const seedEnv = { ...env };
      const seed = spawn('node', ['-e', `
        process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(dataDir)};
        const store = require(${JSON.stringify(path.join(ROOT, 'scripts', 'brain-store.js'))});
        const index = require(${JSON.stringify(path.join(ROOT, 'scripts', 'brain-index.js'))});
        const graph = require(${JSON.stringify(path.join(ROOT, 'scripts', 'brain-graph.js'))});
        (async () => {
          await store.init({ project: ${JSON.stringify(srcProject)} });
          await index.init({ project: ${JSON.stringify(srcProject)} });
          await graph.init({ project: ${JSON.stringify(srcProject)} });
          for (let i = 0; i < 3; i++) {
            const e = { id: 'eximport-'+i, type: 'lesson', title: 'Smoke '+i, summary: 'smoke summary '+i, content: { detail: 'body '+i }, tags: ['smoke', 'kw'+i], scope: 'project', project: ${JSON.stringify(srcProject)}, confidence: 0.8, createdAt: new Date().toISOString() };
            await store.save(e);
            await index.index(e);
            await graph.registerNode(e);
          }
        })().catch(err => { console.error(err); process.exit(1); });
      `], { env: seedEnv, stdio: 'inherit' });
      await new Promise((r, rj) => { seed.on('exit', c => c === 0 ? r() : rj(new Error('seed failed'))); });
    }

    // 1) Export project entries
    const exp = await fetchJson(port, token, 'GET', `/api/brain/export?project=${encodeURIComponent(srcProject)}`);
    if (exp.status !== 200) bad('export project', `status=${exp.status} body=${JSON.stringify(exp.body).slice(0, 200)}`);
    else if (!Array.isArray(exp.body?.entries) || exp.body.entries.length !== 3) bad('export project', `entries count: ${exp.body?.entries?.length}`);
    else if (exp.body.project !== srcProject) bad('export project', `project field: ${exp.body.project}`);
    else ok('export project → 3 entries with project field');

    // Fidelity: export must carry the FULL entry (content/tags/scope), not the lossy
    // store.list() projection. Guards the data-loss bug where import silently dropped
    // lesson bodies because export only shipped id/title/summary/confidence.
    {
      const e0 = (exp.body?.entries || []).find(x => x.id === 'eximport-0');
      if (!e0) bad('export fidelity', 'eximport-0 missing from export');
      else if (!e0.content || e0.content.detail !== 'body 0') bad('export fidelity', `content dropped: ${JSON.stringify(e0.content)}`);
      else if (!Array.isArray(e0.tags) || e0.tags.length === 0) bad('export fidelity', `tags dropped: ${JSON.stringify(e0.tags)}`);
      else if (e0.scope !== 'project') bad('export fidelity', `scope dropped: ${e0.scope}`);
      else ok('export fidelity → content/tags/scope preserved');
    }

    // 2) Import into fresh dst with conflict=skip
    const importBody = { ...exp.body, project: dstProject, conflict: 'skip' };
    const imp1 = await fetchJson(port, token, 'POST', '/api/brain/import', importBody);
    if (imp1.status !== 200) bad('import skip', `status=${imp1.status} body=${JSON.stringify(imp1.body).slice(0, 200)}`);
    else if (imp1.body?.added !== 3 || imp1.body?.skipped !== 0) bad('import skip', `added=${imp1.body?.added} skipped=${imp1.body?.skipped} failed=${imp1.body?.failed}`);
    else ok('import into fresh project → added=3 skipped=0');

    // Round-trip fidelity: re-export the destination and confirm the lesson body
    // survived export→import (the exact failure this smoke now guards).
    {
      const rexp = await fetchJson(port, token, 'GET', `/api/brain/export?project=${encodeURIComponent(dstProject)}`);
      const e0 = (rexp.body?.entries || []).find(x => x.id === 'eximport-0');
      if (!e0 || !e0.content || e0.content.detail !== 'body 0') bad('round-trip fidelity', `content lost after import: ${JSON.stringify(e0 && e0.content)}`);
      else if (!Array.isArray(e0.tags) || e0.tags.length === 0) bad('round-trip fidelity', `tags lost after import: ${JSON.stringify(e0 && e0.tags)}`);
      else ok('round-trip fidelity → content+tags survived export→import');
    }

    // 3) Re-import with conflict=skip (should skip all)
    const imp2 = await fetchJson(port, token, 'POST', '/api/brain/import', importBody);
    if (imp2.body?.skipped !== 3 || imp2.body?.added !== 0) bad('import dedupe', `added=${imp2.body?.added} skipped=${imp2.body?.skipped}`);
    else ok('re-import same → skipped=3 added=0 (dedupe by id)');

    // 4) Import with conflict=overwrite
    const imp3 = await fetchJson(port, token, 'POST', '/api/brain/import', { ...exp.body, project: dstProject, conflict: 'overwrite' });
    if (imp3.body?.overwritten !== 3) bad('import overwrite', `overwritten=${imp3.body?.overwritten}`);
    else ok('import overwrite → overwritten=3');

    // 5) Bad request: missing project
    const imp4 = await fetchJson(port, token, 'POST', '/api/brain/import', { entries: [], conflict: 'skip' });
    if (imp4.status !== 400) bad('import missing project', `status=${imp4.status}`);
    else ok('import missing project → 400');

    // 6) Export with neither scope nor project
    const exp2 = await fetchJson(port, token, 'GET', '/api/brain/export');
    if (exp2.status !== 400) bad('export missing args', `status=${exp2.status}`);
    else ok('export missing args → 400');

    // 7) Auth: no token → 401
    const http = require('http');
    const noAuth = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/brain/export?project=${srcProject}` }, (res) => {
        let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve(0));
      r.end();
    });
    if (noAuth !== 401) bad('auth required', `status=${noAuth}`);
    else ok('export without token → 401');

  } finally {
    child.kill();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Smoke export/import: ${pass} passed  ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
