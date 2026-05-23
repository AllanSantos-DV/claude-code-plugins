#!/usr/bin/env node
/**
 * sync-version.js — single source of truth for plugin version.
 *
 * Propagates version to all three version files and prints the git
 * commands needed to commit + tag + push the release.
 *
 * Usage:
 *   node scripts/sync-version.js 1.4.0       # bump to explicit version
 *   node scripts/sync-version.js             # re-sync from package.json (no bump)
 *
 * Release flow (all local, no CI involvement):
 *   node scripts/sync-version.js 1.4.0
 *   git add package.json scripts/plugin-version.json .claude-plugin/plugin.json
 *   git commit -m "chore: bump version to 1.4.0"
 *   git tag v1.4.0
 *   git push origin main --tags
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// --- read version ---
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = process.argv[2] || pkg.version;
if (!version) { console.error('No version found'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);

// --- plugin-version.json ---
const pvPath = path.join(ROOT, 'scripts', 'plugin-version.json');
const pv = JSON.parse(fs.readFileSync(pvPath, 'utf-8'));
pv.version = version;
pv.releaseDate = today;
fs.writeFileSync(pvPath, JSON.stringify(pv, null, 2) + '\n');

// --- .claude-plugin/plugin.json ---
const plPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
const pl = JSON.parse(fs.readFileSync(plPath, 'utf-8'));
pl.version = version;
fs.writeFileSync(plPath, JSON.stringify(pl, null, 2) + '\n');

// --- package.json (if explicit version passed) ---
if (process.argv[2]) {
  pkg.version = version;
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

console.log(`[sync-version] version synced to ${version}`);
console.log(`  package.json               → ${version}`);
console.log(`  scripts/plugin-version.json → ${version}`);
console.log(`  .claude-plugin/plugin.json  → ${version}`);
console.log('');
console.log('Next steps to release:');
console.log(`  git add claude-code-boss/package.json claude-code-boss/scripts/plugin-version.json claude-code-boss/.claude-plugin/plugin.json`);
console.log(`  git commit -m "chore: bump version to ${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin main --tags`);
