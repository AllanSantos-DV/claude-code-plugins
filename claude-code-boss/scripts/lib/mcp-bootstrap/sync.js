#!/usr/bin/env node
'use strict';
/**
 * sync.js — keeps every copy of mcp-bootstrap/ identical to the upstream one
 * (claude-code-boss is upstream; other plugins vendor the folder as-is).
 *
 *   node sync.js stamp                    upstream only: record the files' hashes in MANIFEST.json
 *   node sync.js check                    every file matches MANIFEST.json, none missing or extra
 *   node sync.js check --upstream <src>   + MANIFEST.json equals the upstream one (<src> = URL or path)
 *
 * Exit 1 with the differing files on any mismatch. Hashes are taken with CRLF→LF, so a
 * Windows checkout (core.autocrlf) and CI agree. Node core only, like the rest of the folder.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const MANIFEST = 'MANIFEST.json';

function hashFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * { name: sha256 } of every file in `dir` except the manifest. The folder is flat by design:
 * a subfolder gets the marker hash "<dir>" so it never passes as in sync (it used to be skipped).
 */
function computeFiles(dir = DIR) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === MANIFEST) continue;
    out[name] = fs.statSync(path.join(dir, name)).isFile() ? hashFile(path.join(dir, name)) : '<dir>';
  }
  return out;
}

function stamp(dir = DIR) {
  const file = path.join(dir, MANIFEST);
  fs.writeFileSync(file, JSON.stringify({ files: computeFiles(dir) }, null, 2) + '\n');
  return file;
}

/** Names whose hashes differ between two { name: sha256 } maps (missing on either side included). */
function diffFiles(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((n) => a[n] !== b[n]);
}

function readManifest(dir = DIR) {
  const file = path.join(dir, MANIFEST);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { throw new Error(`${file} not readable (${err.message}) — run "node sync.js stamp" upstream`); }
  const m = JSON.parse(raw);
  if (!m || typeof m.files !== 'object') throw new Error(`${file} has no "files" map`);
  return m.files;
}

async function loadUpstream(src) {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`upstream manifest ${src} → HTTP ${r.status}`);
    const m = await r.json();
    if (!m || typeof m.files !== 'object') throw new Error(`upstream manifest ${src} has no "files" map`);
    return m.files;
  }
  return readManifest(path.dirname(path.resolve(src)));
}

/** { ok, problems[] } — never throws for a mismatch, only for an unreadable source. */
async function check({ dir = DIR, upstream = '' } = {}) {
  const problems = [];
  const recorded = readManifest(dir);
  const local = diffFiles(recorded, computeFiles(dir));
  if (local.length) problems.push(`files differ from ${MANIFEST}: ${local.join(', ')} — upstream: run "node sync.js stamp"; a copy: re-copy the folder from upstream (never edit it in place)`);
  if (upstream) {
    const up = diffFiles(await loadUpstream(upstream), recorded);
    if (up.length) problems.push(`copy differs from upstream (${upstream}): ${up.join(', ')} — re-copy the folder from upstream`);
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { computeFiles, stamp, check, diffFiles, MANIFEST };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--upstream');
  const upstream = i >= 0 ? rest[i + 1] || '' : '';
  (async () => {
    if (cmd === 'stamp') { console.log(`stamped ${stamp()}`); return; }
    if (cmd !== 'check' || (i >= 0 && !upstream)) {
      console.error('usage: node sync.js stamp | check [--upstream <url|path>]');
      process.exit(2);
    }
    const r = await check({ upstream });
    if (r.ok) { console.log(`OK mcp-bootstrap in sync${upstream ? ' with upstream' : ''}`); return; }
    for (const p of r.problems) console.error(`FAIL ${p}`);
    process.exit(1);
  })().catch((err) => { console.error(`FAIL ${err.message}`); process.exit(1); });
}
