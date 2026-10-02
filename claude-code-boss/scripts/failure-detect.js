#!/usr/bin/env node
/**
 * failure-detect.js — PostToolUseFailure hook (all tools).
 *
 * Appends a normalized failure entry to the per-session journal so that
 * failure-retro.js (Stop) can aggregate and detect loops. Never blocks.
 *
 * Pure normalizeCmd() is exported for unit tests.
 */
'use strict';

const { runSideEffectCli } = require('./lib/hook-io.js');
const failureJournal = require('./lib/failure-journal.js');

function normalizeCmd(cmd) {
  return String(cmd || '')
    .slice(0, 200)
    .replace(/\b\d{10,}\b/g, '<TS>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<SHA>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTarget(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return toolInput.command || toolInput.file_path || toolInput.path || toolInput.url || '';
}

function parseExitCode(errStr) {
  const m = String(errStr || '').match(/^Exit code (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function buildEntry(ev) {
  const target = extractTarget(ev.tool_input);
  const errStr = String(ev.error || '');
  const exitCode = parseExitCode(errStr);
  const headerMatch = errStr.match(/^Exit code \d+\s*\n?/);
  const snippet = (headerMatch ? errStr.slice(headerMatch[0].length) : errStr).slice(0, 500);
  return {
    ts: Date.now(),
    tool: ev.tool_name || 'unknown',
    cmd: normalizeCmd(target),
    exitCode,
    snippet,
    duration: Number.isFinite(ev.duration_ms) ? ev.duration_ms : 0,
  };
}

/**
 * Pure detector entry point — side effect only (appends to the failure
 * journal). Reply is always `{}`. (It used to also record the command into
 * lib/error-store for error-guard; error-guard now reads the session transcript
 * — lib/session-failures.js — so that store had no reader and was removed.)
 * @param {object} ev
 */
async function run(ev) {
  if (!ev) return;
  if (ev.hook_event_name !== 'PostToolUseFailure') return;
  if (ev.is_interrupt === true) return;
  const sid = ev.session_id || ev.sessionId || 'default';
  const entry = buildEntry(ev);
  try {
    failureJournal.appendEntry(sid, entry);
  } catch (err) {
    console.error(`[failure-detect] ${err.message}`);
  }
}

if (require.main === module) {
  runSideEffectCli(run, 'failure-detect');
}

module.exports = { normalizeCmd, extractTarget, parseExitCode, buildEntry, run };
