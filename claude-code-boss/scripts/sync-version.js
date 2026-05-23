#!/usr/bin/env node
/**
 * sync-version.js — propagates version from package.json (single source of truth)
 * to plugin-version.json and .claude-plugin/plugin.json.
 *
 * Usage:
 *   node scripts/sync-version.js              # reads version from package.json
 *   node scripts/sync-version.js 1.3.0        # overrides with explicit version
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
console.log(`  package.json          → ${version}`);
console.log(`  plugin-version.json   → ${version}`);
console.log(`  .claude-plugin/plugin.json → ${version}`);
