'use strict';
/**
 * install-ready.js — is a plugin install complete enough to run the brain daemon from?
 *
 * An update lands a new version folder in Claude Code's cache, and its plugin-setup runs
 * `npm install` there for a minute or two. During that window the folder already has
 * `servers/brain-server/index.js` and, mid-install, the `package.json` of packages whose
 * files are not written yet — so "the entry exists" and "the deps resolve" both say yes
 * while an import still fails (ERR_MODULE_NOT_FOUND). A daemon swapped to, or spawned
 * from, such a folder dies on boot, and every session's MCP link drops with it.
 * plugin-setup marks its root while it runs; a root is ready only without a live mark,
 * with its node_modules, and with the brain-server deps resolving.
 */
const fs = require('fs');
const path = require('path');
const { pidAlive } = require('../../engine/lib/process-lock.js');

const SETUP_MARK = '.plugin-setup.json';
const MARK_STALE_MS = 30 * 60_000;

/** Path of the mark plugin-setup keeps in its root while it installs. */
function setupMarkPath(root) {
  return path.join(root, SETUP_MARK);
}

/** Writes the mark for this process. */
function markSetup(root, pid = process.pid) {
  fs.writeFileSync(setupMarkPath(root), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
}

/** Removes the mark (only this process's). */
function clearSetup(root, pid = process.pid) {
  const owner = readMark(root);
  if (owner && owner.pid !== pid) return;
  try { fs.rmSync(setupMarkPath(root), { force: true }); } catch (err) { console.error(`[install-ready] could not remove the setup mark: ${err.message}`); }
}

function readMark(root) {
  let raw;
  try { raw = fs.readFileSync(setupMarkPath(root), 'utf8'); } catch (err) { void err; return null; }
  try { return JSON.parse(raw); } catch (err) { console.error(`[install-ready] unreadable setup mark in ${root}: ${err.message}`); return null; }
}

/**
 * The setup running in this root, or null. A mark whose process is gone, or older than
 * MARK_STALE_MS (a setup killed hard, its pid later reused), does not count.
 * @returns {{pid:number, startedAt:string}|null}
 */
function setupRunning(root, { now = Date.now(), alive = pidAlive } = {}) {
  const m = readMark(root);
  if (!m || !Number.isInteger(m.pid)) return null;
  const started = Date.parse(m.startedAt);
  if (!Number.isFinite(started) || now - started > MARK_STALE_MS) return null;
  return alive(m.pid) ? m : null;
}

/**
 * Two ways to resolve a package, since dependencies mix CJS, ESM-only and `exports` maps
 * without `./package.json`; absent only when both fail.
 */
function depResolvable(dep, fromDir) {
  try {
    require.resolve(`${dep}/package.json`, { paths: [fromDir] });
    return true;
  } catch (err) { void err; }
  try {
    require.resolve(dep, { paths: [fromDir] });
    return true;
  } catch (err) { void err; }
  let dir = fromDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', dep, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Do the brain-server's dependencies resolve from its folder?
 * @param {string} root plugin root
 * @returns {{ok: boolean, detail: string}}
 */
function brainServerDepsOk(root) {
  const bsDir = path.join(root, 'servers', 'brain-server');
  const pkgPath = path.join(bsDir, 'package.json');
  let deps;
  try {
    deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).dependencies || {});
  } catch (err) {
    return { ok: false, detail: `brain-server package.json ilegível: ${err.message}` };
  }
  const missing = deps.filter((dep) => !depResolvable(dep, bsDir));
  return missing.length
    ? { ok: false, detail: `brain-server deps não resolvem: ${missing.join(', ')} (rode npm install na raiz do plugin)` }
    : { ok: true, detail: `brain-server deps resolvidas (${deps.length})` };
}

/**
 * Can the brain daemon run from this root?
 * @param {string} root plugin root
 * @returns {{ok: boolean, detail: string}}
 */
function installReady(root, opts = {}) {
  const running = setupRunning(root, opts);
  if (running) return { ok: false, detail: `plugin setup still running in ${root} (pid ${running.pid}, since ${running.startedAt})` };
  if (!fs.existsSync(path.join(root, 'node_modules'))) return { ok: false, detail: `no node_modules in ${root}` };
  const deps = brainServerDepsOk(root);
  return deps.ok ? { ok: true, detail: deps.detail } : deps;
}

module.exports = { SETUP_MARK, MARK_STALE_MS, setupMarkPath, markSetup, clearSetup, setupRunning, depResolvable, brainServerDepsOk, installReady };
