#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse / PostToolUseFailure hook for Bash.
 *
 * Delegates classification logic to curation-classifier.js.
 * Delegates shells.json access to shells-config.js.
 *
 * Reasons:
 *   needs-curation        — uncurated command, output exceeded raw thresholds
 *   curated-success-noisy — curated script succeeded but output > summary thresholds
 *   curated-failure-noisy — curated script failed, output exceeded raw thresholds
 *   (silent)              — no condition matched; no payload written
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { findProjectRoot, loadShellsConfig, matchCuratedShell } = require('./shells-config.js');
const { classify }                                              = require('./curation-classifier.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const CURATION_DETECT_DIR = path.join(DATA_DIR, 'detect-curation');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

function loadThresholds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return { maxChars: cfg.curation?.maxOutputChars ?? 1500, maxLines: cfg.curation?.maxOutputLines ?? 30 };
  } catch {
    return { maxChars: 1500, maxLines: 30 };
  }
}

const thresholds = loadThresholds();

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
      // Extract "Exit code N" from the first line, strip it from the body
      const m = errStr.match(/^Exit code (\d+)\s*\n?/);
      if (m) exitCode = parseInt(m[1], 10);
      output = m ? errStr.slice(m[0].length) : errStr;
      stderr = output; // best approximation — failure output is mostly stderr
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
    const { reason, threshold } = classify({ command, isCurated, isSuccess, charCount, lineCount, thresholds });

    if (!reason) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    fs.mkdirSync(CURATION_DETECT_DIR, { recursive: true });

    const payload = {
      reason,
      sessionId,
      cwd,
      detectedAt: new Date().toISOString(),
      command,
      isCurated,
      curatedShell: curatedShell ? { command: curatedShell.command, script: curatedShell.script || null } : null,
      isSuccess,
      exitCode,
      hookEvent,
      interrupted,
      charCount,
      lineCount,
      threshold,
      outputPreview: output.slice(0, 500) + (output.length > 1000 ? '\n...\n' + output.slice(-500) : ''),
      stderrPreview: stderr.slice(0, 500),
    };

    const filename = `curation-${sessionId.slice(0, 8)}-${Date.now()}.json`;
    const tmp = path.join(CURATION_DETECT_DIR, filename + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, path.join(CURATION_DETECT_DIR, filename));
    console.error(`[CURATION-DETECT] ${reason}: ${charCount} chars, ${lineCount} lines — ${filename}`);

    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
