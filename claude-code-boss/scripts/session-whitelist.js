#!/usr/bin/env node
/**
 * Session Whitelist — SessionStart hook.
 *
 * Detects project ecosystem from manifest files and populates the whitelist
 * in the curated shells config (path resolved via curation-paths.js).
 * Whitelisted command prefixes pass through the curation guard without
 * needing a curated script entry.
 *
 * Runs once per session (SessionStart), idempotent — preserves user additions.
 */
const fs = require('fs');
const path = require('path');

const { loadCurationConfig, findProjectRoot, getShellsConfigPath } = require('./curation-paths.js');
const { readStdin } = require('./lib/hook-io.js');

// Safe defaults applied regardless of ecosystem: idempotent, non-destructive,
// small-output, high-frequency commands.
// Build/test tools (npm, pip, cargo, dotnet, ...) are intentionally NOT
// whitelisted — they need curated scripts because their output can be huge.
const BASE_WHITELIST = ['git', 'gh', 'code', 'code.cmd'];

const MANIFEST_ECOSYSTEM = [
  { file: 'package.json', ecosystem: 'node' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'requirements.txt', ecosystem: 'python' },
  { file: 'setup.py', ecosystem: 'python' },
  { file: 'Cargo.toml', ecosystem: 'rust' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Gemfile', ecosystem: 'ruby' },
  { file: 'composer.json', ecosystem: 'php' },
  { file: 'pom.xml', ecosystem: 'java' },
  { file: 'build.gradle', ecosystem: 'java' },
  { file: 'Dockerfile', ecosystem: 'docker' },
  { file: 'docker-compose.yml', ecosystem: 'docker' },
  { file: '*.csproj', ecosystem: 'dotnet' },
  { file: '*.sln', ecosystem: 'dotnet' },
];

function detectEcosystem(projectRoot) {
  if (!projectRoot || !fs.existsSync(projectRoot)) return 'generic';
  const entries = fs.readdirSync(projectRoot);

  for (const { file, ecosystem } of MANIFEST_ECOSYSTEM) {
    if (file.includes('*')) {
      const ext = file.replace('*', '');
      if (entries.some(e => e.endsWith(ext))) return ecosystem;
    } else if (entries.includes(file)) {
      return ecosystem;
    }
  }
  return 'generic';
}

function loadExistingConfig(shellsPath) {
  try {
    if (!fs.existsSync(shellsPath)) return null;
    return JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
  } catch (err) {
    console.error(`[SESSION-WHITELIST] config parse failed: ${err.message}`);
    return null;
  }
}

(async () => {
  try {
    const raw = await readStdin();
    const event = raw ? JSON.parse(raw) : {};

    const startCwd = event.cwd || process.cwd();
    const projectRoot = findProjectRoot(startCwd) || startCwd;
    const shellsPath = getShellsConfigPath(projectRoot)
      || path.join(projectRoot, loadCurationConfig().shellsConfigPath);

    // If the parent dir doesn't exist yet (e.g. .vscode/), bail — we won't
    // silently provision workspace structure. Attach on next SessionStart.
    if (!fs.existsSync(path.dirname(shellsPath))) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const existingConfig = loadExistingConfig(shellsPath);
    const ecosystem = detectEcosystem(projectRoot);

    // Merge: preserve existing whitelist entries, add base defaults.
    const existingWhitelist = existingConfig?.whitelist || [];
    const merged = [...new Set([...existingWhitelist, ...BASE_WHITELIST])].sort();

    if (JSON.stringify(existingWhitelist) === JSON.stringify(merged)) {
      process.stdout.write(JSON.stringify({ ecosystem, whitelist: merged, changed: false }));
      return;
    }

    const config = existingConfig || { version: 1, shells: [] };
    config.whitelist = merged;
    fs.writeFileSync(shellsPath, JSON.stringify(config, null, 2) + '\n');

    console.error(`[SESSION-WHITELIST] Detected ${ecosystem} ecosystem — whitelist: ${merged.join(', ')}`);

    process.stdout.write(JSON.stringify({ ecosystem, whitelist: merged, changed: true }));
  } catch (err) {
    console.error(`[SESSION-WHITELIST] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
