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

// Ordem de "peso" dos tiers (haiku < sonnet < opus). Usado pelo TETO: o roteador
// nunca escala acima do que o usuário escolheu no dropdown — só rebaixa.
const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };

// Mapeia um NOME de modelo (o que veio no body.model = escolha do dropdown) ao tier.
function modelTier(modelStr) {
  const s = (modelStr || '').toLowerCase();
  if (s.includes('haiku'))  return 'haiku';
  if (s.includes('opus'))   return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  return null; // desconhecido (não dá p/ aplicar teto com segurança)
}

// Pesos de custo (proxy dos preços públicos) p/ a ESTIMATIVA de economia. Só
// afetam o relatório de telemetria, nunca o roteamento. Configuráveis.
function costWeights(config) {
  const w = (config && config.routing && config.routing.costWeights) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return { haiku: num(w.haiku, 1), sonnet: num(w.sonnet, 3), opus: num(w.opus, 15) };
}

function tierWeight(tier, config) {
  const w = costWeights(config);
  return (tier && w[tier] != null) ? w[tier] : w.sonnet; // desconhecido → peso sonnet (neutro)
}

// TETO (puro/determinístico): dado o tier classificado, o tier do dropdown e o
// modelo original, devolve { routedTier, newModel, blocked }. Nunca escala ACIMA
// do escolhido — só rebaixa p/ economizar. Ligado por padrão (routing.ceiling !==
// false). origTier null (modelo desconhecido) → sem teto. Extraído do handler p/
// ser testável sem depender do classificador.
function applyCeiling(classifiedTier, origTier, originalModel, config) {
  let routedTier = classifiedTier;
  let newModel   = resolveModel(classifiedTier, config);
  let blocked    = false;
  const ceilingOn = !(config && config.routing && config.routing.ceiling === false);
  if (ceilingOn && origTier && TIER_RANK[classifiedTier] > TIER_RANK[origTier]) {
    routedTier = origTier;
    newModel   = originalModel; // mantém EXATAMENTE o que o usuário escolheu
    blocked    = true;
  }
  return { routedTier, newModel, blocked };
}

// ── Reconciliação do parâmetro `effort` (output_config) ───────────────────────
// O `effort` (Anthropic) controla quanto o modelo "gasta" de tokens. Vive em
// `body.output_config.effort` (forma canônica da API; tratamos top-level como
// defensivo). PONTO-CHAVE: a ESCALA é POR MODELO — não é "tem/não tem". Pela doc
// oficial (platform.claude.com/docs/.../effort): Opus 4.8/4.7 têm `xhigh`; Sonnet
// 4.6 e Opus 4.6 têm `max` mas NÃO `xhigh`; Haiku 4.5 NÃO suporta effort. Logo, ao
// REBAIXAR o modelo (teto/economia) não dá p/ "stripar cego": isso jogaria fora um
// effort válido no destino. Reconciliamos contra o suporte do modelo de DESTINO.
const DEFAULT_EFFORT = {
  order: ['low', 'medium', 'high', 'xhigh', 'max'], // ranking de capacidade (asc)
  support: {
    'claude-opus-4-8':   ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-7':   ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-6':   ['low', 'medium', 'high', 'max'],
    'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
    'claude-opus-4-5':   ['low', 'medium', 'high'],
    // modelos AUSENTES (ex.: claude-haiku-4-5, sonnet-4-5) → não suportam effort.
  },
};

function effortConfig(config) {
  const e = (config && config.routing && config.routing.effort) || {};
  const order   = Array.isArray(e.order) && e.order.length ? e.order : DEFAULT_EFFORT.order;
  const support = (e.support && typeof e.support === 'object') ? e.support : DEFAULT_EFFORT.support;
  return { order, support };
}

// Valores de effort suportados por um modelo (match exato; senão por PREFIXO, p/
// cobrir sufixo de data tipo "claude-sonnet-4-6-20251101"). null = não suporta.
function effortSupportFor(model, support) {
  if (!model) return null;
  if (support[model]) return support[model];
  const key = Object.keys(support).find(k => model.startsWith(k));
  return key ? support[key] : null;
}

// Onde o effort vive no body (canônico output_config.effort; defensivo top-level).
function findEffort(body) {
  if (!body) return null;
  if (body.output_config && body.output_config.effort !== undefined) return { container: body.output_config, nested: true };
  if (body.effort !== undefined) return { container: body, nested: false };
  return null;
}

// Reconcilia o effort do body com o modelo de DESTINO. Muta o body. Devolve
// { action: 'none'|'keep'|'clamp'|'strip', from, to } p/ log/teste.
//   - destino suporta o valor          → keep
//   - suporta effort mas NÃO o valor    → clamp p/ o maior suportado com rank<=pedido
//   - destino não suporta effort        → strip (e remove output_config se ficar vazio)
//   - valor desconhecido (fora do order)→ strip (não dá p/ clampar com segurança)
function reconcileEffort(body, newModel, config) {
  const loc = findEffort(body);
  if (!loc) return { action: 'none' };
  const cur = loc.container.effort;
  const { order, support } = effortConfig(config);
  const sup = effortSupportFor(newModel, support);

  const strip = () => {
    delete loc.container.effort;
    if (loc.nested && body.output_config && Object.keys(body.output_config).length === 0) delete body.output_config;
  };

  if (!sup || sup.length === 0) { strip(); return { action: 'strip', from: cur, to: null }; }
  if (sup.includes(cur)) return { action: 'keep', from: cur, to: cur };

  const rCur = order.indexOf(cur);
  if (rCur < 0) { strip(); return { action: 'strip', from: cur, to: null }; } // valor que não conhecemos

  let best = null, bestRank = -1;
  for (const v of sup) {
    const r = order.indexOf(v);
    if (r >= 0 && r <= rCur && r > bestRank) { best = v; bestRank = r; }
  }
  if (best === null) { // nenhum <= pedido (raro): menor suportado conhecido
    for (const v of sup) { const r = order.indexOf(v); if (r >= 0 && (best === null || r < bestRank)) { best = v; bestRank = r; } }
  }
  if (best === null) { strip(); return { action: 'strip', from: cur, to: null }; }
  loc.container.effort = best;
  return { action: 'clamp', from: cur, to: best };
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

// Tamanho (em chars) do system prompt — string OU array de blocos {type,text}.
// Telemetria p/ separar tarefa auxiliar (sys pequeno) de raciocínio (sys grande).
function systemLen(system) {
  try {
    if (!system) return 0;
    if (typeof system === 'string') return system.length;
    if (Array.isArray(system)) {
      return system.reduce((a, s) => a + (s && typeof s.text === 'string' ? s.text.length : 0), 0);
    }
  } catch (_) { /* sys ilegível → 0 */ }
  return 0;
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
  metricsNoKey();
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
let _cooldownSource = '';   // origem do reset: 'header'/'body' (autoritativo) | 'probe' (chute curto)
let _consec429      = 0;    // 429 consecutivos sem header (zera em qualquer sucesso)
let _lastClaudeOkAt = 0;    // epoch ms do último 200 limpo do Claude (prova de janela aberta)

function cooldownCfg(config) {
  const c = (config && config.fallback && config.fallback.cooldown) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled:    c.enabled !== false,                                 // default: ligado
    noHeaderMs: num(c.noHeaderMs != null ? c.noHeaderMs : c.defaultMs, 15000), // sem header → cooldown curto p/ re-sondar
    minMs:      num(c.minMs, 1000),                                  // piso (evita cooldown ~0)
    maxMs:      num(c.maxMs, 6 * 60 * 60 * 1000),                    // teto de segurança (6h)
    tripAfter:  Math.max(1, num(c.tripAfter, 2)),                    // 429s seguidos p/ armar quando não há header
    probeSuppressMs: num(c.probeSuppressMs, 30000),                  // 429 sem header logo após 200 do Claude = concorrência, não janela → não arma
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

// Sinais DETERMINÍSTICOS de janela esgotada que vêm no CORPO da resposta (não em
// header) — o caso típico da ASSINATURA (Claude Pro/Max). Dois formatos confirmados
// em ~15 projetos reais + doc oficial:
//  • evento stream-json:
//      {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
//        "resetsAt":<unix>,"rateLimitType":"five_hour"}}
//    (status "allowed"/"allowed_warning" NÃO esgota — só "rejected")
//  • string renderizada (o que o Claude Code mostra ao usuário):
//      "Claude AI usage limit reached|<unix>[|<tipo>]"
// <unix>/resetsAt em segundos (10 díg) ou ms (13 díg) — detectado por magnitude.
// Retorna { ms, rejected, rateLimitType }: ms = epoch ms do reset (ou null);
// rejected = a janela foi REJEITADA (não é só aviso/allowed).
function parseResetFromBody(bodyStr, nowMs) {
  const empty = { ms: null, rejected: false, rateLimitType: '' };
  if (!bodyStr || typeof bodyStr !== 'string') return empty;
  void nowMs;
  const toMs = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return null;
    return v > 1e12 ? v : v * 1000;                      // <1e12 → segundos
  };
  // (1) Marcador string — sempre é REJEIÇÃO e carrega o próprio timestamp.
  const marker = bodyStr.match(/Claude AI usage limit reached\|(\d{10,13})(?:\|([a-z_]+))?/i);
  // (2) Evento: rejeição = status "rejected".
  const rejected = !!marker || /"status"\s*:\s*"rejected"/i.test(bodyStr);
  const typeM = bodyStr.match(/"rateLimitType"\s*:\s*"([a-z_]+)"/i);
  const rateLimitType = (marker && marker[2]) ? marker[2] : (typeM ? typeM[1] : '');
  let ms = marker ? toMs(marker[1]) : null;
  if (ms == null) {
    // Último resetsAt do corpo (numérico epoch; aceita também ISO entre aspas).
    let last = null, m;
    const re = /"resetsAt"\s*:\s*(?:"([^"]+)"|(\d{10,13}))/g;
    while ((m = re.exec(bodyStr)) !== null) last = m[1] != null ? m[1] : m[2];
    if (last != null) {
      if (/^\d{10,13}$/.test(last)) ms = toMs(last);
      else { const d = Date.parse(last); ms = Number.isNaN(d) ? null : d; }
    }
  }
  return { ms, rejected, rateLimitType };
}

// Headers de rate limit (captura diagnóstica): registra a forma EXATA que a
// Anthropic mandar no próximo limite real — evidência, sem depender de chute.
function ratelimitHeaders(h) {
  if (!h) return undefined;
  const out = {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('anthropic-ratelimit') || lk === 'retry-after') out[k] = h[k];
  }
  return Object.keys(out).length ? out : undefined;
}

// Decide até quando ficar em cooldown. Reset AUTORITATIVO vem dos headers
// (source 'header') OU do corpo da resposta (source 'body', caso da assinatura).
// Sem nada legível, cai num chute curto noHeaderMs (source 'probe'). Com clamp.
// bodyStr é opcional (4º arg p/ compatibilidade com chamadas antigas).
function computeCooldownUntil(headers, config, nowMs, bodyStr) {
  const now = nowMs || Date.now();
  const cfg = cooldownCfg(config);
  let reset = parseResetMs(headers, now);
  let source = reset != null ? 'header' : null;
  if (reset == null) {
    const b = parseResetFromBody(bodyStr, now);
    if (b.ms != null && b.ms > now) { reset = b.ms; source = 'body'; }
  }
  if (source == null) source = 'probe';
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

// Registra um 200 LIMPO do Claude: (1) marca o instante — prova de que a janela
// está aberta, usada por armCooldown p/ suprimir cooldown de palpite durante
// rajadas de concorrência; (2) derruba na hora um cooldown de PALPITE (probe)
// que tenha sido armado por uma rajada concorrente de 429 sem reset. Cooldowns
// AUTORITATIVOS (header/body) têm reset real e NÃO são derrubados aqui — só
// expiram pelo relógio. Idempotente.
function noteClaudeOk() {
  _lastClaudeOkAt = Date.now();
  if (_cooldownUntil && _cooldownSource === 'probe') {
    logger.info('200 do Claude durante cooldown de palpite — derrubando (concorrência, não janela)', {
      eraAte: new Date(_cooldownUntil).toISOString(),
    });
    clearCooldown();
  }
}

// Decide se entra em cooldown a partir de um 429. Retorna true se armou.
// Com reset autoritativo (header OU corpo): arma na hora. Sem nada legível: só
// arma após `tripAfter` 429s consecutivos — um 429 isolado NÃO trava (deixa a
// próxima request testar o Claude). Qualquer sucesso (ver forwardRequest) zera
// _consec429. bodyStr é opcional (corpo do 429 — pode trazer o reset da assinatura).
function armCooldown(headers, config, bodyStr) {
  const cfg = cooldownCfg(config);
  const { until, source } = computeCooldownUntil(headers, config, Date.now(), bodyStr);
  if (source === 'header' || source === 'body') {
    _consec429      = 0;            // reset autoritativo: a Anthropic informou a janela
    _cooldownUntil  = until;
    _cooldownSource = source;
    persistCooldown();
    logger.warn('Cooldown armado (reset autoritativo) — plano B até a janela do Claude resetar', {
      fonte:      source,
      ate:        new Date(until).toISOString(),
      emSegundos: Math.round((until - Date.now()) / 1000),
      retryAfter: headers ? headers['retry-after'] : undefined,
      unified:    headers ? headers['anthropic-ratelimit-unified-reset'] : undefined,
    });
    metricsCooldownArm();
    return true;
  }
  // Sem header → 429 esporádico. Conta consecutivos; só arma quando passa do limiar.
  // GUARD anti-falso-positivo: se o Claude ACABOU de responder 200 (rajada de
  // concorrência paralela do Claude Code, NÃO janela esgotada), não arma nem conta —
  // cai no plano B só nesta request. Resets autoritativos (header/body) já saíram acima.
  const sinceOk = _lastClaudeOkAt ? (Date.now() - _lastClaudeOkAt) : Infinity;
  if (sinceOk < cfg.probeSuppressMs) {
    logger.info('429 sem header logo após 200 do Claude — concorrência, não janela; não arma cooldown', {
      msDesdeUltimo200: Math.round(sinceOk), limiteMs: cfg.probeSuppressMs,
    });
    return false;
  }
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
  metricsCooldownArm();
  return true;
}

// Arma cooldown a partir de uma REJEIÇÃO detectada no CORPO de uma resposta 200
// (stream da assinatura: rate_limit_event status:rejected, ou o marcador string).
// Só age quando há rejeição COM horário de reset legível. Autoritativo → 'body'.
function armCooldownFromBody(bodyStr, config) {
  const b = parseResetFromBody(bodyStr, Date.now());
  if (!b.rejected || b.ms == null) return false;
  const now = Date.now();
  const cfg = cooldownCfg(config);
  let until = b.ms;
  if (until < now + cfg.minMs) until = now + cfg.minMs;
  if (until > now + cfg.maxMs) until = now + cfg.maxMs;
  _consec429      = 0;
  _cooldownUntil  = until;
  _cooldownSource = 'body';
  persistCooldown();
  logger.warn('Janela esgotada detectada no stream do Claude (rate_limit_event) — cooldown até o reset real', {
    ate:           new Date(until).toISOString(),
    emSegundos:    Math.round((until - now) / 1000),
    rateLimitType: b.rateLimitType || undefined,
  });
  metricsCooldownArm();
  return true;
}

// Dica honesta p/ o usuário. Com reset autoritativo (header/corpo): "Claude volta
// ~HH:MM" (hora real do reset). Sem nada (chute): "reavaliando o Claude em ~Ns".
function resumeHint() {
  if (!_cooldownUntil) return '';
  if (_cooldownSource === 'header' || _cooldownSource === 'body') {
    const d = new Date(_cooldownUntil);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Claude volta ~${hh}:${mm}`;
  }
  const secs = Math.max(1, Math.ceil((_cooldownUntil - Date.now()) / 1000));
  return `reavaliando o Claude em ~${secs}s`;
}

// ── Telemetria (validação de economia) ───────────────────────────────────────
// Conta requisições, rebaixamentos (downgrades), teto aplicado e plano B, e estima
// a economia em "unidades de custo" (pesos proxy dos preços) vs. rodar TUDO no
// modelo que o usuário escolheu. Persistido p/ sobreviver a reinícios (economia
// cumulativa). Best-effort: NUNCA interfere no proxy (try/catch onde necessário).

const METRICS_FILE = path.join(STATE_DIR, 'metrics.json');
let _metricsDirty = false;

function emptyTierMap() { return { haiku: 0, sonnet: 0, opus: 0, unknown: 0 }; }

function newMetrics() {
  return {
    startedAt:       new Date().toISOString(),
    lastReqAt:       null,
    total:           0,   // requisições /messages roteadas
    classified:      0,   // classificador retornou um tier
    byOriginal:      emptyTierMap(),  // tier do modelo escolhido no dropdown
    byFinal:         emptyTierMap(),  // tier que decidimos mandar pro Claude
    downgrades:      0,   // final mais barato que o escolhido
    kept:            0,   // manteve o mesmo tier
    upgradesBlocked: 0,   // teto impediu subir acima do escolhido
    servedClaude:    0,   // respondido pelo Claude
    servedPlanB:     0,   // respondido pelo plano B (NVIDIA = custo-Claude zero)
    planBNoKey:      0,   // limite batido mas sem chave NVIDIA (só aviso)
    cooldownArms:    0,   // vezes que a janela esgotou e armou cooldown
    cost:            { baselineUnits: 0, actualUnits: 0 },
    tokens:          { in: 0, out: 0 },
  };
}

let metrics = newMetrics();

function loadMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
      metrics = Object.assign(newMetrics(), saved, {
        byOriginal: Object.assign(emptyTierMap(), saved.byOriginal || {}),
        byFinal:    Object.assign(emptyTierMap(), saved.byFinal || {}),
        cost:       Object.assign({ baselineUnits: 0, actualUnits: 0 }, saved.cost || {}),
        tokens:     Object.assign({ in: 0, out: 0 }, saved.tokens || {}),
      });
    }
  } catch (e) {
    logger.warn('Falha ao carregar metrics.json (recomeçando do zero)', { err: e.message });
    metrics = newMetrics();
  }
}

function persistMetrics() {
  if (!_metricsDirty) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    _metricsDirty = false;
  } catch (e) {
    logger.debug('Falha ao persistir metrics.json (ignorado)', { err: e.message });
  }
}

function resetMetrics() {
  metrics = newMetrics();
  _metricsDirty = true;
  persistMetrics();
}

// Registra a DECISÃO de rota. origTier = dropdown do usuário; finalTier = o que
// vamos mandar pro Claude; blocked = teto impediu um upgrade.
function metricsRoute(origTier, finalTier, classified, blocked) {
  metrics.total += 1;
  metrics.lastReqAt = new Date().toISOString();
  metrics.byOriginal[origTier || 'unknown'] += 1;
  metrics.byFinal[finalTier || 'unknown'] += 1;
  if (classified) metrics.classified += 1;
  if (blocked) {
    metrics.upgradesBlocked += 1;
  } else if (origTier && finalTier && TIER_RANK[finalTier] < TIER_RANK[origTier]) {
    metrics.downgrades += 1;
  } else {
    metrics.kept += 1;
  }
  _metricsDirty = true;
}

// Registra o DESFECHO econômico. kind: 'claude' (servido pelo Claude) ou 'planB'
// (NVIDIA = custo-Claude zero). baseline = peso do modelo escolhido pelo usuário.
function metricsOutcome(kind, route, config) {
  if (!route) return;
  metrics.cost.baselineUnits += tierWeight(route.origTier, config);
  if (kind === 'planB') {
    metrics.servedPlanB += 1; // actual += 0 (grátis, fora do Claude)
  } else {
    metrics.servedClaude += 1;
    metrics.cost.actualUnits += tierWeight(route.finalTier, config);
  }
  _metricsDirty = true;
}

function metricsNoKey()       { metrics.planBNoKey += 1; _metricsDirty = true; }
function metricsCooldownArm() { metrics.cooldownArms += 1; _metricsDirty = true; }

function metricsTokens(inTok, outTok) {
  if (inTok)  metrics.tokens.in  += inTok;
  if (outTok) metrics.tokens.out += outTok;
  _metricsDirty = true;
}

// Snapshot + economia calculada (em %). economiaPct = 1 - actual/baseline.
function metricsSnapshot() {
  const b = metrics.cost.baselineUnits;
  const a = metrics.cost.actualUnits;
  const economiaPct = b > 0 ? Math.round((1 - a / b) * 1000) / 10 : 0;
  return Object.assign({}, metrics, {
    economiaPct,
    savedUnits: Math.round((b - a) * 10) / 10,
  });
}

// ── Proxy core: forward ───────────────────────────────────────────────────────

// Repasse VERBATIM ao upstream, preservando o path original. Usado para
// `/v1/messages/count_tokens` (e qualquer endpoint não-geração): a contagem de
// tokens é GRÁTIS na Anthropic e independe do modelo (tokenizer compartilhado).
// Reescrever pra `/v1/messages` converteria a contagem grátis em geração paga e,
// no boot, satura o rate limit (RPM) → 429 em massa. Aqui NÃO classificamos, NÃO
// trocamos o modelo, NÃO acionamos plano B e NÃO fazemos tee de telemetria: só
// repassamos a request e a resposta como se o proxy não existisse para ela.
function passthrough(rawBody, originalHeaders, res, pathOriginal) {
  const headers = {
    'content-type':      'application/json',
    'content-length':    Buffer.byteLength(rawBody),
    'anthropic-version': originalHeaders['anthropic-version'] || '2023-06-01',
  };
  if (originalHeaders['x-api-key'])      headers['x-api-key']      = originalHeaders['x-api-key'];
  if (originalHeaders['authorization'])  headers['authorization']  = originalHeaders['authorization'];
  if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta'];

  const options = {
    hostname: UPSTREAM_HOST,
    port:     UPSTREAM_PORT,
    path:     pathOriginal || '/v1/messages/count_tokens',
    method:   'POST',
    headers,
  };

  const upstream = UPSTREAM_LIB.request(options, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    logger.error('Passthrough upstream error', { err: e.message, path: pathOriginal });
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
    }
  });
  upstream.write(rawBody);
  upstream.end();
}

function forwardRequest(reqBody, originalHeaders, res, config, route) {
  const cd = cooldownCfg(config);
  // Circuit breaker: janela em cooldown? vai DIRETO ao plano B (sem martelar a Anthropic).
  if (cd.enabled && _cooldownUntil) {
    if (Date.now() < _cooldownUntil) {
      logger.info('Cooldown ativo — plano B direto (sem tocar na Anthropic)', {
        restamSeg: Math.round((_cooldownUntil - Date.now()) / 1000),
        ate:       new Date(_cooldownUntil).toISOString(),
      });
      metricsOutcome('planB', route, config);
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
    path:     (route && route.path) || '/v1/messages',
    method:   'POST',
    headers,
  };

  const triggers = (config && config.fallback && Array.isArray(config.fallback.triggerStatuses))
    ? config.fallback.triggerStatuses
    : [429];

  const upstream = UPSTREAM_LIB.request(options, (upRes) => {
    // Janela esgotada / limite → plano B (NÃO repassa o erro ao cliente).
    if (triggers.includes(upRes.statusCode)) {
      let errBody = '';
      upRes.on('data', (c) => { if (errBody.length < 16384) errBody += c; }); // limita memória
      upRes.on('end', () => {
        // Arma DEPOIS de ler o corpo: na assinatura o reset pode vir no CORPO
        // (rate_limit_event/marcador), não só nos headers.
        if (cd.enabled) armCooldown(upRes.headers, config, errBody);
        const hint = resumeHint();
        logger.warn('Limite upstream detectado — acionando plano B', {
          status:     upRes.statusCode,
          preview:    errBody.slice(0, 500).replace(/\n/g, ' '),
          retryAfter: upRes.headers['retry-after'],
          unified:    upRes.headers['anthropic-ratelimit-unified-reset'],
          rlHeaders:  ratelimitHeaders(upRes.headers),   // captura total p/ evidência
        });
        metricsOutcome('planB', route, config);
        handleLimitExceeded(reqBody, config, res, hint);
      });
      upRes.on('error', (e) => {
        if (cd.enabled) armCooldown(upRes.headers, config, '');
        logger.warn('Erro lendo corpo do limite — acionando plano B mesmo assim', { err: e.message });
        metricsOutcome('planB', route, config);
        handleLimitExceeded(reqBody, config, res, resumeHint());
      });
      return;
    }
    // Claude respondeu (não é trigger) → não estamos em outage: zera o contador
    // e registra o 200 limpo (marca a janela aberta + derruba cooldown de palpite).
    if (_consec429 !== 0) {
      logger.debug('Claude respondeu — zerando 429 consecutivos', { eram: _consec429 });
      _consec429 = 0;
    }
    noteClaudeOk();
    metricsOutcome('claude', route, config);
    res.writeHead(upRes.statusCode, upRes.headers);
    // "Tee" leve no 200: repassamos o stream verbatim ao cliente E o escaneamos
    // para (1) detectar a janela esgotada DENTRO de um 200 (evento stream-json
    // rate_limit_event status:rejected, ou o marcador string) e armar o cooldown
    // até o resetsAt real; (2) capturar `usage` (tokens reais) p/ telemetria.
    // Nunca altera/pausa o corpo; tudo best-effort (try/catch).
    {
      const wantRLScan = cd.enabled && !_cooldownUntil;
      let scanBuf = '';
      let armed = false;
      let inTok = 0, outTok = 0;
      upRes.on('data', (c) => {
        try {
          const s = c.toString('utf8');
          if (wantRLScan && !armed) {
            scanBuf += s;
            if (scanBuf.length > 65536) scanBuf = scanBuf.slice(-65536); // cauda; limita memória
            if (scanBuf.includes('rate_limit_event') || scanBuf.includes('Claude AI usage limit reached')) {
              if (armCooldownFromBody(scanBuf, config)) armed = true;
            }
          }
          const mi = s.match(/"input_tokens"\s*:\s*(\d+)/);     // 1ª ocorrência (message_start)
          if (mi && !inTok) inTok = Number(mi[1]);
          let mo;                                                // output_tokens cresce nos deltas → pega o MAIOR
          const reOut = /"output_tokens"\s*:\s*(\d+)/g;
          while ((mo = reOut.exec(s)) !== null) { const v = Number(mo[1]); if (v > outTok) outTok = v; }
        } catch (_) { void _; /* telemetria/scan nunca quebram o pipe */ }
      });
      upRes.on('end', () => { if (inTok || outTok) metricsTokens(inTok, outTok); });
    }
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

    // Telemetria: snapshot dos contadores + economia estimada (lido pelo dashboard).
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metricsSnapshot()));
      return;
    }
    if (req.method === 'POST' && req.url === '/metrics/reset') {
      resetMetrics();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
      // count_tokens é o endpoint GRÁTIS de contagem (beta token-counting): repassa
      // verbatim preservando o path. Classificar/reescrever pra /v1/messages
      // converteria contagem grátis em geração paga e saturaria o RPM no boot.
      if (req.url.includes('/count_tokens')) {
        logger.debug('count_tokens — passthrough verbatim (sem rota)', { path: req.url, bytes: Buffer.byteLength(rawBody) });
        passthrough(rawBody, req.headers, res, req.url);
        return;
      }
      let body;
      try { body = JSON.parse(rawBody); }
      catch (e) {
        logger.warn('Body parse error', { err: e.message });
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      const originalModel = body.model || 'unknown';
      const origTier = modelTier(originalModel);
      const prompt = extractPrompt(body);

      let tier = null;
      try {
        tier = await classify(prompt.slice(0, 800), config);
      } catch (e) {
        logger.warn('Classify error — modelo original mantido', { err: e.message });
      }

      let finalTier = origTier;
      let blocked = false;
      if (tier) {
        const dec = applyCeiling(tier, origTier, originalModel, config);
        blocked = dec.blocked;
        if (blocked) {
          logger.info('Teto — classificador acima do escolhido; mantido o modelo do usuário', {
            escolhido: origTier, classificou: tier, modelo: originalModel,
          });
        }
        body.model = dec.newModel;
        finalTier  = dec.routedTier;
        // Reconcilia `effort` (output_config) com o modelo de DESTINO: cada modelo tem
        // escala própria (Opus 4.8 tem xhigh; Sonnet 4.6 não; Haiku não tem effort).
        // Só mexe quando o modelo MUDA — mantém / clampa / remove conforme o suporte.
        let effortAdj = { action: 'none' };
        if (dec.newModel !== originalModel) effortAdj = reconcileEffort(body, dec.newModel, config);
        logger.info('Roteado', {
          tier:        dec.routedTier,
          classificou: tier,
          original:    originalModel,
          novo:        dec.newModel,
          teto:        blocked || undefined,
          effort:      effortAdj.action !== 'none' ? { acao: effortAdj.action, de: effortAdj.from, para: effortAdj.to } : undefined,
          // Telemetria de FORMATO p/ decidir offload (auxiliar vs raciocínio):
          // maxTok pequeno + nMsg baixo = tarefa auxiliar (título/classificação);
          // bytes = contexto REAL enviado (o que pesa na janela de uso).
          maxTok:      typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
          nMsg:        Array.isArray(body.messages) ? body.messages.length : 0,
          sysLen:      systemLen(body.system),
          bytes:       Buffer.byteLength(rawBody),
          stream:      body.stream || undefined,
          preview:     prompt.slice(0, 80).replace(/\n/g, ' '),
        });
      } else {
        logger.debug('Sem tier — modelo original mantido', { model: originalModel });
      }

      try { metricsRoute(origTier, finalTier, !!tier, blocked); }
      catch (e) { logger.debug('metricsRoute falhou (ignorado)', { err: e.message }); }

      forwardRequest(body, req.headers, res, config, { origTier, finalTier, path: req.url });
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

// Sonda /health da porta fixa para saber se quem a ocupa é um model-router NOSSO
// (vs. outro processo qualquer). Usado no EADDRINUSE para decidir reuso vs. abort.
function probeOurHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1200 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let ok = false;
        try { ok = res.statusCode === 200 && JSON.parse(buf).status === 'ok'; }
        catch (err) { void err; ok = false; }
        resolve(ok);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== model-router iniciando ===', { pid: process.pid, pluginRoot: PLUGIN_ROOT, dataDir: DATA_DIR });

  fs.mkdirSync(STATE_DIR, { recursive: true });

  const config = loadConfig();
  loadCooldown();
  loadMetrics();
  const _metricsTimer = setInterval(persistMetrics, 5000);
  if (_metricsTimer.unref) _metricsTimer.unref(); // não segura o processo vivo

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

  // PORTA FIXA: o settings.json env aponta para ela. NUNCA incrementa — se a porta
  // já tem um model-router NOSSO saudável, esta instância é redundante e sai limpa
  // (reuso). Se for outro processo, falha sem sequestrar porta alheia. Isso elimina
  // o "port sprawl" (várias instâncias em portas +1) e mantém a URL estável/fixa.
  const FIXED_PORT = config.port || 13456;

  const onError = (e) => {
    if (e.code === 'EADDRINUSE') {
      probeOurHealth(FIXED_PORT).then((ours) => {
        if (ours) {
          logger.info(`Porta ${FIXED_PORT} já tem um model-router saudável — instância redundante, saindo (reuso).`);
          process.exit(0);
          return;
        }
        logger.error(`Porta ${FIXED_PORT} ocupada por outro processo (não é o model-router). Abortando.`);
        process.exit(1);
      });
      return;
    }
    logger.error('Server error fatal', { err: e.message });
    process.exit(1);
  };
  // `once`: só UM handler de bind ativo por vez (evita exit duplo no EADDRINUSE).
  server.once('error', onError);
  server.listen(FIXED_PORT, '127.0.0.1', () => {
    server.removeListener('error', onError);
    // Handler permanente para erros de runtime após o bind (não derruba o processo).
    server.on('error', (e) => logger.error('Server runtime error', { err: e.message }));
    logger.info(`=== Servidor pronto em http://127.0.0.1:${FIXED_PORT} ===`, { port: FIXED_PORT });
    writeState(FIXED_PORT);
    process.stdout.write(`ROUTER_PORT=${FIXED_PORT}\n`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => { logger.info('SIGTERM recebido, encerrando'); persistMetrics(); server.close(() => process.exit(0)); });
  process.on('SIGINT',  () => { logger.info('SIGINT recebido, encerrando');  persistMetrics(); server.close(() => process.exit(0)); });
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
    parseResetFromBody,
    computeCooldownUntil,
    cooldownCfg,
    clearCooldown,
    armCooldown,
    noteClaudeOk,
    __testHooks: {
      reset() { _cooldownUntil = 0; _cooldownSource = ''; _consec429 = 0; _lastClaudeOkAt = 0; },
      getState() { return { until: _cooldownUntil, source: _cooldownSource, consec: _consec429, lastOkAt: _lastClaudeOkAt }; },
      setLastClaudeOkAt(ms) { _lastClaudeOkAt = ms; },
    },
    modelTier,
    tierWeight,
    applyCeiling,
    reconcileEffort,
    effortSupportFor,
    effortConfig,
    metricsRoute,
    metricsOutcome,
    metricsSnapshot,
    resetMetrics,
    newMetrics,
  };
}
