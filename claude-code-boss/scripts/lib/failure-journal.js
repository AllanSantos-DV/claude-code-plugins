/**
 * failure-journal.js — append-only per-session journal for failure events.
 *
 * Same race-free per-entry files as turn-journal.js (lib/session-journal.js), under
 * a distinct prefix so failures don't get mixed with curation entries when both
 * hooks fire in the same turn.
 *
 * Schema of each entry:
 *   { ts, tool, cmd, exitCode, snippet, duration }
 *
 * Files: `${CLAUDE_PLUGIN_DATA}/.runtime/failure-turn-<sid>--<ts>-<rand>.json`
 * sweepOld(maxAgeMs) is called from failure-retro to bound disk usage — entries
 * past the retro window are already logically ignored.
 */
'use strict';

const { createJournal } = require('./session-journal.js');

const { appendEntry, readEntries, clearEntries, sweepOld, RUNTIME_DIR } = createJournal({ prefix: 'failure-turn', label: 'failure-journal' });

module.exports = { appendEntry, readEntries, clearEntries, sweepOld, RUNTIME_DIR };
