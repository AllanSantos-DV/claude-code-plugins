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

module.exports = { main };
