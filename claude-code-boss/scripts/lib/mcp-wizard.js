'use strict';
/**
 * mcp-wizard.js — Orchestrates the MCP Memory Server activation flow.
 *
 * Steps:
 *   1. Java check (>=21)
 *   2. JAR presence / download
 *   3. Daemon spawn (stdio) or URL validate (http)
 *   4. /health verification
 *   5. Project handshake (initialize + tools/list)
 *
 * State is persisted in the global config path so any consumer can poll.
 * Concurrency: lock-file at globalDir()/.mcp-wizard.lock prevents parallel spawns.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { globalDir } = require('./data-dir.js');
const { loadWithVersion: loadBrainConfigWithVersion, save: saveBrainConfig } = require('./brain-config.js');
const { detectGpu, resolveLatestAsset } = require('./mcp-release-resolver.js');
const { acquireFileLock, releaseFileLock, parseOwner, pidAlive, clearStaleReclaim } = require('./process-lock.js');
const loadBrainConfig = () => loadBrainConfigWithVersion().config;

const MIN_JAVA_MAJOR = 21;
// Resolved per-call (not frozen at module load), same convention as
// brain-config.js's userConfigPath() — globalDir() depends on os.homedir(),
// and a const here would freeze whatever HOME/USERPROFILE was set at the
// moment this module was FIRST required, silently ignoring any later
// repoint (tests that isolate HOME per-case, or a real re-exec with a
// different profile).
function wizardStateFile() { return path.join(globalDir(), 'mcp-wizard-state.json'); }
function lockFile() { return path.join(globalDir(), '.mcp-wizard.lock'); }
const MINDATA_TIMEOUT_MS = 15000;
const VALIDATE_RETRIES = 3;
const VALIDATE_RETRY_DELAY_MS = 2000;
const REQUIRED_TOOLS = ['add_document', 'search_memory', 'get_document', 'delete_document'];

let _state = null;

// A lock is stale ONLY when its holder is provably gone (PID doesn't resolve
// to a live process — kill(pid, 0) throws ESRCH). Age is deliberately NOT a
// staleness signal: an age-based fallback would steal the lock out from under
// a holder that is demonstrably alive and simply slow (e.g. a first JAR
// download with no timeout), which is worse than the crash-recovery problem
// it was meant to solve. A live-but-unrelated process occupying a recycled
// PID is an accepted, narrow residual risk — the alternative (never
// expiring) is safer than the alternative (stealing an active lock).
function _staleFromRaw(raw) {
  const owner = parseOwner(raw);
  return !owner || !pidAlive(owner.pid);
}

function _isLockStale(lp) {
  let raw;
  try { raw = fs.readFileSync(lp, 'utf8'); } catch (err) { console.error(`[mcp-wizard] read lock (${lp}): ${err.message}`); return false; } // vanished mid-check → not our call
  return _staleFromRaw(raw);
}

let _manualLockOwner = null;
let _activeRun = null;

function _acquireLock() {
  const result = acquireFileLock(lockFile());
  _manualLockOwner = result.acquired ? result.owner : null;
  return result.acquired;
}

function _releaseLock() {
  if (_manualLockOwner) releaseFileLock(lockFile(), _manualLockOwner);
  _manualLockOwner = null;
}

function loadState() {
  if (_state) return _state;
  try {
    const sp = wizardStateFile();
    if (fs.existsSync(sp)) {
      _state = JSON.parse(fs.readFileSync(sp, 'utf8'));
      if (_state && _state.status) return _state;
    }
  } catch { /* corrupted */ }
  _state = { step: 0, total: 5, status: 'idle', progress: 0, details: [], startedAt: null, finishedAt: null, error: null };
  return _state;
}

function saveState() {
  try {
    const sp = wizardStateFile();
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(_state));
  } catch { /* best-effort */ }
}

function _emit(step, status, detail) {
  _state.step = step;
  _state.status = status;
  _state.progress = Math.round((step / _state.total) * 100);
  if (!_state.details) _state.details = [];
  _state.details[step - 1] = { status, detail, ts: new Date().toISOString() };
  saveState();
}

async function checkJava() {
  return new Promise((resolve) => {
    const r = spawnSync('java', ['-version'], { encoding: 'utf-8', timeout: 5000 });
    if (r.error) {
      return resolve({ ok: false, error: r.error.code === 'ENOENT' ? 'Java 21+ not found in PATH' : r.error.message });
    }
    const out = (r.stderr || '') + (r.stdout || '');
    const m = out.match(/(?:openjdk|java|jdk)\s+version\s+"?(\d+)/i);
    if (!m) return resolve({ ok: false, error: 'Java version unparseable' });
    const major = parseInt(m[1], 10);
    if (major < MIN_JAVA_MAJOR) return resolve({ ok: false, error: `Java ${MIN_JAVA_MAJOR}+ required, found ${major}` });
    const version = out.match(/(?:version\s+")?(\d+\.\d+\.\d+)/i);
    resolve({ ok: true, version: version ? version[1] : `java ${major}`, raw: out.trim().split('\n')[0] });
  });
}

async function checkJar(jarPath, downloadUrl) {
  return new Promise((resolve) => {
    if (fs.existsSync(jarPath)) {
      try {
        const stat = fs.statSync(jarPath);
        if (!stat.isFile()) return resolve({ ok: false, error: 'Path exists but is not a file' });
        const fd = fs.openSync(jarPath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (buf[0] !== 0x50 || buf[1] !== 0x4B) return resolve({ ok: false, error: 'File is not a valid JAR (missing PK magic)' });
        return resolve({ ok: true, jarPath, size: stat.size });
      } catch (err) { return resolve({ ok: false, error: `JAR read failed: ${err.message}` }); }
    }
    if (!downloadUrl) return resolve({ ok: false, error: 'JAR not found and no downloadUrl configured' });
    return resolve({ ok: false, jarPath: null, error: 'JAR missing — will download', needsDownload: true, downloadUrl });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Resolve where to download the JAR from: an explicit mcpCfg.downloadUrl is a manual
 * override and wins as-is; otherwise auto-detect the local GPU and pick the matching
 * release asset (see mcp-release-resolver.js) — this is the "sem GPU baixa CPU only"
 * contract the download button now fulfills automatically.
 */
async function resolveDownload(mcpCfg) {
  if (mcpCfg.downloadUrl) return { url: mcpCfg.downloadUrl, sha256: (mcpCfg.expectedSha256 || '').toLowerCase() };
  const gpu = detectGpu();
  const asset = await resolveLatestAsset({ gpu: gpu.present });
  return { url: asset.url, sha256: asset.sha256, gpu, version: asset.version, name: asset.name };
}

/** Ensure jarPath exists and is a valid JAR, auto-downloading (hardware-aware) if missing. */
async function ensureJar(jarPath, mcpCfg, emit) {
  if (fs.existsSync(jarPath)) {
    const jarCheck = await checkJar(jarPath, '');
    if (!jarCheck.ok) throw new Error(`JAR error: ${jarCheck.error}`);
    emit('ok', `JAR valid (${Math.round(jarCheck.size / 1024 / 1024)}MB)`);
    return;
  }
  emit('running', 'Detecting hardware...');
  const resolved = await resolveDownload(mcpCfg);
  const label = resolved.gpu
    ? (resolved.gpu.present ? `GPU detected (${resolved.gpu.name}) — downloading GPU build ${resolved.version}` : `No GPU detected — downloading CPU-only build ${resolved.version}`)
    : 'Downloading configured JAR...';
  emit('running', label);
  await downloadJar(resolved.url, jarPath);
  if (resolved.sha256) {
    const actual = await sha256File(jarPath);
    if (actual !== resolved.sha256) {
      fs.unlinkSync(jarPath);
      throw new Error(`Downloaded JAR sha256 mismatch (expected ${resolved.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…) — file removed`);
    }
    emit('ok', 'JAR downloaded and verified');
  } else {
    emit('ok', 'JAR downloaded (unverified — no checksum published for this asset)');
  }
}

async function downloadJar(downloadUrl, jarPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(jarPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = jarPath + '.tmp';
    const doGet = (targetUrl) => {
      const file = fs.createWriteStream(tmpPath);
      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { file.close(); fs.unlinkSync(tmpPath); doGet(res.headers.location); return; }
        if (res.statusCode !== 200) { file.close(); fs.unlinkSync(tmpPath); reject(new Error(`Download HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); fs.renameSync(tmpPath, jarPath); resolve(); });
        file.on('error', (e) => { fs.unlinkSync(tmpPath); reject(e); });
      }).on('error', (e) => { fs.unlinkSync(tmpPath); reject(e); });
    };
    doGet(downloadUrl);
  });
}

async function spawnDaemon(jarPath, workspacePath, javaArgs) {
  return new Promise((resolve, reject) => {
    const args = [...javaArgs, '-jar', jarPath, '--workspace', workspacePath || '.', '--transport', 'http'];
    const proc = spawn('java', args, { stdio: 'ignore', detached: true });
    proc.unref();
    const deadline = Date.now() + MINDATA_TIMEOUT_MS;
    const check = async () => {
      if (Date.now() > deadline) { proc.kill(); return reject(new Error('Daemon failed to become healthy after spawn')); }
      const url = await discoverDaemonUrl();
      if (url) {
        const alive = await httpHealth(url);
        if (alive) return resolve({ url });
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 2000);
  });
}

function discoverDaemonUrl() {
  const reg = path.join(process.env.MCP_RUN_DIR || path.join(require('os').homedir(), '.mcp-memory', 'run'), 'daemon.json');
  try {
    const raw = JSON.parse(fs.readFileSync(reg, 'utf8'));
    return raw && raw.url ? String(raw.url) : null;
  } catch (err) { console.error(`[mcp-wizard] read daemon registry (${reg}): ${err.message}`); return null; }
}

function httpHealth(baseUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(baseUrl + '/health'); } catch (err) { console.error(`[mcp-wizard] invalid health URL (${baseUrl}): ${err.message}`); return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function validateDaemon(serverUrl, retries) {
  const maxAttempts = retries || VALIDATE_RETRIES;
  const url = serverUrl || discoverDaemonUrl();
  if (!url) return { ok: false, error: 'No daemon URL — start the Native Java daemon or set serverUrl' };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const alive = await httpHealth(url);
    if (alive) {
      let info = {};
      try {
        const lib = url.startsWith('https') ? https : http;
        info = await new Promise((r) => {
          lib.get(url + '/health', (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(JSON.parse(b) || {})); }).on('error', () => r({}));
        });
      } catch { /* best-effort */ }
      return { ok: true, url, version: info.version || '' };
    }
    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, VALIDATE_RETRY_DELAY_MS));
  }
  return { ok: false, error: `Daemon at ${url} not reachable after ${maxAttempts} attempts` };
}

async function handshake(projectId) {
  try {
    const McpClient = require('../mcp-client.js');
    const config = loadBrainConfig();
    const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
    const client = new McpClient({
      transport: 'http',
      serverUrl: mcpCfg.serverUrl || discoverDaemonUrl() || '',
      runDir: mcpCfg.runDir || '',
      projectId: projectId || 'default',
      timeout: 60000,
    });
    await client.connect();
    const tools = client._availableTools || [];
    client.close();
    const toolNames = tools.map((t) => t.name || t);
    const missing = REQUIRED_TOOLS.filter((t) => !toolNames.includes(t));
    if (missing.length) return { ok: false, error: `Missing required tools: ${missing.join(', ')}` };
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: `Handshake failed: ${err.message}` };
  }
}

async function start(projectId) {
  _state = loadState();
  if (_state.status === 'running' || _activeRun) return _state;

  const acquired = acquireFileLock(lockFile());
  if (!acquired.acquired) {
    _state = { step: 0, total: 5, status: 'failed', progress: 0, details: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: 'Another wizard instance is running (lock file)', projectId: projectId || 'default' };
    saveState();
    return _state;
  }
  const run = { owner: acquired.owner };
  _activeRun = run;

  _state = { step: 0, total: 5, status: 'running', progress: 0, details: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, projectId: projectId || 'default' };
  saveState();

  (async () => {
    try {
      _emit(1, 'running', 'Checking Java 21+...');
      const java = await checkJava();
      if (!java.ok) throw new Error(`Java check failed: ${java.error}`);
      _emit(1, 'ok', `Java ${java.version} found`);

      const config = loadBrainConfig();
      const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
      const transport = mcpCfg.transport === 'http' ? 'http' : 'stdio';
      const jarPath = mcpCfg.jarPath || path.join(require('./data-dir.js').dataDir(), 'mcp', 'mcp-memory-server.jar');
      const javaArgs = mcpCfg.javaArgs || ['-Xmx512m'];
      const workspacePath = path.join(require('./data-dir.js').dataDir(), 'brain', _state.projectId);

      if (transport === 'http') {
        _emit(2, 'running', 'Probing daemon health...');
        let daemon = await validateDaemon(mcpCfg.serverUrl);
        if (daemon.ok) {
          _emit(2, 'ok', `Daemon reachable at ${daemon.url}`);
        } else {
          _emit(2, 'running', 'Daemon down — ensuring JAR...');
          await ensureJar(jarPath, mcpCfg, (status, detail) => _emit(2, status, detail));
          _emit(2, 'running', 'Starting daemon...');
          await spawnDaemon(jarPath, workspacePath, javaArgs);
          _emit(2, 'ok', 'Daemon restarted');
        }

        _emit(3, 'running', 'Performing MCP handshake...');
        const hs = await handshake(_state.projectId);
        if (!hs.ok) throw new Error(`Handshake failed: ${hs.error}`);
        _emit(3, 'ok', `Handshake OK (${hs.tools.length} tools)`);
      } else {
        _emit(2, 'running', 'Checking JAR...');
        await ensureJar(jarPath, mcpCfg, (status, detail) => _emit(2, status, detail));

        _emit(3, 'running', 'Starting daemon...');
        const spawnResult = await spawnDaemon(jarPath, workspacePath, javaArgs);
        _emit(3, 'ok', `Daemon started at ${spawnResult.url}`);

        _emit(4, 'running', 'Performing MCP handshake...');
        const hs = await handshake(_state.projectId);
        if (!hs.ok) throw new Error(`Handshake failed: ${hs.error}`);
        _emit(4, 'ok', `Handshake OK (${hs.tools.length} tools)`);
      }

      _emit(5, 'running', 'Validating project scope...');
      const config2 = loadBrainConfig();
      const mcpCfg2 = (config2.backend && config2.backend.mcpMemory) || {};
      const finalUrl = mcpCfg2.serverUrl || discoverDaemonUrl();
      if (finalUrl) {
        const health = await httpHealth(finalUrl);
        if (!health) throw new Error('Final health check failed');
      }
      _emit(5, 'ok', `Project "${_state.projectId}" validated`);

      _state.status = 'completed';
      _state.finishedAt = new Date().toISOString();
      _state.error = null;
      saveState();

      const { config: brainCfg, version: brainCfgVersion } = loadBrainConfigWithVersion();
      if (!brainCfg.backend || brainCfg.backend.type !== 'mcp-memory') {
        // expectedVersion pinned to the load right above: if the dashboard (or
        // another wizard run) saved a change to this same override in the
        // seconds it took Java/daemon/handshake checks to run, this save is
        // rejected instead of silently discarding that concurrent change.
        saveBrainConfig(
          { ...brainCfg, backend: { type: 'mcp-memory', mcpMemory: mcpCfg2 } },
          { expectedVersion: brainCfgVersion }
        );
      }
    } catch (err) {
      _state.status = 'failed';
      _state.error = err.message;
      _state.finishedAt = new Date().toISOString();
      saveState();
    } finally {
      releaseFileLock(lockFile(), run.owner);
      if (_activeRun === run) _activeRun = null;
    }
  })();

  return _state;
}

function getState() { return loadState(); }

// Manual/cross-process recovery, NOT self-release: reset() may run from a
// different process (e.g. the dashboard restarted) than the one that holds
// the lock, so it can't use _releaseLock()'s ownership check (that would
// permanently strand the wizard whenever the holder's pid no longer matches).
// Instead it uses the same liveness test _acquireLock() uses — delete the
// lock only if it's provably ours or provably dead; a lock held by a live,
// different process is left alone (deleting it mid-operation would be the
// actual bug, not a fix).
function reset() {
  const lp = lockFile();
  if (_activeRun) {
    return { ..._state, error: 'Cannot reset while the wizard is running' };
  }
  if (_manualLockOwner) {
    releaseFileLock(lp, _manualLockOwner);
    _manualLockOwner = null;
  }
  try {
    const raw = fs.readFileSync(lp, 'utf8');
    if (_staleFromRaw(raw)) fs.unlinkSync(lp);
  } catch { /* no lock file, or vanished mid-check — nothing to release */ }
  clearStaleReclaim(lp);
  _state = { step: 0, total: 5, status: 'idle', progress: 0, details: [], startedAt: null, finishedAt: null, error: null };
  try { fs.unlinkSync(wizardStateFile()); } catch { /* best-effort */ }
  return _state;
}

module.exports = {
  start, getState, reset, wizardStateFile, checkJava, checkJar, validateDaemon, handshake, REQUIRED_TOOLS,
  // Exported for isolated unit testing of the hardware-aware auto-download path
  // (mocking mcp-release-resolver.js / downloadJar) without a real spawn/network flow.
  resolveDownload, ensureJar, sha256File,
  // Exported for isolated unit testing only (same convention as brain-config.js's
  // _resetCache) — lets lock semantics be verified without driving the full
  // start() orchestration (which spawns real `java` subprocesses).
  lockFile, _isLockStale, _acquireLock, _releaseLock,
};
