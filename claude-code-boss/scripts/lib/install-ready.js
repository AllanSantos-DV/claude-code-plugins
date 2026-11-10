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
 * plugin-setup marks its root while it runs and clears the mark only when it finishes; a
 * root is ready only without a mark (live, or left by an interrupted setup), with its
 * node_modules, and with the brain-server deps resolving.
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
 * A mark left by a setup that never finished (killed with its session, or npm timed out),
 * or null. Its node_modules may be half written, so the folder no longer proves anything
 * and the next setup reinstalls.
 * @returns {{pid:number, startedAt:string}|null}
 */
function setupInterrupted(root, opts = {}) {
  const m = readMark(root);
  if (!m) return null;
  return setupRunning(root, opts) ? null : m;
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
 * Do the `dependencies` of the package in `dir` resolve from that folder?
 * @param {string} dir package folder (holds package.json)
 * @param {string} label name used in the detail
 * @returns {{ok: boolean, detail: string}}
 */
function packageDepsOk(dir, label) {
  let deps;
  try {
    deps = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).dependencies || {});
  } catch (err) {
    return { ok: false, detail: `${label} package.json ilegível: ${err.message}` };
  }
  const missing = deps.filter((dep) => !depResolvable(dep, dir));
  return missing.length
    ? { ok: false, detail: `${label} deps não resolvem: ${missing.join(', ')} (rode npm install na raiz do plugin)` }
    : { ok: true, detail: `${label} deps resolvidas (${deps.length})` };
}

/**
 * Do the brain-server's dependencies resolve from its folder?
 * @param {string} root plugin root
 * @returns {{ok: boolean, detail: string}}
 */
function brainServerDepsOk(root) {
  return packageDepsOk(path.join(root, 'servers', 'brain-server'), 'brain-server');
}

/**
 * Can the brain daemon run from this root?
 * @param {string} root plugin root
 * @returns {{ok: boolean, detail: string}}
 */
function installReady(root, opts = {}) {
  const running = setupRunning(root, opts);
  if (running) return { ok: false, detail: `plugin setup still running in ${root} (pid ${running.pid}, since ${running.startedAt})` };
  const broken = setupInterrupted(root, opts);
  if (broken) return { ok: false, detail: `plugin setup in ${root} did not finish (pid ${broken.pid}, since ${broken.startedAt}); the next setup reinstalls` };
  if (!fs.existsSync(path.join(root, 'node_modules'))) return { ok: false, detail: `no node_modules in ${root}` };
  const deps = brainServerDepsOk(root);
  return deps.ok ? { ok: true, detail: deps.detail } : deps;
}

module.exports = { SETUP_MARK, MARK_STALE_MS, setupMarkPath, markSetup, clearSetup, setupRunning, setupInterrupted, depResolvable, packageDepsOk, brainServerDepsOk, installReady };
