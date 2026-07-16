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

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const failureJournal = require('./lib/failure-journal.js');
const { dataDir } = require('./lib/data-dir.js');
const errorStore = require('./lib/error-store.js');
const { getErrorGuard } = require('./lib/hooks-config.js');

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
 * Deterministic error-guard recording (Phase 2 micro-1): on a Bash failure,
 * durably record the RAW command's canonical signature into lib/error-store so
 * error-guard (PreToolUse) can DENY a recurring re-run. Uses the RAW command
 * (event.tool_input.command), NOT the masked/truncated normalizeCmd string, so
 * canonicalSig sees the real command. Best-effort and gated — never blocks the
 * failure-journal path above.
 * @param {object} ev   the PostToolUseFailure event
 * @param {object} entry the buildEntry() result (reuses snippet + exitCode)
 * @param {string} sid  session id
 */
function recordErrorGuard(ev, entry, sid) {
  if (ev.tool_name !== 'Bash') return;
  try {
    if (getErrorGuard().enabled === false) return;
    const command = (ev.tool_input && ev.tool_input.command) || '';
    if (!command) return;
    const projectKey = errorStore.resolveProjectKey(ev.cwd || process.cwd());
    errorStore.record(dataDir(), projectKey, {
      command,
      cause: entry.snippet,
      exitCode: entry.exitCode,
      sessionId: sid,
    });
  } catch (err) {
    console.error(`[failure-detect] error-store record failed: ${err.message}`);
  }
}

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw);
  if (!ev) return emitEmpty();
  if (ev.hook_event_name !== 'PostToolUseFailure') return emitEmpty();
  if (ev.is_interrupt === true) return emitEmpty();
  const sid = ev.session_id || ev.sessionId || 'default';
  const entry = buildEntry(ev);
  try {
    failureJournal.appendEntry(sid, entry);
  } catch (err) {
    console.error(`[failure-detect] ${err.message}`);
  }
  recordErrorGuard(ev, entry, sid);
  emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[failure-detect] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { normalizeCmd, extractTarget, parseExitCode, buildEntry };
