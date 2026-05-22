#!/usr/bin/env node
/**
 * Session Whitelist — SessionStart hook.
 *
 * Detects project ecosystem from manifest files and populates the whitelist
 * in .vscode/shells.json. Whitelisted command prefixes pass through the
 * curation guard without needing a curated script entry.
 *
 * Runs once per session (SessionStart), idempotent — preserves user additions.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Ecosystem → whitelist mapping
// ONLY commands that are: idempotent, non-destructive, small-output, high-frequency
// Build/test tools (npm, npx, pip, cargo, dotnet, etc.) are NOT whitelisted —
// they need curated scripts via shells.json because their output can be huge.
const ECOSYSTEM_WHITELISTS = {
  node: ['git', 'gh', 'code', 'code.cmd'],
  python: ['git', 'gh', 'code', 'code.cmd'],
  rust: ['git', 'gh', 'code', 'code.cmd'],
  dotnet: ['git', 'gh', 'code', 'code.cmd'],
  java: ['git', 'gh', 'code', 'code.cmd'],
  go: ['git', 'gh', 'code', 'code.cmd'],
  ruby: ['git', 'gh', 'code', 'code.cmd'],
  php: ['git', 'gh', 'code', 'code.cmd'],
  docker: ['git', 'gh', 'code', 'code.cmd'],
  generic: ['git', 'gh', 'code', 'code.cmd'],
};

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

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function detectEcosystem(projectRoot) {
  if (!projectRoot || !fs.existsSync(projectRoot)) return 'generic';
  const entries = fs.readdirSync(projectRoot);

  for (const { file, ecosystem } of MANIFEST_ECOSYSTEM) {
    if (file.includes('*')) {
      // Glob-like pattern — check extension
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
  } catch {
    return null;
  }
}

(async () => {
  try {
    const raw = await readStdin();
    const event = raw ? JSON.parse(raw) : {};

    const projectRoot = event.cwd
      ? (() => {
          let dir = event.cwd;
          for (let i = 0; i < 10; i++) {
            if (fs.existsSync(path.join(dir, '.vscode'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
          return event.cwd;
        })()
      : process.cwd();

    if (!fs.existsSync(path.join(projectRoot, '.vscode'))) {
      // No .vscode dir — nothing to whitelist
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const shellsPath = path.join(projectRoot, '.vscode', 'shells.json');
    const existingConfig = loadExistingConfig(shellsPath);

    // Detect ecosystem
    const ecosystem = detectEcosystem(projectRoot);
    const ecosystemWhitelist = ECOSYSTEM_WHITELISTS[ecosystem] || ECOSYSTEM_WHITELISTS.generic;

    // Merge: preserve existing whitelist entries, add ecosystem defaults
    const existingWhitelist = existingConfig?.whitelist || [];
    const merged = [...new Set([...existingWhitelist, ...ecosystemWhitelist])].sort();

    // Only write if changed
    if (JSON.stringify(existingWhitelist) === JSON.stringify(merged)) {
      process.stdout.write(JSON.stringify({ ecosystem, whitelist: merged, changed: false }));
      return;
    }

    // Write merged config
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
