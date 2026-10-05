#!/usr/bin/env node
/**
 * brain-status.js — Reports the real backend integration status.
 *
 * Uses mcp-health.js (single source of truth) for probing.
 * Output (JSON): { mode, connected, project, backend, details, latency }
 */
'use strict';

const { load: loadBrainConfig } = require('./lib/brain-config.js');
const { probeHealth } = require('./lib/mcp-health.js');
const { readStdin, emitJson } = require('./lib/hook-io.js');

const NO_ID = '(none — memory is off in this folder)';

/**
 * The folder's project id by the same strict resolver every other path uses (was the
 * folder name, or 'default'). Never written to process.env: run() executes inside the
 * prompt dispatcher, and CCB_PROJECT_ID is the resolver's FIRST rung — setting it there
 * handed the other detectors in that process a made-up id.
 */
function statusProject(cwd) {
  try { return require('./lib/project-id.js').tryResolveProjectId({ cwd }) || null; }
  catch (err) { console.error(`[brain-status] project id: ${err.message}`); return null; }
}

async function main(cwd = process.cwd()) {
  const config = loadBrainConfig();
  const id = statusProject(cwd);
  const status = await probeHealth(config, id ? { project: id } : {});
  emitJson({ ...status, project: id || NO_ID });
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
    const id = statusProject((event && event.cwd) || process.cwd());
    const config = loadBrainConfig();
    const status = await probeHealth(config, id ? { project: id } : {});
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
    const cwd = payload.cwd || process.cwd();
    await main(cwd).catch((err) => {
      emitJson({ mode: 'unknown', connected: false, project: statusProject(cwd) || NO_ID, backend: 'unknown', details: { error: err.message }, latency: 0 });
    });
    process.exit(0);
  }).catch((err) => {
    console.error(`[brain-status] CCHOOK stdin parse failed: ${err.message}`);
    process.exit(1);
  });
} else if (require.main === module) {
  main().catch((err) => {
    emitJson({ mode: 'unknown', connected: false, project: statusProject(process.cwd()) || NO_ID, backend: 'unknown', details: { error: err.message }, latency: 0 });
  });
}

module.exports = { main, run };
