#!/usr/bin/env node
/**
 * mcp-headers.js — `headersHelper` of the brain-server entry in .mcp.json.
 *
 * Claude Code runs it before EVERY connection to the brain daemon (session start and
 * reconnect, up to 10 s) and sends the JSON it prints as request headers. Two jobs:
 *
 *   1. Make sure the daemon is up BEFORE the client's first connection attempt. Started
 *      only by the SessionStart hook, the daemon came up ~1 s after the client's first
 *      attempt had already failed; the client then sat in its reconnect backoff and
 *      skipped the `mcp_tool` hooks of the first turn(s). The client waits for this
 *      helper, so the first attempt now meets a listening daemon.
 *   2. Hand the daemon's local token to the client: `/mcp` requires it, so another local
 *      process (e.g. another OS user's) can no longer read/write the KB or drive the
 *      hook tools through the fixed port.
 *
 * Claude Code passes the plugin data dir as argv[2] (`${CLAUDE_PLUGIN_DATA}`): the
 * helper's env has no CLAUDE_PLUGIN_DATA, and credential-named vars (BRAIN_HTTP_TOKEN)
 * are stripped from it — the token is read from the file the daemon keeps in sync.
 *
 * Contract: one JSON object on stdout, exit 0. No token at all → stderr + exit 1
 * (Claude Code then connects without the header and the daemon answers 401 — loud).
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ENSURE_BUDGET_MS = 8000; // under Claude Code's 10 s helper limit

async function headers({ argvDataDir, root = path.resolve(__dirname, '..'), ensure, budgetMs = ENSURE_BUDGET_MS } = {}) {
  const { validEnvDir, dataDir } = require('./lib/data-dir.js');
  // Same data dir the plugin's hooks resolve (they get CLAUDE_PLUGIN_DATA in their env).
  if (validEnvDir(argvDataDir)) process.env.CLAUDE_PLUGIN_DATA = argvDataDir;
  const data = dataDir();
  const run = ensure || ((d) => require('./brain-daemon-ensure.js').run({ hook_event_name: 'headersHelper' }, { root, data: d }));
  let timer;
  const note = await Promise.race([
    Promise.resolve().then(() => run(data)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(`daemon not up within ${budgetMs} ms`), budgetMs); }),
  ]).finally(() => clearTimeout(timer));
  if (note) console.error(`[mcp-headers] ${note}`);
  const { ensureToken } = await import(pathToFileURL(path.join(root, 'servers', 'brain-server', 'lib', 'daemon-common.js')).href);
  const token = ensureToken(data);
  if (!token) throw new Error(`no brain daemon token in ${data}`);
  return { Authorization: `Bearer ${token}` };
}

if (require.main === module) {
  headers({ argvDataDir: process.argv[2] })
    // Exit right after printing: an ensure still waiting past the budget must not hold
    // the client (the daemon child is detached and outlives this process).
    .then((h) => { process.stdout.write(JSON.stringify(h), () => process.exit(0)); })
    .catch((err) => { console.error(`[mcp-headers] ${err.message}`); process.exit(1); });
}

module.exports = { headers };
