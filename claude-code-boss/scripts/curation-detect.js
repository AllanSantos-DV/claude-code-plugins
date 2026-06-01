#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse / PostToolUseFailure hook for Bash.
 *
 * In-loop design (replaces the old payload-on-disk + subagent pipeline):
 *  - During the turn, append-only journal entries land at
 *    ${CLAUDE_PLUGIN_DATA}/.runtime/curation-turn-<sid>--<ts>-<rand>.json
 *    (one file per entry — race-free, no read-modify-write).
 *  - At end of turn, curation-stop.js aggregates the journal via
 *    lib/turn-journal.js#readEntries and asks the main loop to act on the
 *    captured signals.
 *
 * Delegates classification to curation-classifier.js (pure function).
 * Delegates shells.json access to shells-config.js.
 *
 * Reasons recorded:
 *   needs-curation        — uncurated command, output exceeded raw thresholds
 *   curated-success-noisy — curated script succeeded but output > summary thresholds
 *   curated-failure-noisy — curated script failed, output exceeded raw thresholds
 *   (null)                — no condition matched; no entry recorded
 */
const { readStdin } = require('./lib/hook-io.js');
const turnJournal = require('./lib/turn-journal.js');
const path = require('path');

const { findProjectRoot, loadShellsConfig, matchCuratedShell } = require('./shells-config.js');
const { classify }                                              = require('./curation-classifier.js');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');

const _curationCfg = require('./lib/brain-config.js').getCuration();
const thresholds = { maxChars: _curationCfg.maxOutputChars, maxLines: _curationCfg.maxOutputLines };

// ─── Turn state ──────────────────────────────────────────────────────────────
// All state lives in the append-only turn journal (lib/turn-journal.js) —
// race-free because each entry writes its own file.

function appendTurnEntry(sessionId, entry) {
  turnJournal.appendEntry(sessionId, entry);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const event = JSON.parse(raw);

    // Only handle Bash tool PostToolUse
    if (event.tool_name !== 'Bash') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Two different event shapes:
    //   PostToolUse (success):
    //     { tool_response: { stdout, stderr, interrupted, isImage, noOutputExpected } }
    //   PostToolUseFailure (failure):
    //     { error: "Exit code N\n<stdout+stderr>", is_interrupt: bool, duration_ms }
    //     (NO tool_response, NO separate exit_code)
    const hookEvent = event.hook_event_name || '';
    const isFailure = hookEvent === 'PostToolUseFailure';

    let stdout = '', stderr = '', output = '', interrupted = false, exitCode = null;
    if (isFailure) {
      const errStr = String(event.error || '');
      const m = errStr.match(/^Exit code (\d+)\s*\n?/);
      if (m) exitCode = parseInt(m[1], 10);
      output = m ? errStr.slice(m[0].length) : errStr;
      stderr = output;
      interrupted = event.is_interrupt === true;
    } else {
      const tr = event.tool_response || {};
      stdout = tr.stdout || '';
      stderr = tr.stderr || '';
      interrupted = tr.interrupted === true;
      exitCode = typeof tr.exit_code === 'number' ? tr.exit_code : null;
      output = [stdout, stderr].filter(Boolean).join('\n');
    }

    const command = event.tool_input?.command || '';
    const sessionId = event.session_id || event.sessionId || 'default';
    const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || '';
    const charCount = output.length;
    const lineCount = output ? output.split('\n').length : 0;

    // Success determination:
    //   1. PostToolUseFailure → always failure
    //   2. PostToolUse with explicit exit_code → check it
    //   3. Otherwise (PostToolUse default) → success
    const isSuccess = isFailure ? false
      : (exitCode !== null ? exitCode === 0 : true);

    // Detect curated shell
    const projectRoot = findProjectRoot(cwd);
    const { shells } = loadShellsConfig(projectRoot);
    const curatedShell = matchCuratedShell(command, shells);
    const isCurated = curatedShell !== null;

    // Classify
    const { reason } = classify({ command, isCurated, isSuccess, charCount, lineCount, thresholds });

    if (!reason) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Append to per-turn state (curation-stop.js will read at end of turn).
    appendTurnEntry(sessionId, {
      command,
      reason,
      lines: lineCount,
      chars: charCount,
      isCurated,
      curatedScript: curatedShell?.script || null,
      isSuccess,
      interrupted,
      hookEvent,
      exitCode,
      timestamp: new Date().toISOString(),
    });

    console.error(`[CURATION-DETECT] ${reason}: ${charCount} chars, ${lineCount} lines — turn state updated`);
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
