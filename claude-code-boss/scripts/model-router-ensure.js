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
const { spawn, execSync, execFileSync } = require('child_process');
const shim   = require('./model-router-shim.js');
const { resolveMode } = require('./lib/router-mode.js');
const { writeJsonAtomic } = require('./lib/atomic-write.js');
const { dataDir } = require('./lib/data-dir.js');
const { routerUserConfigPath, backfillRouterUserConfig } = require('./lib/router-config-path.js');
const { configFingerprint } = require('./lib/router-fingerprint.js');

// ── Paths ─────────────────────────────────────────────────────────────────────

function valid(v) { return v && !v.includes('${') ? v : null; }

const PLUGIN_ROOT = valid(process.env.CLAUDE_PLUGIN_ROOT)
  || path.resolve(__dirname, '..');

const DATA_DIR = dataDir();

const STATE_FILE    = path.join(DATA_DIR, 'model-router', 'state.json');
const LOG_FILE      = path.join(DATA_DIR, 'model-router', 'router.log');
// Token de identidade da porta fixa (verify-before-trust). Escrito pelo servidor
// (servers/model-router/index.js) com mode 0o600; lido AQUI p/ provar que quem
// ocupa a porta é o NOSSO roteador ANTES de apontar o Claude Code para lá (senão o
// Claude mandaria a credencial real a um squatter). Ver healthCheck abaixo.
const ROUTER_TOKEN_FILE = path.join(DATA_DIR, 'model-router', 'router.token');
const SERVER_SCRIPT = path.join(PLUGIN_ROOT, 'servers', 'model-router', 'index.js');
const CONFIG_FILE   = path.join(PLUGIN_ROOT, 'config', 'router-config.json');
// Override do usuário (chave NVIDIA + toggles) — vive num caminho GLOBAL estável
// (globalDir()/model-router/user-config.json) para todo processo concordar e a
// troca de pasta de dados nunca órfãos a chave salva. Carimbo do nudge fica no DATA_DIR.
const USER_CONFIG_FILE = routerUserConfigPath();
const NUDGE_STAMP      = path.join(DATA_DIR, 'model-router', '.nudge-stamp');
// Carimbo de "aviso ATIVO já injetado nesta sessão" — evita repetir o mesmo texto
// informativo em todo UserPromptSubmit (ruído de contexto). Mapa { chave: ts }.
const ANNOUNCE_FILE    = path.join(DATA_DIR, 'model-router', '.announced-sessions.json');
const ANNOUNCE_TTL_MS  = 24 * 60 * 60 * 1000;  // GC de sessões com > 24h
const ANON_COOLDOWN_MS = 10 * 60 * 1000;       // fallback quando não há session_id
// Carimbo da ÚLTIMA troca de build (kill+respawn por buildChanged). Duas instalações
// válidas do MESMO plugin rodando ao mesmo tempo (checkout dev vs cache do
// marketplace) resolvem PLUGIN_ROOT DIFERENTE cada uma — cada SessionStart/"Salvar &
// aplicar" acha que o processo vivo é "outro build" e o derruba pro SEU path, num
// ping-pong: A mata B, B (na sessão seguinte) mata A de volta, cada kill deixando a
// porta momentaneamente fora do ar (visto 2026-08-05: dois kills em ~10s, ECONNREFUSED
// no meio de uma request → "Chat admission capacity" no cliente). O debounce abaixo
// quebra o loop sem desligar o self-heal legítimo (1 troca de build por janela é o
// caso normal de "acabei de instalar uma versão nova").
const BUILD_SWITCH_STAMP     = path.join(DATA_DIR, 'model-router', '.build-switch-stamp');
const BUILD_SWITCH_DEBOUNCE_MS = 60000;
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

// epoch ms da última troca de build, ou 0 se nunca (ou arquivo ilegível — trata
// como "faz tempo", nunca bloqueia o self-heal por um carimbo corrompido).
function readBuildSwitchStamp() {
  try {
    const raw = fs.readFileSync(BUILD_SWITCH_STAMP, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    // Ausente é o caso NORMAL (primeira execução) e ilegível é inofensivo: os dois
    // significam "faz tempo", que é o lado seguro — libera o self-heal. Logar aqui
    // seria ruído em toda sessão nova, então o erro é explicitamente descartado.
    void err;
    return 0;
  }
}

function writeBuildSwitchStamp() {
  try {
    fs.mkdirSync(path.dirname(BUILD_SWITCH_STAMP), { recursive: true });
    fs.writeFileSync(BUILD_SWITCH_STAMP, String(Date.now()));
  } catch (e) { log(`AVISO: não foi possível gravar o carimbo de troca de build: ${e.message}`); }
}

// Merge do override do usuário POR CIMA dos defaults shipados (override vence).
// Espelha servers/model-router/index.js#mergeUserConfig: `nim`, `routing`,
// `fallback` e `sticky` são mesclados RASO (preserva chaves shipadas — ex.: um
// user-config {sticky:{enabled:true}} liga o sticky SEM apagar ttlMs; um
// {fallback:{enabled:true}} liga o fallback SEM apagar triggerStatuses/cooldown);
// escalares (enabled/port) sobrescrevem. É o que torna o OPT-IN durável: /dashboard
// grava {enabled:true} ou {fallback:{enabled:true}} no user-config e tanto o ensure
// (aqui) quanto o server passam a ver o opt-in — sobrevive a updates do plugin
// (user-config vive no DATA_DIR, fora do pacote versionado).
function mergeRouterConfig(shipped, override) {
  const merged = { ...(shipped || {}) };
  if (!override || typeof override !== 'object') return merged;
  for (const key of Object.keys(override)) {
    if ((key === 'nim' || key === 'routing' || key === 'fallback' || key === 'sticky' || key === 'byok' || key === 'contextTuning') && override[key] && typeof override[key] === 'object') {
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

// ── Token-override env bundle (Parte B) ──────────────────────────────────────
// Ao LIGAR o roteamento (proxy custom) setamos, junto do ANTHROPIC_BASE_URL, dois
// env que RECUPERAM o que o proxy custom desliga/infla: ENABLE_TOOL_SEARCH=true
// (religa o tool-search nativo, ~52k deferidos/request) e CLAUDE_CODE_AUTO_COMPACT_
// WINDOW (capa o contexto ativo mantendo o 1M disponível). Medido na sessão real:
// cache_read/turno 447k → 74–127k. Ao DESLIGAR, removemos só os NOSSOS.
const AUTO_COMPACT_DEFAULT = 200000;
const AUTO_COMPACT_MIN = 50000;
const AUTO_COMPACT_MAX = 1000000;

// PURA: resolve o teto de auto-compact a partir do config (já mesclado), clampando
// a uma faixa sã. autoCompactWindow ausente → default (sem aviso). Fora da faixa /
// inválido → clampado com flag (o orquestrador loga um AVISO visível).
function resolveAutoCompactWindow(config) {
  const raw = config && config.autoCompactWindow;
  if (raw == null) return { value: AUTO_COMPACT_DEFAULT, clamped: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: AUTO_COMPACT_DEFAULT, clamped: true, original: raw };
  const v = Math.max(AUTO_COMPACT_MIN, Math.min(Math.trunc(n), AUTO_COMPACT_MAX));
  return { value: v, clamped: v !== n, original: n };
}

// PURA: dado o env ATUAL do settings.json, a nossa base_url e o valor de auto-
// compact, computa o env DESEJADO e se há mudança a gravar. NUNCA clobbera um
// ENABLE_TOOL_SEARCH/AUTO_COMPACT que o usuário fixou (== null → só preenche
// ausente). base_url custom de terceiro → { foreign:true } (preserva o do usuário).
// `isOurs(url)` é injetado (o real é isOurProxyUrl) p/ testes herméticos.
function planEnableEnv(currentEnv, url, autoCompactValue, isOurs) {
  const env = { ...(currentEnv || {}) };
  const cur = env.ANTHROPIC_BASE_URL;
  if (cur && !isOurs(cur)) return { foreign: true };
  const next = { ...env };
  next.ANTHROPIC_BASE_URL = url;
  if (next.ENABLE_TOOL_SEARCH == null) next.ENABLE_TOOL_SEARCH = 'true';
  if (next.CLAUDE_CODE_AUTO_COMPACT_WINDOW == null) next.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactValue);
  // O bloco de atribuição (versão do cliente + fingerprint do prompt) abre o system
  // prompt e MUDA entre versões/sessões — atrás de um gateway isso invalida o prefixo
  // cacheado. A doc é explícita: desligá-lo "improves prompt-cache hit rates when
  // routing through an LLM gateway", e numa conexão DIRETA o cache "is unaffected
  // either way". Por isso ele entra AQUI (proxy no caminho), e não no tuning sem proxy.
  if (next.CLAUDE_CODE_ATTRIBUTION_HEADER == null) next.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  const changed = next.ANTHROPIC_BASE_URL !== env.ANTHROPIC_BASE_URL
    || next.ENABLE_TOOL_SEARCH !== env.ENABLE_TOOL_SEARCH
    || next.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    || next.CLAUDE_CODE_ATTRIBUTION_HEADER !== env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  return { env: next, changed };
}

// ── Env-tuning DESACOPLADO do proxy (opt-in) ─────────────────────────────────
//
// POR QUÊ: o ganho de token medido (auto-compact + tool search) vem do
// settings.json, NÃO do proxy. Mas até aqui ele só era gravado dentro do enable,
// junto do ANTHROPIC_BASE_URL — e é a base_url que faz o Claude Code, atrás de um
// "gateway", deixar de validar suporte a 1M e orçar a sessão em 200K (doc oficial
// do Claude Code). Resultado: quem só queria economizar token pagava com 800K de
// janela. Estas funções entregam o tuning SEM proxy: jamais escrevem base_url.
//
// OPT-IN (default OFF): ligar por padrão fixaria auto-compact em 200K para todo
// mundo — inclusive quem usa modelo de 1M e não pediu nada. Quem quer o ganho opta.

/** true SÓ com `contextTuning.enabled === true` (literal). Ausente/inválido → false. */
function contextTuningEnabled(config) {
  const t = config && config.contextTuning;
  return !!(t && typeof t === 'object' && t.enabled === true);
}

// PURA: env desejado com APENAS o tuning (sem proxy). Nunca toca ANTHROPIC_BASE_URL
// (nem escreve, nem remove: uma base_url de terceiro que já esteja lá é preservada).
// `== null` → só preenche o ausente, nunca clobbera o valor explícito do usuário.
function planTuningEnv(currentEnv, autoCompactValue) {
  const env = { ...(currentEnv || {}) };
  const next = { ...env };
  if (next.ENABLE_TOOL_SEARCH == null) next.ENABLE_TOOL_SEARCH = 'true';
  if (next.CLAUDE_CODE_AUTO_COMPACT_WINDOW == null) next.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactValue);
  const changed = next.ENABLE_TOOL_SEARCH !== env.ENABLE_TOOL_SEARCH
    || next.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return { env: next, changed };
}

// PURA: remove os 2 env de tuning SÓ quando batem o valor que TERÍAMOS gravado
// (auto-compact lido do config ATUAL) — um valor deliberado do usuário sobrevive.
// Não toca a base_url (quem cuida dela é o planDisableEnv, ancorado em isOurs).
function planTuningRemoval(currentEnv, autoCompactValue) {
  const env = { ...(currentEnv || {}) };
  const next = { ...env };
  if (next.ENABLE_TOOL_SEARCH === 'true') delete next.ENABLE_TOOL_SEARCH;
  if (next.CLAUDE_CODE_AUTO_COMPACT_WINDOW === String(autoCompactValue)) delete next.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const changed = Object.keys(env).length !== Object.keys(next).length;
  return { env: next, changed };
}

// PURA: computa o env após remover só o NOSSO bundle no disable. Anchor: só age
// quando a base_url é NOSSA (isOurs). Remove a base_url (nossa); remove os 2 env
// só quando batem o valor que TERÍAMOS gravado (auto-compact lido do config ATUAL,
// não hardcoded) — assim um valor deliberado diferente do usuário SOBREVIVE e não
// fica órfão. Retorna { env, changed }.
function planDisableEnv(currentEnv, autoCompactValue, isOurs) {
  const env = { ...(currentEnv || {}) };
  if (!isOurs(env.ANTHROPIC_BASE_URL)) return { env, changed: false };
  const next = { ...env };
  delete next.ANTHROPIC_BASE_URL;
  if (next.ENABLE_TOOL_SEARCH === 'true') delete next.ENABLE_TOOL_SEARCH;
  if (next.CLAUDE_CODE_AUTO_COMPACT_WINDOW === String(autoCompactValue)) delete next.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (next.CLAUDE_CODE_ATTRIBUTION_HEADER === '0') delete next.CLAUDE_CODE_ATTRIBUTION_HEADER;
  return { env: next, changed: Object.keys(next).length !== Object.keys(env).length };
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

// ── Identidade de build do router vivo ───────────────────────────────────────
// O state.json guarda pid/port/mode — NENHUMA identidade de build. Sem isso o
// ensure reusava QUALQUER router saudável, inclusive um de um SHA anterior: o
// processo é um daemon detached, sobrevive ao restart do Claude Code e segue
// segurando a porta 13456 servindo o binário velho (visto 2026-07-30/31: PIDs
// 2440, 56008, 69700 — um install "bem-sucedido" que nunca entrava em vigor).
//
// A única saída virava matar na mão, e aí mora o dano: o router É o proxy da
// sessão (ANTHROPIC_BASE_URL). Um kill em pleno turno derruba a API da própria
// sessão, e o self-heal só roda no PRÓXIMO prompt do usuário — na prática,
// minutos de "Unable to connect to API (ConnectionRefused)".
//
// Aqui a troca acontece no SessionStart: antes do primeiro request da sessão,
// que é a ÚNICA janela em que derrubar a porta não quebra ninguém.
function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-o', 'command=', '-p', String(pid)],
        { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch (err) {
    // Não dá para inspecionar o processo (sem permissão, PID morto, powershell/ps
    // ausente). O chamador trata null como "não consegui provar divergência" e
    // deixa o router em paz — nunca derrubamos com base em ignorância.
    log(`AVISO: não foi possível ler a command line do PID ${pid}: ${err.message}`);
    return null;
  }
}

// Comparar path CRU não serve: o PLUGIN_ROOT pode chegar com '/' (env, config,
// shell POSIX) enquanto a command line do Windows traz '\', e o Windows ainda é
// case-insensitive. Sem normalizar, o includes() dá falso-negativo e o hook
// derrubaria o router CORRETO a cada boot — um loop de restart, pior que o bug
// original. Normaliza separador e caixa antes de comparar.
function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
    .toLowerCase();
}

// true  = é o nosso build, OU não deu para provar o contrário.
// false = SÓ quando a command line foi lida e aponta para outro PLUGIN_ROOT.
// Fail-safe deliberado: na dúvida NUNCA derrubamos um router que está servindo.
function servesThisBuild(pid) {
  const cmd = processCommandLine(pid);
  if (!cmd) return true;                      // não conseguimos ler → não mexe
  if (!/model-router/.test(cmd)) return true; // PID reciclado por outro processo
  return normPath(cmd).includes(normPath(PLUGIN_ROOT));
}

// Espera a porta parar de responder após o kill, para o bind do novo servidor
// não bater em EADDRINUSE (o startServer sairia por reuso e falharia).
async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeAlive(port))) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
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
      writeJsonAtomic(ANNOUNCE_FILE, store);
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

// Lê o token de identidade do roteador (verify-before-trust). Ausente/ilegível →
// null: o healthCheck então falha fechado (um processo sem o token NÃO é tratado
// como o nosso roteador).
function readRouterToken() {
  try {
    const tok = fs.readFileSync(ROUTER_TOKEN_FILE, 'utf-8').trim();
    return tok || null;
  } catch (_) { void _; return null; } // arquivo ausente/ilegível → sem token
}

// Sonda /health COM PROVA DE IDENTIDADE. WHY (credential-leak defense): sem isto,
// o hook apontaria o ANTHROPIC_BASE_URL do Claude Code para QUALQUER processo que
// responda 200 em /health na porta fixa — e o Claude Code mandaria a credencial
// REAL (Authorization/x-api-key) para ele. Um squatter local que tome a porta antes
// colheria as credenciais. Então mandamos o segredo de <DATA_DIR>/model-router/
// router.token no header x-router-token e só retornamos true se o servidor PROVAR
// que conhece o token (statusCode 200 E body.authenticated === true). Um processo
// que responda 200 mas sem autenticar (squatter que não consegue LER o arquivo) →
// authenticated:false → healthCheck false → o chamador NÃO ativa o roteamento
// (fail-open: Claude vai direto). CAVEAT honesto: isto derrota um squatter que NÃO
// consegue ler router.token (outro usuário do SO / sandbox, ou corrida antes do
// arquivo existir). Um atacante MESMO-USUÁRIO que leia o <DATA_DIR> lê o token e se
// passa por nós — fronteira de confiança do mesmo usuário no SO, idêntica ao
// brain-http.token, FORA de escopo. opts.{httpGet,token} são injeção p/ testes.
function healthCheck(port, opts) {
  const httpGet = (opts && opts.httpGet) || http.get;
  const token   = (opts && 'token' in opts) ? opts.token : readRouterToken();
  return new Promise((resolve) => {
    const headers = token ? { 'x-router-token': token } : {};
    const req = httpGet(`http://127.0.0.1:${port}/health`, { timeout: 1500, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let ok = false;
        try { ok = res.statusCode === 200 && JSON.parse(buf).authenticated === true; }
        catch (e) { void e; ok = false; } // corpo não-JSON / sem authenticated → não confia
        resolve(ok);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Liveness SEM prova de identidade: algo responde 200 em /health nesta porta? Usado
// SÓ para o AVISO (distinguir "porta ocupada por processo não reconhecido" de "porta
// livre") — NUNCA ativa roteamento por si. opts.httpGet é injeção p/ testes.
function probeAlive(port, opts) {
  const httpGet = (opts && opts.httpGet) || http.get;
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null; // guard: only real env-var names reach the PowerShell string
  try {
    const out = execSync(
      `powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('${name}', 'User')"`,
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return out || null;
  } catch (_) { void _; return null; }
}

function clearSystemEnvVar(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false; // guard: reject anything that isn't a plain env-var name
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
  writeJsonAtomic(SETTINGS_FILE, obj);
}

function isOurProxyUrl(url) {
  return typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(url);
}

// Idempotente: grava env.ANTHROPIC_BASE_URL só se mudou. Retorna true se, ao final,
// o settings.json aponta para o nosso proxy.
function enableSettingsRouting(url) {
  const s = readSettings();
  if (s === null) return false;
  const acw = resolveAutoCompactWindow(readConfig());
  if (acw.clamped) log(`AVISO: autoCompactWindow ${acw.original} fora de [${AUTO_COMPACT_MIN}, ${AUTO_COMPACT_MAX}] — ajustado para ${acw.value}.`);
  const plan = planEnableEnv(s.env, url, acw.value, isOurProxyUrl);
  if (plan.foreign) {
    log(`AVISO: settings.json já tem ANTHROPIC_BASE_URL custom ("${s.env.ANTHROPIC_BASE_URL}") — preservado, roteador NÃO sobrescreve.`);
    return false;
  }
  if (!plan.changed) return true; // os 3 já no estado desejado → no-op (não reescreve)
  s.env = plan.env;
  try {
    writeSettings(s);
    log(`settings.json: ANTHROPIC_BASE_URL → ${url}; ENABLE_TOOL_SEARCH=${s.env.ENABLE_TOOL_SEARCH}; CLAUDE_CODE_AUTO_COMPACT_WINDOW=${s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW}; CLAUDE_CODE_ATTRIBUTION_HEADER=${s.env.CLAUDE_CODE_ATTRIBUTION_HEADER}`);
    return true;
  } catch (e) {
    log(`AVISO: não foi possível escrever settings.json: ${e.message}`);
    return false;
  }
}

// Aplica APENAS o env-tuning (sem proxy): tool-search + auto-compact no
// settings.json, sem ANTHROPIC_BASE_URL. É o ganho de token sem o custo da janela
// de 1M. Idempotente. `on=false` remove só o que teríamos gravado.
function applySettingsTuning(on) {
  const s = readSettings();
  if (s === null) return false;
  const acw = resolveAutoCompactWindow(readConfig());
  if (on && acw.clamped) log(`AVISO: autoCompactWindow ${acw.original} fora de [${AUTO_COMPACT_MIN}, ${AUTO_COMPACT_MAX}] — ajustado para ${acw.value}.`);
  const plan = on ? planTuningEnv(s.env || {}, acw.value) : planTuningRemoval(s.env || {}, acw.value);
  if (!plan.changed) return true;
  if (Object.keys(plan.env).length === 0) delete s.env; else s.env = plan.env;
  try {
    writeSettings(s);
    log(on
      ? `settings.json: env-tuning SEM proxy — ENABLE_TOOL_SEARCH=${plan.env.ENABLE_TOOL_SEARCH}; CLAUDE_CODE_AUTO_COMPACT_WINDOW=${plan.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW} (ANTHROPIC_BASE_URL NÃO é publicada — a janela de 1M é preservada).`
      : 'settings.json: env-tuning removido (só o que era nosso).');
    return true;
  } catch (e) {
    log(`AVISO: não foi possível escrever settings.json (tuning): ${e.message}`);
    return false;
  }
}

// Remove SÓ o nosso bundle (base_url localhost + os 2 env que gravamos). Nunca
// apaga uma ANTHROPIC_BASE_URL custom nem um valor deliberado do usuário.
function disableSettingsRouting() {
  const s = readSettings();
  if (s === null || !s.env) return;
  const acw = resolveAutoCompactWindow(readConfig());
  const plan = planDisableEnv(s.env, acw.value, isOurProxyUrl);
  if (!plan.changed) return; // base_url não é nossa (ou nada nosso p/ remover) → não mexe
  if (Object.keys(plan.env).length === 0) delete s.env; else s.env = plan.env;
  try {
    writeSettings(s);
    log('settings.json: bundle do roteador removido (ANTHROPIC_BASE_URL + tool-search/auto-compact nossos → Claude direto).');
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
function disableRoutingFootprintAtomic() {
  // 1. settings.json ATÔMICO — tenta disableSettingsRouting (usa writeJsonAtomic via writeSettings)
  // Mas disableSettingsRouting retorna cedo se settings corrupto; então tentamos limpar base_url manual se possível
  let settingsCleaned = false;
  try {
    disableSettingsRouting();
    settingsCleaned = true;
  } catch (e) { /* ignore */ }
  
  // Se settings corrupto, tenta limpar base_url manual do settings.json (best-effort)
  if (!settingsCleaned) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.env && parsed.env.ANTHROPIC_BASE_URL && isOurProxyUrl(parsed.env.ANTHROPIC_BASE_URL)) {
        delete parsed.env.ANTHROPIC_BASE_URL;
        delete parsed.env.ENABLE_TOOL_SEARCH;
        delete parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        delete parsed.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
        writeJsonAtomic(SETTINGS_FILE, parsed);
        log('settings.json: bundle do roteador removido (recuperação corrupto)');
      }
    } catch (_) { /* ignore corrupt file */ }
  }
  
  // 2. url.txt best-effort
  try { if (fs.existsSync(PROXY_URL_FILE)) { fs.unlinkSync(PROXY_URL_FILE); log('model-router-url.txt removido'); } } catch (e) { log(`AVISO: não remover ${PROXY_URL_FILE}: ${e.message}`); }
  
  // 3. global env cleanup
  cleanupGlobalEnv();
}

// Manter disableRoutingFootprint() original para compatibilidade
function disableRoutingFootprint() {
  disableSettingsRouting();
  cleanupGlobalEnv();
  clearLegacyUrlFile();
}

function startServer(mode) {
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
      // BOSS_ROUTER_MODE é só diagnóstico: o server recomputa o modo da própria
      // config (fonte única lib/router-mode.js). Não é a fonte de verdade.
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: DATA_DIR, BOSS_ROUTER_MODE: mode || '' },
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
  // One-time Phase-1.5 migration: copy a legacy DATA_DIR/model-router/user-config.json
  // up to the stable global path (never overwriting an existing global) so the saved
  // NVIDIA key + toggles survive the move. Fail-open — never throws at SessionStart.
  backfillRouterUserConfig();
  const config = readConfig();
  const hookInput = readHookInput();
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  // Este script roda em DOIS eventos (SessionStart e UserPromptSubmit). O
  // hookSpecificOutput.hookEventName precisa ecoar o evento REAL: devolver um nome
  // fixo faz o Claude Code rejeitar o hook inteiro com "expected 'SessionStart' but
  // got 'UserPromptSubmit'" — e aí nem o additionalContext nem o hook entram.
  const hookEventName = hookInput.hook_event_name || hookInput.hookEventName || 'UserPromptSubmit';

  // MODO (fonte única: lib/router-mode.js). 'off' = inerte → limpa o footprint e sai.
  // 'routing' (cost-routing) e 'fallback-only' (passthrough cache-safe + 429→plano B)
  // exigem o proxy NO CAMINHO: publicam ANTHROPIC_BASE_URL/shim igual. O server lê a
  // própria config e computa o próprio modo; passamos BOSS_ROUTER_MODE só p/ log/diag.
  const mode = resolveMode(config);
  if (mode === 'off') {
    log('Roteador e fallback desabilitados (mode: off). Limpando footprint e saindo.');
    disableRoutingFootprintAtomic();
    // O "Salvar & aplicar" do dashboard desligou o roteador: derruba o daemon órfão
    // que ainda segura a porta fixa (senão ele fica vivo consumindo recursos mesmo
    // com o footprint removido). Só quando a invocação pede aplicação explícita —
    // no hook em modo off isso não é necessário (o daemon não está no caminho).
    if (process.env.BOSS_ROUTER_FORCE_RESTART === '1') {
      const st = readState();
      if (st && st.pid) {
        log(`Roteador desligado pelo dashboard — derrubando daemon órfão PID ${st.pid}.`);
        try { process.kill(st.pid); } catch (e) { log(`AVISO: kill do PID ${st.pid} falhou: ${e.message}`); }
      }
    }
    // DESACOPLADO: com o proxy fora, o env-tuning (tool-search + auto-compact) ainda
    // pode valer — é ele que dá o ganho de token, e não o proxy. Aplicado DEPOIS do
    // disable (que remove o bundle inteiro) para o resultado líquido ser: sem
    // base_url (janela de 1M preservada) + com o tuning. Opt-in: default OFF.
    if (contextTuningEnabled(config)) {
      applySettingsTuning(true);
    } else {
      applySettingsTuning(false);
    }
    if (process.platform === 'win32') {
      try { 
        const results = shim.removeShimAll(log);
        const anySuccess = results.some(r => r.result === 'removed' || r.result === 'cleaned');
        if (results.length === 0) log('Shim não instalado');
        else if (anySuccess) log('Shim removido com sucesso');
        else log('AVISO: falha na remoção do shim');
      } catch (e) { log(`AVISO: remoção do shim falhou: ${e.message}`); }
    }
    process.exit(0);
  }
  log(`Modo do proxy: ${mode}${mode === 'fallback-only' ? ' (passthrough cache-safe + fallback de limite)' : ''}${mode === 'sticky-tier' ? ' (sticky cache-safe: tier fixo por sessao + fallback de limite)' : ''}.`);

  // ── 1. Garante servidor rodando na PORTA FIXA ────────────────────────────
  const FIXED_PORT = config.port || 13456;
  log(`Verificando model-router na porta fixa ${FIXED_PORT}...`);

  let justStarted = false;
  let isRunning = await healthCheck(FIXED_PORT);
  if (isRunning) {
    const st = readState();
    // Janela segura para trocar o build OU recarregar a config: o SessionStart roda
    // antes do primeiro request da sessão; o "Salvar & aplicar" do dashboard
    // (BOSS_ROUTER_FORCE_RESTART=1) é uma ação EXPLÍCITA do usuário pedindo a
    // aplicação IMEDIATA. No UserPromptSubmit estamos no meio de um turno e derrubar
    // a porta cortaria a API em uso — nunca trocamos ali (e evitamos o custo do
    // spawn de inspeção a cada prompt).
    const isSessionStart = hookEventName === 'SessionStart';
    const forceRestart = process.env.BOSS_ROUTER_FORCE_RESTART === '1';
    const safeWindow = isSessionStart || forceRestart;
    // O daemon detached carrega a config UMA vez no boot e não a relê. Sem comparar
    // o fingerprint da config efetiva ele serviria para sempre uma config ANTIGA
    // (o bug do "Salvar & aplicar" que nunca aplicava: o dashboard gravava o
    // user-config, mas o daemon seguia com o que carregou na subida). Estado sem
    // fingerprint = daemon de versão anterior → tratamos como desatualizado também.
    const currentFp = configFingerprint(config);
    const servedFp = st && st.configFingerprint;
    const configChanged = !servedFp || servedFp !== currentFp;
    const rawBuildChanged = st && st.pid && !servesThisBuild(st.pid);
    // Debounce SÓ para buildChanged: configChanged é sempre uma ação deliberada do
    // usuário (Salvar & aplicar) e não tem o modo de falha de ping-pong entre dois
    // PLUGIN_ROOT — não faz sentido atrasá-la.
    const sinceLastSwitchMs = rawBuildChanged ? (Date.now() - readBuildSwitchStamp()) : Infinity;
    const switchDebounced = rawBuildChanged && sinceLastSwitchMs < BUILD_SWITCH_DEBOUNCE_MS;
    const buildChanged = rawBuildChanged && !switchDebounced;
    if (switchDebounced) {
      log(`Router PID ${st.pid} serve outro build (esperado ${PLUGIN_ROOT}), mas a última troca de build foi há ${Math.round(sinceLastSwitchMs / 1000)}s — parece duas instalações do plugin (dev vs marketplace) disputando a porta ${FIXED_PORT}. Não derrubando de novo agora para não repetir o ping-pong; se isto persistir, feche a sessão que usa a outra instalação.`);
    }
    if (safeWindow && st && st.pid && (buildChanged || configChanged)) {
      if (buildChanged) {
        log(`Router PID ${st.pid} serve OUTRO build (esperado ${PLUGIN_ROOT}). Derrubando no boot para o binário instalado entrar em vigor.`);
        writeBuildSwitchStamp();
      } else {
        log(`Router PID ${st.pid} serve config DESATUALIZADA (fingerprint ${servedFp || '(ausente)'} != ${currentFp}). Derrubando para a config salva entrar em vigor.`);
      }
      try { process.kill(st.pid); } catch (e) { log(`AVISO: kill do PID ${st.pid} falhou: ${e.message}`); }
      if (!(await waitPortFree(FIXED_PORT, 5000))) {
        log(`AVISO: porta ${FIXED_PORT} continua ocupada após o kill — mantendo o router atual em vez de arriscar a sessão sem proxy.`);
      } else {
        isRunning = false; // cai no startServer abaixo, que sobe com a config atual
      }
    } else {
      log(`Servidor OK na porta ${FIXED_PORT}${st && st.pid ? ` (PID ${st.pid})` : ''}.`);
    }
  }
  if (!isRunning) {
    // healthCheck false = ou a porta está livre, ou está ocupada por um processo que
    // NÃO prova identidade (sem o token). Em ambos, tentamos (re)subir o NOSSO
    // roteador. Se a porta estiver tomada por um processo alheio, o nosso server não
    // consegue fazer bind (EADDRINUSE → sai por reuso sem escrever state fresco) e o
    // startServer reporta falha → caímos no fail-open (sem roteamento, Claude direto).
    log(`Porta ${FIXED_PORT} sem roteador reconhecido. Iniciando servidor...`);
    const started = await startServer(mode);
    if (started) isRunning = await healthCheck(FIXED_PORT);
    if (!isRunning) {
      // Distingue um SQUATTER (algo responde /health, mas sem o token) de uma falha
      // comum, só para dar um AVISO preciso. Em QUALQUER caso: fail-open (Claude
      // direto) — NUNCA gravamos a URL / ativamos roteamento para um processo não
      // reconhecido (seria vazar a credencial real para ele).
      const occupied = await probeAlive(FIXED_PORT);
      if (occupied) {
        log(`AVISO: porta ${FIXED_PORT} ocupada por processo não reconhecido (sem o token do roteador) — roteamento desativado nesta sessão; Claude Code usará a Anthropic API diretamente.`);
      } else {
        log('AVISO: roteamento indisponível nesta sessão. Removendo footprint; Claude Code usará Anthropic API diretamente.');
      }
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
  // Trade-off HONESTO e silencioso que o usuário precisa saber ao ligar o proxy:
  // com um ANTHROPIC_BASE_URL que não é o oficial, o Claude Code NÃO consegue
  // validar suporte a 1M e orça a sessão em 200K — inclusive nos modelos de 1M
  // nativo (Opus 5 / Fable 5 / Sonnet 5). É limitação do CLIENTE (documentada em
  // https://code.claude.com/docs/en/model-config), não do proxy: o router repassa
  // o anthropic-beta intacto. Não há erro — a janela só encolhe em silêncio, então
  // avisamos aqui. Quem precisa de 1M: mantenha o router em off (o env-tuning
  // opt-in `contextTuning` entrega o ganho de token SEM publicar a base_url).
  const ONE_M_NOTE = ' ⚠️ Janela: com o proxy no caminho o Claude Code orça a sessão em 200K mesmo em modelos de 1M (limitação do cliente atrás de gateway). Precisa de 1M? Deixe o router em off e use contextTuning.';
  if (wired) {
    if (mode === 'fallback-only') {
      contextMsg = `[model-router] FALLBACK DE LIMITE ATIVO ✓ — porta ${FIXED_PORT} via settings.json env (escopo Claude Code). Passthrough cache-safe para o Claude (NÃO troca modelo/effort; o prompt cache é preservado). Só no 429 (janela esgotada) aciona o plano B: ${config.nim?.apiKey ? 'NVIDIA (não é mais o Claude)' : '/dashboard p/ configurar a chave NVIDIA'}. Isolado: outros apps não são afetados. Se acabou de ativar, reinicie o Claude Code uma vez.${ONE_M_NOTE}`;
      log('Fallback de limite ATIVO (passthrough cache-safe, settings.json env).');
    } else if (mode === 'sticky-tier') {
      contextMsg = `[model-router] STICKY ROUTER ATIVO ✓ (cache-safe) — porta ${FIXED_PORT} via settings.json env (escopo Claude Code). Classificador: ${config.nim?.apiKey ? 'NIM' : 'MiniLM local'}. O tier é escolhido UMA vez por sessão (turno 0) e o modelo é FIXADO pelo resto da sessão — modelo constante preserva o prompt cache quente. Isolado: outros apps não são afetados. Se acabou de ativar, reinicie o Claude Code uma vez para o roteamento engatar.${ONE_M_NOTE}`;
      log('Sticky router ATIVO (cache-safe, settings.json env).');
    } else {
      contextMsg = `[model-router] ATIVO ✓ — porta ${FIXED_PORT} via settings.json env (escopo Claude Code). Classificador: ${config.nim?.apiKey ? 'NIM' : 'MiniLM local'}. Prompts roteados (haiku/sonnet/opus). Isolado: outros apps não são afetados. Se acabou de instalar/ativar, reinicie o Claude Code uma vez para o roteamento engatar.${ONE_M_NOTE}`;
      log('Roteamento ATIVO (settings.json env).');
    }
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
      hookSpecificOutput: { hookEventName, additionalContext },
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
// healthCheck/probeAlive/readRouterToken exportados p/ os testes de verify-before-trust.
module.exports = { mergeRouterConfig, readConfig, healthCheck, probeAlive, readRouterToken,
  resolveAutoCompactWindow, planEnableEnv, planDisableEnv, enableSettingsRouting, disableSettingsRouting,
  contextTuningEnabled, planTuningEnv, planTuningRemoval, applySettingsTuning,
  // servesThisBuild/processCommandLine/normPath exportados p/ os testes de troca-de-build no boot.
  servesThisBuild, processCommandLine, normPath };
