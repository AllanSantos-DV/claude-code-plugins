'use strict';
/**
 * node-support.js — which Node runs the plugin, and with which flags.
 *
 * Tested range: Node 22.13 (first with node:sqlite) up to the 24 LTS line. Node 25 aborted
 * the Brain daemon with 0xC0000409 under parallel HTTPS calls on a second machine, and the
 * crashes stopped on Node 24 LTS — so a newer major is reported as a failure, not a nicety.
 * The daemon inherits NODE_OPTIONS from whichever hook spawns it; a JIT flag left there as a
 * workaround (--no-maglev was) keeps running in a configuration nobody tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MIN_NODE = [22, 13, 0];
const MAX_TESTED_MAJOR = 24;
const NODE_LTS_URL = 'https://nodejs.org/en/download';
const RANGE_TEXT = `${MIN_NODE[0]}.${MIN_NODE[1]} – ${MAX_TESTED_MAJOR}.x`;

/** @returns {{ok:boolean, version:string, reason:null|'old'|'new'|'unknown'}} */
function nodeSupport(version = process.version) {
  const raw = String(version || '').replace(/^v/, '');
  const p = raw.split('.').map((n) => parseInt(n, 10));
  if (p.length < 2 || p.some((n) => !Number.isInteger(n))) return { ok: false, version: raw, reason: 'unknown' };
  for (let i = 0; i < 3; i++) {
    if ((p[i] || 0) === MIN_NODE[i]) continue;
    if ((p[i] || 0) < MIN_NODE[i]) return { ok: false, version: raw, reason: 'old' };
    break;
  }
  if (p[0] > MAX_TESTED_MAJOR) return { ok: false, version: raw, reason: 'new' };
  return { ok: true, version: raw, reason: null };
}

/** One sentence on what is wrong and what to install; '' when the version is supported. */
function supportAdvice(s) {
  if (s.ok) return '';
  if (s.reason === 'new') {
    return `Node v${s.version} is newer than the tested range (${RANGE_TEXT}); Node 25 aborted the Brain daemon (0xC0000409) under parallel HTTPS calls. ` +
      `Install Node ${MAX_TESTED_MAJOR} LTS (${NODE_LTS_URL}), make it the \`node\` on PATH and restart Claude Code.`;
  }
  return `Node v${s.version || '?'} is older than ${MIN_NODE.join('.')} (node:sqlite). Install Node ${MAX_TESTED_MAJOR} LTS (${NODE_LTS_URL}) and restart Claude Code.`;
}

/** NODE_OPTIONS as a flag list (plain whitespace split: Node itself rejects most quoting). */
function parseNodeOptions(s) {
  return String(s || '').split(/\s+/).filter(Boolean);
}

// The only flags the supervisor itself passes (crash-evidence.reportFlags).
const OWN_FLAGS = ['--report-on-fatalerror', '--report-uncaught-exception', '--report-directory'];
const flagName = (f) => String(f).split('=')[0];

/** Flags the daemon gets that the plugin did not choose. */
function foreignFlags(flags) {
  return (flags || []).filter((f) => !OWN_FLAGS.includes(flagName(f)));
}

/** Own flags a running daemon lacks (it was started by an older version). */
function missingOwnFlags(execArgv) {
  const names = new Set((execArgv || []).map(flagName));
  return OWN_FLAGS.filter((f) => !names.has(f));
}

// ── A supported Node for the long-running processes ──────────────────────────
// When the default `node` is outside the range (Node 25 as the system default), the
// supervisor runs the daemon on another Node 22/24 already installed. Nothing in the
// user's configuration (PATH, version manager default) is touched.

function hiddenSpawnSync(cmd, args, opts) { return spawnSync(cmd, args, { ...opts, windowsHide: true }); }

function listDirSafe(dir) {
  try { return fs.readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.error(`[node-support] cannot list ${dir}: ${err.message}`);
    return [];
  }
}

/** Every place a Node binary is usually installed, the PATH first. Paths are not checked for existence. */
function nodeCandidates({ env = process.env, platform = process.platform, homedir = os.homedir(), listDir = listDirSafe } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exe = win ? 'node.exe' : 'node';
  const out = [];
  const add = (dir) => { if (dir) out.push(p.join(dir, exe)); };
  const versions = (dir, sub = '') => listDir(dir).filter((n) => /^v?\d+\./.test(n) || /^v\d+$/.test(n)).forEach((n) => add(sub ? p.join(dir, n, sub) : p.join(dir, n)));
  String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean).forEach(add);
  if (win) {
    add(p.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
    if (env.NVM_HOME) versions(env.NVM_HOME);
    if (env.LOCALAPPDATA) versions(p.join(env.LOCALAPPDATA, 'Volta', 'tools', 'image', 'node'));
    const fnm = env.FNM_DIR || (env.APPDATA && p.join(env.APPDATA, 'fnm'));
    if (fnm) versions(p.join(fnm, 'node-versions'), 'installation');
  } else {
    versions(p.join(env.NVM_DIR || p.join(homedir, '.nvm'), 'versions', 'node'), 'bin');
    versions(p.join(env.VOLTA_HOME || p.join(homedir, '.volta'), 'tools', 'image', 'node'), 'bin');
    const fnm = env.FNM_DIR || p.join(homedir, platform === 'darwin' ? p.join('Library', 'Application Support', 'fnm') : p.join('.local', 'share', 'fnm'));
    versions(p.join(fnm, 'node-versions'), p.join('installation', 'bin'));
    for (const v of ['24', '22']) { add(`/opt/homebrew/opt/node@${v}/bin`); add(`/usr/local/opt/node@${v}/bin`); }
    add('/usr/local/bin'); add('/usr/bin');
  }
  const seen = new Set();
  return out.filter((f) => { const k = win ? f.toLowerCase() : f; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** `node --version` of a binary, hidden and bounded. */
function probeNodeVersion(file, run = hiddenSpawnSync) {
  const r = run(file, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return { version: null, error: r.error ? r.error.message : `exit ${r.status}` };
  return { version: String(r.stdout || '').trim(), error: null };
}

const versionKey = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = versionKey(a); const y = versionKey(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

/**
 * The Node the daemon should run on. The current one when supported; else the newest supported
 * binary among the candidates; else the current one with `unsupported` (the doctor keeps warning).
 * @returns {{execPath:string, version:string, switched:boolean, from?:string, unsupported?:boolean, tried?:Array}}
 */
function pickSupportedNode({
  current = { execPath: process.execPath, version: process.version },
  candidates = null,
  versionOf = probeNodeVersion,
  exists = fs.existsSync,
} = {}) {
  const cur = { execPath: current.execPath, version: String(current.version).replace(/^v/, '') };
  if (nodeSupport(cur.version).ok) return { ...cur, switched: false };
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const tried = [];
  let best = null;
  for (const file of candidates || nodeCandidates()) {
    if (same(file, cur.execPath) || !exists(file)) continue;
    const { version, error } = versionOf(file);
    tried.push({ file, version, error });
    if (!version || !nodeSupport(version).ok) continue;
    if (!best || newer(version, best.version)) best = { execPath: file, version: version.replace(/^v/, '') };
  }
  if (best) return { ...best, switched: true, from: cur.version, tried };
  return { ...cur, switched: false, unsupported: true, tried };
}

module.exports = {
  MIN_NODE, MAX_TESTED_MAJOR, NODE_LTS_URL, RANGE_TEXT, OWN_FLAGS, nodeSupport, supportAdvice, parseNodeOptions, foreignFlags, missingOwnFlags,
  nodeCandidates, probeNodeVersion, pickSupportedNode,
};
