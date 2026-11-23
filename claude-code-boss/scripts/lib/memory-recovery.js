'use strict';
/**
 * memory-recovery.js — gets the local memory server running on a machine that has none.
 *
 * The client only restarts a server whose launcher is already installed. A machine that holds the
 * `mcp-memory` config without the server (a second machine, a fresh profile) stayed without memory
 * until someone ran the setup wizard. This module runs the same published-release install
 * (download, launcher, start) on demand, once at a time per machine, and records its progress in a
 * state file that the dashboard and the status tools read.
 */
const fs = require('fs');
const path = require('path');

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 15 * 60 * 1000;

let inFlight = null;

/** @param {string} [dir] plugin data dir (default: the resolved one) */
function statePath(dir) {
  return path.join(dir || require('../../engine/lib/data-dir.js').dataDir(), '.runtime', 'memory-recovery.json');
}

/** @returns {object|null} the last recorded recovery state, null when none ran */
function readState(dir) {
  try {
    return JSON.parse(require('../../engine/lib/atomic-write.js').retryTransient(() => fs.readFileSync(statePath(dir), 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[memory-recovery] state unreadable: ${err.message}`);
    return null;
  }
}

/**
 * Replace the recorded recovery state atomically.
 * @param {string} [dir] plugin data dir
 * @param {object} state the whole new state
 */
function writeState(dir, state) {
  const file = statePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  require('../../engine/lib/atomic-write.js').writeJsonAtomic(file, state);
}

/**
 * True when this machine is meant to run the memory server itself: the backend is mcp-memory and
 * no server address is set (a server the user pointed to is not ours to install).
 */
function configuredToRunHere(config) {
  const backend = (config && config.backend) || {};
  return backend.type === 'mcp-memory' && !String((backend.mcpMemory || {}).serverUrl || '').trim();
}

const loadConfig = () => require('../../engine/lib/brain-config.js').load();

/**
 * Why a recovery must not start now, or null when it may.
 * @returns {'running'|'cooldown'|null}
 */
function blockedBy(state, now) {
  if (!state) return null;
  if (state.status === 'running' && now - (state.updatedAt || 0) < STALE_RUNNING_MS) return 'running';
  if (state.status === 'failed' && now - (state.finishedAt || 0) < FAILURE_COOLDOWN_MS) return 'cooldown';
  return null;
}

/**
 * Install the memory server from the published release and start it.
 * Never throws: the outcome is the returned and recorded state.
 * Skipped unless the backend is mcp-memory with no server address set.
 * @param {{dir?:string, mcpCfg?:object, ensure?:Function, now?:()=>number, config?:object}} [opts] `ensure` and `config` are test seams
 * @returns {Promise<{status:'ok'|'failed'|'skipped', reason?:string, state?:object}>}
 */
async function recover({ dir, mcpCfg = {}, ensure, now = Date.now, config = loadConfig() } = {}) {
  if (!configuredToRunHere(config)) return { status: 'skipped', reason: 'not-configured' };
  if (inFlight) return { status: 'skipped', reason: 'running' };
  const blocked = blockedBy(readState(dir), now());
  if (blocked) return { status: 'skipped', reason: blocked };
  const run = ensure || ((cfg, emit) => require('./mcp-bootstrap/install.js').ensureLocalDaemon(cfg, emit));
  const startedAt = now();
  const attempts = ((readState(dir) || {}).attempts || 0) + 1;
  const save = (patch) => writeState(dir, { startedAt, attempts, updatedAt: now(), ...patch });
  inFlight = (async () => {
    try {
      save({ status: 'running', step: 0, detail: 'starting' });
      const started = await run(mcpCfg, (step, status, detail) => save({ status: 'running', step, detail }));
      const state = { startedAt, attempts, updatedAt: now(), finishedAt: now(), status: 'ok', detail: `memory server v${started.version} at ${started.url}`, url: started.url, version: started.version };
      writeState(dir, state);
      return { status: 'ok', state };
    } catch (err) {
      console.error(`[memory-recovery] could not provision the memory server: ${err.message}`);
      const state = { startedAt, attempts, updatedAt: now(), finishedAt: now(), status: 'failed', error: err.message };
      writeState(dir, state);
      return { status: 'failed', state };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Start a recovery without waiting for it.
 * @returns {{started:boolean, reason?:string}}
 */
function startRecovery(opts = {}) {
  if (!configuredToRunHere(opts.config || loadConfig())) return { started: false, reason: 'not-configured' };
  const blocked = inFlight ? 'running' : blockedBy(readState(opts.dir), (opts.now || Date.now)());
  if (blocked) return { started: false, reason: blocked };
  recover(opts).catch((err) => console.error(`[memory-recovery] ${err.message}`));
  return { started: true };
}

/**
 * What the dashboard shows about the local memory server on this machine.
 * @returns {{launcherInstalled:boolean, serverVersion:string|null, recovery:object|null}}
 */
function describe(dir) {
  const launcher = require('./mcp-bootstrap/launcher.js');
  const jar = launcher.newestInstalledJar();
  return { launcherInstalled: fs.existsSync(launcher.launcherPath()), serverVersion: jar ? jar.version : null, recovery: readState(dir) };
}

require('../../engine/mcp-client.js').setProvisioner({ start: startRecovery, run: recover });

module.exports = { configuredToRunHere, recover, startRecovery, readState, statePath, describe, FAILURE_COOLDOWN_MS };
