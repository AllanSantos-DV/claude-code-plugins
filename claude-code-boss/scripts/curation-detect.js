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

// Thresholds that trigger investigation
const MAX_OUTPUT_CHARS = 5000;
const MAX_OUTPUT_LINES = 80;

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
    if (event.event !== 'PostToolUse' || event.toolUse?.name !== 'Bash') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const output = event.toolUse?.output || '';
    const command = event.toolUse?.input?.command || '';
    const sessionId = event.sessionId || 'default';

    // Ensure directory
    if (!fs.existsSync(CURATION_DETECT_DIR)) {
      fs.mkdirSync(CURATION_DETECT_DIR, { recursive: true });
    }

    // Get output stats
    const charCount = output.length;
    const lineCount = output.split('\n').length;

    const exceeded = charCount > MAX_OUTPUT_CHARS || lineCount > MAX_OUTPUT_LINES;

    // Write payload
    const payload = {
      version: 1,
      sessionId,
      detectedAt: new Date().toISOString(),
      command,
      charCount,
      lineCount,
      exceeded,
      threshold: { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_OUTPUT_LINES },
      // Preview: first 500 chars + last 500 chars for context-aware analysis
      outputPreview: output.slice(0, 500) + (output.length > 1000 ? '\n...\n' + output.slice(-500) : ''),
    };

    const filename = `curation-${sessionId.slice(0, 8)}-${Date.now()}.json`;
    fs.writeFileSync(path.join(CURATION_DETECT_DIR, filename), JSON.stringify(payload, null, 2));

    if (exceeded) {
      console.error(`[CURATION-DETECT] Large output detected: ${charCount} chars, ${lineCount} lines — written to ${filename}`);
    }

    // Always return empty JSON — PostToolUse should not modify the tool result
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
