#!/usr/bin/env node
/**
 * file-edit-detect.js — PostToolUse hook for Edit / Write / NotebookEdit (D2).
 *
 * Records a `{kind:'edit', path}` entry in the per-turn verify-journal so the
 * verify-nudge Stop detector can tell whether the agent edited files this turn.
 * Silent and fail-open: only journals, never blocks.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const verifyJournal = require('./lib/verify-journal.js');

// Edit, MultiEdit, Write, NotebookEdit all carry "Edit"/"Write" in their name.
const EDIT_TOOL = /(?:Edit|Write)/;

function editedPath(ev) {
  const ti = ev.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || '';
}

async function run(event) {
  const ev = event || {};
  const tool = ev.tool_name || '';
  if (!EDIT_TOOL.test(tool)) return {};
  const sid = ev.session_id || ev.sessionId || 'default';
  verifyJournal.appendEdit(sid, editedPath(ev));
  return {};
}

if (require.main === module) {
  (async () => {
    try {
      const raw = await readStdin();
      await run(parsePayload(raw) || {});
    } catch (err) {
      console.error(`[file-edit-detect] ${err.message}`);
    }
    emitEmpty();
  })();
}

module.exports = { run, editedPath, EDIT_TOOL };
