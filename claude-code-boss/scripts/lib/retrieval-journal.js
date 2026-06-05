/**
 * retrieval-journal.js — append-only per-session journal of brain retrievals.
 *
 * Mirrors failure-journal.js (race-free per-entry file writes). Each entry
 * records WHICH KB entries were surfaced in a PreToolUse retrieval, so the
 * Stop-hook citation matcher can later score whether the agent actually used
 * any of them in its reply.
 *
 * Schema of each entry:
 *   { retrievalId, ts, sid, tool, queryTokens:[...], returnedIds:[...],
 *     returnedTitles:[...] }
 *
 * Files: `${CLAUDE_PLUGIN_DATA}/.runtime/retrieval-turn-<sid>--<ts>-<rand>.json`
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
  return `retrieval-turn-${sanitizeSessionId(sessionId)}${SEP}`;
}

function newRetrievalId() {
  return crypto.randomBytes(4).toString('hex');
}

function appendEntry(sessionId, entry) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const file = path.join(RUNTIME_DIR, `${_prefix(sessionId)}${ts}-${rand}.json`);
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch (err) {
    console.error(`[retrieval-journal] append failed: ${err.message}`);
  }
}

function readEntries(sessionId, maxEntries = 200) {
  const entries = [];
  try {
    if (!fs.existsSync(RUNTIME_DIR)) return [];
    const prefix = _prefix(sessionId);
    const files = fs.readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf-8'));
        if (data && typeof data === 'object') entries.push(data);
      } catch (err) {
        console.error(`[retrieval-journal] entry read failed (${f}): ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[retrieval-journal] dir read failed: ${err.message}`);
  }
  return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
}

function clearEntries(sessionId) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) return;
    const prefix = _prefix(sessionId);
    for (const f of fs.readdirSync(RUNTIME_DIR)) {
      if (f.startsWith(prefix) && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); } catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.error(`[retrieval-journal] clear failed: ${err.message}`);
  }
}

/**
 * Sweep entries older than `maxAgeMs` from any session. Best-effort.
 * Called periodically to bound disk usage.
 */
function sweepOld(maxAgeMs) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const f of fs.readdirSync(RUNTIME_DIR)) {
      if (!f.startsWith('retrieval-turn-') || !f.endsWith('.json')) continue;
      try {
        const stat = fs.statSync(path.join(RUNTIME_DIR, f));
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(path.join(RUNTIME_DIR, f));
          n++;
        }
      } catch { /* best effort */ }
    }
    return n;
  } catch { return 0; }
}

module.exports = { appendEntry, readEntries, clearEntries, sweepOld, newRetrievalId, RUNTIME_DIR };
