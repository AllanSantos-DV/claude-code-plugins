#!/usr/bin/env node
'use strict';
/**
 * backend-onboarding-advisory.js — SessionStart: on the local backend, tell the AGENT what is
 * off and that it can enable it for the user (backend_status / backend_setup). The landing
 * page sells graph tools and compose recall; users who never heard of "mcp-memory" got
 * "these tools don't exist" (2026-10-05). Agent context only — never shown to the user.
 */
const path = require('path');

function run(event, deps = {}) {
  try {
    const load = deps.loadConfig || (() => require(path.join(__dirname, 'lib', 'brain-config.js')).load());
    const b = (load() || {}).backend || {};
    if (b.type === 'mcp-memory') return null;
    const { OFF_ON_LOCAL } = require(path.join(__dirname, 'lib', 'setup-tools.js'));
    return `[BOSS] Memory backend: local (built in). OFF until the memory server is enabled: ${OFF_ON_LOCAL}. `
      + 'If the user wants any of these (or asks why a graph_* tool refuses), explain it in plain words and offer to enable it: '
      + 'backend_status shows what is installed and running here. Ask first whether they already run a memory server on another host '
      + '(technical users give an address → backend_setup with serverUrl); if they do not know, backend_setup without it reuses a server already '
      + 'on this machine (sister plugins install one) or installs one — never a second. It reports the server version; updates only with the user\'s OK (backend_update).';
  } catch (err) {
    console.error(`[backend-onboarding-advisory] ${err.message}`);
    return null;
  }
}

module.exports = { run };
