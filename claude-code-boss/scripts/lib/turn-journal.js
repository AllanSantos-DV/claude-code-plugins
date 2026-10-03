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

const { sanitizeSessionId } = require('./session-id.js');
const { createJournal } = require('./session-journal.js');

const journal = createJournal({ prefix: 'curation-turn', label: 'turn-journal' });
const { appendEntry, RUNTIME_DIR } = journal;

function _legacyPath(sessionId) {
  return path.join(RUNTIME_DIR, `curation-turn-${sanitizeSessionId(sessionId)}.json`);
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

  // 2. Journal files, oldest first
  entries.push(...journal.readAll(sessionId));

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
  journal.clearEntries(sessionId);
}

module.exports = { appendEntry, readEntries, clearEntries, RUNTIME_DIR };
