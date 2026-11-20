#!/usr/bin/env node
/**
 * mcp-headers.js — `headersHelper` of the brain-server entry in plugin.json.
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

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

// Claude Code kills the helper at 10 s; node's own start-up under load eats part of that.
const ENSURE_BUDGET_MS = 5000;
const PROBE_BUDGET_MS = 1000;

/**
 * Whether the daemon's `/health` answers on `port` within `timeoutMs`; never rejects.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function daemonAnswers(port, timeoutMs = PROBE_BUDGET_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * The `Authorization` header for the brain daemon. A daemon that already answers needs no ensure
 * (the helper then costs one file read), so a restart under load cannot push it past the client's
 * limit: a client that gets no header falls into OAuth registration (HTTP 404) and stays
 * disconnected for the whole session.
 *
 * @param {{argvDataDir?:string, root?:string, ensure?:Function, budgetMs?:number, probe?:(port:number)=>Promise<boolean>}} [opts]
 * @returns {Promise<{Authorization:string}>}
 */
async function headers({ argvDataDir, root = path.resolve(__dirname, '..'), ensure, budgetMs = ENSURE_BUDGET_MS, probe = daemonAnswers } = {}) {
  const { validEnvDir, dataDir } = require('../engine/lib/data-dir.js');
  // Same data dir the plugin's hooks resolve (they get CLAUDE_PLUGIN_DATA in their env).
  if (validEnvDir(argvDataDir)) process.env.CLAUDE_PLUGIN_DATA = argvDataDir;
  const data = dataDir();
  require('./lib/mcp-launcher.js').installLauncher(validEnvDir(argvDataDir) || data);
  const { ensureToken, resolvePort } = await import(pathToFileURL(path.join(root, 'servers', 'brain-server', 'lib', 'daemon-common.js')).href);
  const within = (work, ms, onTimeout) => {
    let timer;
    return Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
    ]).finally(() => clearTimeout(timer));
  };
  if (!(await within(() => probe(resolvePort(data)), PROBE_BUDGET_MS, false))) {
    const run = ensure || ((d) => require('./brain-daemon-ensure.js').run({ hook_event_name: 'headersHelper' }, { root, data: d }));
    const note = await within(() => run(data), budgetMs, `daemon not up within ${budgetMs} ms`);
    if (note) console.error(`[mcp-headers] ${note}`);
  }
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
