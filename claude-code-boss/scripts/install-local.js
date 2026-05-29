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
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_NAME = 'claude-code-boss';
const INSTALLED_PLUGINS = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

// ── Resolve SHA ──────────────────────────────────────────────────────────────
let sha;
try {
  sha = cp.execSync('git rev-parse --short=12 HEAD', { cwd: PLUGIN_ROOT, encoding: 'utf-8' }).trim();
} catch {
  sha = `dev-${Date.now()}`;
}

// ── Detect the actual installed identity (no hardcoded marketplace) ───────────
const registry = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, 'utf-8'));
const keys = Object.keys(registry.plugins || {}).filter(k => k.split('@')[0] === PLUGIN_NAME);
if (keys.length === 0) {
  throw new Error(`No "${PLUGIN_NAME}@<marketplace>" entry in installed_plugins.json — install it via marketplace first.`);
}
if (keys.length > 1) {
  console.warn(`[install-local] ⚠️ multiple identities found: ${keys.join(', ')} — updating the first.`);
}
const key = keys[0];
const entry = registry.plugins[key][0];

// Cache base = the parent of the current installPath (follows the real layout),
// falling back to the conventional cache path derived from the identity.
const marketplace = key.split('@')[1] || 'local';
const CACHE_BASE = entry.installPath
  ? path.dirname(entry.installPath)
  : path.join(os.homedir(), '.claude', 'plugins', 'cache', marketplace, PLUGIN_NAME);
const TARGET = path.join(CACHE_BASE, sha);

// Data dir resolved by the official rule (id with non-[a-zA-Z0-9_-] -> '-').
const dataId  = key.replace(/[^a-zA-Z0-9_-]/g, '-');
const DATA_DIR = path.join(os.homedir(), '.claude', 'plugins', 'data', dataId);

// ── copyDir ──────────────────────────────────────────────────────────────────
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`\n[install-local] identity=${key}  sha=${sha}`);
console.log(`  code (src)   ${PLUGIN_ROOT}`);
console.log(`  code (dst)   ${TARGET}`);
console.log(`  data dir     ${DATA_DIR}${fs.existsSync(DATA_DIR) ? '' : '  (will be created on first use)'}\n`);

if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
copyDir(PLUGIN_ROOT, TARGET);

entry.installPath  = TARGET;
entry.version      = sha;
entry.gitCommitSha = sha;
entry.lastUpdated  = new Date().toISOString();
fs.writeFileSync(INSTALLED_PLUGINS, JSON.stringify(registry, null, 2));

console.log(`✅  installed ${key} sha=${sha}`);
console.log(`   Code + data resolve to the identity above. Restart Claude Code to load.\n`);
