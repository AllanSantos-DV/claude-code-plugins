#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse hook for Bash tool calls.
 *
 * Detects when a curated script's output exceeds a threshold (lines or chars)
 * and writes a payload for the curation-improver subagent to analyze.
 *
 * The subagent investigates: can the script be improved to produce
 * more concise output? What noise could be removed?
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const CURATION_DETECT_DIR = path.join(DATA_DIR, 'detect-curation');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

// Load thresholds from brain-config.json (falls back to defaults if missing)
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

    const output = event.tool_result?.text || '';
    const command = event.tool_input?.command || '';
    const sessionId = event.session_id || event.sessionId || 'default';
    const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || '';

    // Ensure directory
    if (!fs.existsSync(CURATION_DETECT_DIR)) {
      fs.mkdirSync(CURATION_DETECT_DIR, { recursive: true });
    }

    // Get output stats
    const charCount = output.length;
    const lineCount = output.split('\n').length;

    const exceeded = charCount > MAX_OUTPUT_CHARS || lineCount > MAX_OUTPUT_LINES;

    // Only write payload when threshold is actually exceeded — avoid noise
    if (!exceeded) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const payload = {
      version: 1,
      sessionId,
      cwd,
      detectedAt: new Date().toISOString(),
      command,
      charCount,
      lineCount,
      exceeded: true,
      threshold: { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_OUTPUT_LINES },
      // Preview: first 500 chars + last 500 chars for context-aware analysis
      outputPreview: output.slice(0, 500) + (output.length > 1000 ? '\n...\n' + output.slice(-500) : ''),
    };

    const filename = `curation-${sessionId.slice(0, 8)}-${Date.now()}.json`;
    fs.writeFileSync(path.join(CURATION_DETECT_DIR, filename), JSON.stringify(payload, null, 2));
    console.error(`[CURATION-DETECT] Large output detected: ${charCount} chars, ${lineCount} lines — written to ${filename}`);

    // Always return empty JSON — PostToolUse should not modify the tool result
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
