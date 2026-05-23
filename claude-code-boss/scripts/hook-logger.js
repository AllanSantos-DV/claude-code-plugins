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

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PLUGIN_ROOT, '.runtime');
const HOOK_ERRORS_PATH = path.join(RUNTIME_DIR, 'hook-errors.jsonl');
const MAX_LINES = 1000;

function hookLog(level, source, message) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), level, source, message }) + '\n';
    fs.appendFileSync(HOOK_ERRORS_PATH, entry);
    // Trim to MAX_LINES to avoid unbounded growth
    const content = fs.readFileSync(HOOK_ERRORS_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(HOOK_ERRORS_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch (err) {
    // Intentional: hook must not crash even if logging fails
    console.error(`[HOOK-LOGGER] Append failed: ${err.message}`);
  }
}

module.exports = { hookLog };
