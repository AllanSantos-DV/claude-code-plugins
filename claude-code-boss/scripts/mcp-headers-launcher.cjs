#!/usr/bin/env node
/**
 * mcp-headers-launcher.cjs — version-proof entry of the brain-server `headersHelper`.
 *
 * A copy of this file lives in the plugin data dir (`${CLAUDE_PLUGIN_DATA}`, kept across
 * updates), written by `scripts/lib/mcp-launcher.js`. `.mcp.json` runs it instead of a script
 * under `${CLAUDE_PLUGIN_ROOT}`: a session keeps the plugin dir it started with, and an update
 * or a prune removes that dir while the session lives. The helper then died before printing
 * the token, the client connected without it, fell into OAuth registration (HTTP 404) and gave
 * up, taking every `mcp_tool` hook of the session down with it.
 *
 * The launcher picks the plugin dir at run time (registry install, the session's own dir, then
 * any intact dir in the cache) and delegates to that dir's `scripts/mcp-headers.js`.
 * Contract: one JSON object on stdout and exit 0; exit 1 with the causes on stderr otherwise.
 * Self-contained on purpose: Node core only, no relative requires.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = 'claude-code-boss';
const HELPER = path.join('scripts', 'mcp-headers.js');

function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Plugin dirs worth trying, best first, without duplicates. */
function candidateRoots(env = process.env) {
  const out = [];
  const add = (p) => { if (p && !String(p).includes('${') && !out.includes(String(p))) out.push(String(p)); };
  const cacheDirs = [];
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(configDir(env), 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, list] of Object.entries(reg.plugins || {})) {
      if (!key.startsWith(`${PLUGIN}@`) || !Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || !e.installPath) continue;
        add(e.installPath);
        cacheDirs.push(path.dirname(String(e.installPath)));
      }
    }
  } catch (err) { console.error(`[mcp-headers-launcher] registry unreadable: ${err.message}`); }
  add(env.CLAUDE_PLUGIN_ROOT);
  for (const base of new Set(cacheDirs)) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (err) { console.error(`[mcp-headers-launcher] cannot list ${base}: ${err.message}`); }
    const stamped = names.flatMap((n) => {
      try { return [{ p: path.join(base, n), t: fs.statSync(path.join(base, n)).mtimeMs }]; } catch (err) { void err; return []; }
    });
    stamped.sort((a, b) => b.t - a.t).forEach((s) => add(s.p));
  }
  return out;
}

/** Print the headers of the first plugin dir that can produce them; throws with every cause when none can. */
async function launch(argvDataDir, env = process.env) {
  const causes = [];
  for (const root of candidateRoots(env)) {
    const helper = path.join(root, HELPER);
    if (!fs.existsSync(helper)) { causes.push(`${root}: no ${HELPER}`); continue; }
    try {
      return await require(helper).headers({ argvDataDir, root });
    } catch (err) { causes.push(`${root}: ${err.message}`); }
  }
  throw new Error(`no usable ${PLUGIN} install (${causes.join('; ') || 'none found'})`);
}

if (require.main === module) {
  launch(process.argv[2])
    .then((h) => { process.stdout.write(JSON.stringify(h), () => process.exit(0)); })
    .catch((err) => { console.error(`[mcp-headers-launcher] ${err.message}`); process.exit(1); });
}

module.exports = { launch, candidateRoots };
