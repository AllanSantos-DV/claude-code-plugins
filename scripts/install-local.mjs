#!/usr/bin/env node
/**
 * scripts/install-local.mjs
 *
 * Force-install the current working tree of `claude-code-boss/` into the local
 * Claude Code Desktop plugin cache, bypassing the 24h auto-update window.
 *
 * Use this BEFORE tagging a release to validate the plugin loads, hooks fire,
 * and MCP servers boot in a real Claude Code Desktop session — instead of
 * shipping blind and relying on CI alone.
 *
 * What it does:
 *  1. Reads HEAD short SHA (12 chars) — used as the cache folder name, mirroring
 *     the format Claude Code uses for git-subdir installs.
 *  2. Reads marketplace + plugin name from `.claude-plugin/marketplace.json`.
 *  3. Copies `claude-code-boss/` to
 *     `~/.claude/plugins/cache/<marketplace>/<plugin>/<sha>/`
 *     excluding `.git/`, `node_modules/`, `*.log`, `*.download`, `output-styles/`.
 *  4. Runs `npm install --omit=dev --no-audit --no-fund` in the destination —
 *     this triggers the postinstall `plugin-setup.js` which compiles native
 *     modules (sharp, better-sqlite3) for the current platform.
 *  5. Updates `~/.claude/plugins/installed_plugins.json` to point at the new
 *     cache folder + SHA (backup of the old file is written alongside).
 *  6. Prints next steps (restart Claude Code Desktop, run smoke checks).
 *
 * Safety:
 *  - Refuses to run if the working tree has uncommitted changes (override with --dirty).
 *  - Backups installed_plugins.json before mutating.
 *  - Does NOT delete the previous cache folder (manual cleanup if you want).
 *
 * Usage:
 *   node scripts/install-local.mjs              # standard flow
 *   node scripts/install-local.mjs --dirty      # allow uncommitted working tree
 *   node scripts/install-local.mjs --no-install # skip npm install (faster, but no native rebuild)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'claude-code-boss');
const MARKETPLACE_JSON = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const CLAUDE_PLUGINS = path.join(os.homedir(), '.claude', 'plugins');
const REGISTRY = path.join(CLAUDE_PLUGINS, 'installed_plugins.json');

const args = new Set(process.argv.slice(2));
const ALLOW_DIRTY = args.has('--dirty');
const SKIP_INSTALL = args.has('--no-install');

const EXCLUDE = new Set(['.git', 'node_modules', 'output-styles']);
const EXCLUDE_EXT = new Set(['.log', '.download']);

function log(msg) { process.stdout.write(`[install-local] ${msg}\n`); }
function die(msg) { process.stderr.write(`[install-local] ERROR: ${msg}\n`); process.exit(1); }

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf-8', ...opts }).trim();
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    if (EXCLUDE_EXT.has(path.extname(entry.name))) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── 1. Validate state ─────────────────────────────────────────────────────
log('checking git state…');
const status = git('status --porcelain');
if (status && !ALLOW_DIRTY) {
  die(`working tree has uncommitted changes (use --dirty to override):\n${status}`);
}
const sha = git('rev-parse --short=12 HEAD');
const fullSha = git('rev-parse HEAD');
log(`HEAD: ${fullSha} (${sha})`);

// ─── 2. Read marketplace + plugin names ────────────────────────────────────
if (!fs.existsSync(MARKETPLACE_JSON)) die(`marketplace.json not found at ${MARKETPLACE_JSON}`);
const mp = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, 'utf-8'));
const marketplaceName = mp.name;
const pluginEntry = (mp.plugins || []).find(p => p.source?.path === 'claude-code-boss' || p.name === 'claude-code-boss');
if (!pluginEntry) die('plugin entry for claude-code-boss not found in marketplace.json');
const pluginName = pluginEntry.name;
log(`marketplace: ${marketplaceName}  plugin: ${pluginName}`);

// ─── 3. Compute destination ────────────────────────────────────────────────
const destDir = path.join(CLAUDE_PLUGINS, 'cache', marketplaceName, pluginName, sha);
if (fs.existsSync(destDir)) {
  log(`destination already exists, removing: ${destDir}`);
  fs.rmSync(destDir, { recursive: true, force: true });
}
log(`copying plugin → ${destDir}`);
copyTree(PLUGIN_DIR, destDir);

// ─── 4. npm install (triggers postinstall = plugin-setup.js) ───────────────
if (!SKIP_INSTALL) {
  log('running npm install (this may take a minute — native compile for sharp/better-sqlite3)…');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund', {
      cwd: destDir,
      stdio: 'inherit',
      timeout: 5 * 60 * 1000,
    });
  } catch (err) {
    die(`npm install failed: ${err.message}`);
  }
} else {
  log('SKIPPED npm install (--no-install); native modules will be missing');
}

// ─── 5. Update installed_plugins.json ──────────────────────────────────────
log(`updating registry: ${REGISTRY}`);
let registry;
if (fs.existsSync(REGISTRY)) {
  const backup = `${REGISTRY}.bak.${Date.now()}`;
  fs.copyFileSync(REGISTRY, backup);
  log(`backed up registry → ${backup}`);
  registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
} else {
  registry = { version: 2, plugins: {} };
}
if (!registry.plugins) registry.plugins = {};

const key = `${pluginName}@${marketplaceName}`;
const existing = registry.plugins[key]?.[0] || {};
registry.plugins[key] = [{
  scope: existing.scope || 'user',
  installPath: destDir,
  version: sha,
  installedAt: existing.installedAt || new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
  gitCommitSha: sha,
}];
fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));

// ─── 6. Next steps ─────────────────────────────────────────────────────────
log('');
log('✓ install complete.');
log('');
log('Next steps:');
log('  1. Restart Claude Code Desktop (full quit + reopen) to load the new plugin.');
log('  2. In a Claude Code session, validate:');
log('     - /plugin list                        → claude-code-boss shows the new SHA');
log('     - hooks fire (e.g. run a Bash command, check brain-retrieve injects context)');
log('     - MCP tools resolve (e.g. brain_search, brain_store)');
log('     - skills load (e.g. /skill or trigger curation-stop in a turn)');
log('  3. If anything breaks, REVERT before tagging:');
log('     - Restore registry: cp <backup> ' + REGISTRY);
log('     - Or reinstall previous version: /plugin uninstall + /plugin install');
log('');
log('Once validated → safe to git tag and push (release.yml will publish).');
