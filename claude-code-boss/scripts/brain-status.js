#!/usr/bin/env node
/**
 * brain-status.js — Reports the real backend integration status.
 *
 * Uses mcp-health.js (single source of truth) for probing.
 * Output (JSON): { mode, connected, project, backend, details, latency }
 */
'use strict';

const path = require('path');
const { load: loadBrainConfig } = require('./lib/brain-config.js');
const { probeHealth } = require('./lib/mcp-health.js');
const { readStdin, emitJson } = require('./lib/hook-io.js');

async function main() {
  const config = loadBrainConfig();
  const status = await probeHealth(config);
  emitJson(status);
}

/**
 * Pure detector entry point for `user-prompt-submit-dispatcher.js` — NOT the
 * same as `main()` above (which is the raw-status CLI used by the
 * `brain-status` skill and manual/dashboard use, unchanged). Returns an
 * advisory string only when the mcp-memory backend is unreachable (`local`
 * is always `connected: true` by design — see mcp-health.js — so it never
 * warrants a nudge here); `null` when healthy/local, so most turns stay
 * silent instead of repeating the raw report every prompt.
 * @param {object} event
 * @returns {Promise<string|null>}
 */
async function run(event) {
  try {
    const project = event && event.cwd ? path.basename(event.cwd) : (process.env.CCB_PROJECT_ID || 'default');
    process.env.CCB_PROJECT_ID = project;
    const config = loadBrainConfig();
    const status = await probeHealth(config);
    if (status.connected) return null;
    const detail = status.details ? JSON.stringify(status.details) : '';
    return `[BRAIN-STATUS] mcp-memory backend unreachable (project: ${status.project}) ${detail}. ` +
      'Check the mcp-memory daemon is running; falls back to local behavior may be degraded until it reconnects.';
  } catch (err) {
    console.error(`[brain-status] ${err.message}`);
    return null;
  }
}

if (process.env.CCHOOK) {
  readStdin().then(async (raw) => {
    const payload = JSON.parse(raw || '{}');
    const project = payload.cwd ? payload.cwd.split(path.sep).pop() : (process.env.CCB_PROJECT_ID || 'default');
    process.env.CCB_PROJECT_ID = project;
    await main().catch((err) => {
      emitJson({ mode: 'unknown', connected: false, project, backend: 'unknown', details: { error: err.message }, latency: 0 });
    });
    process.exit(0);
  }).catch((err) => {
    console.error(`[brain-status] CCHOOK stdin parse failed: ${err.message}`);
    process.exit(1);
  });
} else if (require.main === module) {
  main().catch((err) => {
    emitJson({ mode: 'unknown', connected: false, project: 'default', backend: 'unknown', details: { error: err.message }, latency: 0 });
  });
}

module.exports = { main, run };
