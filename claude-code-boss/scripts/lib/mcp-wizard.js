'use strict';
/**
 * mcp-wizard.js — Orchestrates the MCP Memory Server activation flow.
 *
 * Steps:
 *   1. Java check (>=21)
 *   2. JAR presence / download
 *   3. Daemon: reuse the live one (daemon.json) or spawn one in daemon mode
 *   4. /health verification
 *   5. Project handshake (initialize + tools/list)
 *
 * State is persisted in the global config path so any consumer can poll.
 * Concurrency: lock-file at globalDir()/.mcp-wizard.lock prevents parallel spawns.
 */
const fs = require('fs');
const { readDaemonUrl } = require('./mcp-registry.js');
const { probeHealth } = require('./http-health.js');
const { sha256File } = require('./file-hash.js');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
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
// A first start downloads the embedding model (~430 MB) before /health answers: 15 s made
// every fresh install fail (seen in the real-session proof). The wizard runs in the background.
const SPAWN_TIMEOUT_MS = Number(process.env.CCB_MCP_SPAWN_TIMEOUT_MS) || 10 * 60 * 1000;
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

/**
 * Java binaries to try: JAVA_HOME, PATH, then the standard install dirs. A Java the agent
 * just installed (winget/brew/apt) is NOT on this process's PATH — Claude Code and the
 * daemon inherited the old one — so the install dirs are what make it usable at once.
 */
function javaCandidates(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const out = [];
  if (env.JAVA_HOME) out.push(path.join(env.JAVA_HOME, 'bin', exe));
  out.push('java');
  const globDirs = (base, sub) => {
    try { return fs.readdirSync(base).map((d) => path.join(base, d, ...sub, exe)); } catch (err) { void err; return []; }
  };
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto']) out.push(...globDirs(path.join(pf, vendor), ['bin']));
    }
  } else if (platform === 'darwin') {
    out.push(...globDirs('/Library/Java/JavaVirtualMachines', ['Contents', 'Home', 'bin']));
    out.push('/opt/homebrew/opt/openjdk/bin/java', '/opt/homebrew/opt/openjdk@21/bin/java', '/usr/local/opt/openjdk@21/bin/java');
  } else {
    out.push(...globDirs('/usr/lib/jvm', ['bin']));
  }
  return [...new Set(out)];
}

function probeJava(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? 'not found' : r.error.message };
  const out = (r.stderr || '') + (r.stdout || '');
  const m = out.match(/(?:openjdk|java|jdk)\s+version\s+"?(\d+)/i);
  if (!m) return { ok: false, error: 'Java version unparseable' };
  const major = parseInt(m[1], 10);
  const version = out.match(/(?:version\s+")?(\d+\.\d+\.\d+)/i);
  return { ok: true, major, version: version ? version[1] : `java ${major}`, raw: out.trim().split(/\r?\n/)[0] };
}

/** First Java >= 21 among the candidates: { ok, bin, version, raw } or { ok:false, error }. */
async function checkJava({ candidates = javaCandidates(), probe = probeJava } = {}) {
  let older = null;
  for (const bin of candidates) {
    if (bin !== 'java' && !fs.existsSync(bin)) continue;
    const r = probe(bin);
    if (!r.ok) continue;
    if (r.major >= MIN_JAVA_MAJOR) return { ok: true, bin, version: r.version, raw: r.raw };
    older = older || r;
  }
  return { ok: false, error: older ? `Java ${MIN_JAVA_MAJOR}+ required, found ${older.major}` : `Java ${MIN_JAVA_MAJOR}+ not found (PATH, JAVA_HOME, standard install dirs)` };
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

// Daemon mode is what announces the instance in ~/.mcp-memory/run/daemon.json. Since server
// 2.43 any explicit --transport turns it OFF (native-java CHANGELOG 2.43.0), so the old
// `--transport http` spawn never produced a daemon.json and this step always timed out.
function daemonArgs(jarPath, javaArgs) {
  return [...javaArgs, '-jar', jarPath, '--daemon'];
}

async function spawnDaemon(jarPath, javaArgs, javaBin = 'java', { spawnImpl = spawn, timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = daemonArgs(jarPath, javaArgs);
    const proc = spawnImpl(javaBin, args, { stdio: 'ignore', detached: true, windowsHide: true });
    proc.unref();
    // A server that dies on boot (bad JVM flag, port, corrupt jar) fails the step at once.
    let exited = null;
    proc.on('exit', (code, signal) => { exited = `exited with ${code != null ? `code ${code}` : signal}`; });
    proc.on('error', (err) => { exited = `could not start: ${err.message}`; });
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      if (exited) return reject(new Error(`The memory server ${exited} before becoming healthy (${javaBin} ${args.join(' ')})`));
      if (Date.now() > deadline) { proc.kill(); return reject(new Error(`Daemon failed to become healthy within ${Math.round(timeoutMs / 1000)} s after spawn`)); }
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
  return readDaemonUrl(process.env.MCP_RUN_DIR || path.join(require('os').homedir(), '.mcp-memory', 'run'), { label: 'mcp-wizard' });
}

async function httpHealth(baseUrl) {
  const r = await probeHealth(baseUrl, { timeoutMs: 3000 });
  if (r.error && /^bad URL/.test(r.error)) console.error(`[mcp-wizard] invalid health URL (${baseUrl}): ${r.error}`);
  return r.status === 200;
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
      const jarPath = mcpCfg.jarPath || path.join(require('./data-dir.js').dataDir(), 'mcp', 'mcp-memory-server.jar');
      const javaArgs = mcpCfg.javaArgs || ['-Xmx512m'];

      // One path: the plugins consume the server as the per-user HTTP daemon found via
      // daemon.json (stdio is no longer a server default). Reuse a live one; else start it.
      _emit(2, 'running', 'Probing daemon health...');
      const live = await validateDaemon(mcpCfg.serverUrl, 1);
      if (live.ok) {
        _emit(2, 'ok', `Daemon reachable at ${live.url}`);
        _emit(3, 'ok', 'Using the running daemon');
      } else {
        _emit(2, 'running', 'Daemon down — ensuring JAR...');
        await ensureJar(jarPath, mcpCfg, (status, detail) => _emit(2, status, detail));
        _emit(3, 'running', 'Starting the server (the first start downloads its embedding model, ~430 MB — can take a few minutes)...');
        const spawned = await spawnDaemon(jarPath, javaArgs, java.bin);
        _emit(3, 'ok', `Daemon started at ${spawned.url}`);
      }

      _emit(4, 'running', 'Performing MCP handshake...');
      const hs = await handshake(_state.projectId);
      if (!hs.ok) throw new Error(`Handshake failed: ${hs.error}`);
      _emit(4, 'ok', `Handshake OK (${hs.tools.length} tools)`);

      _emit(5, 'running', 'Validating project scope...');
      const config2 = loadBrainConfig();
      const mcpCfg2 = (config2.backend && config2.backend.mcpMemory) || {};
      const finalUrl = mcpCfg2.serverUrl || discoverDaemonUrl();
      if (finalUrl) {
        const health = await httpHealth(finalUrl);
        if (!health) throw new Error('Final health check failed');
      }
      _emit(5, 'ok', `Project "${_state.projectId}" validated`);

      const { config: brainCfg, version: brainCfgVersion } = loadBrainConfigWithVersion();
      if (!brainCfg.backend || brainCfg.backend.type !== 'mcp-memory' || (brainCfg.backend.mcpMemory || {}).transport !== 'http') {
        // expectedVersion pinned to the load right above: if the dashboard (or
        // another wizard run) saved a change to this same override in the
        // seconds it took Java/daemon/handshake checks to run, this save is
        // rejected instead of silently discarding that concurrent change.
        saveBrainConfig(
          // transport http: the daemon above IS http, and mcp-memory auto-update only runs on http.
          { ...brainCfg, backend: { type: 'mcp-memory', mcpMemory: { ...mcpCfg2, transport: 'http' } } },
          { expectedVersion: brainCfgVersion }
        );
      }
      // Completed only AFTER the backend is saved: a poller that acts on 'completed'
      // (restarting the brain daemon) must find the new backend on disk.
      _state.status = 'completed';
      _state.finishedAt = new Date().toISOString();
      _state.error = null;
      saveState();
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
  start, getState, reset, spawnDaemon, wizardStateFile, checkJava, checkJar, validateDaemon, handshake, REQUIRED_TOOLS, daemonArgs, discoverDaemonUrl, javaCandidates, MIN_JAVA_MAJOR,
  // Exported for isolated unit testing of the hardware-aware auto-download path
  // (mocking mcp-release-resolver.js / downloadJar) without a real spawn/network flow.
  resolveDownload, ensureJar, sha256File,
  // Exported for isolated unit testing only (same convention as brain-config.js's
  // _resetCache) — lets lock semantics be verified without driving the full
  // start() orchestration (which spawns real `java` subprocesses).
  lockFile, _isLockStale, _acquireLock, _releaseLock,
};
