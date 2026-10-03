/**
 * retrieval-journal.js — append-only per-session journal of brain retrievals.
 *
 * Same race-free per-entry files as failure-journal.js (lib/session-journal.js).
 * Each entry records WHICH KB entries were surfaced in a PreToolUse retrieval, so
 * the Stop-hook citation matcher can later score whether the agent actually used
 * any of them in its reply.
 *
 * Schema of each entry:
 *   { retrievalId, ts, sid, tool, queryTokens:[...], returnedIds:[...],
 *     returnedTitles:[...] }
 *
 * Files: `${CLAUDE_PLUGIN_DATA}/.runtime/retrieval-turn-<sid>--<ts>-<rand>.json`
 */
'use strict';

const crypto = require('crypto');
const { createJournal } = require('./session-journal.js');

const { appendEntry, readEntries, clearEntries, sweepOld, RUNTIME_DIR } = createJournal({ prefix: 'retrieval-turn', label: 'retrieval-journal' });

function newRetrievalId() {
  return crypto.randomBytes(4).toString('hex');
}

module.exports = { appendEntry, readEntries, clearEntries, sweepOld, newRetrievalId, RUNTIME_DIR };
