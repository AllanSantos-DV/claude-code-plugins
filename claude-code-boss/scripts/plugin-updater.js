#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const VERSION_PATH = path.join(__dirname, 'plugin-version.json');
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const LAST_CHECK_PATH = path.join(STATE_DIR, 'plugin-update-check.json');

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf-8'));
  } catch {
    return { version: '0.0.0', checkInterval: 86400000, apiUrl: '' };
  }
}

function readLastCheck() {
  try {
    if (fs.existsSync(LAST_CHECK_PATH)) {
      return JSON.parse(fs.readFileSync(LAST_CHECK_PATH, 'utf-8'));
    }
  } catch {}
  return { lastCheck: 0 };
}

function writeLastCheck(data) {
  const dir = path.dirname(LAST_CHECK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAST_CHECK_PATH, JSON.stringify(data));
}

function parseVersion(v) {
  const parts = (v || '0.0.0').split('.').map(Number);
  return parts.reduce((acc, n, i) => acc + n * Math.pow(1000, 2 - i), 0);
}

(async () => {
  try {
    const manifest = readManifest();
    const { version: currentVersion, checkInterval, apiUrl } = manifest;

    const lastCheck = readLastCheck();
    const now = Date.now();

    if (now - lastCheck.lastCheck < (checkInterval || 86400000)) {
      process.stdout.write(JSON.stringify({
        version: currentVersion,
        checked: true,
        skipped: true,
        reason: 'recently checked',
      }));
      return;
    }

    if (!apiUrl) {
      writeLastCheck({ lastCheck: now });
      process.stdout.write(JSON.stringify({ version: currentVersion, checked: false, reason: 'no apiUrl' }));
      return;
    }

    let latestVersion = null;
    try {
      latestVersion = await fetchLatestVersion(apiUrl);
    } catch {
      writeLastCheck({ lastCheck: now });
      process.stdout.write(JSON.stringify({ version: currentVersion, checked: false, reason: 'fetch failed' }));
      return;
    }

    writeLastCheck({ lastCheck: now, latestVersion, lastResult: latestVersion || 'unknown' });

    if (!latestVersion) {
      process.stdout.write(JSON.stringify({ version: currentVersion }));
      return;
    }

    if (parseVersion(latestVersion) > parseVersion(currentVersion)) {
      const output = [
        `[PLUGIN-UPDATE] New version available: ${currentVersion} → ${latestVersion}`,
        `[PLUGIN-UPDATE] Run update command or download from:`,
        `[PLUGIN-UPDATE]   ${manifest.releaseUrl || 'https://github.com/AllanSantos-DV/claude-code-boss/releases'}`,
      ].join('\n');

      process.stdout.write(JSON.stringify({
        version: currentVersion,
        latestVersion,
        updateAvailable: true,
        hookSpecificOutput: output,
      }));
    } else {
      process.stdout.write(JSON.stringify({
        version: currentVersion,
        latestVersion,
        updateAvailable: false,
        upToDate: true,
      }));
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ version: 'unknown', error: err.message }));
  }
})();

function fetchLatestVersion(apiUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'claude-code-brain/1.1.0',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirect = res.headers.location;
        if (redirect) {
          return fetchLatestVersion(redirect).then(resolve, reject);
        }
      }
      if (res.statusCode === 404) {
        return resolve(null);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tag = data.tag_name || '';
          resolve(tag.replace(/^v/, ''));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
