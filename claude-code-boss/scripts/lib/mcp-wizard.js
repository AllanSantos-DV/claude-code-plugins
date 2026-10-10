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
const { readDaemonUrl } = require('./mcp-bootstrap/registry.js');
const { probeHealth } = require('./http-health.js');
const install = require('./mcp-bootstrap/install.js');
const path = require('path');
const https = require('https');
const http = require('http');
const { globalDir } = require('./data-dir.js');
const { loadWithVersion: loadBrainConfigWithVersion, save: saveBrainConfig } = require('./brain-config.js');
const { acquireFileLock, releaseFileLock, parseOwner, pidAlive, clearStaleReclaim } = require('./process-lock.js');
const loadBrainConfig = () => loadBrainConfigWithVersion().config;

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
        const started = await install.ensureLocalDaemon(mcpCfg, _emit);
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
  start, getState, reset, wizardStateFile, validateDaemon, handshake, REQUIRED_TOOLS, discoverDaemonUrl,
  // The local install steps live in the shared mcp-bootstrap/install.js; re-exported so
  // existing callers keep one entry point.
  checkJava: install.checkJava, checkJar: install.checkJar, javaCandidates: install.javaCandidates,
  MIN_JAVA_MAJOR: install.MIN_JAVA_MAJOR, downloadServerJar: install.downloadServerJar,
  // Exported for isolated unit testing of the download + checksum path
  // (mocking mcp-bootstrap/release-resolver.js / downloadJar) without a real spawn/network flow.
  resolveDownload: install.resolveDownload, ensureJar: install.ensureJar, sha256File: require('./mcp-bootstrap/file-hash.js').sha256File,
  // Exported for isolated unit testing only (same convention as brain-config.js's
  // _resetCache) — lets lock semantics be verified without driving the full
  // start() orchestration (which spawns real `java` subprocesses).
  lockFile, _isLockStale, _acquireLock, _releaseLock,
};
