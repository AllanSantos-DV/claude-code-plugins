#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse hook for Bash tool calls.
 *
 * Triggers semanticamente, não só por volume:
 *
 *   1. Comando é um script curado (.vscode/shells.json) E sucesso E saída > 3 linhas
 *      → reason: "curated-success-noisy"
 *      → o script foi mal feito: sucesso deveria emitir 1 linha de summary
 *
 *   2. Comando é um script curado E falhou (stderr ou interrupted) E saída excedeu threshold
 *      → reason: "curated-failure-noisy"
 *      → o script precisa de melhor summary de falha
 *
 *   3. Comando NÃO é curado E saída excedeu threshold
 *      → reason: "needs-curation"
 *      → candidate to wrap into a curated shell script
 *
 *   Else → skip, sem payload.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const CURATION_DETECT_DIR = path.join(DATA_DIR, 'detect-curation');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

// Curated script "ideal" output: success → ≤ 3 lines, ≤ 500 chars.
// If success exceeds these, the script is poorly designed.
const CURATED_SUCCESS_MAX_LINES = 3;
const CURATED_SUCCESS_MAX_CHARS = 500;

// Load raw-command thresholds from brain-config.json (fallback defaults)
function loadThresholds() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    return {
      maxChars: cfg.curation?.maxOutputChars ?? 1500,
      maxLines: cfg.curation?.maxOutputLines ?? 30,
    };
  } catch {
    return { maxChars: 1500, maxLines: 30 };
  }
}

const { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_OUTPUT_LINES } = loadThresholds();

// ─── Curated-shell detection (mirrors curation-guard.js) ──────────────────────

function findProjectRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.vscode', 'shells.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadShells(projectRoot) {
  if (!projectRoot) return [];
  try {
    const p = path.join(projectRoot, '.vscode', 'shells.json');
    if (!fs.existsSync(p)) return [];
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return cfg.shells || [];
  } catch (err) {
    console.error(`[CURATION-DETECT] Failed to parse shells.json: ${err.message}`);
    return [];
  }
}

function matchCuratedShell(command, shells) {
  const trimmed = command.trim();
  for (const shell of shells) {
    if (!shell.command) continue;
    if (trimmed.startsWith(shell.command.trim())) return shell;
    if (Array.isArray(shell.aliases)) {
      for (const a of shell.aliases) {
        if (trimmed.startsWith(a.trim())) return shell;
      }
    }
  }
  return null;
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
      output = [stdout, stderr].filter(Boolean).join('\n')
        || (typeof event.tool_result === 'string' ? event.tool_result : (event.tool_result?.text || ''));
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
    const shells = loadShells(projectRoot);
    const curatedShell = matchCuratedShell(command, shells);
    const isCurated = curatedShell !== null;

    // Decide trigger reason
    let reason = null;
    if (isCurated) {
      if (isSuccess && (lineCount > CURATED_SUCCESS_MAX_LINES || charCount > CURATED_SUCCESS_MAX_CHARS)) {
        reason = 'curated-success-noisy';
      } else if (!isSuccess && (charCount > MAX_OUTPUT_CHARS || lineCount > MAX_OUTPUT_LINES)) {
        reason = 'curated-failure-noisy';
      }
    } else {
      if (charCount > MAX_OUTPUT_CHARS || lineCount > MAX_OUTPUT_LINES) {
        reason = 'needs-curation';
      }
    }

    if (!reason) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    if (!fs.existsSync(CURATION_DETECT_DIR)) {
      fs.mkdirSync(CURATION_DETECT_DIR, { recursive: true });
    }

    const payload = {
      version: 2,
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
      threshold: isCurated && isSuccess
        ? { maxChars: CURATED_SUCCESS_MAX_CHARS, maxLines: CURATED_SUCCESS_MAX_LINES }
        : { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_OUTPUT_LINES },
      outputPreview: output.slice(0, 500) + (output.length > 1000 ? '\n...\n' + output.slice(-500) : ''),
      stderrPreview: stderr.slice(0, 500),
    };

    const filename = `curation-${sessionId.slice(0, 8)}-${Date.now()}.json`;
    fs.writeFileSync(path.join(CURATION_DETECT_DIR, filename), JSON.stringify(payload, null, 2));
    console.error(`[CURATION-DETECT] ${reason}: ${charCount} chars, ${lineCount} lines — ${filename}`);

    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
