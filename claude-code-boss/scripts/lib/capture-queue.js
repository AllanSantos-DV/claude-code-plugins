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

function _default() { return { rev: 0, scan: { offset: 0, anchorHash: '' }, seen: [], queue: [], offer: null, offers: 0, lastOfferTs: 0, deferred: [] }; }

function _load(project, sid) {
  try {
    const o = JSON.parse(fs.readFileSync(_file(project, sid), 'utf-8'));
    return {
      rev: o.rev || 0,
      scan: (o.scan && typeof o.scan.offset === 'number') ? o.scan : { offset: 0, anchorHash: '' },
      seen: Array.isArray(o.seen) ? o.seen : [],
      queue: Array.isArray(o.queue) ? o.queue : [],
      offer: o.offer || null,
      offers: o.offers || 0,
      lastOfferTs: o.lastOfferTs || 0,
      deferred: Array.isArray(o.deferred) ? o.deferred : [],
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
// marker; it never guesses from the transcript.
function recordAck(windowId, outcome) {
  try {
    const dir = _runtimeDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_ackFile(windowId), JSON.stringify({ outcome: outcome || 'captured', ts: Date.now() }));
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
  const windowId = crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 16);
  const expect = state.rev;
  state.offer = { windowId, ids, at: Date.now(), attempts: 1, scanAt: state.scan.offset };
  state.offers = (state.offers || 0) + 1;   // cadence bounds (per-session count)
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
 * capture_lesson(windowId) or capture_ack(windowId) tool call): drain on ack;
 * else re-block (keep the offer open so the Stop hook re-injects); after
 * `parkAfter` un-acked reconciles, PARK the cycles (kept in `deferred`, never
 * deleted) so a stuck window can't nag forever.
 * @returns {{acked:boolean, dropped:boolean, outcome?:string, retry?:number, parked?:boolean}}
 */
function reconcile(project, sid, parkAfter) {
  const state = _load(project, sid);
  if (!state.offer) return { acked: false, dropped: false };
  const wid = state.offer.windowId;
  const ackRec = readAck(wid);
  if (ackRec) {
    const ids = new Set(state.offer.ids);
    const expect = state.rev;
    state.queue = state.queue.filter(c => !ids.has(c.id));
    state.offer = null;
    state.rev = expect + 1;
    _save(project, sid, state, expect);
    clearAck(wid);
    return { acked: true, dropped: false, outcome: ackRec.outcome || 'captured' };
  }
  const park = typeof parkAfter === 'number' ? parkAfter : 6;
  if (state.offer.attempts >= park) {
    const ids = new Set(state.offer.ids);
    const expect = state.rev;
    const parked = state.queue.filter(c => ids.has(c.id));
    state.queue = state.queue.filter(c => !ids.has(c.id));
    state.deferred = (state.deferred || []).concat(parked); // kept durably — never deleted
    state.offer = null;
    state.rev = expect + 1;
    _save(project, sid, state, expect);
    return { acked: false, dropped: false, parked: true };
  }
  const expect = state.rev;
  state.offer.attempts++;
  state.rev = expect + 1;
  _save(project, sid, state, expect);
  return { acked: false, dropped: false, retry: state.offer.attempts };
}

module.exports = { ingest, getState, reset, offer, currentOfferText, ack, reconcile, recordAck, readAck, clearAck, _hash, _load, _save, _file };
