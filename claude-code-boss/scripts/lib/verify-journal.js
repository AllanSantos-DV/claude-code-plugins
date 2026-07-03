/**
 * verify-journal.js — append-only per-turn activity journal for the D2
 * verify-nudge (self-review).
 *
 * Records the two facts the verify detector needs at Stop:
 *   - `{ kind: 'edit', path, ts }`  — a file was edited (Edit/Write/NotebookEdit).
 *   - `{ kind: 'cmd', sig, curated, ts }` — a Bash command ran (sig = canonical
 *     signature; `curated` = matched curated-shell id/script or null).
 *
 * Same race-free pattern as turn-journal.js (one file per entry, no
 * read-modify-write, no locking), but a SEPARATE prefix so it never collides
 * with the curation turn-journal — and DIFFERENT read semantics: verify entries
 * have no (command,reason) identity, so read() keeps them all in chronological
 * order instead of deduping.
 *
 * Lifetime: the verify detector clears the journal every turn (Stop), so entries
 * describe "this turn" only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { sanitizeSessionId } = require('./session-id.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');

const SEP = '--';

function _prefix(sessionId) {
  return `turn-verify-${sanitizeSessionId(sessionId)}${SEP}`;
}

/**
 * Append one entry as a fresh file. Race-free: never reads or rewrites existing
 * files. Swallows errors — journaling must never break a hook.
 * @param {string} sessionId
 * @param {object} entry
 */
function _append(sessionId, entry) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const file = path.join(RUNTIME_DIR, `${_prefix(sessionId)}${ts}-${rand}.json`);
    fs.writeFileSync(file, JSON.stringify({ ts, ...entry }));
  } catch (err) {
    console.error(`[verify-journal] append failed: ${err.message}`);
  }
}

/**
 * Record a file edit (Edit/Write/NotebookEdit).
 * @param {string} sessionId
 * @param {string} filePath
 */
function appendEdit(sessionId, filePath) {
  _append(sessionId, { kind: 'edit', path: String(filePath || '') });
}

/**
 * Record a Bash command that ran this turn.
 * @param {string} sessionId
 * @param {{ sig?: string, curated?: string|null }} info
 */
function appendCommand(sessionId, info = {}) {
  _append(sessionId, {
    kind: 'cmd',
    sig: String(info.sig || ''),
    curated: info.curated ? String(info.curated) : null,
  });
}

/**
 * Read all entries for a session in chronological order (no dedup).
 * @param {string} sessionId
 * @param {number} maxEntries
 * @returns {object[]}
 */
function readEntries(sessionId, maxEntries = 200) {
  const entries = [];
  try {
    if (fs.existsSync(RUNTIME_DIR)) {
      const prefix = _prefix(sessionId);
      const files = fs.readdirSync(RUNTIME_DIR)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .sort(); // lexical = timestamp order (fixed-width ms timestamps)
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf-8'));
          if (data && typeof data === 'object') entries.push(data);
        } catch (err) {
          console.error(`[verify-journal] entry read failed (${f}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[verify-journal] dir read failed: ${err.message}`);
  }
  return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
}

/**
 * Remove all journal files for a session (turn boundary reset).
 * @param {string} sessionId
 */
function clearEntries(sessionId) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) return;
    const prefix = _prefix(sessionId);
    for (const f of fs.readdirSync(RUNTIME_DIR)) {
      if (f.startsWith(prefix) && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); }
        catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error(`[verify-journal] clear failed: ${err.message}`);
  }
}

module.exports = { appendEdit, appendCommand, readEntries, clearEntries, RUNTIME_DIR };
