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
// Per records folder: { mtimeMs, byRoot: Map<normalized root, Set<projectId>> }. The
// daemon asks envProjectIdForRoot on EVERY model MCP call; re-reading every record each
// time (123 files measured 2026-10-11) held its main thread 145–210ms per burst. Rebuilt
// only when the folder's mtime moves — records are created/replaced by rename (atomic
// write) and removed by unlink, all of which touch the folder's mtime.
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
function recordSessionRoot(sessionId, projectDir, { base, projectId } = {}) {
  const id = safeId(sessionId);
  if (!id || !projectDir) return false;
  const dir = dirOf(base);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rec = { projectDir, at: Date.now() };
    if (projectId) rec.projectId = String(projectId);
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
  const hit = _rootIndex.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.byRoot;
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] list failed: ${err.message}`);
    return null;
  }
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
  // Keyed by the mtime read BEFORE listing: a record landing mid-read moves it again.
  if (_rootIndex.size >= ROOT_INDEX_MAX && !_rootIndex.has(dir)) _rootIndex.clear();
  _rootIndex.set(dir, { mtimeMs, byRoot });
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

function _resetMemo() { _memo.clear(); _rootIndex.clear(); }

module.exports = { recordSessionRoot, sessionRecordFor, sessionRootFor, envProjectIdForRoot, forgetSessionRoot, _resetMemo };
