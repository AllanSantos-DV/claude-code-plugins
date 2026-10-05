#!/usr/bin/env node
/**
 * install-local.js — Copy the current working tree into the Claude Code plugin
 * cache so local changes are testable before publishing.
 *
 * Usage:
 *   node claude-code-boss/scripts/install-local.js
 *
 * Identity-robust: it does NOT hardcode the marketplace. It finds the actual
 * `claude-code-boss@<marketplace>` entry in installed_plugins.json and updates
 * THAT one, deriving the cache base from its existing installPath. It also prints
 * the resolved CLAUDE_PLUGIN_DATA directory so the data namespace is never a
 * surprise.
 *
 * Plugin data dir rule (official, docs/plugins-reference): CLAUDE_PLUGIN_DATA =
 * ~/.claude/plugins/data/{id}/ where {id} is the plugin identifier with chars
 * outside [a-zA-Z0-9_-] replaced by '-'. So `claude-code-boss@allansantos-plugins`
 * -> data/claude-code-boss-allansantos-plugins/. (A `@inline` identity -> the
 * `-inline` data dir.) Code (this cache) and data (that dir) are separate
 * namespaces; this tool reports both.
 *
 * Safe with live sessions (2026-10-05: a run of the old version took every open
 * session's brain-server down for good): it never deletes an existing cache dir
 * (the shared brain daemon may be running from it — removing it crashed the daemon),
 * backs up the registry, and brings the daemon up from the new install right away,
 * so open sessions reconnect inside Claude Code's ~15 s retry window.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_NAME = 'claude-code-boss';
// Runtime/dev junk never shipped into the cache.
const SKIP_DIRS = new Set(['.runtime', '.token-guard', 'coverage']);

/**
 * The cache dir to install into: `<base>/<sha>`, or — when that already exists (a
 * re-install of the same commit, possibly the one the live daemon runs from) — a
 * fresh `<base>/<sha>-<suffix>`. Never an existing dir.
 */
function chooseTarget(base, sha, exists = fs.existsSync, suffix = () => Date.now().toString(36)) {
  const first = path.join(base, sha);
  if (!exists(first)) return first;
  for (let i = 0; i < 20; i++) {
    const alt = path.join(base, `${sha}-${suffix()}${i ? `-${i}` : ''}`);
    if (!exists(alt)) return alt;
  }
  throw new Error(`no free cache dir for ${sha} under ${base}`);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Stop a daemon of ANOTHER install on the port and start this one's (≈1 s outage). */
async function handOffDaemon(target) {
  const port = Number(process.env.BRAIN_HTTP_PORT) || 38217;
  const health = async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json(); }
    catch (err) { void err; return null; }
  };
  const norm = (p) => path.resolve(String(p || '')).toLowerCase();
  const h = await health();
  if (h && h.pid && norm(h.pluginRoot) !== norm(target)) {
    try { process.kill(h.pid); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    for (let i = 0; i < 50 && await health(); i++) await new Promise((r) => setTimeout(r, 100));
    console.log(`  stopped the old daemon pid ${h.pid} (${h.pluginRoot})`);
  }
  const r = cp.spawnSync(process.execPath, [path.join(target, 'scripts', 'brain-daemon-ensure.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'install-local', cwd: target }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: target },
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || (out && out !== '{}')) throw new Error(`brain daemon did not come up from ${target} (exit ${r.status}): ${out || r.stderr}`);
  const up = await health();
  if (!up || norm(up.pluginRoot) !== norm(target)) throw new Error(`the daemon on port ${port} is not the new install (${up ? up.pluginRoot : 'no answer'})`);
  console.log(`  brain daemon up from the new install (pid ${up.pid})`);
}

async function main() {
  const INSTALLED_PLUGINS = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

  let sha;
  try {
    sha = cp.execSync('git rev-parse --short=12 HEAD', { cwd: PLUGIN_ROOT, encoding: 'utf-8', windowsHide: true }).trim();
  } catch (err) {
    console.error(`[install-local] git sha unavailable (${err.message}) — using a dev id`);
    sha = `dev-${Date.now()}`;
  }

  // Detect the actual installed identity (no hardcoded marketplace).
  const registry = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, 'utf-8'));
  const keys = Object.keys(registry.plugins || {}).filter((k) => k.split('@')[0] === PLUGIN_NAME);
  if (keys.length === 0) throw new Error(`No "${PLUGIN_NAME}@<marketplace>" entry in installed_plugins.json — install it via marketplace first.`);
  if (keys.length > 1) console.warn(`[install-local] ⚠️ multiple identities found: ${keys.join(', ')} — updating the first.`);
  const key = keys[0];
  const entry = registry.plugins[key][0];

  // Cache base = the parent of the current installPath (follows the real layout),
  // falling back to the conventional cache path derived from the identity.
  const marketplace = key.split('@')[1] || 'local';
  const CACHE_BASE = entry.installPath
    ? path.dirname(entry.installPath)
    : path.join(os.homedir(), '.claude', 'plugins', 'cache', marketplace, PLUGIN_NAME);
  const TARGET = chooseTarget(CACHE_BASE, sha);

  // Data dir resolved by the official rule (id with non-[a-zA-Z0-9_-] -> '-').
  const dataId = key.replace(/[^a-zA-Z0-9_-]/g, '-');
  const DATA_DIR = path.join(os.homedir(), '.claude', 'plugins', 'data', dataId);

  console.log(`\n[install-local] identity=${key}  sha=${sha}`);
  console.log(`  code (src)   ${PLUGIN_ROOT}`);
  console.log(`  code (dst)   ${TARGET}`);
  console.log(`  data dir     ${DATA_DIR}${fs.existsSync(DATA_DIR) ? '' : '  (will be created on first use)'}\n`);

  copyDir(PLUGIN_ROOT, TARGET);

  const backup = `${INSTALLED_PLUGINS}.bak.${Date.now()}`;
  fs.copyFileSync(INSTALLED_PLUGINS, backup);
  console.log(`  registry backup ${backup}`);
  entry.installPath = TARGET;
  entry.version = sha;
  entry.gitCommitSha = sha;
  entry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(INSTALLED_PLUGINS, JSON.stringify(registry, null, 2));

  await handOffDaemon(TARGET);

  console.log(`✅  installed ${key} sha=${sha}`);
  console.log('   Run /reload-plugins in open sessions to load the new plugin code.\n');
}

if (require.main === module) {
  main().catch((err) => { console.error(`[install-local] FAILED: ${err.message}`); process.exit(1); });
}

module.exports = { chooseTarget, copyDir, SKIP_DIRS };
