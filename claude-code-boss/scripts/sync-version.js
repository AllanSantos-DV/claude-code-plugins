#!/usr/bin/env node
/**
 * sync-version.js — single source of truth for plugin version.
 *
 * Propagates version to all version-bearing files and validates sync.
 *
 * Usage:
 *   node scripts/sync-version.js 1.4.0   # bump to explicit version
 *   node scripts/sync-version.js         # re-sync from package.json (no bump)
 *   node scripts/sync-version.js --check # dry-run: exit 0 if all in sync, 1 if not
 *
 * Files managed:
 *   claude-code-boss/package.json
 *   README.md (repo root)     — table row  | claude-code-boss | X.Y.Z |
 *   claude-code-boss/README.md — badge/table row and **vX.Y.Z** references
 *
 * NOTE: servers/boss-server/package.json and servers/brain-server/package.json
 *       are independent MCP packages with their own version lifecycle — NOT synced.
 *
 * Release flow (all local, no CI involvement):
 *   node scripts/sync-version.js 1.4.0
 *   git add claude-code-boss/package.json README.md claude-code-boss/README.md
 *   git commit -m "chore: bump version to 1.4.0"
 *   git tag v1.4.0
 *   git push origin main --tags
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..');

const CHECK_MODE = process.argv.includes('--check');
const explicitVersion = process.argv.find(a => /^\d+\.\d+\.\d+$/.test(a));

// --- read canonical version from package.json ---
const pkgPath = path.join(PLUGIN_ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const version = explicitVersion || pkg.version;
if (!version) { console.error('No version found'); process.exit(1); }

/**
 * Each descriptor: { path, read, write, check }
 *   read()  → current version string found in file
 *   write() → update file to new version (only called when !CHECK_MODE)
 */

function jsonVersionFile(filePath, ...keys) {
  return {
    path: filePath,
    read() {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let cur = obj;
      for (const k of keys) cur = cur[k];
      return cur;
    },
    write() {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
      cur[keys[keys.length - 1]] = version;
      if (filePath === pkgPath && !explicitVersion) return; // don't touch pkg if no explicit bump
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
    },
  };
}

function markdownTableFile(filePath, pluginName) {
  // Matches: | pluginName | X.Y.Z | ... — tolerating markdown bold/link wrappers
  // around the name, e.g. | [**pluginName**](./path) | X.Y.Z |
  const re = new RegExp(`(\\|\\s*\\[?\\*{0,2}${pluginName}\\*{0,2}\\]?[^|]*\\|\\s*)([0-9]+\\.[0-9]+\\.[0-9]+)(\\s*\\|)`, 'g');
  return {
    path: filePath,
    read() {
      const content = fs.readFileSync(filePath, 'utf-8');
      const m = re.exec(content);
      re.lastIndex = 0;
      return m ? m[2] : null;
    },
    write() {
      let content = fs.readFileSync(filePath, 'utf-8');
      content = content.replace(re, (_, pre, _ver, post) => `${pre}${version}${post}`);
      re.lastIndex = 0;
      fs.writeFileSync(filePath, content);
    },
  };
}

function markdownBoldVersionFile(filePath) {
  // Matches: **vX.Y.Z** or — vX.Y.Z
  const re = /(\*\*v)[0-9]+\.[0-9]+\.[0-9]+(\*\*)/g;
  return {
    path: filePath,
    read() {
      const content = fs.readFileSync(filePath, 'utf-8');
      const m = re.exec(content);
      re.lastIndex = 0;
      return m ? content.match(/\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/)?.[1] : null;
    },
    write() {
      let content = fs.readFileSync(filePath, 'utf-8');
      content = content.replace(re, (_, pre, post) => `${pre}${version}${post}`);
      re.lastIndex = 0;
      fs.writeFileSync(filePath, content);
    },
  };
}

const FILES = [
  jsonVersionFile(pkgPath, 'version'),
  markdownTableFile(path.join(REPO_ROOT, 'README.md'), 'claude-code-boss'),
  markdownBoldVersionFile(path.join(PLUGIN_ROOT, 'README.md')),
];

// ─── Check or Sync ──────────────────────────────────────────────────────────

let allInSync = true;
const report = [];

for (const f of FILES) {
  const rel = path.relative(REPO_ROOT, f.path);
  let current;
  try {
    current = f.read();
  } catch (err) {
    console.error(`[sync-version] Cannot read ${rel}: ${err.message}`);
    process.exit(1);
  }

  if (current === null) {
    // Pattern not found — file may not have a version reference; skip silently
    report.push(`  ${rel.padEnd(50)} (no version pattern — skipped)`);
    continue;
  }

  const inSync = current === version;
  if (!inSync) allInSync = false;

  if (CHECK_MODE) {
    const mark = inSync ? '✓' : '✗';
    report.push(`  ${mark} ${rel.padEnd(50)} ${inSync ? `${current}` : `${current} → should be ${version}`}`);
  } else {
    f.write();
    report.push(`  ${rel.padEnd(50)} → ${version}`);
  }
}

if (CHECK_MODE) {
  console.log(`[sync-version] --check  (canonical: ${version})\n`);
  report.forEach(l => console.log(l));
  if (allInSync) {
    console.log('\n✅ All version references are in sync.');
    process.exit(0);
  } else {
    console.error('\n❌ Version mismatch detected. Run: node scripts/sync-version.js');
    process.exit(1);
  }
} else {
  console.log(`[sync-version] version synced to ${version}\n`);
  report.forEach(l => console.log(l));
  console.log('');
  if (explicitVersion) {
    console.log('Next steps to release:');
    console.log(`  git add claude-code-boss/package.json README.md claude-code-boss/README.md`);
    console.log(`  git commit -m "chore: bump version to ${version}"`);
    console.log(`  git tag v${version}`);
    console.log(`  git push origin main --tags`);
  }
}
