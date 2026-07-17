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
const { extractCyclesFromBuffer, packCycles } = require('./transcript-block.js');

const SEEN_CAP = 5000;

function _runtimeDir() { return path.join(dataDir(), '.runtime'); }
function _file(project, sid) {
  return path.join(_runtimeDir(), `capture-queue-${sanitizeSessionId(project)}--${sanitizeSessionId(sid)}.json`);
}

function _default() { return { rev: 0, scan: { offset: 0, anchorHash: '' }, seen: [], queue: [], offer: null, offers: 0, captured: 0, lastOfferTs: 0 }; }

function _load(project, sid) {
  try {
    const o = JSON.parse(fs.readFileSync(_file(project, sid), 'utf-8'));
    return {
      rev: o.rev || 0,
      scan: (o.scan && typeof o.scan.offset === 'number') ? o.scan : { offset: 0, anchorHash: '' },
      seen: Array.isArray(o.seen) ? o.seen : [],
      queue: Array.isArray(o.queue) ? o.queue : [],
      offer: o.offer || null,
      offers: o.offers || 0,       // review interruptions opened this session (cadence cap)
      captured: o.captured || 0,   // real captures (non-'none' acks) — evolution telemetry
      lastOfferTs: o.lastOfferTs || 0,
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

function _ackFile(windowId) {
  return path.join(_runtimeDir(), `capture-ack-${sanitizeSessionId(windowId)}.json`);
}

// Explicit ACK channel keyed by windowId (NOT by sid) so the MCP tool handler —
// running in the brain-server process — and the Stop hook (a separate process)
// coordinate purely through the filesystem. The deterministic side READS this
// marker; it never guesses from the transcript. The write is atomic (tmp+rename)
// so a concurrent reader never sees a partial marker.
function recordAck(windowId, outcome) {
  if (!windowId) return false;
  try {
    const dir = _runtimeDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const f = _ackFile(windowId);
    const tmp = `${f}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ outcome: outcome || 'captured', ts: Date.now() }));
    fs.renameSync(tmp, f);
    return true;
  } catch (err) {
    console.error(`[capture-queue] recordAck failed: ${err.message}`);
    return false;
  }
}
function readAck(windowId) {
  try { return JSON.parse(fs.readFileSync(_ackFile(windowId), 'utf-8')); } catch (err) { void err; return null; }
}
function clearAck(windowId) {
  try { fs.unlinkSync(_ackFile(windowId)); } catch (err) { void err; }
}

/**
 * Open an offer over the OLDEST queued cycles that fit maxChars (FIFO). Cycles
 * are NOT removed until ack(). Returns { windowId, text, cycles } or null.
 */
function offer(project, sid, maxChars) {
  const state = _load(project, sid);
  if (state.offer) return null;        // an offer is already open — reconcile it first
  if (state.queue.length === 0) return null;
  const { text, kept } = packCycles(state.queue, maxChars);
  if (!text || kept === 0) return null;
  const ids = state.queue.slice(0, kept).map(c => c.id);
  // Single-use RANDOM nonce — NOT derived from content. A content-hash windowId
  // would collide across sessions/projects for identical/anonymous cycles, letting
  // one session's ack marker drain another's offer. A random nonce is unique per
  // offer, so the ack marker binds to exactly this window.
  const windowId = crypto.randomBytes(12).toString('hex');
  const expect = state.rev;
  // `attempts` = reconcile retry telemetry (bumped on each un-acked reconcile).
  // `blockCount` = capture-dispatch's anti-deadlock safety-cap counter (bumped by
  // noteBlock each time step 3 RE-blocks an un-acked offer). Both live ON the offer,
  // so both RESET structurally: a fresh offer starts them here, and an ack drains the
  // offer to null — a later offer starts fresh, never a cross-offer carryover.
  state.offer = { windowId, ids, at: Date.now(), attempts: 1, blockCount: 0, scanAt: state.scan.offset };
  state.offers = (state.offers || 0) + 1;   // cadence bounds (review interruptions per session)
  state.lastOfferTs = Date.now();
  state.rev = expect + 1;
  if (!_save(project, sid, state, expect)) return null; // CAS: never emit an untracked offer
  return { windowId, text, cycles: kept };
}

/** Re-pack an already-open offer's cycles for a retry re-inject, or null. */
function currentOfferText(project, sid, maxChars) {
  const state = _load(project, sid);
  if (!state.offer) return null;
  const ids = new Set(state.offer.ids);
  const cycles = state.queue.filter(c => ids.has(c.id));
  if (cycles.length === 0) return null;
  const { text } = packCycles(cycles, maxChars);
  return text ? { windowId: state.offer.windowId, text } : null;
}

/**
 * Bump the open offer's BLOCK counter and return the new value. capture-dispatch's
 * safety valve calls this each time step 3 RE-blocks an un-acked offer; once the
 * count reaches the configured max it RELENTS (allows the Stop) to avoid a hard
 * deadlock when acking is impossible (brain-server/MCP down ⇒ capture_lesson/
 * capture_ack unavailable) or the model is stuck. The counter lives ON the offer, so
 * it RESETS structurally — a fresh offer() starts it at 0 and an ack drains the offer
 * to null (a later offer starts fresh). CAS-safe: it never emits a torn/lost write
 * (a concurrent Stop that moved `rev` is retried, mirroring offer()/reconcile()).
 * @returns {number} the new blockCount, or 0 when no offer is open.
 */
function noteBlock(project, sid) {
  for (let i = 0; i < 5; i++) {
    const state = _load(project, sid);
    if (!state.offer) return 0;
    const expect = state.rev;
    state.offer.blockCount = (state.offer.blockCount || 0) + 1;
    state.rev = expect + 1;
    if (_save(project, sid, state, expect)) return state.offer.blockCount;
    // lost the CAS to a concurrent writer — reload and retry.
  }
  const s = _load(project, sid); // best-effort: report the observed count so the caller can still relent
  return (s.offer && s.offer.blockCount) || 0;
}

/** Remove the offered window's cycles and clear the offer — only for a MATCHING windowId. */
function ack(project, sid, windowId, outcome) {
  const state = _load(project, sid);
  if (!state.offer || state.offer.windowId !== windowId) return false;
  void outcome;
  const ids = new Set(state.offer.ids);
  const expect = state.rev;
  state.queue = state.queue.filter(c => !ids.has(c.id));
  state.offer = null;
  state.rev = expect + 1;
  return _save(project, sid, state, expect);
}

/**
 * Drive the open offer via the EXPLICIT ack marker (written by the agent's
 * capture_lesson(windowId) or capture_ack(windowId) tool call):
 *   - ack present → DRAIN the offered cycles (clearing the marker ONLY after the
 *     queue commit succeeds, so a valid ack is never lost to a failed/stale write);
 *     a non-'none' outcome increments `captured` (evolution telemetry, distinct
 *     from `offers`);
 *   - no ack → keep the offer OPEN so the Stop hook re-blocks the turn. Allan's
 *     design: the turn does not proceed until the agent acks. Cycles STAY in the
 *     durable queue — a stuck/interrupted window is re-offered on the next Stop,
 *     never parked into a terminal collection, never deleted (no-loss).
 * @param {{save?:Function}} [deps] optional save seam for fault-injection tests
 * @returns {{acked:boolean, dropped:boolean, outcome?:string, retry?:number}}
 */
function reconcile(project, sid, deps) {
  const save = (deps && typeof deps.save === 'function') ? deps.save : _save;
  const state = _load(project, sid);
  if (!state.offer) return { acked: false, dropped: false };
  const wid = state.offer.windowId;
  const ackRec = readAck(wid);
  if (ackRec) {
    const ids = new Set(state.offer.ids);
    const outcome = ackRec.outcome || 'captured';
    const expect = state.rev;
    state.queue = state.queue.filter(c => !ids.has(c.id));
    state.offer = null;
    if (outcome !== 'none') state.captured = (state.captured || 0) + 1;
    state.rev = expect + 1;
    if (!save(project, sid, state, expect)) return { acked: false, dropped: false }; // commit failed → keep marker + offer for a retry
    clearAck(wid); // consume the marker only after the drain is durably committed
    return { acked: true, dropped: false, outcome };
  }
  // No ack → re-block (offer stays open, cycles stay queued). attempts is metrics-only.
  const expect = state.rev;
  state.offer.attempts = (state.offer.attempts || 1) + 1;
  state.rev = expect + 1;
  save(project, sid, state, expect);
  return { acked: false, dropped: false, retry: state.offer.attempts };
}

module.exports = { ingest, getState, reset, offer, currentOfferText, noteBlock, ack, reconcile, recordAck, readAck, clearAck, _hash, _load, _save, _file };
