#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const VERSION_PATH = path.join(__dirname, 'plugin-version.json');
const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(PLUGINS_DIR, 'data', 'claude-code-boss');
const LAST_CHECK_PATH = path.join(STATE_DIR, 'plugin-update-check.json');
const INSTALLED_PLUGINS_PATH = path.join(PLUGINS_DIR, 'installed_plugins.json');
const MARKETPLACE_CLONE = path.join(PLUGINS_DIR, 'marketplaces', 'allansantos-plugins');
const PLUGIN_KEY = 'claude-code-boss@allansantos-plugins';

// Files/dirs to preserve during update (user-customized config)
const PRESERVE = ['config/brain-config.json', 'config/model-router.json', 'config/pipelines.json'];

function readManifest() {
  try { return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf-8')); }
  catch { return { version: '0.0.0', checkInterval: 86400000 }; }
}

function readLastCheck() {
  try {
    if (fs.existsSync(LAST_CHECK_PATH)) return JSON.parse(fs.readFileSync(LAST_CHECK_PATH, 'utf-8'));
  } catch {}
  return { lastCheck: 0 };
}

function writeLastCheck(data) {
  const dir = path.dirname(LAST_CHECK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAST_CHECK_PATH, JSON.stringify(data));
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', timeout: 15000 }).toString().trim();
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function applyUpdate(sourceDir, cacheDir, newSha, newVersion) {
  // Snapshot user config before overwrite
  const preserved = {};
  for (const rel of PRESERVE) {
    const full = path.join(cacheDir, rel);
    if (fs.existsSync(full)) preserved[rel] = fs.readFileSync(full);
  }

  // Copy new files from marketplace clone to cache
  copyDir(sourceDir, cacheDir);

  // Restore user config
  for (const [rel, content] of Object.entries(preserved)) {
    fs.writeFileSync(path.join(cacheDir, rel), content);
  }

  // Update installed_plugins.json
  try {
    const reg = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS_PATH, 'utf-8'));
    const entries = reg.plugins[PLUGIN_KEY];
    if (entries && entries[0]) {
      entries[0].version = newVersion;
      entries[0].gitCommitSha = newSha;
      entries[0].lastUpdated = new Date().toISOString();
      // Rename cache dir if version folder changed
      const oldPath = entries[0].installPath;
      const newPath = oldPath.replace(/[\d.]+$/, newVersion);
      if (oldPath !== newPath && fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
        entries[0].installPath = newPath;
      }
      fs.writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(reg, null, 2));
    }
  } catch {}
}

(async () => {
  try {
    const manifest = readManifest();
    const { version: currentVersion, checkInterval } = manifest;
    const lastCheck = readLastCheck();
    const now = Date.now();

    if (now - lastCheck.lastCheck < (checkInterval || 86400000)) {
      process.stdout.write(JSON.stringify({ version: currentVersion, skipped: true, reason: 'recently checked' }));
      return;
    }

    // Marketplace clone must exist for git-based update
    if (!fs.existsSync(path.join(MARKETPLACE_CLONE, '.git'))) {
      writeLastCheck({ lastCheck: now });
      process.stdout.write(JSON.stringify({ version: currentVersion, checked: false, reason: 'no marketplace clone' }));
      return;
    }

    // Fetch silently
    try { git('fetch origin main --quiet', MARKETPLACE_CLONE); } catch {
      writeLastCheck({ lastCheck: now });
      process.stdout.write(JSON.stringify({ version: currentVersion, checked: false, reason: 'fetch failed' }));
      return;
    }

    const localSha  = git('rev-parse HEAD', MARKETPLACE_CLONE);
    const remoteSha = git('rev-parse origin/main', MARKETPLACE_CLONE);

    writeLastCheck({ lastCheck: now, localSha, remoteSha });

    if (localSha === remoteSha) {
      process.stdout.write(JSON.stringify({ version: currentVersion, upToDate: true }));
      return;
    }

    // Pull and get new version
    git('pull origin main --quiet', MARKETPLACE_CLONE);
    const newSha = git('rev-parse HEAD', MARKETPLACE_CLONE);

    let newVersion = currentVersion;
    try {
      const newManifest = JSON.parse(
        fs.readFileSync(path.join(MARKETPLACE_CLONE, 'claude-code-boss', 'scripts', 'plugin-version.json'), 'utf-8')
      );
      newVersion = newManifest.version || currentVersion;
    } catch {}

    const sourceDir = path.join(MARKETPLACE_CLONE, 'claude-code-boss');
    const cacheDir = PLUGIN_ROOT;

    applyUpdate(sourceDir, cacheDir, newSha, newVersion);

    const output = [
      `[PLUGIN-UPDATE] claude-code-boss atualizado: ${currentVersion} → ${newVersion}`,
      `[PLUGIN-UPDATE] Reinicie o Claude Code para carregar a nova versão.`,
    ].join('\n');

    process.stdout.write(JSON.stringify({
      version: newVersion,
      previousVersion: currentVersion,
      updated: true,
      hookSpecificOutput: output,
    }));

  } catch (err) {
    process.stdout.write(JSON.stringify({ version: 'unknown', error: err.message }));
  }
})();
