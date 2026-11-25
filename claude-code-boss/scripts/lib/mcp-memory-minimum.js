'use strict';
/**
 * mcp-memory-minimum.js — brings a local mcp-memory server that is older than the declared
 * minimum up to date without asking the old server for anything. The server's own `update` tool
 * does not exist on old versions, so a stuck machine could never leave its old release; this
 * path downloads the published release and restarts the server onto it (the bring-up the
 * `mcp-memory-bootstrap` CLI does).
 */
const path = require('path');
const { MIN_SERVER_VERSION } = require('./mcp-min-version.js');
const { compareVersions } = require('./mcp-bootstrap/launcher.js');

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/** @returns {string} the state file that remembers the last failed attempt */
function stateFile() {
  return path.join(require('../../engine/lib/data-dir.js').globalDir(), 'mcp-memory-minimum-state.json');
}

function readState(file = stateFile()) {
  return require('../../engine/lib/json-file.js').readJsonLoud(file, 'mcp-memory-minimum');
}

function writeState(state, file = stateFile()) {
  require('../../engine/lib/atomic-write.js').writeJsonAtomic(file, state);
}

/**
 * Which installed version is below the minimum, or null when nothing needs upgrading.
 * A running server is judged by its /health version, a stopped one by the newest jar on disk.
 * A machine with no jar and no server is the first-install flow, not this one.
 * @param {{jar: ?{version:string}, daemon: {running:boolean, version?:string}}} snap
 * @param {string} min
 * @returns {?string}
 */
function versionBelowMinimum(snap, min) {
  const version = snap.daemon.running ? snap.daemon.version : snap.jar && snap.jar.version;
  if (!version || Number.isNaN(compareVersions(version, min))) return null;
  return compareVersions(version, min) < 0 ? version : null;
}

/**
 * What a status screen shows about the memory server: who manages it, its version and the minimum.
 * A configured server URL means the server is the user's own and is never touched, whatever runs locally.
 * @param {{serverUrl?: string, daemon: {running:boolean, version?:string}, jar: ?{version:string}, min?: string}} snap
 * @returns {{management:'local'|'remote', running:boolean, version:?string, minimum:string, belowMinimum:boolean}}
 */
function describeServer(snap) {
  const minimum = snap.min || MIN_SERVER_VERSION;
  if (String(snap.serverUrl || '').trim()) return { management: 'remote', running: false, version: null, minimum, belowMinimum: false };
  const below = versionBelowMinimum({ jar: snap.jar, daemon: snap.daemon }, minimum);
  const version = snap.daemon.running ? snap.daemon.version || null : snap.jar ? snap.jar.version : null;
  return { management: 'local', running: !!snap.daemon.running, version, minimum, belowMinimum: below !== null };
}

/** @returns {string} one line for backend_status */
function describeLine(d) {
  if (d.management === 'remote') return 'Server management: the server address is set, so it is yours and the Boss never touches it (no install, start or update).';
  const state = d.version ? `v${d.version}${d.running ? '' : ' (not running)'}` : 'not installed';
  const below = d.belowMinimum ? ` — below the minimum ${d.minimum}; the Boss upgrades it at the next session start` : ` — minimum ${d.minimum} met`;
  return `Server management: managed by the Boss (local server, no address set) — ${state}${d.version ? below : ''}.`;
}

/** Reads the local daemon and the newest jar the way the bootstrap CLI does, for a status screen. */
async function inspectServer(serverUrl) {
  if (String(serverUrl || '').trim()) return describeServer({ serverUrl, daemon: { running: false }, jar: null });
  const deps = require('../mcp-memory-bootstrap.js').defaultDeps();
  return describeServer({ serverUrl: '', daemon: await deps.probeDaemon(), jar: deps.launcher.newestInstalledJar() });
}

function describeFailure(from, min, error) {
  return `[BRAIN] O servidor de memória (mcp-memory) está na versão ${from}, abaixo da mínima ${min}, e a atualização automática falhou: ${error}. `
    + 'Enquanto isso a memória do Brain fica degradada. Nova tentativa em alguns minutos; a causa também está em ~/.mcp-memory/logs.';
}

/**
 * Upgrade a local mcp-memory server that is below the declared minimum.
 * @param {object} [opts]
 * @param {string} [opts.min] minimum version (default: the declared MIN_SERVER_VERSION)
 * @param {() => number} [opts.now]
 * @param {object} [opts.deps] bootstrap seams (launcher, probeDaemon, resolveLatest, downloadServerJar, ensureLocalDaemon, restartOnJar, checkJava, javaInstallCommand)
 * @param {() => ?object} [opts.read] state reader
 * @param {(state: object) => void} [opts.write] state writer
 * @param {{acquire: Function, release: Function}} [opts.lock]
 * @returns {Promise<{status:'ok'|'upgraded'|'cooldown'|'locked'|'error', from?:string, to?:string, error?:string, advisory?:string}>}
 */
async function ensureMinimumServer(opts = {}) {
  const min = opts.min || MIN_SERVER_VERSION;
  const now = opts.now || Date.now;
  const read = opts.read || (() => readState());
  const write = opts.write || ((state) => writeState(state));
  const bootstrap = require('../mcp-memory-bootstrap.js');
  const deps = opts.deps || bootstrap.defaultDeps();

  const jar = deps.launcher.newestInstalledJar();
  const daemon = await deps.probeDaemon();
  const from = versionBelowMinimum({ jar, daemon }, min);
  if (!from) return { status: 'ok' };

  const previous = read();
  if (previous && previous.lastError && now() - (previous.lastAttemptAt || 0) < FAILURE_COOLDOWN_MS) {
    return { status: 'cooldown', from, error: previous.lastError, advisory: describeFailure(from, min, previous.lastError) };
  }
  const lock = opts.lock || {
    acquire: () => require('../../engine/lib/process-lock.js').acquireFileLock(path.join(path.dirname(stateFile()), '.mcp-memory-minimum.lock')),
    release: (owner) => require('../../engine/lib/process-lock.js').releaseFileLock(path.join(path.dirname(stateFile()), '.mcp-memory-minimum.lock'), owner),
  };
  const held = lock.acquire();
  if (!held || !held.acquired) return { status: 'locked', from };
  try {
    console.error(`[mcp-memory-minimum] server ${from} is below ${min} — upgrading to the latest published release`);
    const result = await bootstrap.ensure({ min, deps, emit: (m) => console.error(`[mcp-memory-minimum] ${m}`) });
    if (!result.ok) {
      write({ lastAttemptAt: now(), lastError: result.error, from });
      return { status: 'error', from, error: result.error, advisory: describeFailure(from, min, result.error) };
    }
    write({ lastAttemptAt: now(), lastError: null, from, to: result.version });
    return {
      status: 'upgraded', from, to: result.version,
      advisory: `[BRAIN] O servidor de memória (mcp-memory) estava na versão ${from}, abaixo da mínima ${min}, e foi atualizado para ${result.version}.`,
    };
  } finally {
    lock.release(held.owner);
  }
}

module.exports = { ensureMinimumServer, versionBelowMinimum, describeServer, describeLine, inspectServer, FAILURE_COOLDOWN_MS, stateFile };
