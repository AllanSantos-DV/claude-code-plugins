#!/usr/bin/env node
/**
 * brain-daemon-ensure.js — SessionStart / UserPromptSubmit hook.
 *
 * .mcp.json declares `brain-server` as a direct "type":"http" URL (no
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
 * Auto-setup: se o daemon está ABSENT e o node_modules do plugin está
 * faltando, roda plugin-setup.js em background (detached, non-blocking)
 * ANTES de tentar o spawn do daemon. Isso garante que as dependências
 * estão presentes na próxima tentativa, sem precisar que a LLM repasse
 * um aviso ao usuário.
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
const { dataDir } = require('./lib/data-dir.js');

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

/**
 * Roda plugin-setup.js em background (detached, não bloqueia o hook).
 * Retorna true se o spawn foi iniciado, false se o setup não era necessário
 * ou se o spawn falhou.
 */
function runSetupInBackground(root, dataDir) {
  const nodeModules = path.join(root, 'node_modules');
  const setupScript = path.join(root, 'scripts', 'plugin-setup.js');
  if (fs.existsSync(nodeModules)) return false; // deps presentes, sem necessidade
  if (!fs.existsSync(setupScript)) return false;
  try {
    const child = spawn(process.execPath, [setupScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    });
    child.unref();
    return true;
  } catch (err) {
    console.error(`[brain-daemon-ensure] não pôde spawn plugin-setup: ${err.message}`);
    return false;
  }
}

/**
 * Pure detector entry point — ensures the daemon, side effect only. Returns
 * the advisory text (string) when the daemon couldn't be ensured, or `null`
 * when healthy (silent). Never throws — fail-open, same guarantee as before.
 * @param {object} event
 * @returns {Promise<string|null>}
 */
async function run(_event) {
  try {
    const root = pluginRoot();
    const data = dataDir();

    // Auto-setup: se node_modules está faltando, roda plugin-setup.js em
    // background ANTES de chamar ensureDaemon. O daemon precisa das
    // dependências para subir saudável; se o setup está rodando, a próxima
    // tentativa de spawn vai encontrar tudo pronto.
    const setupStarted = runSetupInBackground(root, data);

    const fileUrl = require('url').pathToFileURL(
      path.join(root, 'servers', 'brain-server', 'lib', 'daemon-supervisor.js'),
    ).href;
    const { ensureDaemon } = await import(fileUrl);

    const result = await ensureDaemon({ pluginRoot: root, dataDir: data });

    if (result.status === 'error') {
      const setupNote = setupStarted
        ? ' [setup em background — tente novamente se o daemon não subir]'
        : '';
      return `[BRAIN] daemon único não pôde ser garantido (${result.error})${setupNote}. ` +
        'O brain-server tentará reiniciar automaticamente no próximo prompt; se falhar, ' +
        'rode `node scripts/plugin-setup.js && node servers/brain-server/index.js` manualmente.';
    }
    return null;
  } catch (err) {
    console.error(`[brain-daemon-ensure] ${err.message}`);
    return null; // nunca bloqueia o início da sessão
  }
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

module.exports = { pluginRoot, runSetupInBackground, run };
