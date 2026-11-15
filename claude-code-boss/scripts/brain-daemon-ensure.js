#!/usr/bin/env node
/**
 * brain-daemon-ensure.js — SessionStart / UserPromptSubmit hook.
 *
 * plugin.json declares `brain-server` as a direct "type":"http" URL (no
 * `command`, no per-session process — ADR-001 "daemon único"). Algo
 * ainda precisa garantir que o daemon único está escutando na porta
 * fixa ANTES do cliente MCP do Claude Code tentar conectar no início
 * da sessão — e esse algo é este hook. Ele é efêmero (roda, garante,
 * sai — não é um runtime residente, então não viola o princípio
 * daemon-único que serve).
 *
 * Delega inteiramente ao lib/daemon-supervisor.js's ensureDaemon() —
 * a mesma lógica de find-or-start/swap já usada elsewhere; sem novo
 * código de ciclo de vida de daemon aqui.
 *
 * Auto-setup: se as dependências do plugin estão faltando, roda
 * plugin-setup.js em background (detached, non-blocking) e NÃO sobe o daemon
 * nesta rodada: sem as deps ele morre na importação (ERR_MODULE_NOT_FOUND,
 * crash-report de 2026-10-14). O próximo SessionStart/UserPromptSubmit acha as
 * deps prontas e sobe. A saída do setup vai para `plugin-setup.log` no data dir.
 *
 * Fail-open: qualquer erro significa apenas que a primeira ferramenta de
 * KB da sessão pode falhar e retentar num prompt posterior (o próximo
 * SessionStart/UserPromptSubmit re-emite este hook); este hook NUNCA
 * bloqueia o início de uma sessão.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');
const { dataDir } = require('../engine/lib/data-dir.js');
const brainConfig = require('../engine/lib/brain-config.js');
const mcpAutoUpdate = require('./lib/mcp-memory-auto-update.js');
const crashEvidence = require('./lib/crash-evidence.js');
const once = require('./lib/notice-once.js');

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

/**
 * Roda plugin-setup.js em background (detached, não bloqueia o hook).
 * Retorna true se um setup já roda nesta raiz ou se o spawn foi iniciado, false se o setup não era necessário
 * ou se o spawn falhou.
 */
function runSetupInBackground(root, dataDir) {
  const setupScript = path.join(root, 'scripts', 'plugin-setup.js');
  const ready = require('./lib/install-ready.js');
  // A setup already installing here: still installing, and no second process to find the lock held.
  if (ready.setupRunning(root)) return true;
  if (ready.installReady(root).ok) return false;
  if (!fs.existsSync(setupScript)) return false;
  let log = 'ignore';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    log = fs.openSync(path.join(dataDir, 'plugin-setup.log'), 'a');
  } catch (err) { console.error(`[brain-daemon-ensure] setup log unavailable: ${err.message}`); }
  try {
    const child = spawn(process.execPath, [setupScript], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    });
    child.unref();
    return true;
  } catch (err) {
    console.error(`[brain-daemon-ensure] não pôde spawn plugin-setup: ${err.message}`);
    return false;
  } finally {
    if (typeof log === 'number') fs.closeSync(log);
  }
}

/**
 * Pure detector entry point — ensures the daemon, side effect only. Returns
 * the advisory text (string) when the daemon couldn't be ensured, or `null`
 * when healthy (silent). Never throws — fail-open, same guarantee as before.
 * @param {object} event
 * @returns {Promise<string|null>}
 */
/**
 * Visible notice for a daemon that died without shutting down (the supervisor recorded it
 * before respawning). The Windows fault lookup is still running at this point, so the
 * notice points at the doctor, which reads the enriched record.
 * @param {object} crash  record returned by ensureDaemon (with logFile)
 * @returns {string}
 */
function crashAdvisory(crash) {
  return `[BRAIN-CRASH] The Brain daemon crashed and was restarted: ${crashEvidence.describe(crash)}. ` +
    `Evidence saved in ${crash.logFile}. Tell the user, and suggest running \`npm run doctor\` in the claude-code-boss plugin folder to see the cause and the fix.`;
}

async function run(event, deps = {}) {
  try {
    const root = deps.root || pluginRoot();
    const data = deps.data || dataDir();
    const setup = deps.runSetupInBackground || runSetupInBackground;
    require('./lib/mcp-launcher.js').installLauncher(data);

    // Deps missing → install in background and leave the spawn to the next
    // hook run; spawning now only crashes the daemon on import.
    if (setup(root, data)) {
      return once.notice({
        key: 'brain-setup', signature: 'installing', base: data,
        text: '[BRAIN] O serviço de memória do claude-code-boss está terminando a instalação e volta sozinho; não precisa fazer nada.',
        detail: `installing the plugin dependencies in the background (log: ${path.join(data, 'plugin-setup.log')})`,
      });
    }
    once.recovered('brain-setup', { base: data });

    let ensureDaemon = deps.ensureDaemon;
    if (!ensureDaemon) {
      const fileUrl = require('url').pathToFileURL(
        path.join(root, 'servers', 'brain-server', 'lib', 'daemon-supervisor.js'),
      ).href;
      ({ ensureDaemon } = await import(fileUrl));
    }

    const result = await ensureDaemon({ pluginRoot: root, dataDir: data });
    const crashNote = result.crash ? crashAdvisory(result.crash) + '\n' : '';

    if (result.status === 'error') {
      // One short line per owner while the same failure lasts; the full cause goes to brain-notices.log.
      const down = once.notice({
        key: 'brain-daemon', signature: `error:${result.error}`, base: data,
        text: '[BRAIN] O serviço de memória do claude-code-boss está fora do ar e está sendo restaurado automaticamente; não precisa fazer nada.',
        detail: `daemon único não pôde ser garantido (${result.error}); retried on the next prompt`,
      });
      return (crashNote + (down || '')).trim() || null;
    }
    once.recovered('brain-daemon', { base: data });
    if (event && event.hook_event_name === 'UserPromptSubmit') {
      const cfg = (deps.loadConfig || brainConfig.load)();
      const mm = (cfg && cfg.backend) || {};
      if (mm.type === 'mcp-memory' && !((mm.mcpMemory || {}).serverUrl)) await relaunchDeadMemoryServer({ ...deps, dir: data });
    }
    if (event && event.hook_event_name === 'SessionStart') {
      const loadConfig = deps.loadConfig || brainConfig.load;
      const cfg = loadConfig();
      // Contract step 1 (native-java ADR-023): a daemon that died or never came up at logon is
      // started at session start, before the first recall — but ONLY when its /health does not
      // answer. Running the launcher on every SessionStart (headless `claude -p` runs fire one
      // every few seconds) started a process tree each time for a daemon already up.
      const mm = (cfg && cfg.backend) || {};
      if (mm.type === 'mcp-memory' && !((mm.mcpMemory || {}).serverUrl)) await (deps.ensureMemoryServer || ensureMemoryServer)(deps);
      if (!deps.skipAutoUpdate) {
        const updateResult = await (deps.runAutoUpdate || mcpAutoUpdate.runAutoUpdate)({ event, config: cfg });
        if (updateResult && updateResult.status === 'error') return crashNote + updateResult.advisory;
      }
    }
    return crashNote ? crashNote.trimEnd() : null;
  } catch (err) {
    console.error(`[brain-daemon-ensure] ${err.message}`);
    return null; // nunca bloqueia o início da sessão
  }
}

const noticeFile = (dir) => path.join(dir || dataDir(), '.runtime', 'mcp-auto-update.notice');

/**
 * The mcp-memory auto-update, run apart from the session start (its download and restart can take
 * a minute). A failure cannot ride this session's context any more: it waits as a notice that the
 * next prompt takes once (takeAutoUpdateNotice).
 * @param {object} event  SessionStart payload
 * @param {{loadConfig?: Function, runAutoUpdate?: Function, dir?: string}} [deps]
 * @returns {Promise<{status: string}|null>}
 */
async function runAutoUpdateInBackground(event, deps = {}) {
  const cfg = (deps.loadConfig || brainConfig.load)();
  const result = await (deps.runAutoUpdate || mcpAutoUpdate.runAutoUpdate)({ event, config: cfg });
  if (result && result.status === 'error') {
    const file = noticeFile(deps.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result.advisory);
    once.logDetail(`mcp-memory auto-update failed: ${result.error}`, { base: deps.dir });
  }
  return result;
}

/**
 * The failed background auto-update, once: the advisory text, or null when none is waiting.
 * @param {{dir?: string}} [opts]
 * @returns {string|null}
 */
function takeAutoUpdateNotice({ dir } = {}) {
  const file = noticeFile(dir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[brain-daemon-ensure] auto-update notice unreadable: ${err.message}`);
    return null;
  }
  try { fs.unlinkSync(file); } catch (err) { console.error(`[brain-daemon-ensure] auto-update notice not removed: ${err.message}`); }
  return text || null;
}

/**
 * Kick the memory server's launcher only if the daemon is down (mcp-client's own health check:
 * daemon.json → GET /health; alive → nothing is spawned). Never throws, never waits for the boot.
 * @param {{kickLauncher?: Function, McpClient?: Function}} [deps]
 * @returns {Promise<'alive'|'kicked'|'error'>}
 */
async function ensureMemoryServer(deps = {}) {
  const Client = deps.McpClient || require('../engine/mcp-client.js');
  // The real kick is CONFIRMED (kickLauncherVerified): a hidden launch that silently failed
  // reported "kicked" forever. The sync test seam (deps.kickLauncher) stays as it was.
  let verify = null;
  const kick = deps.kickLauncher || (() => {
    const L = require('./lib/mcp-bootstrap/launcher.js');
    if (!fs.existsSync(L.launcherPath())) return false;
    verify = L.kickLauncherVerified();
    return true;
  });
  const client = new Client({ restartMode: 'background', kickLauncher: kick });
  try {
    await client._ensureDaemon();
    return 'alive';
  } catch (err) {
    if (err && err.code === 'MEMORY_SERVER_RESTARTING' && !/not found/.test(err.message)) {
      const how = verify ? await verify : 'kicked';
      return how === 'fallback' ? 'kicked-visible' : how === 'failed' ? 'error' : 'kicked';
    }
    console.error(`[brain-daemon-ensure] memory server check failed: ${err.message}`);
    return 'error';
  }
}

const KICK_MARKER_COOLDOWN_MS = 120000;
const kickMarker = (dir) => path.join(dir || dataDir(), '.runtime', 'memory-server-kick.json');

/**
 * Mid-session relaunch of a memory server that died: asks its launcher to start it, once per
 * failure. The kick is remembered on disk (hook processes are short-lived) and not repeated
 * while the cooldown runs; the marker goes away as soon as the server answers again.
 * @param {{dir?: string, now?: number, ensureMemoryServer?: Function}} [deps]
 * @returns {Promise<'alive'|'kicked'|'cooldown'|'error'|'kicked-visible'>}
 */
async function relaunchDeadMemoryServer(deps = {}) {
  const file = kickMarker(deps.dir);
  const now = deps.now || Date.now();
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')).at || 0; } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[brain-daemon-ensure] kick marker unreadable: ${err.message}`);
  }
  const probe = deps.probeOnly || (async () => {
    const Client = deps.McpClient || require('../engine/mcp-client.js');
    const c = new Client({ restartMode: 'background', kickLauncher: () => false });
    const url = c.serverUrl || c._discoverDaemonUrl();
    return !!(url && await c._httpHealth(url));
  });
  if (await probe()) {
    if (last) try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') console.error(`[brain-daemon-ensure] kick marker not removed: ${err.message}`); }
    return 'alive';
  }
  if (last && now - last < KICK_MARKER_COOLDOWN_MS) return 'cooldown';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now }));
  } catch (err) { console.error(`[brain-daemon-ensure] kick marker not written: ${err.message}`); }
  const outcome = await (deps.ensureMemoryServer || ensureMemoryServer)(deps);
  once.logDetail(`memory server was down at a prompt: launcher ${outcome}`, { base: deps.dir });
  return outcome;
}

async function main() {
  let eventName = 'SessionStart';
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    eventName = event.hook_event_name || eventName;
    const text = await run(event);
    if (text) {
      emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
      return;
    }
    emitEmpty();
  } catch (err) {
    console.error(`[brain-daemon-ensure] ${err.message}`);
    emitEmpty(); // nunca bloqueia o início da sessão
  }
}

if (require.main === module) main();

module.exports = {
  relaunchDeadMemoryServer, KICK_MARKER_COOLDOWN_MS, crashAdvisory, pluginRoot, runSetupInBackground, run, ensureMemoryServer, runAutoUpdateInBackground, takeAutoUpdateNotice };
