'use strict';
/**
 * session-marker.js — capture-window cursor state machine (Phase 1, task 1).
 *
 * Tracks, per (project, sessionId), how far the lesson-capture pipeline has
 * consumed the Claude Code transcript JSONL:
 *   - committed: {offset, anchorHash, size} — byte offset at a COMPLETE-line
 *     boundary up to which turns are already captured. The uncaptured window is
 *     [committed.offset, currentEnd). anchorHash (hash of the last complete line
 *     at the boundary) detects that the file was truncated/rewritten (in-band
 *     compaction) instead of appended-to, so we never silently re-curate
 *     everything nor skip everything — the caller quarantines/recovers instead.
 *   - pending: {from, to, windowHash} | null — a window handed to the agent for
 *     capture but not yet reconciled. committed does NOT move while pending; it
 *     advances only on commit() (after the agent captures OR marks "no lesson").
 *
 * Why byte-offset + anchor (not uuid/timestamp/line-count): a real transcript
 * had a DUPLICATE assistant uuid, timestamps are not unique, and line-count
 * cannot detect truncation/replacement.
 *
 * DURABILITY: append-only transition log (one file per transition, like
 * turn-journal.js) so concurrent Stops never lose an update via read-modify-write.
 * A monotonic per-process sequence makes the fold order deterministic.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeSessionId } = require('./session-id.js');
const { dataDir } = require('./data-dir.js');

const SEP = '--';
let _seq = 0; // monotonic within a process; breaks same-ms ties deterministically

function _runtimeDir() {
  return path.join(dataDir(), '.runtime');
}

function _key(project, sid) {
  return `capture-marker-${sanitizeSessionId(project)}${SEP}${sanitizeSessionId(sid)}`;
}

function _appendTransition(project, sid, obj) {
  try {
    const dir = _runtimeDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const seq = String(_seq++).padStart(9, '0');
    const rand = crypto.randomBytes(4).toString('hex');
    const file = path.join(
      dir,
      `${_key(project, sid)}${SEP}${String(ts).padStart(15, '0')}-${seq}-${rand}.json`,
    );
    fs.writeFileSync(file, JSON.stringify({ ts, ...obj }));
  } catch (err) {
    console.error(`[session-marker] append failed: ${err.message}`);
  }
}

function _readTransitions(project, sid) {
  const dir = _runtimeDir();
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    const prefix = `${_key(project, sid)}${SEP}`;
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort(); // fixed-width ts-seq → lexical == chronological
    for (const f of files) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
      } catch (err) {
        console.error(`[session-marker] read ${f}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[session-marker] dir read: ${err.message}`);
  }
  return out;
}

/** Fold the transition log into the current {committed, pending} state. */
function getState(project, sid) {
  const state = { committed: null, pending: null };
  for (const t of _readTransitions(project, sid)) {
    switch (t.type) {
      case 'init':
      case 'commit':
        state.committed = { offset: t.offset, anchorHash: t.anchorHash || '', size: t.size };
        state.pending = null; // a commit reconciles the window it captured
        break;
      case 'pending':
        state.pending = { from: t.from, to: t.to, windowHash: t.windowHash };
        break;
      case 'clear':
        state.pending = null;
        break;
      default:
        break;
    }
  }
  return state;
}

/** Byte offset just after the last '\n' at or before `upTo` (a complete-line boundary). */
function _boundaryAtOrBefore(transcriptPath, upTo) {
  if (upTo <= 0) return 0;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const start = Math.max(0, upTo - 65536);
      const len = upTo - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const lastNl = buf.lastIndexOf(0x0a);
      return lastNl === -1 ? 0 : start + lastNl + 1;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    void err; // unreadable transcript → no safe boundary yet
    return 0;
  }
}

/**
 * Hash of the last COMPLETE line ending at `offset` (offset is a line boundary).
 * Cheap (bounded read) and changes if the file at that position is rewritten.
 */
function anchorAt(transcriptPath, offset) {
  if (offset <= 0) return crypto.createHash('sha256').update('').digest('hex').slice(0, 16);
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const start = Math.max(0, offset - 8192);
      const len = offset - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const trimmed = buf[len - 1] === 0x0a ? buf.slice(0, len - 1) : buf; // drop trailing '\n'
      const prevNl = trimmed.lastIndexOf(0x0a);
      const line = prevNl === -1 ? trimmed : trimmed.slice(prevNl + 1);
      return crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    void err; // unreadable → empty anchor (validateAnchor will flag mismatch)
    return '';
  }
}

/**
 * Confirm the committed cursor still points into the SAME file content.
 * @returns {{ok:boolean, reason:string}} reason ∈ '' | no-committed | missing | truncated | anchor-mismatch
 */
function validateAnchor(transcriptPath, committed) {
  if (!committed) return { ok: false, reason: 'no-committed' };
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (err) {
    void err;
    return { ok: false, reason: 'missing' };
  }
  if (size < committed.offset) return { ok: false, reason: 'truncated' };
  const cur = anchorAt(transcriptPath, committed.offset);
  if (committed.anchorHash && cur !== committed.anchorHash) {
    return { ok: false, reason: 'anchor-mismatch' };
  }
  return { ok: true, reason: '' };
}

/**
 * Set the committed baseline at the transcript's current end (last complete
 * line) IF no marker exists yet. Idempotent: never moves an existing cursor.
 */
function initIfAbsent(project, sid, transcriptPath) {
  const st = getState(project, sid);
  if (st.committed) return st;
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (err) {
    void err; // transcript may not exist yet at SessionStart
    size = 0;
  }
  const offset = _boundaryAtOrBefore(transcriptPath, size);
  _appendTransition(project, sid, { type: 'init', offset, anchorHash: anchorAt(transcriptPath, offset), size });
  return getState(project, sid);
}

/** Open a capture window [from,to). committed stays put until commit(). */
function beginPending(project, sid, from, to, windowHash) {
  _appendTransition(project, sid, { type: 'pending', from, to, windowHash });
  return getState(project, sid);
}

/** Advance committed to `to` and clear pending — after capture OR "no lesson" ack. */
function commit(project, sid, to, anchorHash, size) {
  _appendTransition(project, sid, { type: 'commit', offset: to, anchorHash, size });
  return getState(project, sid);
}

/** Abort the pending window without moving committed (agent failed → retry next window). */
function clearPending(project, sid) {
  _appendTransition(project, sid, { type: 'clear' });
  return getState(project, sid);
}

/** Remove all transition files for (project, sid). For tests / hard reset. */
function resetAll(project, sid) {
  const dir = _runtimeDir();
  try {
    if (!fs.existsSync(dir)) return;
    const prefix = `${_key(project, sid)}${SEP}`;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(dir, f)); }
        catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error(`[session-marker] resetAll: ${err.message}`);
  }
}

module.exports = {
  getState,
  initIfAbsent,
  beginPending,
  commit,
  clearPending,
  anchorAt,
  validateAnchor,
  resetAll,
  _boundaryAtOrBefore,
};
