'use strict';
/**
 * mcp-wizard.js — Orchestrates the MCP Memory Server activation flow.
 *
 * Steps:
 *   1. Java check (>=21)
 *   2. JAR presence / download
 *   3. Daemon: through the server launcher only (native-java ADR-023) — or the user's remote URL
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
const { spawnSync } = require('child_process');
const https = require('https');
const http = require('http');
const { globalDir } = require('./data-dir.js');
const { loadWithVersion: loadBrainConfigWithVersion, save: saveBrainConfig } = require('./brain-config.js');
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
  // The Java runtime the native-java installer (used by the sister plugins) bundles.
  out.push(path.join(env.USERPROFILE || env.HOME || require('os').homedir(), '.mcp-memory', 'server', 'runtime', 'bin', exe));
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
 * Where to download the server from: an explicit mcpCfg.downloadUrl wins as-is; otherwise the
 * latest release's CPU build. The launcher (native-java ADR-023, contract C-3) only runs exact
 * mcp-memory-server-X.Y.Z.jar names — a "-gpu" jar would never be started.
 */
async function resolveDownload(mcpCfg) {
  if (mcpCfg.downloadUrl) {
    let name = '';
    try { name = path.basename(new URL(mcpCfg.downloadUrl).pathname); } catch (err) { void err; name = path.basename(String(mcpCfg.downloadUrl)); }
    return { url: mcpCfg.downloadUrl, sha256: (mcpCfg.expectedSha256 || '').toLowerCase(), name };
  }
  const asset = await require('./mcp-release-resolver.js').resolveLatestAsset();
  return { url: asset.url, sha256: asset.sha256, version: asset.version, name: asset.name };
}

/** Ensure jarPath exists and is a valid JAR, downloading (and verifying the checksum) if missing. */
async function ensureJar(jarPath, mcpCfg, emit, resolvedIn = null) {
  if (fs.existsSync(jarPath)) {
    const jarCheck = await checkJar(jarPath, '');
    if (!jarCheck.ok) throw new Error(`JAR error: ${jarCheck.error}`);
    emit('ok', `JAR valid (${Math.round(jarCheck.size / 1024 / 1024)}MB)`);
    return;
  }
  const resolved = resolvedIn || await resolveDownload(mcpCfg);
  emit('running', `Downloading ${resolved.name || 'the server'}${resolved.version ? ` (${resolved.version})` : ''}...`);
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

/** Download the latest server into ~/.mcp-memory/lib under its exact name (the launcher picks it up). */
async function downloadServerJar(mcpCfg, emit, home = require('os').homedir()) {
  const resolved = await resolveDownload(mcpCfg);
  if (!require('./mcp-launcher.js').JAR_RE.test(resolved.name || '')) {
    throw new Error(`the server launcher only runs mcp-memory-server-X.Y.Z.jar — ${resolved.name || 'this download'} would never be started`);
  }
  const target = path.join(home, '.mcp-memory', 'lib', resolved.name);
  await ensureJar(target, mcpCfg, emit, resolved);
  return target;
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

async function handshake(projectId, url = '') {
  try {
    const McpClient = require('../mcp-client.js');
    const config = loadBrainConfig();
    const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
    const client = new McpClient({
      transport: 'http',
      serverUrl: url || mcpCfg.serverUrl || discoverDaemonUrl() || '',
      runDir: mcpCfg.runDir || '',
      projectId: projectId || 'default',
      timeout: 60000,
    });
    await client.connect();
    const tools = client._availableTools || [];
    const toolNames = tools.map((t) => t.name || t);
    // Is the server current? (the user is asked before anything is updated)
    let update = null;
    if (toolNames.includes('check_update')) {
      try { update = require('./mcp-memory-auto-update.js').parseCheckUpdate(await client.callTool('check_update', {})); }
      catch (err) { update = { error: err.message }; }
    }
    client.close();
    const missing = REQUIRED_TOOLS.filter((t) => !toolNames.includes(t));
    if (missing.length) return { ok: false, error: `Missing required tools: ${missing.join(', ')}` };
    return { ok: true, tools, update };
  } catch (err) {
    return { ok: false, error: `Handshake failed: ${err.message}` };
  }
}

/**
 * @param {string} projectId
 * @param {{serverUrl?: string}} [opts] serverUrl = a server the USER pointed to (often on
 *   another host): validate and use it — never download or start a local one instead.
 */
async function start(projectId, opts = {}) {
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
      const config = loadBrainConfig();
      const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
      const remoteUrl = String(opts.serverUrl || '').trim().replace(/\/+$/, '');
      let launchedUrl = '';

      if (remoteUrl) {
        // The user's own server (maybe on another host): no local Java, jar or daemon.
        _emit(1, 'ok', 'Using the server the user pointed to — nothing installed locally');
        _emit(2, 'running', `Probing ${remoteUrl}/health...`);
        const remote = await validateDaemon(remoteUrl, 3);
        if (!remote.ok) throw new Error(`The server at ${remoteUrl} did not answer /health (${remote.error}) — check the address and that it is running`);
        _emit(2, 'ok', `Server reachable at ${remoteUrl}${remote.version ? ` (v${remote.version})` : ''}`);
        _emit(3, 'ok', 'Using the remote server');
      } else {
        // Official contract (native-java ADR-023): the server is started ONLY by its own
        // launcher (~/.mcp-memory/bin/mcp-memory-daemon) — it reuses a live daemon, picks the
        // newest installed jar, and is registered to start at logon. Never `java -jar` here.
        const L = require('./mcp-launcher.js');
        const java = L.bundledJava() ? { ok: true, version: 'bundled runtime', bin: L.bundledJava() } : await checkJava();
        const javaHome = java.ok && java.bin && java.bin !== 'java' ? path.dirname(path.dirname(java.bin)) : '';
        _emit(1, 'running', 'Looking for the memory server launcher...');
        let started = await L.runLauncher({ javaHome });
        if (started.missing) {
          if (!java.ok) throw new Error(`Java check failed: ${java.error}`);
          _emit(1, 'ok', `Launcher not installed yet — Java ${java.version} found`);
          let jar = L.newestInstalledJar();
          if (!jar || L.compareVersions(jar.version, L.MIN_LAUNCHER_VERSION) < 0) {
            _emit(2, 'running', jar ? `Installed server ${jar.version} is too old for the launcher — downloading the latest...` : 'No server installed — downloading the latest...');
            await downloadServerJar(mcpCfg, (status, detail) => _emit(2, status, detail));
            jar = L.newestInstalledJar();
          } else {
            _emit(2, 'ok', `Server ${jar.version} already installed (${jar.path}) — no download`);
          }
          _emit(2, 'running', 'Installing the server launcher (also starts it at logon)...');
          const inst = await L.installLauncher({ jar, javaBin: java.bin });
          if (!inst.ok) throw new Error(inst.error);
          _emit(2, 'ok', `Launcher installed: ${inst.launcher}`);
          _emit(3, 'running', 'Starting the server through its launcher (a first start downloads its embedding model, ~430 MB — can take a few minutes)...');
          started = await L.runLauncher({ javaHome });
        } else {
          _emit(1, 'ok', 'Launcher found');
          _emit(2, 'ok', 'Nothing to install');
        }
        if (!started.ok) throw new Error(started.error);
        _emit(3, 'ok', `${started.spawned ? 'Started' : 'Reusing'} the memory server v${started.version} at ${started.url}`);
        launchedUrl = started.url;
      }

      _emit(4, 'running', 'Performing MCP handshake...');
      const hs = await handshake(_state.projectId, remoteUrl || launchedUrl);
      if (!hs.ok) throw new Error(`Handshake failed: ${hs.error}`);
      _state.update = hs.update || null;
      _emit(4, 'ok', `Handshake OK (${hs.tools.length} tools)`);

      _emit(5, 'running', 'Validating project scope...');
      const config2 = loadBrainConfig();
      const mcpCfg2 = { ...((config2.backend && config2.backend.mcpMemory) || {}), ...(remoteUrl ? { serverUrl: remoteUrl } : {}) };
      const finalUrl = mcpCfg2.serverUrl || discoverDaemonUrl();
      if (finalUrl) {
        const health = await httpHealth(finalUrl);
        if (!health) throw new Error('Final health check failed');
      }
      _emit(5, 'ok', `Project "${_state.projectId}" validated`);

      const { config: brainCfg, version: brainCfgVersion } = loadBrainConfigWithVersion();
      const cur = (brainCfg.backend && brainCfg.backend.mcpMemory) || {};
      if (!brainCfg.backend || brainCfg.backend.type !== 'mcp-memory' || cur.transport !== 'http' || (remoteUrl && cur.serverUrl !== remoteUrl)) {
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
  start, getState, reset, wizardStateFile, checkJava, checkJar, validateDaemon, handshake, REQUIRED_TOOLS, discoverDaemonUrl, javaCandidates, MIN_JAVA_MAJOR, downloadServerJar,
  // Exported for isolated unit testing of the download + checksum path
  // (mocking mcp-release-resolver.js / downloadJar) without a real spawn/network flow.
  resolveDownload, ensureJar, sha256File,
  // Exported for isolated unit testing only (same convention as brain-config.js's
  // _resetCache) — lets lock semantics be verified without driving the full
  // start() orchestration (which spawns real `java` subprocesses).
  lockFile, _isLockStale, _acquireLock, _releaseLock,
};
