#!/usr/bin/env node
/**
 * plugin-setup.js — runs after npm install (postinstall) and after plugin updates.
 * Ensures native modules (sharp, better-sqlite3) are compiled for the current platform.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: PLUGIN_ROOT, timeout: 120000, ...opts });
    return true;
  } catch {
    return false;
  }
}

function needsInstall() {
  const nm = path.join(PLUGIN_ROOT, 'node_modules');
  if (!fs.existsSync(nm)) return true;
  // Check if sharp binary exists for current platform
  try {
    require(path.join(nm, 'sharp'));
    return false;
  } catch {
    return true;
  }
}

(async () => {
  if (!needsInstall()) {
    process.stdout.write('[plugin-setup] Dependencies OK\n');
    return;
  }

  process.stdout.write('[plugin-setup] Installing dependencies...\n');

  // Install all deps
  const ok = run('npm install --prefer-offline --no-audit --no-fund');
  if (!ok) {
    // Fallback: install sharp for explicit platform
    const plat = process.platform;
    const arch = process.arch;
    run(`npm install --platform=${plat} --arch=${arch} sharp --no-audit --no-fund`);
  }

  process.stdout.write('[plugin-setup] Done\n');
})();
