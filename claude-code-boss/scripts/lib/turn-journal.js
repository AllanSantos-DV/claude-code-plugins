/**
 * turn-journal.js — append-only per-turn journal for curation entries.
 *
 * RACE PROBLEM (pre-journal):
 *   Two concurrent PostToolUse events for the same session would both
 *   read+mutate+rename the single curation-turn-<sid>.json file.
 *   Last-write-wins → one of the entries silently lost.
 *
 * SOLUTION:
 *   Each appendEntry() writes a brand-new file
 *   `curation-turn-<sid>--<ts>-<rand>.json` containing a single entry.
 *   No read-modify-write. No locking needed. No lost writes.
 *
 *   readEntries() aggregates all journal files for the session, plus the
 *   legacy single-file format (`curation-turn-<sid>.json`) for backward
 *   compatibility with tests that pre-seed state.
 *
 *   clearEntries() removes both journal files and legacy file.
 *
 * SEPARATOR:
 *   Double-dash `--` between sid and timestamp avoids prefix collisions
 *   (sid="foo" would otherwise match files of sid="foobar").
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sanitizeSessionId } = require('./session-id.js');
const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DATA_DIR = dataDir();
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');

const SEP = '--';

function _journalPrefix(sessionId) {
  return `curation-turn-${sanitizeSessionId(sessionId)}${SEP}`;
}

function _legacyPath(sessionId) {
  return path.join(RUNTIME_DIR, `curation-turn-${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Append one entry as a new journal file. Race-free: never reads or rewrites
 * existing files.
 * @param {string} sessionId
 * @param {object} entry
 */
function appendEntry(sessionId, entry) {
  try {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const file = path.join(RUNTIME_DIR, `${_journalPrefix(sessionId)}${ts}-${rand}.json`);
    writeJsonAtomic(file, entry);
  } catch (err) {
    console.error(`[turn-journal] append failed: ${err.message}`);
  }
}

/**
 * Read all entries for a session from journal files + legacy file.
 * Applies dedup-by-(command,reason): later entries win.
 * @param {string} sessionId
 * @param {number} maxEntries
 * @returns {object[]} entries ordered by timestamp ascending
 */
function readEntries(sessionId, maxEntries = 50) {
  const entries = [];

  // 1. Legacy single-file format (backward-compat for tests + pre-migration data)
  try {
    const legacyP = _legacyPath(sessionId);
    if (fs.existsSync(legacyP)) {
      const data = JSON.parse(fs.readFileSync(legacyP, 'utf-8'));
      if (Array.isArray(data?.entries)) entries.push(...data.entries);
    }
  } catch (err) {
    console.error(`[turn-journal] legacy read failed: ${err.message}`);
  }

  // 2. Journal files — order by timestamp embedded in filename
  try {
    if (fs.existsSync(RUNTIME_DIR)) {
      const prefix = _journalPrefix(sessionId);
      const files = fs.readdirSync(RUNTIME_DIR)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .sort(); // lexical sort = timestamp order (fixed-width ms timestamps)
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf-8'));
          if (data && typeof data === 'object') entries.push(data);
        } catch (err) {
          console.error(`[turn-journal] entry read failed (${f}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[turn-journal] dir read failed: ${err.message}`);
  }

  // Dedup by (command, reason): later entries replace earlier ones
  const byKey = new Map();
  const order = [];
  for (const e of entries) {
    const key = `${e?.command || ''}|${e?.reason || ''}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, e);
  }
  const deduped = order.map(k => byKey.get(k));

  return deduped.length > maxEntries ? deduped.slice(-maxEntries) : deduped;
}

/**
 * Remove all journal files + legacy file for a session.
 * @param {string} sessionId
 */
function clearEntries(sessionId) {
  try {
    const legacyP = _legacyPath(sessionId);
    if (fs.existsSync(legacyP)) fs.unlinkSync(legacyP);
  } catch { /* best effort */ }

  try {
    if (!fs.existsSync(RUNTIME_DIR)) return;
    const prefix = _journalPrefix(sessionId);
    for (const f of fs.readdirSync(RUNTIME_DIR)) {
      if (f.startsWith(prefix) && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); }
        catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error(`[turn-journal] clear failed: ${err.message}`);
  }
}

module.exports = { appendEntry, readEntries, clearEntries, RUNTIME_DIR };
