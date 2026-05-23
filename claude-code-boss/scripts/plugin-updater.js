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

const LOCK_PATH = path.join(STATE_DIR, 'updater.lock');
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 min

// Dynamic: preserve ALL config/*.json files found in cacheDir before update.
function getPreserveList(cacheDir) {
  const configDir = path.join(cacheDir, 'config');
  if (!fs.existsSync(configDir)) return [];
  return fs.readdirSync(configDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join('config', f));
}

function acquireLock() {
  // Remove stale lock (older than LOCK_STALE_MS).
  if (fs.existsSync(LOCK_PATH)) {
    const mtime = fs.statSync(LOCK_PATH).mtimeMs;
    if (Date.now() - mtime > LOCK_STALE_MS) {
      console.error('[PLUGIN-UPDATE] Removing stale lock file.');
      fs.unlinkSync(LOCK_PATH);
    }
  }
  try {
    const dir = path.dirname(LOCK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false; // another process holds lock
    throw err;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (err) { console.error(`[PLUGIN-UPDATE] Lock release error: ${err.message}`); }
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf-8')); }
  catch (err) {
    console.error(`[PLUGIN-UPDATE] Failed to read version manifest: ${err.message}`);
    return { version: '0.0.0', checkInterval: 86400000 };
  }
}

function readLastCheck() {
  try {
    if (fs.existsSync(LAST_CHECK_PATH)) return JSON.parse(fs.readFileSync(LAST_CHECK_PATH, 'utf-8'));
  } catch (err) { console.error(`[PLUGIN-UPDATE] Last check read error: ${err.message}`); }
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
  // --- Snapshot: preserve ALL config/*.json files (dynamic, not hardcoded). ---
  const preserveList = getPreserveList(cacheDir);
  const preserved = {};
  for (const rel of preserveList) {
    const full = path.join(cacheDir, rel);
    if (fs.existsSync(full)) preserved[rel] = fs.readFileSync(full);
  }

  // --- Backup: snapshot cacheDir → <cacheDir>.bak-<sha> for rollback. ---
  const backupDir = `${cacheDir}.bak-${newSha.slice(0, 8)}`;
  if (fs.existsSync(backupDir)) {
    // Remove old backup to keep only the latest
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  copyDir(cacheDir, backupDir);
  console.error(`[PLUGIN-UPDATE] Snapshot created at ${backupDir}`);

  let setupOk = false;
  try {
    // Copy new files from marketplace clone to cache
    copyDir(sourceDir, cacheDir);

    // Restore user config (overrides anything from the new source)
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
        fs.writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(reg, null, 2));
      }
    } catch (err) { console.error(`[PLUGIN-UPDATE] installed_plugins.json update error: ${err.message}`); }

    // Re-run plugin-setup (npm install etc.)
    execSync('node scripts/plugin-setup.js', { cwd: cacheDir, stdio: 'pipe', timeout: 120000 });
    setupOk = true;
  } catch (err) {
    console.error(`[PLUGIN-UPDATE] Update failed (${err.message}), rolling back from ${backupDir}`);
    copyDir(backupDir, cacheDir);
    throw err;
  } finally {
    if (setupOk) {
      // Remove backup on success (or keep latest — here we keep it for one cycle)
    }
  }
}

(async () => {
  // Acquire exclusive lock — prevents concurrent updates from 2 Claude Code instances.
  if (!acquireLock()) {
    const manifest = readManifest();
    process.stdout.write(JSON.stringify({ version: manifest.version, skipped: true, reason: 'update already in progress' }));
    return;
  }
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
    try { git('fetch origin main --quiet', MARKETPLACE_CLONE); } catch (err) {
      console.error(`[PLUGIN-UPDATE] git fetch failed: ${err.message}`);
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
    } catch (err) { console.error(`[PLUGIN-UPDATE] New manifest read error: ${err.message}`); }

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
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: output,
      },
    }));

  } catch (err) {
    process.stdout.write(JSON.stringify({ version: 'unknown', error: err.message }));
  } finally {
    releaseLock();
  }
})();
