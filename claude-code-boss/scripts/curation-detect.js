#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse / PostToolUseFailure hook for Bash.
 *
 * In-loop design (replaces the old payload-on-disk + subagent pipeline):
 *  - During the turn, append a lightweight entry to a per-turn state file
 *    at ${CLAUDE_PLUGIN_DATA}/.runtime/curation-turn-<sessionId>.json.
 *  - At end of turn, curation-stop.js reads the state and asks the main loop
 *    (with full turn context) to create/refine the .mjs scripts.
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
const fs = require('fs');
const path = require('path');
const os = require('os');

const { findProjectRoot, loadShellsConfig, matchCuratedShell } = require('./shells-config.js');
const { classify }                                              = require('./curation-classifier.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

/** Cap entries per turn to prevent unbounded growth on pathological sessions. */
const MAX_ENTRIES_PER_TURN = 50;

function loadThresholds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return { maxChars: cfg.curation?.maxOutputChars ?? 1500, maxLines: cfg.curation?.maxOutputLines ?? 30 };
  } catch (err) {
    console.error(`[CURATION-DETECT] config load failed, using defaults: ${err.message}`);
    return { maxChars: 1500, maxLines: 30 };
  }
}

const thresholds = loadThresholds();

// ─── Turn state ──────────────────────────────────────────────────────────────

function turnStatePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(RUNTIME_DIR, `curation-turn-${safe}.json`);
}

function loadTurnState(sessionId) {
  try {
    const p = turnStatePath(sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[CURATION-DETECT] turn state load failed: ${err.message}`);
    return null;
  }
}

function saveTurnState(sessionId, state) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = turnStatePath(sessionId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, turnStatePath(sessionId));
  } catch (err) {
    console.error(`[CURATION-DETECT] Failed to save turn state: ${err.message}`);
  }
}

function appendTurnEntry(sessionId, entry) {
  const state = loadTurnState(sessionId) || {
    sessionId,
    startedAt: new Date().toISOString(),
    entries: [],
  };
  // Dedup by command+reason (same noisy command repeated → keep most recent metrics only)
  const dupIdx = state.entries.findIndex(e => e.command === entry.command && e.reason === entry.reason);
  if (dupIdx >= 0) {
    state.entries[dupIdx] = entry;
  } else {
    state.entries.push(entry);
  }
  if (state.entries.length > MAX_ENTRIES_PER_TURN) {
    state.entries = state.entries.slice(-MAX_ENTRIES_PER_TURN);
  }
  saveTurnState(sessionId, state);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

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
