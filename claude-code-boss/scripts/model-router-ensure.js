#!/usr/bin/env node
/**
 * model-router-ensure.js — SessionStart + UserPromptSubmit hook
 *
 * Garante que o proxy model-router está rodando.
 * O ANTHROPIC_BASE_URL precisa estar definido como variável de sistema Windows
 * (não em settings.json — o bloco env do settings não afeta as chamadas HTTP
 * do próprio Claude Code). Esse hook detecta se está configurado e guia o setup.
 *
 * Falha sempre silenciosa: se algo der errado, loga e sai sem bloquear o Claude Code.
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn, execSync } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────

function valid(v) { return v && !v.includes('${') ? v : null; }

const PLUGIN_ROOT = valid(process.env.CLAUDE_PLUGIN_ROOT)
  || path.resolve(__dirname, '..');

const DATA_DIR = valid(process.env.CLAUDE_PLUGIN_DATA)
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

const STATE_FILE    = path.join(DATA_DIR, 'model-router', 'state.json');
const LOG_FILE      = path.join(DATA_DIR, 'model-router', 'router.log');
const SERVER_SCRIPT = path.join(PLUGIN_ROOT, 'servers', 'model-router', 'index.js');
const CONFIG_FILE   = path.join(PLUGIN_ROOT, 'config', 'router-config.json');
// Override do usuário (chave NVIDIA + toggles) + carimbo do nudge de primeira execução.
const USER_CONFIG_FILE = path.join(DATA_DIR, 'model-router', 'user-config.json');
const NUDGE_STAMP      = path.join(DATA_DIR, 'model-router', '.nudge-stamp');

// ── Logger ────────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function appendLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${ts()}] [ENSURE] ${msg}\n`);
  } catch (_) { /* */ }
}
function log(msg) { process.stderr.write(`[model-router] ${msg}\n`); appendLog(msg); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (_) { /* */ }
  return null;
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (_) { /* */ }
  return {};
}

function readUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
  } catch (_) { void _; /* override ausente/ilegível → trata como não configurado */ }
  return null;
}

// Nudge ONE-SHOT: avisa que o roteador existe enquanto o usuário ainda não
// aceitou os termos. O carimbo garante que aparece só uma vez (não a cada sessão).
function firstRunNudge() {
  try {
    if (fs.existsSync(NUDGE_STAMP)) return '';
    const uc = readUserConfig();
    if (uc && uc.acceptedTerms === true) return '';
    fs.mkdirSync(path.dirname(NUDGE_STAMP), { recursive: true });
    fs.writeFileSync(NUDGE_STAMP, ts());
    return '⚙️ Roteador de modelo disponível — configure a chave NVIDIA (grátis) e ative em /dashboard.';
  } catch (e) {
    log(`AVISO: falha ao gravar nudge stamp: ${e.message}`);
    return '';
  }
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitForFreshState(minStartedAt, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const state = readState();
      if (state?.port && state?.startedAt >= minStartedAt) { resolve(state); return; }
      if (Date.now() - start > maxMs) { resolve(null); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function getSystemEnvVar(name) {
  // Lê variável de ambiente do nível User no Windows (não só da sessão atual)
  try {
    const out = execSync(
      `powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('${name}', 'User')"`,
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return out || null;
  } catch (_) { void _; return null; }
}

function setSystemEnvVar(name, value) {
  try {
    execSync(
      `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')"`,
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch (e) {
    log(`AVISO: não foi possível definir variável de sistema ${name}: ${e.message}`);
    return false;
  }
}

function startServer() {
  return new Promise((resolve) => {
    log('Iniciando servidor model-router em background...');

    if (!fs.existsSync(SERVER_SCRIPT)) {
      log(`ERRO: script do servidor não encontrado: ${SERVER_SCRIPT}`);
      resolve(false);
      return;
    }

    // Remove state file antigo para waitForFreshState não ler valor stale
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) { /* */ }

    const spawnedAt = new Date().toISOString();

    const child = spawn(process.execPath, [
      SERVER_SCRIPT,
      '--plugin-root', PLUGIN_ROOT,
      '--data-dir',    DATA_DIR,
    ], {
      detached: true,
      stdio:    ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: DATA_DIR },
    });
    child.unref();

    log(`Processo filho lançado (PID provável: ${child.pid}). Aguardando state file...`);

    waitForFreshState(spawnedAt, 10000).then((state) => {
      if (state?.port) {
        log(`Servidor iniciado na porta ${state.port}`);
        resolve(true);
      } else {
        log('ERRO: timeout aguardando state file. Roteamento desabilitado esta sessão.');
        resolve(false);
      }
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = readConfig();

  if (config.enabled === false) {
    log('Roteador desabilitado (enabled: false). Nada a fazer.');
    process.exit(0);
  }

  // ── 0. Instala/verifica wrapper do claude.exe ────────────────────────────
  // O Desktop App (Electron) strip NODE_OPTIONS e sobrescreve ANTHROPIC_BASE_URL.
  // O wrapper resolve isso interceptando ANTES do SDK Anthropic inicializar.
  try {
    const wrapperInstall = require('./model-router-wrapper-install');
    const result = wrapperInstall.install(PLUGIN_ROOT);
    if (result.reason === 'fresh-install') {
      log(`Wrapper instalado para versão ${result.version}. Reinício do Claude Code necessário.`);
    } else if (result.reason === 'compile-failed' || result.reason === 'install-failed') {
      log(`AVISO: falha na instalação do wrapper (${result.reason}). Roteamento pode não funcionar.`);
    }
  } catch (e) {
    log(`AVISO: erro no wrapper-install: ${e.message}`);
  }

  // ── 1. Garante servidor rodando ──────────────────────────────────────────
  log('Verificando status do model-router...');

  let state   = readState();
  let isRunning = false;

  if (state?.port) {
    isRunning = await healthCheck(state.port);
    if (isRunning) {
      log(`Servidor OK na porta ${state.port} (PID ${state.pid}).`);
    } else {
      log(`State file existe (porta ${state.port}) mas servidor offline. Reiniciando...`);
    }
  }

  if (!isRunning) {
    const started = await startServer();
    if (!started) {
      log('AVISO: roteamento indisponível nesta sessão. Claude Code usará Anthropic API diretamente.');
      process.exit(0);
    }
    state = readState();
  }

  if (!state?.port) {
    log('ERRO interno: sem porta no state. Continuando sem roteamento.');
    process.exit(0);
  }

  const proxyUrl = `http://127.0.0.1:${state.port}`;

  // ── 2. Garante NODE_OPTIONS e ANTHROPIC_BASE_URL no registry User ──────────
  // O Claude Desktop App (Electron) sobrescreve ANTHROPIC_BASE_URL no processo filho.
  // A solução é NODE_OPTIONS=--require patcher.js que atua DENTRO do processo Node.js
  // antes do SDK Anthropic inicializar.

  const PATCHER_FILE = path.join(os.homedir(), '.claude', 'model-router-patcher.js');
  const PATCHER_PATH = PATCHER_FILE.replace(/\\/g, '/'); // forward slashes (Node.js precisa disso em NODE_OPTIONS no Windows)
  const EXPECTED_NODE_OPTS = `--require "${PATCHER_PATH}"`;

  // Instala/atualiza o patcher na home (local estável). NODE_OPTIONS aponta pra cá
  // e não pro diretório versionado do cache, que muda a cada atualização do plugin.
  const PATCHER_SRC = path.join(PLUGIN_ROOT, 'servers', 'model-router', 'patcher.js');
  try {
    if (fs.existsSync(PATCHER_SRC)) {
      fs.copyFileSync(PATCHER_SRC, PATCHER_FILE);
    } else {
      log(`AVISO: patcher fonte não encontrado em ${PATCHER_SRC}`);
    }
  } catch (e) {
    log(`AVISO: não foi possível instalar o patcher: ${e.message}`);
  }

  const currentNodeOpts = getSystemEnvVar('NODE_OPTIONS') || '';
  const currentBaseUrl  = getSystemEnvVar('ANTHROPIC_BASE_URL') || '';
  const sessionUrl      = process.env.ANTHROPIC_BASE_URL || '';

  log(`Proxy em ${proxyUrl} | sessão="${sessionUrl}" | NODE_OPTIONS sistema="${currentNodeOpts || '(vazio)'}"`);

  // Garante NODE_OPTIONS correto no registry
  if (!currentNodeOpts.includes('model-router-patcher')) {
    log(`Definindo NODE_OPTIONS no sistema Windows: ${EXPECTED_NODE_OPTS}`);
    setSystemEnvVar('NODE_OPTIONS', EXPECTED_NODE_OPTS);
  }

  // Garante ANTHROPIC_BASE_URL no registry (fallback para sessões fora do Desktop App)
  if (currentBaseUrl !== proxyUrl) {
    setSystemEnvVar('ANTHROPIC_BASE_URL', proxyUrl);
  }

  let contextMsg;

  if (sessionUrl === proxyUrl) {
    contextMsg = `[model-router] ATIVO ✓ — porta ${state.port}. Classificador: ${config.nim?.apiKey ? 'NIM' : 'MiniLM local'}. Prompts roteados semanticamente (haiku/sonnet/opus).`;
    log('Roteamento ATIVO nesta sessão.');
  } else {
    // Patcher via NODE_OPTIONS resolve isso no próximo início. Informa o usuário.
    contextMsg = `[model-router] Servidor OK na porta ${state.port}. NODE_OPTIONS configurado com patcher. REINICIE o Claude Code para ativar o roteamento automático.`;
    log('Roteamento INATIVO nesta sessão. NODE_OPTIONS garantido — reiniciar ativará o patcher.');
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextMsg,
    },
  };

  // Nudge aditivo de primeira execução (não quebra o contrato do hook).
  const nudge = firstRunNudge();
  if (nudge) output.hookSpecificOutput.additionalContext = `${contextMsg}\n${nudge}`;

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

main().catch(e => {
  log(`ERRO fatal no ensure hook: ${e.message}`);
  process.exit(0); // Não bloqueia
});
