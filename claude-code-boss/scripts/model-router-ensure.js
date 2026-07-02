#!/usr/bin/env node
/**
 * model-router-ensure.js — SessionStart + UserPromptSubmit hook
 *
 * Garante que o proxy model-router está rodando na PORTA FIXA e que o Claude Code
 * aponta para ele.
 *
 * DESIGN (isolamento — dois mecanismos, conforme o entrypoint):
 *   • CLI (entrypoint=cli): o cowork RESPEITA env.ANTHROPIC_BASE_URL do
 *     ~/.claude/settings.json e o aplica só aos processos do Claude Code.
 *   • Desktop (entrypoint=claude-desktop, 2.1.197+): PROVADO que o app FORÇA
 *     ANTHROPIC_BASE_URL=api.anthropic.com no processo claude-code e este passa a
 *     IGNORAR o settings.json env. Aí o roteamento é aplicado por um SHIM do
 *     binário (claude.exe→claude-real.exe + wrapper que troca a URL pelo proxy),
 *     instalado/mantido por model-router-shim.js. O shim é FAIL-OPEN (router morto
 *     → Claude direto) e afeta SÓ o claude.exe do Claude Code.
 * Em ambos os casos NUNCA definimos variáveis no nível User/sistema (vazam e
 * corrompem outros apps, ex.: GitHub Copilot/hermes) nem mexemos em PATH/hosts/CA.
 *
 * Self-heal: a URL (settings.json env + ~/.claude/model-router-url.txt lido pelo
 * shim) é gravada APENAS quando o roteador está vivo, e REMOVIDA do url.txt quando
 * não está. Também removemos qualquer resíduo global (NODE_OPTIONS/
 * ANTHROPIC_BASE_URL User-scope) deixado por versões antigas.
 *
 * Falha sempre silenciosa: se algo der errado, loga e sai sem bloquear o Claude Code.
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn, execSync } = require('child_process');
const shim   = require('./model-router-shim.js');

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
// Carimbo de "aviso ATIVO já injetado nesta sessão" — evita repetir o mesmo texto
// informativo em todo UserPromptSubmit (ruído de contexto). Mapa { chave: ts }.
const ANNOUNCE_FILE    = path.join(DATA_DIR, 'model-router', '.announced-sessions.json');
const ANNOUNCE_TTL_MS  = 24 * 60 * 60 * 1000;  // GC de sessões com > 24h
const ANON_COOLDOWN_MS = 10 * 60 * 1000;       // fallback quando não há session_id
// Arquivo de URL que o WRAPPER (shim do claude.exe) lê para descobrir o proxy
// vivo. PROVADO E2E: no Claude Desktop 2.1.197 o app força ANTHROPIC_BASE_URL=
// api.anthropic.com no processo claude-code e este passa a IGNORAR o `env` do
// settings.json — então, no Desktop, quem aplica o roteamento é o shim. Escrito
// SOMENTE quando o roteador está de pé; removido quando não está (o wrapper cai
// no fail-open e o Claude vai direto). O settings.json env continua mantido por
// compat com o modo CLI (entrypoint=cli respeita o env block).
const PROXY_URL_FILE = path.join(os.homedir(), '.claude', 'model-router-url.txt');
// settings.json do Claude Code — onde gravamos env.ANTHROPIC_BASE_URL (escopo Claude).
const SETTINGS_FILE  = path.join(os.homedir(), '.claude', 'settings.json');

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

// Merge do override do usuário POR CIMA dos defaults shipados (override vence).
// Espelha servers/model-router/index.js#mergeUserConfig: `nim` e `routing` são
// mesclados RASO (preserva chaves shipadas); escalares (enabled/port) sobrescrevem.
// É o que torna o OPT-IN durável: /dashboard grava {enabled:true} no user-config e
// tanto o ensure (aqui) quanto o server passam a ver enabled:true — sobrevive a
// updates do plugin (user-config vive no DATA_DIR, fora do pacote versionado).
function mergeRouterConfig(shipped, override) {
  const merged = { ...(shipped || {}) };
  if (!override || typeof override !== 'object') return merged;
  for (const key of Object.keys(override)) {
    if ((key === 'nim' || key === 'routing') && override[key] && typeof override[key] === 'object') {
      merged[key] = { ...(merged[key] || {}), ...override[key] };
    } else {
      merged[key] = override[key];
    }
  }
  return merged;
}

function readConfig() {
  let shipped = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) shipped = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (_) { void _; /* shipped ilegível → defaults vazios */ }
  return mergeRouterConfig(shipped, readUserConfig());
}

// Lê o payload do hook no stdin (session_id, hook_event_name…) sem travar quando
// rodado manualmente num terminal interativo (isTTY) ou sem stdin.
function readHookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf-8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) { /* stdin ausente/ilegível: segue sem payload */ }
  return {};
}

// Decide se o aviso "[model-router] ATIVO" deve ser injetado neste turno.
// Regra: sempre que o servidor (re)subiu agora; caso contrário, no máximo 1x por
// session_id; sem session_id, cai num cooldown por tempo. Persiste o carimbo.
function shouldAnnounce(sessionId, justStarted) {
  let store = {};
  try {
    if (fs.existsSync(ANNOUNCE_FILE)) store = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf-8')) || {};
  } catch (_) { store = {}; }
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (typeof store[k] !== 'number' || now - store[k] > ANNOUNCE_TTL_MS) delete store[k];
  }
  const key = sessionId ? `s:${sessionId}` : '_anon';
  let announce;
  if (justStarted) announce = true;
  else if (sessionId) announce = !store[key];
  else announce = !store[key] || (now - store[key]) > ANON_COOLDOWN_MS;
  if (announce) {
    store[key] = now;
    try {
      fs.mkdirSync(path.dirname(ANNOUNCE_FILE), { recursive: true });
      fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(store));
    } catch (_) { /* */ }
  }
  return announce;
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

// ── settings.json (escopo Claude Code) ───────────────────────────────────────
// O mecanismo de roteamento é o bloco `env` do ~/.claude/settings.json. PROVADO
// (30/06): o cowork do Claude Desktop RESPEITA env.ANTHROPIC_BASE_URL e o aplica
// só aos processos do Claude Code — zero efeito em outros apps (Copilot/hermes).
// Escrevemos a URL APENAS quando o roteador está vivo; removemos no instante em que
// não está. Escrita atômica (temp + rename). Só tocamos no NOSSO valor (localhost) —
// uma ANTHROPIC_BASE_URL custom do usuário é preservada e nunca sobrescrita.

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return {};
  } catch (e) {
    log(`AVISO: settings.json ilegível (${e.message}) — não vou alterá-lo.`);
    return null; // null = não mexer (evita corromper um arquivo já quebrado)
  }
}

function writeSettings(obj) {
  const tmp = SETTINGS_FILE + '.tmp-router';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function isOurProxyUrl(url) {
  return typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(url);
}

// Idempotente: grava env.ANTHROPIC_BASE_URL só se mudou. Retorna true se, ao final,
// o settings.json aponta para o nosso proxy.
function enableSettingsRouting(url) {
  const s = readSettings();
  if (s === null) return false;
  const cur = s.env && s.env.ANTHROPIC_BASE_URL;
  if (cur && !isOurProxyUrl(cur)) {
    log(`AVISO: settings.json já tem ANTHROPIC_BASE_URL custom ("${cur}") — preservado, roteador NÃO sobrescreve.`);
    return false;
  }
  if (cur === url) return true; // já correto → no-op (não reescreve o arquivo)
  s.env = s.env || {};
  s.env.ANTHROPIC_BASE_URL = url;
  try {
    writeSettings(s);
    log(`settings.json: env.ANTHROPIC_BASE_URL → ${url}`);
    return true;
  } catch (e) {
    log(`AVISO: não foi possível escrever settings.json: ${e.message}`);
    return false;
  }
}

// Remove SÓ o nosso valor (localhost). Nunca apaga uma ANTHROPIC_BASE_URL custom.
function disableSettingsRouting() {
  const s = readSettings();
  if (s === null || !s.env) return;
  if (!isOurProxyUrl(s.env.ANTHROPIC_BASE_URL)) return; // não é nosso → não mexe
  delete s.env.ANTHROPIC_BASE_URL;
  if (Object.keys(s.env).length === 0) delete s.env;
  try {
    writeSettings(s);
    log('settings.json: env.ANTHROPIC_BASE_URL removido (roteador indisponível → Claude direto).');
  } catch (e) {
    log(`AVISO: não foi possível limpar settings.json: ${e.message}`);
  }
}

// Remove arquivo de URL quando o roteador NÃO está vivo (wrapper cai no fail-open).
function clearLegacyUrlFile() {
  try {
    if (fs.existsSync(PROXY_URL_FILE)) fs.unlinkSync(PROXY_URL_FILE);
  } catch (e) {
    log(`AVISO: não foi possível remover ${PROXY_URL_FILE}: ${e.message}`);
  }
}

// Publica a URL viva do proxy para o WRAPPER (shim) ler. Escrita atômica
// (temp + rename). Chamado só quando o roteador respondeu /health.
function writeProxyUrlFile(url) {
  try {
    fs.mkdirSync(path.dirname(PROXY_URL_FILE), { recursive: true });
    const tmp = PROXY_URL_FILE + '.tmp-router';
    fs.writeFileSync(tmp, url);
    fs.renameSync(tmp, PROXY_URL_FILE);
  } catch (e) {
    log(`AVISO: não foi possível escrever ${PROXY_URL_FILE}: ${e.message}`);
  }
}

// Mantém o shim do claude.exe na versão ativa do Claude Code (Windows-only).
// Best-effort e fail-open: qualquer falha loga e segue sem bloquear o Claude.
// Vale a partir da PRÓXIMA vez que o app spawnar o claude.exe (o hook roda tarde,
// dentro do claude-code já em execução).
function maintainShimSafe() {
  if (process.platform !== 'win32') return;
  try {
    const r = shim.maintainShim(PLUGIN_ROOT, DATA_DIR, log);
    if (r && r.result && r.result !== 'ok' && r.result !== 'already') {
      log(`Shim do claude.exe: ${r.result}${r.dir ? ` @ ${r.dir}` : ''}`);
    }
  } catch (e) {
    log(`AVISO: manutenção do shim falhou: ${e.message}`);
  }
}

// Caminho de saída "sem roteamento": tira a URL do settings.json, limpa resíduo
// global de versões antigas e o arquivo de URL legado. Claude Code usa Anthropic direto.
function disableRoutingFootprint() {
  disableSettingsRouting();
  cleanupGlobalEnv();
  clearLegacyUrlFile();
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
  const hookInput = readHookInput();
  const sessionId = hookInput.session_id || hookInput.sessionId || null;

  if (config.enabled === false) {
    log('Roteador desabilitado (enabled: false). Limpando footprint e saindo.');
    disableRoutingFootprint();
    if (process.platform === 'win32') {
      try { shim.removeShimAll(log); } catch (e) { log(`AVISO: remoção do shim falhou: ${e.message}`); }
    }
    process.exit(0);
  }

  // ── 1. Garante servidor rodando na PORTA FIXA ────────────────────────────
  const FIXED_PORT = config.port || 13456;
  log(`Verificando model-router na porta fixa ${FIXED_PORT}...`);

  let justStarted = false;
  let isRunning = await healthCheck(FIXED_PORT);
  if (isRunning) {
    const st = readState();
    log(`Servidor OK na porta ${FIXED_PORT}${st && st.pid ? ` (PID ${st.pid})` : ''}.`);
  } else {
    log(`Porta ${FIXED_PORT} sem resposta. Iniciando servidor...`);
    const started = await startServer();
    if (started) isRunning = await healthCheck(FIXED_PORT);
    if (!isRunning) {
      log('AVISO: roteamento indisponível nesta sessão. Removendo footprint; Claude Code usará Anthropic API diretamente.');
      disableRoutingFootprint();
      process.exit(0);
    }
    justStarted = true;
  }

  const proxyUrl = `http://127.0.0.1:${FIXED_PORT}`;

  // ── 2. Publica a URL: settings.json env (CLI) + url.txt p/ o shim (Desktop) ─
  // PROVADO: via CLI (entrypoint=cli) o cowork respeita env.ANTHROPIC_BASE_URL do
  // settings.json. Mas no Desktop (entrypoint=claude-desktop, 2.1.197+) o app força
  // api.anthropic.com no processo e o claude-code IGNORA o settings.json env → quem
  // roteia é o SHIM do claude.exe, que lê a URL viva do url.txt. Mantemos os dois
  // mecanismos: settings.json (CLI) + shim (Desktop). Nenhuma variável global é
  // definida → zero efeito em outros apps. Resíduo global antigo é removido (self-heal).
  const wired = enableSettingsRouting(proxyUrl);
  cleanupGlobalEnv();
  writeProxyUrlFile(proxyUrl);   // canal oficial wrapper(shim) ↔ ensure
  maintainShimSafe();            // instala/reaplica o shim do claude.exe (Windows)

  let contextMsg;
  if (wired) {
    contextMsg = `[model-router] ATIVO ✓ — porta ${FIXED_PORT} via settings.json env (escopo Claude Code). Classificador: ${config.nim?.apiKey ? 'NIM' : 'MiniLM local'}. Prompts roteados (haiku/sonnet/opus). Isolado: outros apps não são afetados. Se acabou de instalar/ativar, reinicie o Claude Code uma vez para o roteamento engatar.`;
    log('Roteamento ATIVO (settings.json env).');
  } else {
    contextMsg = `[model-router] Servidor OK na porta ${FIXED_PORT}, mas não gravei env.ANTHROPIC_BASE_URL no settings.json (já existe uma URL custom, ou o arquivo está ilegível). Nenhuma variável global foi definida (zero efeito em outros apps).`;
    log('Roteamento INATIVO — settings.json não atualizado.');
  }

  // O aviso "[model-router] ATIVO" é informativo e idêntico a cada turno — repeti-lo
  // em todo UserPromptSubmit vira ruído de contexto (~89 tokens/turno). Emitimos o
  // aviso completo no máximo 1x por sessão (ou quando o servidor (re)subiu agora). O
  // trabalho real (garantir o router + re-armar settings/url.txt) continua todo turno;
  // só a injeção de contexto passa a ser 1x. O nudge de primeira execução tem carimbo
  // próprio (.nudge-stamp) e sempre passa quando existe.
  const nudge = firstRunNudge();
  const announce = shouldAnnounce(sessionId, justStarted);
  let additionalContext = null;
  if (announce && nudge) additionalContext = `${contextMsg}\n${nudge}`;
  else if (announce)     additionalContext = contextMsg;
  else if (nudge)        additionalContext = nudge;

  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    }) + '\n');
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    log(`ERRO fatal no ensure hook: ${e.message}`);
    process.exit(0); // Não bloqueia
  });
}

// Export p/ testes herméticos da lógica de opt-in. O guard require.main===module
// acima garante que um require() em teste NÃO dispara main() (nenhum efeito colateral).
module.exports = { mergeRouterConfig, readConfig };
