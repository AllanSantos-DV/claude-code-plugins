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
 * plugin data dir (shared by the command hook and the daemon), pruned after 7 days.
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./data-dir.js');

const TTL_MS = 7 * 86400_000;
const MEMO_MAX = 256;
const _memo = new Map();

const safeId = (sid) => String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const dirOf = (base) => path.join(base || dataDir(), '.runtime', 'session-roots');

/** Record the root of `sessionId` (SessionStart, command hook). Returns true when written. */
function recordSessionRoot(sessionId, projectDir, { base } = {}) {
  const id = safeId(sessionId);
  if (!id || !projectDir) return false;
  const dir = dirOf(base);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ projectDir, at: Date.now() }));
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

/** Root recorded for `sessionId`, or '' when unknown (session started before this build). */
function sessionRootFor(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return '';
  const key = `${base || ''}|${id}`;
  if (_memo.has(key)) return _memo.get(key);
  let root = '';
  try {
    root = String(JSON.parse(fs.readFileSync(path.join(dirOf(base), `${id}.json`), 'utf8')).projectDir || '');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[session-root] read failed for ${id}: ${err.message}`);
  }
  if (root) { // only hits are memoized: a session recorded later must still be found
    if (_memo.size >= MEMO_MAX) _memo.delete(_memo.keys().next().value);
    _memo.set(key, root);
  }
  return root;
}

function _resetMemo() { _memo.clear(); }

module.exports = { recordSessionRoot, sessionRootFor, _resetMemo };
