#!/usr/bin/env node
/**
 * install-local.js — Copy the current working tree into the Claude Code Desktop
 * plugin cache so local changes are testable before publishing.
 *
 * Usage:
 *   node claude-code-boss/scripts/install-local.js
 *
 * Uses the current git commit SHA as the cache-dir name (falls back to
 * "dev-<timestamp>" when not inside a git repo). Restart Claude Code Desktop
 * after running to pick up the new version.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

// ── Resolve SHA ──────────────────────────────────────────────────────────────
let sha;
try {
  sha = cp.execSync('git rev-parse --short=12 HEAD', { cwd: PLUGIN_ROOT, encoding: 'utf-8' }).trim();
} catch {
  sha = `dev-${Date.now()}`;
}

// ── Paths ────────────────────────────────────────────────────────────────────
const CACHE_BASE       = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'allansantos-plugins', 'claude-code-boss');
const TARGET           = path.join(CACHE_BASE, sha);
const INSTALLED_PLUGINS = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

// ── copyDir ──────────────────────────────────────────────────────────────────
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`\n[install-local] sha=${sha}`);
console.log(`  src  ${PLUGIN_ROOT}`);
console.log(`  dst  ${TARGET}\n`);

if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
copyDir(PLUGIN_ROOT, TARGET);

// Update installed_plugins.json so Claude Code Desktop resolves the new path
const registry = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, 'utf-8'));
const key   = 'claude-code-boss@allansantos-plugins';
const entry = registry.plugins?.[key]?.[0];
if (!entry) throw new Error(`Plugin key "${key}" not found in installed_plugins.json — is the plugin installed via marketplace first?`);
entry.installPath  = TARGET;
entry.version      = sha;
entry.gitCommitSha = sha;
entry.lastUpdated  = new Date().toISOString();
fs.writeFileSync(INSTALLED_PLUGINS, JSON.stringify(registry, null, 2));

console.log(`✅  installed sha=${sha}\n   Restart Claude Code Desktop to load.\n`);
