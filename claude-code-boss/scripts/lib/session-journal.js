'use strict';
/**
 * session-journal.js — append-only per-session journal: one JSON file per entry
 * under `${dataDir}/.runtime/<prefix>-<sid>--<ts>-…json`. Race-free (an append
 * never reads or rewrites another file) — the shared body of the turn, failure,
 * retrieval and verify journals.
 *
 * The `--` between sid and timestamp avoids prefix collisions (sid "foo" would
 * otherwise match files of sid "foobar"). Lexical sort = timestamp order
 * (fixed-width ms timestamps).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sanitizeSessionId } = require('./session-id.js');
const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const SEP = '--';
const DAY_MS = 86400000;
// `<prefix>-<sid>--<13-digit ms ts>-…json`: the age is in the name, so a sweep never needs a stat per file.
const STAMPED = /--(\d{13})-[^\\/]*\.json$/;

/**
 * Delete every journal entry, of any journal and any session, older than `maxAgeMs`.
 * A journal describes "this turn": whatever a session left behind (a detector gated off by the profile never
 * drains its journal) is dead weight, and every read lists the whole directory. Stops after `budgetMs`, so a
 * backlog is drained over a few sessions without stalling the one that found it.
 * @returns {{scanned:number, removed:number, failed:number, truncated:boolean}}
 */
function sweepStaleJournals({ dir = path.join(dataDir(), '.runtime'), maxAgeMs = DAY_MS, budgetMs = 1200, now = Date.now } = {}) {
  const out = { scanned: 0, removed: 0, failed: 0, truncated: false };
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  const t0 = now();
  const cutoff = t0 - maxAgeMs;
  for (const f of names) {
    const m = STAMPED.exec(f);
    if (!m) continue;
    out.scanned++;
    if (Number(m[1]) >= cutoff) continue;
    if (now() - t0 > budgetMs) { out.truncated = true; break; }
    try { fs.unlinkSync(path.join(dir, f)); out.removed++; } catch (err) {
      if (err.code !== 'ENOENT') out.failed++; // another session swept it first: not a failure
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.prefix    file prefix, e.g. 'failure-turn'
 * @param {string} o.label     log tag, e.g. 'failure-journal'
 * @param {boolean} [o.seqNames]  add a per-process monotonic counter to the name, so
 *   same-millisecond appends keep their order (<ts>-<seq6>-<rand>)
 * @param {boolean} [o.stampTs]   store `{ ts, ...entry }` instead of the entry as given
 */
function createJournal({ prefix, label, seqNames = false, stampTs = false }) {
  const RUNTIME_DIR = path.join(dataDir(), '.runtime');
  let seq = 0;
  const prefixOf = (sessionId) => `${prefix}-${sanitizeSessionId(sessionId)}${SEP}`;
  const filesOf = (sessionId) => {
    const p = prefixOf(sessionId);
    return fs.readdirSync(RUNTIME_DIR).filter((f) => f.startsWith(p) && f.endsWith('.json')).sort();
  };

  function appendEntry(sessionId, entry) {
    try {
      const ts = Date.now();
      const name = seqNames
        ? `${ts}-${String(seq++ % 1000000).padStart(6, '0')}-${crypto.randomBytes(3).toString('hex')}`
        : `${ts}-${crypto.randomBytes(4).toString('hex')}`;
      writeJsonAtomic(path.join(RUNTIME_DIR, `${prefixOf(sessionId)}${name}.json`), stampTs ? { ts, ...entry } : entry);
    } catch (err) {
      console.error(`[${label}] append failed: ${err.message}`);
    }
  }

  /** Every entry of the session, oldest first (no cap). */
  function readAll(sessionId) {
    const entries = [];
    try {
      if (!fs.existsSync(RUNTIME_DIR)) return entries;
      for (const f of filesOf(sessionId)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf-8'));
          if (data && typeof data === 'object') entries.push(data);
        } catch (err) {
          console.error(`[${label}] entry read failed (${f}): ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[${label}] dir read failed: ${err.message}`);
    }
    return entries;
  }

  /** The newest `maxEntries` entries, oldest first. */
  function readEntries(sessionId, maxEntries = 200) {
    const entries = readAll(sessionId);
    return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
  }

  function clearEntries(sessionId) {
    try {
      if (!fs.existsSync(RUNTIME_DIR)) return;
      for (const f of filesOf(sessionId)) {
        try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); } catch { /* best effort */ }
      }
    } catch (err) {
      console.error(`[${label}] clear failed: ${err.message}`);
    }
  }

  /** Delete this journal's files of ANY session older than `maxAgeMs`. Returns the count. */
  function sweepOld(maxAgeMs) {
    try {
      if (!fs.existsSync(RUNTIME_DIR)) return 0;
      const cutoff = Date.now() - maxAgeMs;
      let n = 0;
      for (const f of fs.readdirSync(RUNTIME_DIR)) {
        if (!f.startsWith(`${prefix}-`) || !f.endsWith('.json')) continue;
        try {
          if (fs.statSync(path.join(RUNTIME_DIR, f)).mtimeMs < cutoff) {
            fs.unlinkSync(path.join(RUNTIME_DIR, f));
            n++;
          }
        } catch { /* best effort */ }
      }
      return n;
    } catch { /* read failed: zero */ return 0; }
  }

  return { appendEntry, readAll, readEntries, clearEntries, sweepOld, RUNTIME_DIR };
}

module.exports = { createJournal, sweepStaleJournals, SEP };
