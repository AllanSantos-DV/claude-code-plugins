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

module.exports = { createJournal, SEP };
