'use strict';

const fs = require('fs');
const path = require('path');
const McpClient = require('../mcp-client.js');
const { globalDir, dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');
const { acquireFileLock, releaseFileLock } = require('./process-lock.js');
const { restartForBootUpdate } = require('./mcp-daemon-restart.js');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESTART_TIMEOUT_MS = 25000;
const DEFAULT_UPDATE_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 500;

function stateFile() {
  return path.join(globalDir(), 'mcp-memory-auto-update-state.json');
}

function lockFile() {
  return path.join(globalDir(), '.mcp-memory-auto-update.lock');
}

function readStateFile(file = stateFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`[mcp-memory-auto-update] state unreadable (${file}): ${err.message}`);
    }
    return null;
  }
}

function writeStateFile(state, file = stateFile()) {
  writeJsonAtomic(file, state);
}

function parseCheckUpdate(result) {
  if (result && result.raw && result.raw.isError) {
    throw new Error(`check_update retornou isError: ${result.text || 'sem detalhe'}`);
  }
  const text = result && typeof result.text === 'string' ? result.text : '';
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new Error(`check_update retornou JSON inválido: ${err.message}`); }
  if (typeof parsed.currentVersion !== 'string' || !parsed.currentVersion) {
    throw new Error('check_update sem currentVersion');
  }
  if (typeof parsed.latestVersion !== 'string' || !parsed.latestVersion) {
    throw new Error('check_update sem latestVersion');
  }
  if (typeof parsed.updateAvailable !== 'boolean') {
    throw new Error('check_update sem updateAvailable booleano');
  }
  return {
    currentVersion: parsed.currentVersion,
    latestVersion: parsed.latestVersion,
    updateAvailable: parsed.updateAvailable,
    releaseNotes: typeof parsed.releaseNotes === 'string' ? parsed.releaseNotes : '',
    publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : '',
  };
}

function parseUpdateResult(result) {
  if (result && result.raw && result.raw.isError) {
    return { ok: false, restartRequired: false, error: result.text || 'tool update retornou isError' };
  }
  const text = result && typeof result.text === 'string' ? result.text : '';
  if (!text.trim()) return { ok: true, restartRequired: false };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { void err; return { ok: true, restartRequired: false, detail: text }; }
  if (parsed && parsed.error === true) {
    const message = typeof parsed.message === 'string' && parsed.message.trim()
      ? parsed.message.trim()
      : 'tool update retornou erro sem detalhe';
    const restartRequired = /arquivo.*usado por outro processo|file.*used by another process|failed to replace jar/i.test(message);
    return { ok: false, restartRequired, error: message };
  }
  return { ok: true, restartRequired: false, detail: parsed };
}

function isCheckDue(state, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const last = Number(state && state.lastAttemptAt);
  return !Number.isFinite(last) || last <= 0 || (now - last) >= ttlMs;
}

function defaultClientFactory(mcpConfig) {
  const activeDataDir = dataDir();
  return new McpClient({
    transport: 'http',
    serverUrl: mcpConfig.serverUrl || '',
    runDir: mcpConfig.runDir || '',
    projectId: mcpConfig.projectId || '__ccb_auto_update__',
    jarPath: mcpConfig.jarPath || path.join(activeDataDir, 'mcp', 'mcp-memory-server.jar'),
    workspacePath: path.join(activeDataDir, 'brain', '__ccb_auto_update__'),
    javaArgs: mcpConfig.javaArgs || ['-Xmx512m'],
    downloadUrl: mcpConfig.downloadUrl || '',
    expectedSha256: mcpConfig.expectedSha256 || '',
    timeout: Math.min(mcpConfig.timeout || 60000, 5000),
    autoRestart: false,
  });
}

async function waitForExpectedVersion(client, expectedVersion, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_RESTART_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_POLL_MS;
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = await client.readHealth({ rediscover: true });
    const version = last && last.health && last.health.version;
    const normalizedActual = String(version || '').replace(/^v/, '');
    const normalizedExpected = String(expectedVersion || '').replace(/^v/, '');
    if (last && last.alive && last.statusCode === 200 && normalizedActual === normalizedExpected) {
      return { ok: true, version, health: last.health };
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    version: last && last.health && last.health.version || '',
    error: last && last.error || `timeout aguardando versão ${expectedVersion}`,
  };
}

function failureState(previous, at, error) {
  return {
    ...(previous || {}),
    lastAttemptAt: at,
    lastError: error,
  };
}

async function runAutoUpdate(opts = {}) {
  const event = opts.event || {};
  const config = opts.config || {};
  const mcpConfig = config.backend && config.backend.mcpMemory || {};
  const autoUpdate = mcpConfig.autoUpdate && typeof mcpConfig.autoUpdate === 'object'
    ? mcpConfig.autoUpdate
    : {};
  if (event.hook_event_name !== 'SessionStart'
      || !config.backend
      || config.backend.type !== 'mcp-memory'
      || mcpConfig.transport !== 'http'
      || autoUpdate.enabled === false) {
    return { status: 'skipped' };
  }

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const readState = opts.readState || (() => readStateFile());
  const writeState = opts.writeState || ((state) => writeStateFile(state));
  const acquireLock = opts.acquireLock || (() => acquireFileLock(lockFile()));
  const releaseLock = opts.releaseLock || ((owner) => releaseFileLock(lockFile(), owner));
  const clientFactory = opts.clientFactory || defaultClientFactory;
  const restartDaemon = opts.restartDaemon || ((cfg, restartOpts) => restartForBootUpdate(cfg, restartOpts));
  const platform = opts.platform || process.platform;
  const restartTimeoutMs = Number.isFinite(autoUpdate.restartTimeoutMs) && autoUpdate.restartTimeoutMs > 0
    ? Math.min(autoUpdate.restartTimeoutMs, DEFAULT_RESTART_TIMEOUT_MS)
    : DEFAULT_RESTART_TIMEOUT_MS;
  const updateTimeoutMs = Number.isFinite(autoUpdate.updateTimeoutMs) && autoUpdate.updateTimeoutMs > 0
    ? Math.min(autoUpdate.updateTimeoutMs, DEFAULT_UPDATE_TIMEOUT_MS)
    : DEFAULT_UPDATE_TIMEOUT_MS;
  const waitForVersion = opts.waitForExpectedVersion
    || ((version, client) => waitForExpectedVersion(client, version, { timeoutMs: restartTimeoutMs }));
  const ttlMs = Number.isFinite(opts.ttlMs)
    ? opts.ttlMs
    : (Number.isFinite(autoUpdate.intervalMs) && autoUpdate.intervalMs > 0 ? autoUpdate.intervalMs : DEFAULT_TTL_MS);

  const initialState = readState();
  if (!isCheckDue(initialState, now(), ttlMs)) return { status: 'not-due' };
  const lock = acquireLock();
  if (!lock || !lock.acquired) {
    const reason = lock && lock.reason || 'lock indisponível';
    if (['locked', 'reclaiming', 'locked-corrupt-grace', 'lock-changed'].includes(reason)) {
      return { status: 'locked' };
    }
    return {
      status: 'error',
      error: reason,
      advisory: `[BRAIN] auto-update do mcp-memory não conseguiu adquirir o lock: ${reason}. O backend continua disponível.`,
    };
  }

  let client = null;
  let updateAttempted = false;
  let latestState = initialState;
  try {
    latestState = readState();
    if (!isCheckDue(latestState, now(), ttlMs)) return { status: 'not-due' };
    client = clientFactory(mcpConfig);
    await client.connect();
    if (!client.hasToolAvailable('check_update')) {
      throw new Error('o daemon não anuncia a tool check_update');
    }
    const check = parseCheckUpdate(await client.callTool('check_update', {}));
    if (!check.updateAvailable) {
      const at = now();
      writeState({
        lastAttemptAt: at,
        lastSuccessfulCheckAt: at,
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        lastError: null,
      });
      return { status: 'current', ...check };
    }
    if (!client.hasToolAvailable('update')) {
      throw new Error(`há update ${check.latestVersion}, mas o daemon não anuncia a tool update`);
    }

    let updateCallError = null;
    let restartRequired = false;
    let fatalUpdateError = null;
    updateAttempted = true;
    try {
      const updateResult = await client.callToolOnce('update', { force: false }, { timeoutMs: updateTimeoutMs });
      const updateOutcome = parseUpdateResult(updateResult);
      if (!updateOutcome.ok) {
        if (updateOutcome.restartRequired) {
          updateCallError = new Error(updateOutcome.error);
          restartRequired = true;
        } else {
          fatalUpdateError = new Error(updateOutcome.error);
        }
      }
    } catch (err) {
      updateCallError = err;
      console.error(`[mcp-memory-auto-update] update desconectou/errou; confirmando versão no health: ${err.message}`);
      if (platform === 'win32') restartRequired = true;
    }
    if (fatalUpdateError) throw fatalUpdateError;
    if (restartRequired) {
      await restartDaemon(mcpConfig, { latestVersion: check.latestVersion });
    }
    const verified = await waitForVersion(check.latestVersion, client);
    if (!verified || !verified.ok) {
      const detail = verified && (verified.error || verified.version)
        ? `; health: ${verified.error || `versão ${verified.version}`}`
        : '';
      throw new Error(
        `update para ${check.latestVersion} não foi confirmado${updateCallError ? ` (${updateCallError.message})` : ''}${detail}`,
      );
    }
    const at = now();
    writeState({
      lastAttemptAt: at,
      lastSuccessfulCheckAt: at,
      currentVersion: check.latestVersion,
      latestVersion: check.latestVersion,
      updatedFrom: check.currentVersion,
      lastError: null,
    });
    console.error(`[mcp-memory-auto-update] atualizado ${check.currentVersion} → ${check.latestVersion}`);
    return { status: 'updated', from: check.currentVersion, version: check.latestVersion };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const at = now();
    try { writeState(failureState(latestState, at, message)); }
    catch (writeErr) {
      console.error(`[mcp-memory-auto-update] falha ao persistir erro: ${writeErr.message}`);
    }
    return {
      status: 'error',
      error: message,
      advisory: `[BRAIN] auto-update do mcp-memory falhou sem bloquear o backend: ${message}. Tente novamente após o TTL ou rode a tool \`update\` manualmente.`,
    };
  } finally {
    if (client) {
      try { client.close({ skipRemote: updateAttempted }); }
      catch (err) { console.error(`[mcp-memory-auto-update] close: ${err.message}`); }
    }
    releaseLock(lock.owner);
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_RESTART_TIMEOUT_MS,
  stateFile,
  lockFile,
  readStateFile,
  writeStateFile,
  parseCheckUpdate,
  parseUpdateResult,
  isCheckDue,
  waitForExpectedVersion,
  runAutoUpdate,
};
