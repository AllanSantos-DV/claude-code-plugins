'use strict';
/**
 * lib/session-root.js — the calling session's project root for hooks served by the
 * daemon (`mcp_tool` transport).
 *
 * Claude Code interpolates `${path}` in an mcp_tool hook's input from the HOOK INPUT
 * JSON only (2.1.283: "String values support ${path} interpolation from the hook input
 * JSON") — `${CLAUDE_PROJECT_DIR}` is an env var, not an input field, so hooks.json's
 * `project_dir` always arrived as "" (proven with a probe in a real session). The hook
 * input's `cwd` is the shell's CURRENT directory and drifts with `cd`.
 *
 * SessionStart runs as a `command` hook, where CLAUDE_PROJECT_DIR IS set: it records
 * session_id → root here; the daemon reads it back by session_id. Files live under the
 * plugin data dir (shared by the command hook and the daemon); SessionEnd removes the
 * ended session's file (session-end.js), and files older than 7 days are pruned (sessions
 * that died without a SessionEnd).
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const TTL_MS = 7 * 86400_000;
const MEMO_MAX = 256;
const _memo = new Map();
// Per records folder: { sig, byRoot: Map<normalized root, Set<projectId>> }. The daemon
// asks envProjectIdForRoot on EVERY model MCP call; re-reading every record each time (123
// files measured 2026-10-11) held its main thread 145–210ms per burst. Rebuilt only when
// the folder's mtime or its file names change: under load a record created right after a
// rebuild can leave the folder's mtime unchanged, and the new name still forces the rebuild.
const _rootIndex = new Map();
const ROOT_INDEX_MAX = 16;

// No id → '' (the callers treat it as "nothing to record"), else the shared sanitizer.
const safeId = (sid) => (sid ? require('../../engine/lib/session-id.js').sanitizeSessionId(sid) : '');
const dirOf = (base) => path.join(base || dataDir(), '.runtime', 'session-roots');

/**
 * Record the root of `sessionId` (SessionStart, command hook) and the session's
 * CCB_PROJECT_ID, if set — the daemon strips that variable from its own env, so the
 * documented override reached nothing it serves. Returns true when written.
 */
function recordSessionRoot(sessionId, projectDir, { base, projectId, pluginRoot } = {}) {
  const id = safeId(sessionId);
  if (!id || !projectDir) return false;
  const dir = dirOf(base);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rec = { projectDir, at: Date.now() };
    if (projectId) rec.projectId = String(projectId);
    // The plugin dir this session loaded its hooks from: the cache prune must not delete it
    // while the session lives (its command hooks run from there).
    if (pluginRoot && !String(pluginRoot).includes('${')) rec.pluginRoot = String(pluginRoot);
    // Rename, not an in-place write: rewriting a session's record must move the folder's
    // mtime, or the root index above would keep its old projectId.
    writeJsonAtomic(path.join(dir, `${id}.json`), rec);
    _memo.delete(`${base || ''}|${id}`);
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch (err) { void err; /* raced with another prune */ }
    }
    return true;
  } catch (err) {
    console.error(`[session-root] record failed (${dir}): ${err.message}`);
    return false;
  }
}

/** { projectDir, projectId } recorded for `sessionId` ('' when unknown — session started before this build). */
function sessionRecordFor(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return { projectDir: '', projectId: '' };
  const key = `${base || ''}|${id}`;
  if (_memo.has(key)) return _memo.get(key);
  let rec = { projectDir: '', projectId: '' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(base), `${id}.json`), 'utf8'));
    rec = { projectDir: String(j.projectDir || ''), projectId: String(j.projectId || '') };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] read failed for ${id}: ${err.message}`);
  }
  if (rec.projectDir) { // only hits are memoized: a session recorded later must still be found
    if (_memo.size >= MEMO_MAX) _memo.delete(_memo.keys().next().value);
    _memo.set(key, rec);
  }
  return rec;
}

/** Root recorded for `sessionId`, or '' when unknown. */
function sessionRootFor(sessionId, opts) { return sessionRecordFor(sessionId, opts).projectDir; }

/**
 * The CCB_PROJECT_ID of the sessions rooted at `root`, for calls that carry no
 * session_id (the model's MCP tool calls). Adopted only when EVERY recorded session
 * of that folder declared the same id — a session there without the override (or
 * with another) must never inherit it. '' otherwise.
 */
function envProjectIdForRoot(root, { base } = {}) {
  if (!root) return '';
  const byRoot = rootIndexOf(dirOf(base));
  const ids = byRoot && byRoot.get(normRoot(root));
  return ids && ids.size === 1 ? [...ids][0] : '';
}

const normRoot = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };

/** Root → declared ids of every record in `dir`, re-read only when the folder changed; null when unreadable. */
function rootIndexOf(dir) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(dir).mtimeMs; } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] stat failed: ${err.message}`);
    return null;
  }
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] list failed: ${err.message}`);
    return null;
  }
  const sig = `${mtimeMs}|${names.slice().sort().join('|')}`;
  const hit = _rootIndex.get(dir);
  if (hit && hit.sig === sig) return hit.byRoot;
  const byRoot = new Map();
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.projectDir) continue;
      const k = normRoot(j.projectDir);
      if (!byRoot.has(k)) byRoot.set(k, new Set());
      byRoot.get(k).add(String(j.projectId || ''));
    } catch (err) { void err; /* raced with a write/prune: skip that record */ }
  }
  // Keyed by the mtime and names read BEFORE parsing: a record landing mid-read changes them again.
  if (_rootIndex.size >= ROOT_INDEX_MAX && !_rootIndex.has(dir)) _rootIndex.clear();
  _rootIndex.set(dir, { sig, byRoot });
  return byRoot;
}

/** Remove the record of an ended session (SessionEnd). Returns true when a record was removed. */
function forgetSessionRoot(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return false;
  _memo.delete(`${base || ''}|${id}`);
  try {
    fs.unlinkSync(path.join(dirOf(base), `${id}.json`));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] forget failed for ${id}: ${err.message}`);
    return false;
  }
}

// Margin for the uptime clock's resolution: a record touched right at boot still counts.
const BOOT_SLACK_MS = 60_000;

/**
 * Plugin dirs the live sessions run their hooks from: records not past the TTL and touched
 * since the machine booted (no session survives a reboot; a resumed one records itself again
 * at SessionStart). The cache prune keeps them: deleting one leaves that open session without
 * its command hooks.
 * @param {{base?:string, bootMs?:number}} [o] bootMs: boot time, defaults to now - os.uptime()
 */
function livePluginRoots({ base, bootMs } = {}) {
  const dir = dirOf(base);
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] list failed: ${err.message}`);
    return [];
  }
  const now = Date.now();
  const boot = Number.isFinite(bootMs) ? bootMs : now - require('os').uptime() * 1000;
  const roots = new Set();
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    try {
      const { mtimeMs } = fs.statSync(p);
      if (now - mtimeMs > TTL_MS || mtimeMs < boot - BOOT_SLACK_MS) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.pluginRoot) roots.add(String(j.pluginRoot));
    } catch (err) { void err; /* raced with a write/prune: skip that record */ }
  }
  return [...roots];
}

/**
 * A live session whose plugin dir was removed (an update that pruned with older code, a manual
 * cleanup) can no longer run its `headersHelper` or command hooks: the brain-server link then
 * connects without the token, gets a 401 and Claude Code gives up. Recreate each missing dir of
 * a live record as a junction to the current install — same files, nothing copied. Only dirs
 * directly under `cacheBase` are touched, and only with a verified current install.
 * @param {{base?:string, cacheBase:string, current:string|null}} o
 * @returns {{healed:string[], failed:{dir:string, error:string}[]}}
 */
function healMissingPluginRoots({ base, cacheBase, current } = {}) {
  const out = { healed: [], failed: [] };
  if (!current || !cacheBase || !fs.existsSync(path.join(current, 'package.json'))) return out;
  for (const root of livePluginRoots({ base })) {
    if (normRoot(path.dirname(root)) !== normRoot(cacheBase) || normRoot(root) === normRoot(current)) continue;
    if (fs.existsSync(root)) continue;
    try {
      try { fs.lstatSync(root); fs.unlinkSync(root); } catch (err) { if (err.code !== 'ENOENT') throw err; } // a dangling link from an earlier heal
      fs.symlinkSync(current, root, 'junction');
      out.healed.push(root);
      console.error(`[session-root] restored the plugin dir of an open session: ${root} -> ${current}`);
    } catch (err) {
      out.failed.push({ dir: root, error: err.message });
      console.error(`[session-root] could not restore ${root}: ${err.message}`);
    }
  }
  return out;
}

/** A live session says so on each prompt: moves its record's mtime so the TTL measures idleness, not age. */
function touchSessionRecord(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return false;
  try {
    const now = new Date();
    fs.utimesSync(path.join(dirOf(base), `${id}.json`), now, now);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] touch failed for ${id}: ${err.message}`);
    return false;
  }
}

function _resetMemo() { _memo.clear(); _rootIndex.clear(); }

module.exports = { recordSessionRoot, sessionRecordFor, sessionRootFor, envProjectIdForRoot, forgetSessionRoot, livePluginRoots, healMissingPluginRoots, touchSessionRecord, _resetMemo };
