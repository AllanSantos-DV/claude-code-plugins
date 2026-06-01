#!/usr/bin/env node
/**
 * hook-logger — append a log entry to .runtime/hook-errors.jsonl
 * so the dashboard can display hook errors in the Logs panel.
 *
 * Usage (from any hook script):
 *   const { hookLog } = require('./hook-logger.js');
 *   hookLog('error', 'curation-guard', 'Failed to parse shells.json: ...');
 *
 * Writes a single JSONL line: { ts, level, source, message }
 * Silently fails if RUNTIME_DIR is unavailable — hooks must never crash.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
const HOOK_ERRORS_PATH = path.join(RUNTIME_DIR, 'hook-errors.jsonl');
const MAX_LINES = 1000;

function hookLog(level, source, message) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), level, source, message }) + '\n';
    fs.appendFileSync(HOOK_ERRORS_PATH, entry);
    // Probabilistic trim (~1% of writes) — avoids read+rewrite on every append.
    // Worst case: file grows to ~100k lines before trimming back to MAX_LINES.
    if (Math.random() < 0.01) {
      const content = fs.readFileSync(HOOK_ERRORS_PATH, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(HOOK_ERRORS_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
      }
    }
  } catch (err) {
    // Intentional: hook must not crash even if logging fails
    console.error(`[HOOK-LOGGER] Append failed: ${err.message}`);
  }
}

module.exports = { hookLog };
