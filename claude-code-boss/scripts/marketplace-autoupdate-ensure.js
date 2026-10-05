#!/usr/bin/env node
'use strict';
/**
 * marketplace-autoupdate-ensure.js — SessionStart side effect: turn Claude Code's plugin
 * auto-update ON for this plugin's marketplace once (off by default for third-party
 * marketplaces), respecting any explicit user choice. The user is told on the next prompt
 * (lib/marketplace-autoupdate.js takeAutoUpdateNotice). Never blocks the session.
 */
const path = require('path');

function run() {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT.includes('${')
      ? process.env.CLAUDE_PLUGIN_ROOT : path.resolve(__dirname, '..');
    const r = require('./lib/marketplace-autoupdate.js').ensureAutoUpdate({ pluginRoot: root });
    if (r.status === 'error') console.error(`[marketplace-autoupdate] ${r.error}`);
  } catch (err) {
    console.error(`[marketplace-autoupdate] ${err.message}`);
  }
  return null;
}

module.exports = { run };
