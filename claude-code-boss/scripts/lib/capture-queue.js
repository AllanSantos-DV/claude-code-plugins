'use strict';
/**
 * capture-queue.js — Phase 1.5 durable, redacted cleaned-cycle queue.
 *
 * Separates the deterministic TRANSCRIPT SCAN (a byte cursor advanced as cycles
 * are extracted) from CAPTURE PROGRESS (cycles leave the queue only once the
 * agent acknowledges — see the offer/ack layer). Cleaned cycles are REDACTED at
 * rest and addressed by content-hash, so:
 *   - in-band compaction (transcript rewritten shorter) triggers a rebase re-scan
 *     from 0 WITHOUT duplicating already-queued cycles (seen-set dedup);
 *   - a cycle summarized away before it was ever queued is simply gone (inherent),
 *     but nothing already queued is lost.
 *
 * Persistence is a single atomic (tmp+rename) JSON file with a `rev` counter that
 * the 1.5c CAS layer uses to reject stale writes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeSessionId } = require('./session-id.js');
const { dataDir } = require('./data-dir.js');
const { anchorAt, validateAnchor, _boundaryAtOrBefore } = require('./session-marker.js');
const { extractCyclesFromBuffer } = require('./transcript-block.js');

const SEEN_CAP = 5000;

function _runtimeDir() { return path.join(dataDir(), '.runtime'); }
function _file(project, sid) {
  return path.join(_runtimeDir(), `capture-queue-${sanitizeSessionId(project)}--${sanitizeSessionId(sid)}.json`);
}

function _default() { return { rev: 0, scan: { offset: 0, anchorHash: '' }, seen: [], queue: [], offer: null }; }

function _load(project, sid) {
  try {
    const o = JSON.parse(fs.readFileSync(_file(project, sid), 'utf-8'));
    return {
      rev: o.rev || 0,
      scan: (o.scan && typeof o.scan.offset === 'number') ? o.scan : { offset: 0, anchorHash: '' },
      seen: Array.isArray(o.seen) ? o.seen : [],
      queue: Array.isArray(o.queue) ? o.queue : [],
      offer: o.offer || null,
    };
  } catch (err) { void err; return _default(); }
}

// Atomic write. Returns true on success. When `expectRev` is given, the write is
// a compare-and-swap: it is refused if the on-disk rev has moved (1.5c).
function _save(project, sid, state, expectRev) {
  const dir = _runtimeDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (typeof expectRev === 'number') {
      const current = _load(project, sid).rev;
      if (current !== expectRev) return false; // stale — caller retries
    }
    const f = _file(project, sid);
    const tmp = `${f}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, f);
    return true;
  } catch (err) {
    console.error(`[capture-queue] save failed: ${err.message}`);
    return false;
  }
}

function _readBuf(transcriptPath, from, to) {
  const len = Math.max(0, to - from);
  if (len === 0) return Buffer.alloc(0);
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      return n === len ? buf : buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  } catch (err) { void err; return Buffer.alloc(0); }
}

function _hash(promptId, user, assistant) {
  return crypto.createHash('sha256').update(`${promptId}\u0000${user}\u0000${assistant}`).digest('hex').slice(0, 20);
}

/**
 * Scan the transcript from the durable cursor, extract new human cycles, REDACT
 * them, and append the ones not already seen (by content-hash) to the queue.
 * Compaction-safe: an invalid cursor rebases to a full re-scan that dedups.
 * @returns {{added:number, queueLen:number}}
 */
function ingest(project, sid, transcriptPath, redactFn) {
  const redact = typeof redactFn === 'function' ? redactFn : (s => s);
  const state = _load(project, sid);
  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch (err) { void err; return { added: 0, queueLen: state.queue.length }; }

  const committed = { offset: state.scan.offset, anchorHash: state.scan.anchorHash, size };
  const v = validateAnchor(transcriptPath, committed);
  const from = (state.scan.offset > 0 && v.ok) ? state.scan.offset : 0; // mismatch → rebase re-scan
  const boundary = _boundaryAtOrBefore(transcriptPath, size);
  if (!(boundary > from)) {
    if (from === 0 && state.scan.offset !== 0) {
      state.scan = { offset: 0, anchorHash: anchorAt(transcriptPath, 0) };
      state.rev = (state.rev || 0) + 1;
      _save(project, sid, state);
    }
    return { added: 0, queueLen: state.queue.length };
  }

  const buf = _readBuf(transcriptPath, from, boundary);
  const cycles = extractCyclesFromBuffer(buf, from);
  const seenSet = new Set(state.seen);
  let added = 0;
  for (const c of cycles) {
    const user = redact(c.user || '');
    const assistant = redact(c.assistant || '');
    const id = _hash(c.promptId, user, assistant);
    if (seenSet.has(id)) continue; // already queued/captured — compaction-safe dedup
    seenSet.add(id);
    state.seen.push(id);
    state.queue.push({ id, promptId: c.promptId, user, assistant });
    added++;
  }
  if (state.seen.length > SEEN_CAP) state.seen = state.seen.slice(-SEEN_CAP);
  state.scan = { offset: boundary, anchorHash: anchorAt(transcriptPath, boundary) };
  state.rev = (state.rev || 0) + 1;
  _save(project, sid, state);
  return { added, queueLen: state.queue.length };
}

function getState(project, sid) { return _load(project, sid); }
function reset(project, sid) { try { fs.unlinkSync(_file(project, sid)); } catch (err) { void err; } }

module.exports = { ingest, getState, reset, _hash, _load, _save, _file };
