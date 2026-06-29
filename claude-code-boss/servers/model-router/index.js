#!/usr/bin/env node
/**
 * model-router/index.js — Proxy HTTP que intercepta chamadas do Claude Code,
 * classifica o prompt via MiniLM local (ou NIM opcional) e reescreve o campo
 * `model` antes de encaminhar pra Anthropic API real.
 *
 * Bind em porta 0 (OS atribui porta livre), escreve estado em:
 *   ${CLAUDE_PLUGIN_DATA}/model-router/state.json
 *
 * Uso:
 *   node servers/model-router/index.js [--data-dir <path>] [--plugin-root <path>]
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { URL } = require('url');

// ── Resolução de paths ────────────────────────────────────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function valid(v) { return v && !v.includes('${') ? v : null; }

const PLUGIN_ROOT = argValue('--plugin-root')
  || valid(process.env.CLAUDE_PLUGIN_ROOT)
  || path.resolve(__dirname, '..', '..');

const DATA_DIR = argValue('--data-dir')
  || valid(process.env.CLAUDE_PLUGIN_DATA)
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

const STATE_DIR  = path.join(DATA_DIR, 'model-router');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE   = path.join(STATE_DIR, 'router.log');
const CONFIG_FILE = path.join(PLUGIN_ROOT, 'config', 'router-config.json');
// Override do usuário (chave NVIDIA + toggles). Vive SÓ no DATA_DIR, nunca
// versionado. Sobrescreve os defaults shipados quando presente.
const USER_CONFIG_FILE = path.join(STATE_DIR, 'user-config.json');

// ── Logger ────────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function log(level, msg, extra) {
  const line = `[${ts()}] [${level.padEnd(5)}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* ignore log write errors */ }
}

const logger = {
  info:  (m, e) => log('INFO',  m, e),
  warn:  (m, e) => log('WARN',  m, e),
  error: (m, e) => log('ERROR', m, e),
  debug: (m, e) => log('DEBUG', m, e),
};

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  let config = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn('Config load failed, using defaults', { err: e.message });
  }
  // Deep-merge do override do usuário POR CIMA dos defaults (override vence).
  // `nim` e `routing` são mesclados raso; escalares (enabled) são sobrescritos.
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) {
      const override = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
      config = mergeUserConfig(config, override);
    }
  } catch (e) {
    logger.warn('User config override ignorado (falha ao ler)', { err: e.message });
  }
  return config;
}

function mergeUserConfig(base, override) {
  const merged = { ...base };
  for (const key of Object.keys(override || {})) {
    if ((key === 'nim' || key === 'routing') && override[key] && typeof override[key] === 'object') {
      merged[key] = { ...(base[key] || {}), ...override[key] };
    } else {
      merged[key] = override[key];
    }
  }
  return merged;
}

// ── Classifier ───────────────────────────────────────────────────────────────

let _embedder = null;
let _anchors  = null;

async function loadEmbedder(_config) {
  const embedderPath = path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js');
  if (!fs.existsSync(embedderPath)) {
    throw new Error(`brain-embedder.js não encontrado em ${embedderPath}`);
  }
  const embedder = require(embedderPath);
  await embedder.init();
  const status = embedder.getStatus();
  if (status.error) throw new Error(`Embedder error: ${status.error}`);
  logger.info('Embedder inicializado', { model: status.model, dims: status.dimensions });
  return embedder;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

async function buildAnchors(embedder, anchorConfig) {
  const tiers = Object.keys(anchorConfig);
  const result = {};
  for (const tier of tiers) {
    if (tier.startsWith('_')) continue;
    const phrases = anchorConfig[tier];
    const vecs = [];
    for (const phrase of phrases) {
      const v = await embedder.embed(phrase);
      if (v) vecs.push(v);
    }
    if (!vecs.length) continue;
    const avg = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < v.length; i++) avg[i] += v[i] / vecs.length;
    result[tier] = avg;
  }
  logger.info('Âncoras computadas', { tiers: Object.keys(result) });
  return result;
}

// Política de decisão calibrada com tráfego real (router.log): o classificador
// por cosseno tende a eleger OPUS como argmax justamente quando NADA casa bem
// (opus teve o menor score médio ~0.22 e mínimo 0.07). Para "esticar a janela",
// nunca caímos em opus no escuro: exigimos confiança mínima global e uma barra
// mais alta (absoluta + margem) especificamente para opus; na dúvida, sonnet.
function classifierPolicy(config) {
  const c = (config && config.classifier) || {};
  return {
    minScore:     typeof c.minScore     === 'number' ? c.minScore     : 0.30,
    defaultTier:  c.defaultTier || 'sonnet',
    opusMinScore: typeof c.opusMinScore === 'number' ? c.opusMinScore : 0.40,
    opusMargin:   typeof c.opusMargin   === 'number' ? c.opusMargin   : 0.05,
  };
}

function fmtScores(scores) {
  const out = {};
  for (const [t, s] of Object.entries(scores)) out[t] = Number(s.toFixed(3));
  return out;
}

function applyClassifierPolicy(scores, policy) {
  const entries = Object.entries(scores);
  if (!entries.length) return null;
  const sorted = entries.slice().sort((a, b) => b[1] - a[1]);
  const [winTier, winScore] = sorted[0];
  const second = sorted[1] || [null, -Infinity];
  const bestNonOpus = (sorted.find(([t]) => t !== 'opus') || [policy.defaultTier])[0];

  // 1. Confiança global baixa → tier padrão (seguro/barato), nunca opus no escuro.
  if (winScore < policy.minScore) {
    logger.debug('Classificação local: baixa confiança → default', { argmax: winTier, score: Number(winScore.toFixed(3)), tier: policy.defaultTier, scores: fmtScores(scores) });
    return policy.defaultTier;
  }
  // 2. Opus exige barra mais alta — absoluta e em margem — senão rebaixa.
  if (winTier === 'opus') {
    if (winScore < policy.opusMinScore) {
      logger.debug('Classificação local: opus abaixo do mínimo → rebaixa', { score: Number(winScore.toFixed(3)), tier: bestNonOpus, scores: fmtScores(scores) });
      return bestNonOpus;
    }
    if (second[0] && second[0] !== 'opus' && (winScore - second[1]) < policy.opusMargin) {
      logger.debug('Classificação local: opus sem margem → rebaixa', { score: Number(winScore.toFixed(3)), runnerUp: second[0], tier: second[0], scores: fmtScores(scores) });
      return second[0];
    }
  }
  logger.debug('Classificação local', { tier: winTier, score: Number(winScore.toFixed(3)), scores: fmtScores(scores) });
  return winTier;
}

async function classifyLocal(prompt, anchors, policy) {
  if (!_embedder) return null;
  const vec = await _embedder.embed(prompt);
  if (!vec) return null;
  const scores = {};
  for (const [tier, anchor] of Object.entries(anchors)) {
    scores[tier] = cosineSim(vec, anchor);
  }
  return applyClassifierPolicy(scores, policy || classifierPolicy(null));
}

async function classifyNim(prompt, config) {
  const nim = config.nim || {};
  const apiKey = nim.apiKey || process.env.NVIDIA_NIM_KEY || '';
  if (!apiKey) return null;

  const body = JSON.stringify({
    model: nim.classifierModel || 'qwen/qwen2.5-1.5b-instruct',
    messages: [{
      role: 'user',
      content: `Classify the following task into exactly one word — "haiku", "sonnet", or "opus" — based on complexity:\n- haiku: trivial edits, git ops, rename, format, simple lookup\n- sonnet: feature impl, debug, tests, refactor, code review\n- opus: architecture, security audit, complex multi-file analysis, design decisions\n\nTask: ${prompt.slice(0, 500)}\n\nRespond with ONLY the single word (haiku/sonnet/opus).`
    }],
    max_tokens: 5,
    temperature: 0,
  });

  return new Promise((resolve) => {
    const endpoint = new URL(nim.endpoint || 'https://integrate.api.nvidia.com/v1/chat/completions');
    const options = {
      hostname: endpoint.hostname,
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const raw = (parsed.choices?.[0]?.message?.content || '').trim().toLowerCase();
          const tier = ['haiku', 'sonnet', 'opus'].find(t => raw.includes(t)) || null;
          logger.debug('Classificação NIM', { raw, tier });
          resolve(tier);
        } catch (e) {
          logger.warn('NIM classify parse error', { err: e.message });
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      logger.warn('NIM classify request error', { err: e.message });
      resolve(null);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function classify(prompt, config) {
  // Tenta NIM primeiro se configurado
  const nimKey = config.nim?.apiKey || process.env.NVIDIA_NIM_KEY || '';
  if (nimKey) {
    const tier = await classifyNim(prompt, config);
    if (tier) return tier;
    logger.warn('NIM falhou, fallback para MiniLM local');
  }
  // Fallback: MiniLM local
  if (_anchors) return await classifyLocal(prompt, _anchors, classifierPolicy(config));
  return null;
}

// ── Model selection ───────────────────────────────────────────────────────────

function resolveModel(tier, config) {
  const routing = config.routing || {};
  const map = {
    haiku:  routing.haikuTier?.model  || 'claude-haiku-4-5-20251001',
    sonnet: routing.sonnetTier?.model || 'claude-sonnet-4-6',
    opus:   routing.opusTier?.model   || 'claude-opus-4-8',
  };
  return map[tier] || map.sonnet;
}

// ── Extração de prompt do body ────────────────────────────────────────────────

function extractPrompt(body) {
  try {
    const messages = body.messages || [];
    const last = messages.slice().reverse().find(m => m.role === 'user');
    if (!last) return '';
    const content = last.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(c => c.type === 'text').map(c => c.text).join(' ');
    }
  } catch (_) { /* */ }
  return '';
}

// ── Proxy core ────────────────────────────────────────────────────────────────

// Upstream Anthropic. Override via env existe SÓ para testes; produção usa
// api.anthropic.com:443 (https) — comportamento idêntico ao anterior.
const UPSTREAM_HOST     = process.env.ROUTER_UPSTREAM_HOST || 'api.anthropic.com';
const UPSTREAM_PORT     = process.env.ROUTER_UPSTREAM_PORT ? Number(process.env.ROUTER_UPSTREAM_PORT) : 443;
const UPSTREAM_PROTOCOL = process.env.ROUTER_UPSTREAM_PROTOCOL || 'https:';
const UPSTREAM_LIB      = UPSTREAM_PROTOCOL === 'http:' ? http : https;

// ── Fallback "limite excedido" (plano B) ──────────────────────────────────────

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type':  'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection':    'keep-alive',
  });
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Emite uma mensagem assistant de texto único — em SSE (se stream) ou JSON —
// no formato da Anthropic Messages API, para o Claude Code renderizar normal.
function respondAnthropicText(reqBody, res, text) {
  const model = reqBody.model || 'claude';
  const id = 'msg_fb_' + Date.now();
  if (reqBody.stream) {
    sseHeaders(res);
    sseEvent(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    sseEvent(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    sseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } else {
    const payload = { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

const NO_NIM_MESSAGE =
  '⚠️ Limite de acesso do Claude atingido — a janela de uso esgotou.\n\n' +
  'O plano B (NVIDIA) ainda não está configurado. Rode /dashboard, ative o roteador ' +
  'e cole sua chave gratuita da NVIDIA (build.nvidia.com) para continuar trabalhando ' +
  'mesmo com o limite excedido.';

// Traduz o corpo Anthropic Messages → OpenAI chat/completions (NVIDIA NIM).
function anthropicToOpenAI(body, config) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text') {
          parts.push(b.text || '');
        } else if (b.type === 'tool_result') {
          const tr = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n')
              : '';
          parts.push(`[resultado de ferramenta] ${tr}`);
        } else if (b.type === 'tool_use') {
          parts.push(`[uso de ferramenta ${b.name}] ${JSON.stringify(b.input || {})}`);
        } else if (b.type === 'image') {
          parts.push('[imagem omitida no plano B]');
        }
      }
      content = parts.join('\n');
    }
    messages.push({ role, content });
  }
  const nim = config.nim || {};
  return {
    model:       nim.fallbackModel || 'meta/llama-3.3-70b-instruct',
    messages,
    max_tokens:  Math.min(body.max_tokens || 1024, 4096),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream:      !!body.stream,
  };
}

// Stream OpenAI SSE (NVIDIA) → Anthropic SSE, com o aviso de plano B no início.
function streamNvidiaToAnthropic(nvRes, res, reqBody, warning) {
  const model = reqBody.model || 'claude';
  const id = 'msg_fb_' + Date.now();
  sseHeaders(res);
  sseEvent(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sseEvent(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // Aviso primeiro — o usuário precisa saber que NÃO é mais o Claude.
  sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: warning } });

  let buf = '';
  nvRes.setEncoding('utf-8');
  nvRes.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
      } catch (e) {
        logger.debug('NVIDIA SSE parse skip', { err: e.message });
      }
    }
  });
  nvRes.on('end', () => finishStream(res));
  nvRes.on('error', (e) => {
    logger.error('NVIDIA stream erro', { err: e.message });
    finishStream(res);
  });
}

function finishStream(res) {
  sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
  sseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// Resposta única OpenAI (NVIDIA) → Anthropic JSON, com o aviso de plano B.
function jsonNvidiaToAnthropic(nvRes, res, reqBody, warning) {
  let data = '';
  nvRes.setEncoding('utf-8');
  nvRes.on('data', c => data += c);
  nvRes.on('end', () => {
    let text = warning;
    try {
      const j = JSON.parse(data);
      text += (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch (e) {
      logger.error('NVIDIA JSON parse erro', { err: e.message });
      text += '(resposta do plano B ilegível)';
    }
    respondAnthropicText(reqBody, res, text);
  });
  nvRes.on('error', (e) => {
    logger.error('NVIDIA JSON erro', { err: e.message });
    respondAnthropicText(reqBody, res, warning + '(falha ao ler a resposta do plano B)');
  });
}

// Plano B: roteia a chamada para a NVIDIA NIM (OpenAI-compat), traduzindo o
// protocolo nos dois sentidos e SEMPRE avisando que a resposta não é do Claude.
function nvidiaFallback(reqBody, config, res, nimKey, hint) {
  const openaiBody = anthropicToOpenAI(reqBody, config);
  const fbModel = openaiBody.model;
  const aviso = hint ? ` (${hint})` : '';
  const warning = `⚠️ Plano B ativo — limite do Claude esgotado${aviso}. Esta resposta foi gerada pela NVIDIA (${fbModel}), NÃO pelo Claude.\n\n`;
  const payload = JSON.stringify(openaiBody);
  const endpoint = new URL((config.nim && config.nim.endpoint) || 'https://integrate.api.nvidia.com/v1/chat/completions');
  const isHttps = endpoint.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    hostname: endpoint.hostname,
    port:     endpoint.port || (isHttps ? 443 : 80),
    path:     endpoint.pathname,
    method:   'POST',
    headers: {
      'Authorization':  `Bearer ${nimKey}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Accept':         openaiBody.stream ? 'text/event-stream' : 'application/json',
    },
  };
  logger.info('Acionando plano B NVIDIA', { model: fbModel, stream: openaiBody.stream });
  const upstream = lib.request(options, (nvRes) => {
    if (nvRes.statusCode >= 400) {
      let eb = '';
      nvRes.on('data', c => eb += c);
      nvRes.on('end', () => {
        logger.error('NVIDIA fallback HTTP erro', { status: nvRes.statusCode, body: eb.slice(0, 300) });
        respondAnthropicText(reqBody, res, `⚠️ Limite do Claude esgotado e o plano B (NVIDIA) recusou a chamada (HTTP ${nvRes.statusCode}). Revise sua chave em /dashboard.`);
      });
      return;
    }
    if (openaiBody.stream) streamNvidiaToAnthropic(nvRes, res, reqBody, warning);
    else                   jsonNvidiaToAnthropic(nvRes, res, reqBody, warning);
  });
  upstream.on('error', (e) => {
    logger.error('NVIDIA fallback inacessível', { err: e.message });
    respondAnthropicText(reqBody, res, `⚠️ Limite do Claude esgotado e o plano B (NVIDIA) está inacessível (${e.message}). Tente de novo ou revise /dashboard.`);
  });
  upstream.write(payload);
  upstream.end();
}

function handleLimitExceeded(reqBody, config, res, hint) {
  const nimKey = (config && config.nim && config.nim.apiKey) || process.env.NVIDIA_NIM_KEY || '';
  if (nimKey) {
    try { nvidiaFallback(reqBody, config, res, nimKey, hint); return; }
    catch (e) { logger.error('Falha ao iniciar o plano B NVIDIA', { err: e.message }); }
  }
  const msg = hint ? `${NO_NIM_MESSAGE}\n\n⏳ ${hint}.` : NO_NIM_MESSAGE;
  respondAnthropicText(reqBody, res, msg);
}

// ── Circuit breaker (cooldown da janela do Claude) ────────────────────────────
// Ao tomar 429 (janela esgotada), em vez de continuar martelando a Anthropic a
// cada request, decidimos quando voltar a testar o Claude. Dois casos:
//  • A Anthropic informa o reset (headers retry-after / unified-reset): esperamos
//    EXATAMENTE até lá (autoritativo).
//  • Não informa (caso comum da assinatura): o 429 é ESPORÁDICO (janela deslizante).
//    Um 429 isolado cai no plano B só naquela request — a PRÓXIMA já testa o Claude
//    de novo (se ele voltou, você usa na hora). Só depois de `tripAfter` 429s
//    SEGUIDOS (sem nenhum sucesso no meio) armamos um cooldown CURTO (`noHeaderMs`)
//    e re-sondamos logo. Qualquer resposta do Claude zera o contador → recuperação
//    imediata. Estado persistido p/ sobreviver a reinícios do router.

const COOLDOWN_FILE = path.join(STATE_DIR, 'cooldown.json');
let _cooldownUntil  = 0;    // epoch ms; 0 = inativo
let _cooldownSource = '';   // origem do reset: 'header' (autoritativo) | 'probe' (chute curto)
let _consec429      = 0;    // 429 consecutivos sem header (zera em qualquer sucesso)

function cooldownCfg(config) {
  const c = (config && config.fallback && config.fallback.cooldown) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled:    c.enabled !== false,                                 // default: ligado
    noHeaderMs: num(c.noHeaderMs != null ? c.noHeaderMs : c.defaultMs, 15000), // sem header → cooldown curto p/ re-sondar
    minMs:      num(c.minMs, 1000),                                  // piso (evita cooldown ~0)
    maxMs:      num(c.maxMs, 6 * 60 * 60 * 1000),                    // teto de segurança (6h)
    tripAfter:  Math.max(1, num(c.tripAfter, 2)),                    // 429s seguidos p/ armar quando não há header
  };
}

// Extrai o epoch ms do reset a partir dos headers de um 429 da Anthropic.
// Preferência: retry-after (relativo, imune a relógio torto) → unified-reset
// (timestamp absoluto) → buckets individuais (RFC3339/epoch). null = nada legível.
function parseResetMs(headers, nowMs) {
  if (!headers) return null;
  const now = nowMs || Date.now();
  const ra = headers['retry-after'];
  if (ra != null) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return now + secs * 1000;
    const d = Date.parse(ra);                       // retry-after também aceita data HTTP
    if (!Number.isNaN(d) && d > now) return d;
  }
  const toMs = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;  // <1e12 → segundos
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  };
  const unified = headers['anthropic-ratelimit-unified-reset'];
  if (unified != null) {
    const ms = toMs(unified);
    if (ms != null && ms > now) return ms;
  }
  let latest = null;
  for (const key of ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset',
                     'anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-output-tokens-reset']) {
    if (headers[key] == null) continue;
    const ms = toMs(headers[key]);
    if (ms != null && ms > now && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

// Decide até quando ficar em cooldown: reset dos headers (source 'header') ou um
// chute curto noHeaderMs (source 'probe') quando não há header; com clamp.
function computeCooldownUntil(headers, config, nowMs) {
  const now = nowMs || Date.now();
  const cfg = cooldownCfg(config);
  const reset = parseResetMs(headers, now);
  const source = reset != null ? 'header' : 'probe';
  let until = reset != null ? reset : now + cfg.noHeaderMs;
  const min = now + cfg.minMs;
  const max = now + cfg.maxMs;
  if (until < min) until = min;
  if (until > max) until = max;
  return { until, source };
}

function loadCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const j = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
      if (j && Number.isFinite(j.until) && j.until > Date.now()) {
        _cooldownUntil  = j.until;
        _cooldownSource = j.source || '';
        logger.info('Cooldown restaurado do disco', { ate: new Date(_cooldownUntil).toISOString() });
      }
    }
  } catch (e) {
    logger.warn('Falha ao restaurar cooldown (ignorado)', { err: e.message });
  }
}

function persistCooldown() {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ until: _cooldownUntil, source: _cooldownSource, armedAt: Date.now() }));
  } catch (e) {
    logger.warn('Falha ao persistir cooldown (ignorado)', { err: e.message });
  }
}

function clearCooldown() {
  _cooldownUntil = 0;
  _cooldownSource = '';
  try {
    if (fs.existsSync(COOLDOWN_FILE)) fs.unlinkSync(COOLDOWN_FILE);
  } catch (e) {
    logger.debug('Falha ao limpar cooldown (ignorado)', { err: e.message });
  }
}

// Decide se entra em cooldown a partir de um 429. Retorna true se armou.
// Com header de reset: arma na hora (autoritativo). Sem header: só arma após
// `tripAfter` 429s consecutivos — um 429 isolado NÃO trava (deixa a próxima request
// testar o Claude). Qualquer sucesso (ver forwardRequest) zera _consec429.
function armCooldown(headers, config) {
  const cfg = cooldownCfg(config);
  const { until, source } = computeCooldownUntil(headers, config, Date.now());
  if (source === 'header') {
    _consec429      = 0;            // reset autoritativo: a Anthropic disse a janela
    _cooldownUntil  = until;
    _cooldownSource = source;
    persistCooldown();
    logger.warn('Cooldown armado (reset do header) — plano B até a janela do Claude resetar', {
      ate:        new Date(until).toISOString(),
      emSegundos: Math.round((until - Date.now()) / 1000),
      retryAfter: headers ? headers['retry-after'] : undefined,
      unified:    headers ? headers['anthropic-ratelimit-unified-reset'] : undefined,
    });
    return true;
  }
  // Sem header → 429 esporádico. Conta consecutivos; só arma quando passa do limiar.
  _consec429 += 1;
  if (_consec429 < cfg.tripAfter) {
    logger.info('429 sem header — plano B só nesta request (próxima testa o Claude)', {
      consecutivos: _consec429, tripAfter: cfg.tripAfter,
    });
    return false;
  }
  _cooldownUntil  = until;
  _cooldownSource = source;
  persistCooldown();
  logger.warn('Cooldown curto armado (429 sustentado, sem header) — re-sonda o Claude em breve', {
    ate:          new Date(until).toISOString(),
    emSegundos:   Math.round((until - Date.now()) / 1000),
    consecutivos: _consec429, tripAfter: cfg.tripAfter,
  });
  return true;
}

// Dica honesta p/ o usuário. Com header: "Claude volta ~HH:MM" (hora real do reset).
// Sem header (chute): "reavaliando o Claude em ~Ns" — não inventa horário.
function resumeHint() {
  if (!_cooldownUntil) return '';
  if (_cooldownSource === 'header') {
    const d = new Date(_cooldownUntil);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Claude volta ~${hh}:${mm}`;
  }
  const secs = Math.max(1, Math.ceil((_cooldownUntil - Date.now()) / 1000));
  return `reavaliando o Claude em ~${secs}s`;
}

// ── Proxy core: forward ───────────────────────────────────────────────────────

function forwardRequest(reqBody, originalHeaders, res, config) {
  const cd = cooldownCfg(config);
  // Circuit breaker: janela em cooldown? vai DIRETO ao plano B (sem martelar a Anthropic).
  if (cd.enabled && _cooldownUntil) {
    if (Date.now() < _cooldownUntil) {
      logger.info('Cooldown ativo — plano B direto (sem tocar na Anthropic)', {
        restamSeg: Math.round((_cooldownUntil - Date.now()) / 1000),
        ate:       new Date(_cooldownUntil).toISOString(),
      });
      handleLimitExceeded(reqBody, config, res, resumeHint());
      return;
    }
    logger.info('Cooldown expirou — testando o Claude novamente', { eraAte: new Date(_cooldownUntil).toISOString() });
    clearCooldown();
  }
  const bodyStr = JSON.stringify(reqBody);
  const headers = {
    'content-type':      'application/json',
    'content-length':    Buffer.byteLength(bodyStr),
    'anthropic-version': originalHeaders['anthropic-version'] || '2023-06-01',
  };
  if (originalHeaders['x-api-key'])      headers['x-api-key']      = originalHeaders['x-api-key'];
  if (originalHeaders['authorization'])  headers['authorization']  = originalHeaders['authorization'];
  if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta'];

  const options = {
    hostname: UPSTREAM_HOST,
    port:     UPSTREAM_PORT,
    path:     '/v1/messages',
    method:   'POST',
    headers,
  };

  const triggers = (config && config.fallback && Array.isArray(config.fallback.triggerStatuses))
    ? config.fallback.triggerStatuses
    : [429];

  const upstream = UPSTREAM_LIB.request(options, (upRes) => {
    // Janela esgotada / limite → plano B (NÃO repassa o erro ao cliente).
    if (triggers.includes(upRes.statusCode)) {
      if (cd.enabled) armCooldown(upRes.headers, config);
      const hint = resumeHint();
      let errBody = '';
      upRes.on('data', c => errBody += c);
      upRes.on('end', () => {
        logger.warn('Limite upstream detectado — acionando plano B', {
          status:     upRes.statusCode,
          preview:    errBody.slice(0, 200).replace(/\n/g, ' '),
          retryAfter: upRes.headers['retry-after'],
          unified:    upRes.headers['anthropic-ratelimit-unified-reset'],
        });
        handleLimitExceeded(reqBody, config, res, hint);
      });
      upRes.on('error', (e) => {
        logger.warn('Erro lendo corpo do limite — acionando plano B mesmo assim', { err: e.message });
        handleLimitExceeded(reqBody, config, res, hint);
      });
      return;
    }
    // Claude respondeu (não é trigger) → não estamos em outage: zera o contador.
    if (_consec429 !== 0) {
      logger.debug('Claude respondeu — zerando 429 consecutivos', { eram: _consec429 });
      _consec429 = 0;
    }
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (e) => {
    logger.error('Upstream request error', { err: e.message });
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
    }
  });

  upstream.write(bodyStr);
  upstream.end();
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

async function createServer(config) {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    // Só intercepta POST /v1/messages
    if (req.method !== 'POST' || !req.url.includes('/messages')) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // Lê body
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('error', e => {
      logger.error('Request read error', { err: e.message });
      res.writeHead(400);
      res.end();
    });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(rawBody); }
      catch (e) {
        logger.warn('Body parse error', { err: e.message });
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      const originalModel = body.model || 'unknown';
      const prompt = extractPrompt(body);

      try {
        const tier = await classify(prompt.slice(0, 800), config);
        if (tier) {
          const newModel = resolveModel(tier, config);
          body.model = newModel;
          logger.info('Roteado', {
            tier,
            original: originalModel,
            novo: newModel,
            preview: prompt.slice(0, 80).replace(/\n/g, ' '),
          });
        } else {
          logger.debug('Sem tier — modelo original mantido', { model: originalModel });
        }
      } catch (e) {
        logger.warn('Classify error — modelo original mantido', { err: e.message });
      }

      forwardRequest(body, req.headers, res, config);
    });
  });

  return server;
}

// ── State file ────────────────────────────────────────────────────────────────

function writeState(port) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    pid:       process.pid,
    port,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== model-router iniciando ===', { pid: process.pid, pluginRoot: PLUGIN_ROOT, dataDir: DATA_DIR });

  fs.mkdirSync(STATE_DIR, { recursive: true });

  const config = loadConfig();
  loadCooldown();

  if (config.enabled === false) {
    logger.warn('Router desabilitado em router-config.json (enabled: false). Saindo.');
    process.exit(0);
  }

  // Inicializa classificador local (MiniLM)
  try {
    _embedder = await loadEmbedder(config);
    const anchorCfg = config.anchors || {};
    _anchors = await buildAnchors(_embedder, anchorCfg);
  } catch (e) {
    logger.warn('Classificador local não inicializado — será usado NIM ou sem roteamento', { err: e.message });
  }

  const server = await createServer(config);

  // Tenta a porta configurada; se ocupada, tenta as próximas (até +10).
  const basePort = config.port || 13456;
  const MAX_TRIES = 10;

  const bind = (port, attempt) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
        logger.warn(`Porta ${port} ocupada, tentando ${port + 1}...`);
        bind(port + 1, attempt + 1);
        return;
      }
      logger.error('Server error fatal', { err: e.message });
      process.exit(1);
    };
    // `once`: só UM handler de bind ativo por vez (evita exit duplo no EADDRINUSE).
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      // Handler permanente para erros de runtime após o bind (não derruba o processo).
      server.on('error', (e) => logger.error('Server runtime error', { err: e.message }));
      const actual = server.address().port;
      logger.info(`=== Servidor pronto em http://127.0.0.1:${actual} ===`, { port: actual });
      writeState(actual);
      if (actual !== basePort) {
        logger.warn(`ATENÇÃO: servidor na porta ${actual} mas config base é ${basePort}. ANTHROPIC_BASE_URL deve apontar para http://127.0.0.1:${actual}`);
      }
      process.stdout.write(`ROUTER_PORT=${actual}\n`);
    });
  };

  bind(basePort, 0);

  // Graceful shutdown
  process.on('SIGTERM', () => { logger.info('SIGTERM recebido, encerrando'); server.close(() => process.exit(0)); });
  process.on('SIGINT',  () => { logger.info('SIGINT recebido, encerrando');  server.close(() => process.exit(0)); });
}

// Executa o servidor apenas quando rodado direto. Quando requerido (testes),
// exporta os helpers puros para validação isolada — sem subir o proxy.
if (require.main === module) {
  main().catch(e => {
    logger.error('Fatal startup error', { err: e.message, stack: e.stack });
    process.exit(1);
  });
} else {
  module.exports = {
    classifierPolicy,
    applyClassifierPolicy,
    anthropicToOpenAI,
    resolveModel,
    extractPrompt,
    mergeUserConfig,
    parseResetMs,
    computeCooldownUntil,
    cooldownCfg,
    clearCooldown,
  };
}
