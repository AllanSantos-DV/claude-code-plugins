#!/usr/bin/env node
/**
 * model-router-ensure.js — SessionStart + UserPromptSubmit hook
 *
 * Garante que o proxy model-router está rodando.
 *
 * DESIGN (isolamento): o roteamento é aplicado SOMENTE dentro do Claude Code,
 * através do wrapper do claude.exe (servers/model-router/wrapper.cs). O wrapper
 * injeta ANTHROPIC_BASE_URL apenas no processo do Claude Code, lendo a URL de um
 * arquivo fixo (PROXY_URL_FILE). NUNCA definimos variáveis no nível User/sistema:
 * elas vazam para OUTROS apps (ex.: GitHub Copilot/hermes) e corrompem o launch
 * deles (NODE_OPTIONS com aspas quebrou --settings; ANTHROPIC_BASE_URL apontando
 * pra porta morta gerou "Solicitação falhou"). Este hook também faz self-heal,
 * removendo qualquer resíduo global deixado por versões antigas.
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
// Arquivo-fonte-da-verdade da URL do proxy, em local FIXO (independente do sufixo
// do data-dir). O wrapper do claude.exe lê este arquivo para injetar
// ANTHROPIC_BASE_URL apenas dentro do Claude Code. Quando o roteador para ou é
// desabilitado, o arquivo é removido → o wrapper não injeta porta morta (self-heal).
const PROXY_URL_FILE = path.join(os.homedir(), '.claude', 'model-router-url.txt');

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

function clearSystemEnvVar(name) {
  try {
    execSync(
      `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('${name}', $null, 'User')"`,
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch (e) {
    log(`AVISO: não foi possível limpar variável de sistema ${name}: ${e.message}`);
    return false;
  }
}

// Remove QUALQUER resíduo global de versões antigas. Variáveis no nível User
// vazam para outros apps (ex.: GitHub Copilot/hermes) e quebram o launch deles.
// O roteamento NUNCA deve ser global — só dentro do Claude Code, via wrapper.
function cleanupGlobalEnv() {
  const node = getSystemEnvVar('NODE_OPTIONS') || '';
  if (node.includes('model-router-patcher')) {
    log(`Self-heal: limpando NODE_OPTIONS global residual: "${node}"`);
    clearSystemEnvVar('NODE_OPTIONS');
  }
  const base = getSystemEnvVar('ANTHROPIC_BASE_URL') || '';
  if (/127\.0\.0\.1|localhost/.test(base)) {
    log(`Self-heal: limpando ANTHROPIC_BASE_URL global residual: "${base}"`);
    clearSystemEnvVar('ANTHROPIC_BASE_URL');
  }
  // Remove o patcher órfão do mecanismo global antigo (inerte sem NODE_OPTIONS,
  // mas removido para higiene total — nada mais o referencia no design wrapper-only).
  try {
    const oldPatcher = path.join(os.homedir(), '.claude', 'model-router-patcher.js');
    if (fs.existsSync(oldPatcher)) {
      fs.unlinkSync(oldPatcher);
      log('Self-heal: removido patcher órfão do home.');
    }
  } catch (e) {
    log(`AVISO: não foi possível remover patcher órfão: ${e.message}`);
  }
}

function writeProxyUrlFile(url) {
  try {
    fs.mkdirSync(path.dirname(PROXY_URL_FILE), { recursive: true });
    fs.writeFileSync(PROXY_URL_FILE, url, 'utf-8');
    return true;
  } catch (e) {
    log(`AVISO: não foi possível escrever ${PROXY_URL_FILE}: ${e.message}`);
    return false;
  }
}

function clearProxyUrlFile() {
  try {
    if (fs.existsSync(PROXY_URL_FILE)) fs.unlinkSync(PROXY_URL_FILE);
  } catch (e) {
    log(`AVISO: não foi possível remover ${PROXY_URL_FILE}: ${e.message}`);
  }
}

// Garante isolamento total: nenhum global, nenhum arquivo de URL apontando pra
// roteador inexistente. Chamado em todo caminho de saída "sem roteamento".
function disableRoutingFootprint() {
  cleanupGlobalEnv();
  clearProxyUrlFile();
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
    log('Roteador desabilitado (enabled: false). Limpando footprint e saindo.');
    disableRoutingFootprint();
    process.exit(0);
  }

  // ── 0. Instala/verifica wrapper do claude.exe ────────────────────────────
  // O Desktop App (Electron) strip NODE_OPTIONS e sobrescreve ANTHROPIC_BASE_URL.
  // O wrapper resolve isso interceptando ANTES do SDK Anthropic inicializar.
  let wrapperResult = null;
  try {
    const wrapperInstall = require('./model-router-wrapper-install');
    wrapperResult = wrapperInstall.install(PLUGIN_ROOT);
    if (wrapperResult.reason === 'fresh-install') {
      log(`Wrapper instalado para versão ${wrapperResult.version}. Reinício do Claude Code necessário.`);
    } else if (wrapperResult.reason === 'compile-failed' || wrapperResult.reason === 'install-failed') {
      log(`AVISO: falha na instalação do wrapper (${wrapperResult.reason}). Roteamento pode não funcionar.`);
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
      log('AVISO: roteamento indisponível nesta sessão. Limpando footprint; Claude Code usará Anthropic API diretamente.');
      disableRoutingFootprint();
      process.exit(0);
    }
    state = readState();
  }

  if (!state?.port) {
    log('ERRO interno: sem porta no state. Limpando footprint e continuando sem roteamento.');
    disableRoutingFootprint();
    process.exit(0);
  }

  const proxyUrl = `http://127.0.0.1:${state.port}`;

  // ── 2. Publica a URL do proxy SÓ para o Claude Code (via wrapper) ──────────
  // NUNCA setamos variáveis globais (User/sistema): elas vazam para outros apps
  // (GitHub Copilot/hermes) e corrompem o launch deles. Em vez disso, gravamos a
  // URL num arquivo fixo que o wrapper do claude.exe lê e injeta APENAS dentro do
  // processo do Claude Code. Também limpamos qualquer resíduo global antigo.
  cleanupGlobalEnv();
  writeProxyUrlFile(proxyUrl);

  const wrapperActive = !!(wrapperResult && wrapperResult.installed);
  log(`Proxy em ${proxyUrl} | wrapper instalado=${wrapperActive} | URL publicada em ${PROXY_URL_FILE}`);

  let contextMsg;
  if (wrapperActive) {
    contextMsg = `[model-router] ATIVO ✓ — porta ${state.port} (via wrapper do claude.exe). Classificador: ${config.nim?.apiKey ? 'NIM' : 'MiniLM local'}. Prompts roteados (haiku/sonnet/opus). Isolado no Claude Code — outros apps não são afetados.`;
    log('Roteamento ATIVO (wrapper instalado).');
  } else {
    const why = wrapperResult ? wrapperResult.reason : 'desconhecido';
    contextMsg = `[model-router] Servidor OK na porta ${state.port}, mas o wrapper do claude.exe NÃO está instalado (${why}). O roteamento só ativa quando o Claude Code Desktop estiver acessível para o wrapper. Nenhuma variável global foi definida (zero efeito em outros apps).`;
    log(`Roteamento INATIVO — wrapper não instalado (${why}).`);
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
