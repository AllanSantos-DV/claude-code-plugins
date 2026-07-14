'use strict';

/**
 * plugin-updater.js — self-update for the externally-installed claude-code-boss
 * plugin. Because the plugin is installed from a LOCAL marketplace (git-subdir),
 * Claude Code Desktop's `/plugin` slash command does NOT pull updates for it, and
 * the 24h auto-check only notifies. This module lets the dashboard show the
 * installed version, check GitHub for a newer release, and install it — mirroring
 * what `.claude/scripts/install-local.mjs` does for dev, but sourcing the release
 * ZIP from GitHub instead of the working tree.
 *
 * Flow of performUpdate():
 *   1. GET /repos/<repo>/releases/latest  → newest tag + ZIP asset.
 *   2. Download the asset (following redirects to the CDN).
 *   3. Extract (Expand-Archive on Windows, unzip/tar on POSIX).
 *   4. Validate the extracted package.json.
 *   5. Copy → ~/.claude/plugins/cache/<mkt>/<plugin>/<sha>/ and run
 *      `npm install --omit=dev` (postinstall warms the embedder).
 *   6. Back up + repoint installed_plugins.json to the new folder.
 *   7. Kill stale brain-server processes from OLD caches (never self), so the
 *      new code takes over after the user runs /reload-plugins.
 *
 * Pure helpers (parseVersion/compareSemver/pickAsset/computeUpdateState) are
 * exported for hermetic unit tests; the IO functions are thin wrappers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const DEFAULT_REPO = 'AllanSantos-DV/claude-code-plugins';
const MARKETPLACE = 'allansantos-plugins';
const PLUGIN = 'claude-code-boss';
const UA = 'claude-code-boss-updater';

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

function parseVersion(v) {
  const clean = String(v || '').trim().replace(/^v/i, '');
  const core = clean.split('-')[0].split('+')[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function pickAsset(release, version) {
  const assets = (release && release.assets) || [];
  if (assets.length === 0) return null;
  const want = `${PLUGIN}-${version}.zip`;
  return (
    assets.find((a) => a.name === want) ||
    assets.find((a) => /\.zip$/i.test(a.name)) ||
    null
  );
}

// Release-host allowlist: an integrity-checked download must only come from
// GitHub's own hosts. Redirects ARE followed (github.com → CDN), but only to
// these — an attacker-controlled `Location` is refused before a byte is written.
// https only.
const RELEASE_HOSTS = new Set([
  'github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com',
]);
function isAllowedReleaseHost(urlStr) {
  let u;
  try { u = new URL(String(urlStr)); } catch (err) { void err; return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return RELEASE_HOSTS.has(h) || h.endsWith('.githubusercontent.com');
}

// The sibling `<asset>.sha256` published next to the ZIP (release.yml). Its body
// is the hex digest (`<hex>` or `<hex>  <filename>`); the ZIP is verified against
// it BEFORE extraction or `npm install` (which can execute postinstall code).
function pickDigestAsset(release, version) {
  const assets = (release && release.assets) || [];
  const zip = `${PLUGIN}-${version}.zip`;
  return (
    assets.find((a) => a.name === `${zip}.sha256`) ||
    assets.find((a) => /\.sha256$/i.test(a.name)) ||
    null
  );
}

// Compare a computed hex digest against the raw contents of a .sha256 file.
// Case-insensitive, whitespace-tolerant. Non-64-hex on either side → false
// (fail-closed: no valid digest = no trust). Constant-time compare.
function verifyDigest(actualHex, expectedRaw) {
  const expected = String(expectedRaw || '').trim().split(/\s+/)[0].toLowerCase();
  const actual = String(actualHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// Given existing registry backup filenames (`<name>.bak.<ts>`), return the ones
// to delete, keeping the newest keepN. Pure → unit-tested.
function planBackupPrune(names, keepN = 3) {
  return (names || [])
    .map((n) => { const m = String(n).match(/\.bak\.(\d+)$/); return m ? { name: n, ts: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(keepN)
    .map((b) => b.name);
}

/**
 * Derive the update state from an installed version + a GitHub release object.
 * Pure: no IO. Returns a shape the dashboard renders directly.
 */
function computeUpdateState(installedVersion, release) {
  const tag = release && release.tag_name ? String(release.tag_name) : '';
  const latest = tag.replace(/^v/i, '');
  const cmp = latest ? compareSemver(latest, installedVersion) : 0;
  const asset = pickAsset(release, latest);
  const digest = pickDigestAsset(release, latest);
  return {
    installed: installedVersion,
    latest: latest || null,
    tag: tag || null,
    hasUpdate: cmp > 0,
    htmlUrl: (release && release.html_url) || null,
    publishedAt: (release && release.published_at) || null,
    notes: release && release.body ? String(release.body).slice(0, 4000) : '',
    asset: asset
      ? { name: asset.name, url: asset.browser_download_url, size: asset.size }
      : null,
    digestUrl: digest ? digest.browser_download_url : null,
  };
}

function readPluginRepo(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const url =
      typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository && pkg.repository.url;
    if (url) {
      const m = String(url).match(/github\.com[/:]([^/]+\/[^/.]+)/i);
      if (m) return m[1];
    }
  } catch (err) {
    void err;
  }
  return DEFAULT_REPO;
}

// ─── IO: installed state ────────────────────────────────────────────────────

function registryPathOf() {
  return path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
}

function getInstalledInfo(root) {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version) version = String(pkg.version);
  } catch (err) {
    void err;
  }
  let sha = null;
  let installPath = null;
  const registryPath = registryPathOf();
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const key = `${PLUGIN}@${MARKETPLACE}`;
    const e = reg.plugins && reg.plugins[key] && reg.plugins[key][0];
    if (e) {
      sha = e.gitCommitSha || e.version || null;
      installPath = e.installPath || null;
    }
  } catch (err) {
    void err;
  }
  return { version, sha, installPath, node: process.version, registryPath };
}

// ─── IO: GitHub ─────────────────────────────────────────────────────────────

function ghGetJson(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
        timeout: 12000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${buf.slice(0, 180)}`));
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error(`GitHub API parse: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.end();
  });
}

function fetchLatestRelease(repo) {
  return ghGetJson(`/repos/${repo}/releases/latest`);
}

/** Deref a tag ref → underlying commit SHA (handles annotated tags). */
async function resolveCommitSha(repo, tag) {
  try {
    const ref = await ghGetJson(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    const obj = ref && ref.object;
    if (obj && obj.type === 'tag' && obj.sha) {
      const tagObj = await ghGetJson(`/repos/${repo}/git/tags/${obj.sha}`);
      if (tagObj && tagObj.object && tagObj.object.sha) return tagObj.object.sha;
    }
    if (obj && obj.sha) return obj.sha;
  } catch (err) {
    void err;
  }
  return null;
}

function download(url, destFile, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!isAllowedReleaseHost(url)) {
      reject(new Error(`refused download from non-GitHub host: ${url}`));
      return;
    }
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
        timeout: 60000,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          if (!isAllowedReleaseHost(res.headers.location)) {
            reject(new Error(`refused redirect to non-GitHub host: ${res.headers.location}`));
            return;
          }
          resolve(download(res.headers.location, destFile, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`download HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destFile);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destFile)));
        out.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('download timeout')));
  });
}

// ─── IO: extraction + process cleanup ───────────────────────────────────────

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const esc = (s) => s.replace(/'/g, "''");
    const psCmd =
      `$ProgressPreference='SilentlyContinue'; ` +
      `Expand-Archive -LiteralPath '${esc(zipFile)}' -DestinationPath '${esc(destDir)}' -Force`;
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { encoding: 'utf8' }
    );
    if (r.status !== 0) {
      throw new Error(`Expand-Archive falhou: ${String(r.stderr || '').split('\n')[0]}`);
    }
    return;
  }
  let r = spawnSync('unzip', ['-o', zipFile, '-d', destDir], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    r = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`unzip/tar falhou: ${String(r.stderr || '').split('\n')[0]}`);
    }
  }
}

/**
 * Kill node processes that loaded a claude-code-boss module from a cache folder
 * OTHER than keepSha — but never `selfPid` (the dashboard answering this call
 * runs from the old cache and must survive to return the response).
 */
function killStale(keepSha, selfPid) {
  try {
    if (process.platform === 'win32') {
      const ps =
        `$keep='${keepSha}'; $self=${selfPid}; ` +
        `Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $self } | Where-Object { ` +
        `try { @($_.Modules | Where-Object { $_.FileName -like '*\\claude-code-boss\\*' -and $_.FileName -notlike ('*\\' + $keep + '\\*') }).Count -gt 0 } catch { $false } ` +
        `} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`;
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
      });
    } else {
      // brain-server/index.js is a distinct process from the dashboard (self),
      // so pkill by module path won't hit us.
      spawnSync('pkill', ['-f', 'servers/brain-server/index.js'], { encoding: 'utf8' });
    }
  } catch (err) {
    void err;
  }
}

// ─── IO: orchestration ──────────────────────────────────────────────────────

async function checkForUpdate(root) {
  const info = getInstalledInfo(root);
  const repo = readPluginRepo(root);
  const release = await fetchLatestRelease(repo);
  const state = computeUpdateState(info.version, release);
  return { ...state, repo, sha: info.sha, node: info.node };
}

async function performUpdate(root, opts = {}) {
  // Injectable IO seams (default = the real functions) so the apply/registry/
  // rollback path is hermetically unit-testable without network or a shell.
  const io = opts.io || {};
  const _download = io.download || download;
  const _unzip = io.unzip || unzip;
  const _sha256File = io.sha256File || sha256File;
  const _spawnSync = io.spawnSync || spawnSync;
  const _fetchRelease = io.fetchRelease || fetchLatestRelease;
  const _resolveSha = io.resolveSha || resolveCommitSha;

  const info = getInstalledInfo(root);
  const repo = readPluginRepo(root);
  const release = await _fetchRelease(repo);
  const state = computeUpdateState(info.version, release);

  if (!state.hasUpdate && !opts.force) {
    return {
      ok: true,
      updated: false,
      reason: 'already-latest',
      installed: info.version,
      latest: state.latest,
    };
  }
  if (!state.asset || !state.asset.url) {
    throw new Error(`Release ${state.tag || '?'} não tem asset .zip`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-update-'));
  const zipFile = path.join(tmpRoot, state.asset.name);
  const extractDir = path.join(tmpRoot, 'extract');
  try {
    await _download(state.asset.url, zipFile);

    // Integrity gate — verify the published SHA-256 BEFORE extracting or running
    // npm install (postinstall = arbitrary code). Fail-CLOSED: a mismatch OR a
    // missing digest aborts by default (the production caller passes no opts, so
    // the gate is mandatory). `allowUnsignedLegacy` is the explicit escape hatch
    // for pre-digest releases. NOTE: this is a TRANSIT/CORRUPTION check only — the
    // digest is a sibling asset in the SAME release, so it does NOT prove
    // authenticity (a compromised release can ship a matching malicious digest).
    // Closing that needs a detached signature verified against a key pinned in
    // this source — tracked as a follow-up, not provided here.
    if (state.digestUrl) {
      const digestFile = path.join(tmpRoot, 'asset.sha256');
      await _download(state.digestUrl, digestFile);
      const expected = fs.readFileSync(digestFile, 'utf8');
      const actual = _sha256File(zipFile);
      if (!verifyDigest(actual, expected)) {
        throw new Error('SHA-256 do asset não confere com o digest publicado — abortando (possível corrupção/adulteração em trânsito).');
      }
    } else if (!opts.allowUnsignedLegacy) {
      throw new Error('Release sem digest .sha256 publicado — abortando (integridade não verificável). Passe allowUnsignedLegacy para forçar num release legado.');
    }

    _unzip(zipFile, extractDir);

    const pkgPath = path.join(extractDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error('ZIP inválido: package.json ausente na raiz');
    }
    const newPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const newVersion = String(newPkg.version || state.latest);

    let sha = await _resolveSha(repo, state.tag);
    sha = sha ? sha.slice(0, 12) : `rel-${newVersion.replace(/\./g, '-')}`;

    const destDir = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      MARKETPLACE,
      PLUGIN,
      sha
    );
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(extractDir, destDir, { recursive: true });

    if (!opts.skipInstall) {
      const r = _spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: destDir,
        encoding: 'utf8',
        timeout: 5 * 60 * 1000,
        shell: process.platform === 'win32',
      });
      if (r.status !== 0) {
        const tail = String(r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' ');
        throw new Error(`npm install falhou: ${tail || 'exit ' + r.status}`);
      }
    }

    const registryPath = info.registryPath;
    let registry = { version: 2, plugins: {} };
    if (fs.existsSync(registryPath)) {
      fs.copyFileSync(registryPath, `${registryPath}.bak.${Date.now()}`);
      // Prune old registry backups (keep newest 3) so they don't accumulate for
      // the life of the plugin.
      try {
        const dir = path.dirname(registryPath);
        const base = path.basename(registryPath);
        const names = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.bak.`));
        for (const stale of planBackupPrune(names, 3)) {
          fs.rmSync(path.join(dir, stale), { force: true });
        }
      } catch (err) { void err; }
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }
    if (!registry.plugins) registry.plugins = {};
    const key = `${PLUGIN}@${MARKETPLACE}`;
    const existing = (registry.plugins[key] && registry.plugins[key][0]) || {};
    registry.plugins[key] = [
      {
        scope: existing.scope || 'user',
        installPath: destDir,
        version: sha,
        installedAt: existing.installedAt || new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        gitCommitSha: sha,
      },
    ];
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    killStale(sha, process.pid);

    return {
      ok: true,
      updated: true,
      from: info.version,
      to: newVersion,
      sha,
      installPath: destDir,
      reloadHint: 'Rode /reload-plugins no Claude Code Desktop para carregar a nova versão.',
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
}

module.exports = {
  // pure
  parseVersion,
  compareSemver,
  pickAsset,
  pickDigestAsset,
  isAllowedReleaseHost,
  verifyDigest,
  planBackupPrune,
  computeUpdateState,
  readPluginRepo,
  // io
  sha256File,
  getInstalledInfo,
  fetchLatestRelease,
  checkForUpdate,
  performUpdate,
  DEFAULT_REPO,
  MARKETPLACE,
  PLUGIN,
};
