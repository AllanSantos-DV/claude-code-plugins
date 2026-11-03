#!/usr/bin/env node
'use strict';
/**
 * marketplace-autoupdate-ensure.js — SessionStart side effect: turn Claude Code's plugin
 * auto-update ON for this plugin's marketplace once (off by default for third-party
 * marketplaces), respecting any explicit user choice. The user is told on the next prompt
 * (lib/marketplace-autoupdate.js takeAutoUpdateNotice). Never blocks the session.
 */
const path = require('path');

async function run() {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT.includes('${')
      ? process.env.CLAUDE_PLUGIN_ROOT : path.resolve(__dirname, '..');
    const r = require('./lib/marketplace-autoupdate.js').ensureAutoUpdate({ pluginRoot: root });
    if (r.status === 'error') console.error(`[marketplace-autoupdate] ${r.error}`);
    // Cache the newest release so the next prompt can say "version X available" (6h throttle),
    // and drop the previous versions the updates left in the plugin cache (disk), concurrently.
    const prune = require('./lib/cache-prune.js');
    await Promise.all([
      require('./lib/update-notice.js').refreshLatest({ root }),
      prune.pruneOldVersions({ keep: [root, prune.daemonRoot(process.env.CLAUDE_PLUGIN_DATA)] }).then((p) => {
        if (p.skipped) console.error(`[cache-prune] nothing deleted: ${p.skipped}`);
      }),
    ]);
  } catch (err) {
    console.error(`[marketplace-autoupdate] ${err.message}`);
  }
  return null;
}

module.exports = { run };
