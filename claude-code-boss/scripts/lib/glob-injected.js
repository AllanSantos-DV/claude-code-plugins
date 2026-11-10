'use strict';
/**
 * lib/glob-injected.js — which glob policies (and other once-per-context notices, such as the
 * shell-escape rewrite explanation) were already surfaced in a session, so each one is injected
 * once per session instead of on every match. Per session_id under
 * `<data>/.runtime/policy-glob-injected/`; a compaction or /clear wipes the context that
 * held them, so SessionStart with that source resets the record, and SessionEnd removes it.
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const TTL_MS = 7 * 86400_000;

const safeId = (sid) => (sid ? require('../../engine/lib/session-id.js').sanitizeSessionId(sid) : '');
const dirOf = (base) => path.join(base || dataDir(), '.runtime', 'policy-glob-injected');

/** @returns {string[]} policy ids already injected in `sessionId` (empty when unknown). */
function injectedIds(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(base), `${id}.json`), 'utf8'));
    return Array.isArray(j.ids) ? j.ids.map(String) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[glob-injected] read failed for ${id}: ${err.message}`);
    return [];
  }
}

/**
 * Keep the matches not yet injected in this session and record them as injected.
 * Without a session id there is nothing to key on, so every match passes.
 * @param {string} sessionId
 * @param {Array<{id:string}>} matches
 * @returns {Array<{id:string}>}
 */
function takeFresh(sessionId, matches, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return matches;
  const seen = new Set(injectedIds(sessionId, { base }));
  const fresh = matches.filter((m) => !seen.has(String(m.id)));
  if (!fresh.length) return fresh;
  const dir = dirOf(base);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, `${id}.json`), { ids: [...seen, ...fresh.map((m) => String(m.id))], at: Date.now() });
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch (err) { void err; /* raced with another prune */ }
    }
  } catch (err) {
    console.error(`[glob-injected] record failed (${dir}): ${err.message}`);
  }
  return fresh;
}

/** Forget what `sessionId` already saw (compact, clear, session end). Returns true when a record was removed. */
function reset(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return false;
  try {
    fs.unlinkSync(path.join(dirOf(base), `${id}.json`));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[glob-injected] reset failed for ${id}: ${err.message}`);
    return false;
  }
}

module.exports = { injectedIds, takeFresh, reset };
