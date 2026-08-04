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
const crypto = require('crypto');
const { URL } = require('url');
const cacheCycle = require('./cache-cycle.js');
const byok = require('./byok.js');
const catalog = require('./catalog.js');
const { resolveMode } = require('../../scripts/lib/router-mode.js');
const { routerUserConfigPath } = require('../../scripts/lib/router-config-path.js');
const { configFingerprint } = require('../../scripts/lib/router-fingerprint.js');

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
// Override do usuário (chave NVIDIA + toggles). Vive num caminho GLOBAL estável
// (globalDir()/model-router/user-config.json), independente do --data-dir, para
// que servidor, hook e dashboard concordem sempre na MESMA chave. Nunca versionado.
const USER_CONFIG_FILE = routerUserConfigPath();

// ── Identidade na porta fixa (verify-before-trust) ────────────────────────────
// WHY: o hook (model-router-ensure.js) aponta o ANTHROPIC_BASE_URL do Claude Code
// para QUALQUER processo que responda 200 em /health na porta fixa (13456) — e o
// Claude Code passa a mandar a credencial REAL (Authorization/x-api-key) para lá.
// Um processo LOCAL que tome a porta antes do nosso roteador (squatter) colheria
// essas credenciais. Defesa: espelhamos o padrão de token do daemon do Brain
// (servers/brain-server/lib/daemon-common.js) — um segredo por-instalação em
// <DATA_DIR>/model-router/router.token que o CLIENTE precisa devolver no /health
// antes de confiar na porta e ativar o roteamento (verify-before-activate). O
// /health continua 200 p/ liveness, mas só ecoa authenticated:true a quem provar
// conhecer o token; o token em si NUNCA é ecoado.
//
// ESCOPO HONESTO: isto derrota um squatter que NÃO consegue LER router.token (outro
// usuário do SO / sandbox, ou uma corrida antes do arquivo existir — nesse caso o
// cliente falha fechado e o Claude vai direto). Um atacante MESMO-USUÁRIO que leia o
// <DATA_DIR> lê o token e se passa por nós — essa é a fronteira de confiança do
// MESMO usuário no SO, idêntica ao brain-http.token, e está FORA de escopo. Ou seja:
// não "impede roubo de credencial"; REDUZ a superfície de vazamento à fronteira
// mesmo-usuário.
function routerTokenFile(stateDir) { return path.join(stateDir, 'router.token'); }

// Lê o token (trim). Ausente/ilegível → null.
function readRouterToken(stateDir = STATE_DIR) {
  try {
    const tok = fs.readFileSync(routerTokenFile(stateDir), 'utf-8').trim();
    return tok || null;
  } catch (e) { void e; return null; } // arquivo ausente/ilegível → sem token
}

// Read-or-create idempotente (boot do server). Reusa entre reinícios: só cria se
// ausente. 32 bytes hex de crypto.randomBytes. Escrito com mode 0o600 (só o dono lê)
// via writeFileSync DIRETO — o helper atômico (temp+rename) não preserva o modo
// restritivo no arquivo final, então aqui um write direto é o certo.
function ensureRouterToken(stateDir = STATE_DIR) {
  const existing = readRouterToken(stateDir);
  if (existing) return existing;
  const tok = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(routerTokenFile(stateDir), tok, { mode: 0o600 });
  } catch (e) { void e; /* falha de fs → token ainda vale em memória nesta execução */ }
  return tok;
}

// Compara em tempo constante, com guarda de tamanho. crypto.timingSafeEqual LANÇA
// quando os buffers têm tamanhos diferentes, então o check de length evita o throw
// E curto-circuita tokens obviamente errados. Segredo vazio NUNCA autentica.
function routerTokenMatches(given, expected) {
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(String(expected == null ? '' : expected));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
  // `nim`, `routing`, `fallback` e `sticky` são mesclados raso (preserva chaves
  // shipadas — ex.: {sticky:{enabled:true}} liga o sticky SEM apagar ttlMs;
  // {fallback:{enabled:true}} liga o fallback SEM apagar triggerStatuses/cooldown);
  // escalares (enabled) são sobrescritos.
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
    if ((key === 'nim' || key === 'routing' || key === 'fallback' || key === 'sticky') && override[key] && typeof override[key] === 'object') {
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

// Carrega o classificador local (embedder + âncoras) e o PUBLICA nos módulo-vars
// _embedder/_anchors — de forma ATÔMICA: só publica depois que AMBOS deram certo,
// então um embedder quebrado nunca deixa estado meio-inicializado. Chamado
// FIRE-AND-FORGET *depois* que o servidor já está pronto (porta ligada + state file
// escrito), para que um embedder lento/quebrado (ex.: sharp win32-x64 ausente) NUNCA
// atrase nem derrube a prontidão do router. Sem classificador, classifyLocal devolve
// null → passthrough (o routing segue vivo). deps injetáveis (loadEmbedder/buildAnchors)
// p/ testes herméticos, sem tocar em rede/modelo.
async function initClassifier(config, deps = {}) {
  const _loadEmbedder = deps.loadEmbedder || loadEmbedder;
  const _buildAnchors = deps.buildAnchors || buildAnchors;
  const embedder = await _loadEmbedder(config);
  const anchors  = await _buildAnchors(embedder, (config && config.anchors) || {});
  _embedder = embedder;
  _anchors  = anchors;
  logger.info('Classificador local pronto (async, pós-boot).', { tiers: Object.keys(anchors || {}) });
  return { embedder, anchors };
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

async function classify(prompt, config, deps) {
  // Injeção p/ testes herméticos (produção usa os defaults abaixo).
  const nimImpl = (deps && deps.classifyNim) || classifyNim;
  // Local default: honra o embedder/anchors do módulo; injetável nos testes.
  const localImpl = (deps && deps.classifyLocal)
    || ((p, cfg) => (_anchors ? classifyLocal(p, _anchors, classifierPolicy(cfg)) : Promise.resolve(null)));

  // OPT-IN de PRIVACIDADE (default LOCAL): só classificamos REMOTAMENTE — enviando
  // até ~500 chars do prompt REAL à NVIDIA em CADA classificação — quando o usuário
  // liga EXPLICITAMENTE nim.classifyRemote. Sem esse opt-in, a chave NIM serve APENAS
  // ao plano-B de GERAÇÃO (429, em forwardRequest/streamNvidiaToAnthropic): a
  // classificação fica 100% LOCAL (MiniLM) e NENHUM dado de prompt sai da máquina p/
  // classificar. Antes, bastava a chave presente p/ mandar todo prompt à NVIDIA —
  // um usuário que configurou a chave só p/ o plano-B vazava cada prompt sem saber.
  const nim = config.nim || {};
  const classifyRemote = nim.classifyRemote === true;
  const nimKey = nim.apiKey || process.env.NVIDIA_NIM_KEY || '';
  if (classifyRemote && nimKey) {
    const tier = await nimImpl(prompt, config);
    if (tier) return tier;
    logger.warn('NIM falhou, fallback para MiniLM local');
  }
  // Default e fallback: MiniLM LOCAL — nenhum dado de prompt sai da máquina.
  return await localImpl(prompt, config);
}

// ── Model selection ───────────────────────────────────────────────────────────

// ── Catálogo dinâmico de modelos (por assinatura) ─────────────────────────────
// Liga/desliga + TTL/backoff do catalog.js (GET /v1/models). Default LIGADO, mas
// 100% seguro: sem credencial ou com o endpoint indisponível (offline/401/403),
// tudo cai no mapa ESTÁTICO abaixo — comportamento idêntico ao de antes.
function catalogConfig(config) {
  const c = (config && config.routing && config.routing.catalog) || {};
  return {
    enabled:        c.enabled !== false,
    ttlMs:          Number.isFinite(c.ttlMs) ? c.ttlMs : 3600000,
    errorBackoffMs: Number.isFinite(c.errorBackoffMs) ? c.errorBackoffMs : 300000,
  };
}
function catalogEnabled(config) { return catalogConfig(config).enabled; }

function resolveModel(tier, config) {
  const routing = config.routing || {};
  // Catálogo DINÂMICO (se habilitado e aquecido): elege o modelo MAIS NOVO da
  // família — pega lançamentos (ex.: Sonnet 5) sem editar config. Sem catálogo
  // cai no mapa estático abaixo.
  if (catalogEnabled(config)) {
    const dyn = catalog.modelForFamily(tier);
    if (dyn) return dyn;
  }
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
  let sup = effortSupportFor(newModel, support);
  // Catálogo dinâmico: a fonte da verdade do effort é o `capabilities.effort` do
  // /v1/models. Se o catálogo conhece o destino, usa os níveis REAIS dele
  // (null = não conhece → mantém o estático; [] = conhece e NÃO tem effort → strip).
  if (catalogEnabled(config)) {
    const dyn = catalog.effortForModel(newModel);
    if (dyn !== null) sup = dyn;
  }

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

// ── Sticky-tier router (cache-safe) ───────────────────────────────────────────
// L2a: o roteador CORRETO. Rotear por-request (modo 'routing') QUEBRA o prompt
// cache da Anthropic — o cache é POR MODELO, então trocar o modelo turno-a-turno
// força cache-miss do prefixo inteiro (system+tools+histórico). O sticky-tier
// classifica UMA vez por sessão (no turno 0, quando ainda NÃO há cache = grátis) e
// FIXA o modelo pelo resto da sessão: modelo constante mantém o cache quente.
// Reusa o classificador + o teto (downgrade-only), mudando só QUANDO classifica.

// Chave estável de sessão: hash do PREFIXO da conversa (system normalizado + a
// PRIMEIRA mensagem do usuário). Esse prefixo é imutável ao longo da sessão (o
// histórico só cresce no fim), então turnos seguintes da MESMA sessão colidem na
// MESMA chave. Barato (sha1 do texto). system: string OU array de blocos {text};
// content da 1ª msg: string OU array de blocos {type:'text'}. Partes ausentes → ''.
function computeSessionKey(body) {
  const b = body || {};
  let sysText = '';
  const sys = b.system;
  if (typeof sys === 'string') sysText = sys;
  else if (Array.isArray(sys)) {
    sysText = sys.map(s => (s && typeof s.text === 'string') ? s.text : '').join('\n');
  }
  let firstUser = '';
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const first = messages.find(m => m && m.role === 'user');
  if (first) {
    const content = first.content;
    if (typeof content === 'string') firstUser = content;
    else if (Array.isArray(content)) {
      firstUser = content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
    }
  }
  return crypto.createHash('sha1').update(`${sysText}\u0000${firstUser}`).digest('hex');
}

// PIN STORE em memória: sessionKey → { tier, expiresAt }. Lazy-expire na leitura +
// varredura leve na escrita (poda sessões vencidas) p/ limitar memória.
const _stickyPins = new Map();

function stickyTtlMs(config) {
  const t = config && config.sticky && Number(config.sticky.ttlMs);
  return Number.isFinite(t) && t > 0 ? t : 21600000; // default 6h
}

function sweepStickyPins(pins, now) {
  for (const [k, v] of pins) { if (!v || now > v.expiresAt) pins.delete(k); }
}

// Decisão sticky (NÚCLEO PURO/TESTÁVEL). Olha o pin da sessão: se há pin VIVO,
// reusa o tier SEM classificar; se não, é o turno 0 → classifica UMA vez e fixa o
// tier (via teto sobre o classificado). Em AMBOS os casos reaplica o TETO com o
// modelo ATUAL do body — assim, se o usuário trocar /model no meio da sessão,
// rebaixamos graciosamente (nunca escalamos acima do escolhido). deps injetáveis
// p/ teste determinístico: { pins (Map), now (ms epoch), classifyFn(prompt,config) }.
// classifyFn é async → decideStickyModel é async, mas a lógica de pin/teto é pura.
async function decideStickyModel(body, config, deps) {
  const d = deps || {};
  const pins = d.pins || _stickyPins;
  const now = Number.isFinite(d.now) ? d.now : Date.now();
  const classifyFn = d.classifyFn || ((p, c) => classify(p, c));

  const key = computeSessionKey(body);
  const originalModel = (body && body.model) || 'unknown';
  const origTier = modelTier(originalModel);

  const existing = pins.get(key);
  const live = !!(existing && now <= existing.expiresAt);

  let pinnedTier;
  let created = false;
  if (live) {
    pinnedTier = existing.tier; // reusa SEM classificar (cache-safe)
  } else {
    // Turno 0 da sessão: classifica UMA vez (sem cache ainda = grátis).
    let classified = null;
    try {
      const prompt = extractPrompt(body).slice(0, 800);
      classified = await classifyFn(prompt, config);
    } catch (e) {
      logger.warn('Sticky classify error — usando o tier do modelo escolhido', { err: e.message });
    }
    // Aplica o teto sobre o classificado p/ derivar o tier a FIXAR (null → origTier).
    pinnedTier = classified
      ? applyCeiling(classified, origTier, originalModel, config).routedTier
      : (origTier || null);
    pins.set(key, { tier: pinnedTier, expiresAt: now + stickyTtlMs(config) });
    created = true;
    sweepStickyPins(pins, now);
  }

  // pinnedTier null (turno 0 sem classificação E sem origTier conhecido): não dá p/
  // rotear com segurança → mantém o modelo original (pin registrado evita reclassificar).
  if (!pinnedTier) {
    return { key, model: originalModel, tier: origTier, pinned: false, created, blocked: false };
  }
  const dec = applyCeiling(pinnedTier, origTier, originalModel, config);
  return { key, model: dec.newModel, tier: dec.routedTier, pinned: true, created, blocked: dec.blocked };
}

// ── Proxy core ────────────────────────────────────────────────────────────────
// Upstream Anthropic. Override via env existe SÓ para testes; produção usa
// api.anthropic.com:443 (https) — comportamento idêntico ao anterior.
const UPSTREAM_HOST     = process.env.ROUTER_UPSTREAM_HOST || 'api.anthropic.com';
const UPSTREAM_PORT     = process.env.ROUTER_UPSTREAM_PORT ? Number(process.env.ROUTER_UPSTREAM_PORT) : 443;
const UPSTREAM_PROTOCOL = process.env.ROUTER_UPSTREAM_PROTOCOL || 'https:';
const UPSTREAM_LIB      = UPSTREAM_PROTOCOL === 'http:' ? http : https;
// Destino padrão injetado no núcleo do BYOK, para que TODA rota de saída herde
// o mesmo default — e o override de env acima continue valendo em todas elas.
const UPSTREAM_FALLBACK = { host: UPSTREAM_HOST, port: UPSTREAM_PORT, protocol: UPSTREAM_PROTOCOL };

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

// Plano B via ENDPOINT do usuário (BYOK). Baseado no `passthrough`: pipe limpo,
// sem tee de telemetria, sem cooldown, sem classificar — o corpo vai como veio e
// o `model` é repassado VERBATIM (o endpoint normaliza o nome sozinho).
//
// FAIL-LOUD por contrato: 401/404/5xx e "model is not supported" NÃO caem em
// silêncio para a NVIDIA — um erro de configuração precisa aparecer, senão o
// usuário nunca conserta a credencial. Só o 429 (teto por credencial) é tratado
// como retentável e cede a vez ao próximo plano.
// @param {Function} onRetryable chamado quando o endpoint respondeu 429
function byokFallback(reqBody, config, res, hint, upstreamTarget, onRetryable) {
  const bodyStr = JSON.stringify(reqBody);
  const headers = byok.buildHeaders({}, upstreamTarget);
  headers['content-length'] = Buffer.byteLength(bodyStr);

  const lib = upstreamTarget.protocol === 'http:' ? http : https;
  const req = lib.request({
    hostname: upstreamTarget.host,
    port:     upstreamTarget.port,
    path:     '/v1/messages',
    method:   'POST',
    headers,
  }, (upRes) => {
    const cls = byok.classifyResponse(upRes.statusCode, '');
    if (cls.ok) {
      logger.info('BYOK — limite do Claude coberto pelo endpoint do usuário', {
        host: upstreamTarget.host, status: upRes.statusCode,
      });
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      return;
    }
    // Lê um pedaço do corpo: o contrato manda gritar também por corpo
    // ("model is not supported") mesmo quando o status parece aceitável.
    let errBody = '';
    upRes.on('data', (c) => { if (errBody.length < 8192) errBody += c; });
    upRes.on('end', () => {
      const finalCls = byok.classifyResponse(upRes.statusCode, errBody);
      if (finalCls.retryable && typeof onRetryable === 'function') {
        logger.warn('BYOK — endpoint no teto (429); cedendo ao próximo plano', { host: upstreamTarget.host });
        onRetryable();
        return;
      }
      logger.error('BYOK — endpoint recusou a request', {
        host: upstreamTarget.host, status: upRes.statusCode, causa: finalCls.reason,
      });
      respondAnthropicText(reqBody, res, byok.userAdvice(upRes.statusCode, finalCls, hint));
    });
  });
  req.on('error', (e) => {
    logger.error('BYOK — endpoint inacessível', { host: upstreamTarget.host, err: e.message });
    respondAnthropicText(reqBody, res,
      `⚠️ O endpoint BYOK (${upstreamTarget.host}) está inacessível: ${e.message}.\n\n`
      + 'Revise a Base URL em /dashboard → BYOK.');
  });
  req.write(bodyStr);
  req.end();
}

function handleLimitExceeded(reqBody, config, res, hint) {
  // O plano B do ENDPOINT vem antes do da NVIDIA: ele serve os mesmos modelos
  // Claude, então é a substituição mais fiel. Só entra se o usuário ligou.
  const target = byok.resolveUpstream(config, { onLimit: true }, UPSTREAM_FALLBACK);
  if (target.misconfigured) {
    logger.error('BYOK ligado mas mal configurado — não é possível usá-lo como plano B', { causa: target.misconfigured });
  }
  if (target.isByok) {
    try {
      // No 429 do endpoint (teto por credencial) cede a vez à NVIDIA.
      byokFallback(reqBody, config, res, hint, target, () => nvidiaOrMessage(reqBody, config, res, hint));
      return;
    } catch (e) {
      logger.error('Falha ao iniciar o plano B BYOK', { err: e.message });
    }
  }
  nvidiaOrMessage(reqBody, config, res, hint);
}

function nvidiaOrMessage(reqBody, config, res, hint) {
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
    tokens:          { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 },
    // Ciclo de cache observado: quantas respostas vieram de prefixo quente (hits)
    // vs. rebuild (misses), quantas fronteiras frias as sessões atravessaram — e
    // o TAMANHO dessas fronteiras (quanto contexto foi reconstruído ali e quanto
    // uma limpeza teria liberado). Frequência sozinha não decide ROI.
    cacheCycle:      {
      hits: 0, misses: 0, coldBoundaries: 0,
      // inputTokens = RECONSTRUÍDO (custo pago); promptTokens = prompt inteiro
      // (denominador do "% limpável"). Confundir os dois gerou 594% em campo.
      coldBoundaryInputTokens: 0, coldBoundaryPromptTokens: 0, coldBoundaryClearableTokens: 0,
      // Quebra por MOTIVO da fronteira. Buckets fixos (nunca criados a partir de
      // entrada externa): sessão nova × sessão que esfriou × miss observado.
      byReason: {
        'no-state':    { count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 },
        'gap-expired': { count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 },
        'prior-miss':  { count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 },
      },
    },
    // Calibração chars→token medida no próprio tráfego (sem API key).
    calibration:     { samples: 0, chars: 0, realTokens: 0 },
    // Janela de cache CONTRATADA, medida no `usage` de cada write. Sem isso a
    // janela real é palpite — e o Claude Code pode usar 1h por flag remoto.
    ttl:             { write5m: 0, write1h: 0, writeUnknown: 0 },
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
        tokens:     Object.assign({ in: 0, out: 0, cacheRead: 0, cacheCreate: 0 }, saved.tokens || {}),
        cacheCycle: Object.assign(
          { hits: 0, misses: 0, coldBoundaries: 0, coldBoundaryInputTokens: 0, coldBoundaryPromptTokens: 0, coldBoundaryClearableTokens: 0 },
          saved.cacheCycle || {},
          // byReason precisa dos 3 buckets SEMPRE presentes: um metrics.json de
          // versão anterior não os tem, e `bucket.count += 1` num undefined viraria
          // crash silencioso na primeira fronteira.
          {
            byReason: {
              'no-state':    Object.assign({ count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 }, ((saved.cacheCycle || {}).byReason || {})['no-state']),
              'gap-expired': Object.assign({ count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 }, ((saved.cacheCycle || {}).byReason || {})['gap-expired']),
              'prior-miss':  Object.assign({ count: 0, inputTokens: 0, promptTokens: 0, clearableTokens: 0 }, ((saved.cacheCycle || {}).byReason || {})['prior-miss']),
            },
          },
        ),
        calibration: Object.assign({ samples: 0, chars: 0, realTokens: 0 }, saved.calibration || {}),
        ttl: Object.assign({ write5m: 0, write1h: 0, writeUnknown: 0 }, saved.ttl || {}),
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

function metricsTokens(usage) {
  const u = usage || {};
  if (u.in)          metrics.tokens.in          += u.in;
  if (u.out)         metrics.tokens.out         += u.out;
  if (u.cacheRead)   metrics.tokens.cacheRead   += u.cacheRead;
  if (u.cacheCreate) metrics.tokens.cacheCreate += u.cacheCreate;
  _metricsDirty = true;
}

// ── Ciclo de cache: OBSERVAÇÃO ────────────────────────────────────────────────
// Estado por sessão: sessionKey → { lastRequestTs, lastCacheState, ttlMs }. Só
// mede — nesta fase NENHUMA decisão de rota consulta isso. O objetivo é ter o
// baseline antes de agir: quantas respostas vêm de cache quente e quantas vezes
// a sessão cruza uma fronteira fria (a janela em que trocar de modelo/limpar
// contexto sairia de graça).
const _cacheCycleStates = new Map();
const MAX_CACHE_CYCLE_SESSIONS = 5000;

// Observa o desfecho de UMA resposta. Devolve a fronteira que a request ACABOU
// de atravessar (calculada contra o estado ANTERIOR), o estado novo e — só na
// fronteira fria — o PRÊMIO: quanto contexto estava sendo carregado ali e quanto
// uma limpeza teria liberado. `deps` injetável ({ states, body }) p/ teste
// determinístico sem tocar o singleton.
// Sem sessionKey não há sessão a observar → null (nunca inventa uma).
function observeCacheCycle(sessionKey, acc, now, config, deps) {
  if (!sessionKey) return null;
  const states = (deps && deps.states) || _cacheCycleStates;
  const body = deps && deps.body;
  const prev = states.get(sessionKey) || null;

  // TTL agregado já observado em QUALQUER tráfego anterior (não só desta sessão).
  // Uma sessão nova (`no-state`) não tem `state.ttlMs` próprio ainda — sem isso
  // ela cairia direto no hardcoded de 5min mesmo quando o proxy já mediu, em
  // outras sessões, que o contrato real é 1h (ver `ttlWindowMs`/`deriveTtlVerdict`).
  // Lido ANTES de `metricsTtl(usage)` rodar para esta resposta (index.js chama
  // observeCacheCycle antes): reflete o que já era conhecido até a resposta
  // anterior, nunca o que esta própria resposta acabou de revelar.
  const globalTtlMs = cacheCycle.ttlWindowMs(cacheCycle.deriveTtlVerdict(metrics.ttl), config);

  const boundary = cacheCycle.isColdBoundary(prev, now, config, globalTtlMs);
  const state = cacheCycle.observeUsage(prev, cacheCycle.usageFromAccumulator(acc), now, config, globalTtlMs);
  states.set(sessionKey, state);

  // O prêmio só existe NA fronteira: fora dela limpar contexto CUSTA (invalida
  // cache quente pago), então medir ali inflaria uma oportunidade que não existe.
  let prize = null;
  if (boundary.cold) {
    const a = acc || {};
    const clearable = cacheCycle.estimateClearablePayload(body);
    const inTok = Number(a.in) || 0;
    const readTok = Number(a.cacheRead) || 0;
    const createTok = Number(a.cacheCreate) || 0;
    prize = {
      // DUAS grandezas distintas, e confundi-las produziu um número impossível em
      // campo (594% de "limpável"):
      //  - rebuilt: o que ESTA request reconstruiu do zero = o CUSTO pago ali.
      //  - prompt : o prompt inteiro que trafegou = o DENOMINADOR do "% limpável",
      //    já que `clearableTokens` mede o corpo inteiro. Sem o cacheRead, uma
      //    fronteira que ainda leu cache colapsa o denominador e a conta estoura.
      rebuiltTokens: inTok + createTok,
      promptTokens: inTok + readTok + createTok,
      clearableTokens: clearable.tokens,
      clearableBlocks: clearable.blocks,
    };
  }

  if (states.size > MAX_CACHE_CYCLE_SESSIONS) {
    // 1) poda por idade (o caso normal: sessões que morreram há muito tempo).
    for (const [k, v] of states) {
      if (!v || (now - v.lastRequestTs) > 86400000) states.delete(k);
    }
    // 2) TETO DURO. Se todas forem recentes a poda acima não remove nada, e um
    //    proxy longevo cresceria sem limite. Descarta as MENOS recentes de fato
    //    (a ordem de inserção do Map NÃO é recência: reescrever uma chave
    //    existente mantém a posição original, então ordenamos por lastRequestTs).
    const excess = states.size - MAX_CACHE_CYCLE_SESSIONS;
    if (excess > 0) {
      const oldest = [...states.entries()]
        .sort((x, y) => (x[1].lastRequestTs || 0) - (y[1].lastRequestTs || 0))
        .slice(0, excess);
      for (const [k] of oldest) states.delete(k);
    }
  }
  return { state, boundary, prize };
}

function metricsCacheCycle(obs) {
  if (!obs || !obs.state) return;
  if (obs.state.lastCacheState === 'hit')  metrics.cacheCycle.hits   += 1;
  if (obs.state.lastCacheState === 'miss') metrics.cacheCycle.misses += 1;
  if (obs.boundary && obs.boundary.cold)   metrics.cacheCycle.coldBoundaries += 1;
  // Tamanho da oportunidade. Só soma o que foi de fato MEDIDO — uma fronteira sem
  // prêmio medido conta na frequência mas não inventa volume.
  if (obs.prize) {
    metrics.cacheCycle.coldBoundaryInputTokens     += Number(obs.prize.rebuiltTokens) || 0;
    metrics.cacheCycle.coldBoundaryPromptTokens    += Number(obs.prize.promptTokens) || 0;
    metrics.cacheCycle.coldBoundaryClearableTokens += Number(obs.prize.clearableTokens) || 0;
    // POR MOTIVO. Sem esta quebra, a média mistura dois fenômenos opostos: a
    // fronteira de sessão NOVA (`no-state`, quase nada acumulado para limpar) e a
    // da sessão LONGA que esfriou (`gap-expired`, o alvo real da limpeza). Medição
    // de campo: 23 fronteiras com média de ~7K — pequeno demais para sessão
    // acumulada, ou seja, dominado por `no-state`. Decidir pela média agregada
    // descartaria a limpeza pelo motivo errado.
    const bucket = metrics.cacheCycle.byReason[obs.boundary && obs.boundary.reason];
    if (bucket) {
      bucket.count          += 1;
      bucket.inputTokens    += Number(obs.prize.rebuiltTokens) || 0;
      bucket.promptTokens   += Number(obs.prize.promptTokens) || 0;
      bucket.clearableTokens += Number(obs.prize.clearableTokens) || 0;
    }
  }
  _metricsDirty = true;
}

// Calibração chars→token medida em tráfego real (ver cache-cycle.calibrationSample).
// Agrega chars e tokens reais em vez de mediar as razões: assim uma request grande
// pesa mais que uma pequena, que é o comportamento correto para um fator global.
function metricsCalibration(sample) {
  if (!sample) return;
  const chars = Number(sample.chars) || 0;
  const real = Number(sample.realTokens) || 0;
  if (chars <= 0 || real <= 0) return;
  metrics.calibration.samples    += 1;
  metrics.calibration.chars      += chars;
  metrics.calibration.realTokens += real;
  _metricsDirty = true;
}

// TTL OBSERVADO: registra qual janela de cache foi CONTRATADA em cada write.
// A resposta da API declara isso (`ephemeral_5m_input_tokens` /
// `ephemeral_1h_input_tokens`); sem persistir, a janela real vira adivinhação —
// e ela pode ser 1h por feature-flag remoto da Anthropic, sem nada mudar aqui.
// Um write sem detalhe vai para `writeUnknown`: nunca se assume 5m por omissão.
function metricsTtl(acc) {
  if (!acc) return;
  const t5 = Number(acc.cacheTtl5m) || 0;
  const t1 = Number(acc.cacheTtl1h) || 0;
  const create = Number(acc.cacheCreate) || 0;
  if (t5 <= 0 && t1 <= 0 && create <= 0) return; // não houve write: nada a registrar
  metrics.ttl.write5m += t5;
  metrics.ttl.write1h += t1;
  // O que foi escrito mas não veio discriminado por janela.
  const detailed = t5 + t1;
  if (create > detailed) metrics.ttl.writeUnknown += (create - detailed);
  else if (detailed === 0 && create > 0) metrics.ttl.writeUnknown += create;
  _metricsDirty = true;
}

// PURA: extrai os contadores de `usage` de um chunk do stream e MESCLA no
// acumulador. `input_tokens` e os `cache_*` chegam UMA vez (message_start) → a 1ª
// ocorrência vence; `output_tokens` é cumulativo nos deltas → o MAIOR vence. Um
// chunk sem usage devolve o acumulador intacto e nada aqui lança (telemetria
// jamais pode quebrar o pipe do proxy).
//
// POR QUÊ cache_read/cache_creation: são a ÚNICA forma de medir o ganho real de
// cache (token lido do cache custa 0.1x; escrever custa 1.25x/2x). Sem esse
// baseline não há como provar se manter o proxy ligado compensa.
function accumulateUsage(acc, chunk) {
  const a = acc || { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheTtl1h: 0, cacheTtl5m: 0 };
  let s;
  try { s = String(chunk); } catch (e) { void e; return a; }
  const firstOnly = (re, cur) => {
    if (cur) return cur;
    const m = s.match(re);
    return m ? Number(m[1]) : cur;
  };
  a.in          = firstOnly(/"input_tokens"\s*:\s*(\d+)/, a.in);
  a.cacheRead   = firstOnly(/"cache_read_input_tokens"\s*:\s*(\d+)/, a.cacheRead);
  a.cacheCreate = firstOnly(/"cache_creation_input_tokens"\s*:\s*(\d+)/, a.cacheCreate);
  // Janela CONTRATADA no write. Sem estes dois, o ciclo de cache só pode ser
  // adivinhado por relógio; com eles, o TTL real da sessão é observado.
  a.cacheTtl1h  = firstOnly(/"ephemeral_1h_input_tokens"\s*:\s*(\d+)/, a.cacheTtl1h);
  a.cacheTtl5m  = firstOnly(/"ephemeral_5m_input_tokens"\s*:\s*(\d+)/, a.cacheTtl5m);
  let mo;
  const reOut = /"output_tokens"\s*:\s*(\d+)/g;
  while ((mo = reOut.exec(s)) !== null) { const v = Number(mo[1]); if (v > a.out) a.out = v; }
  return a;
}

// Snapshot + economia calculada (em %). economiaPct = 1 - actual/baseline.
// cacheHitPct = fração dos tokens de ENTRADA que veio do cache (0.1x) em vez de
// input cheio (1.0x) — é a métrica que prova (ou desmente) o ganho de cache do
// proxy. Sem tráfego → 0 (nunca divide por zero, nunca inventa número).
function metricsSnapshot() {
  const b = metrics.cost.baselineUnits;
  const a = metrics.cost.actualUnits;
  const economiaPct = b > 0 ? Math.round((1 - a / b) * 1000) / 10 : 0;
  const t = metrics.tokens || {};
  const inTotal = (t.cacheRead || 0) + (t.in || 0);
  const cacheHitPct = inTotal > 0 ? Math.round(((t.cacheRead || 0) / inTotal) * 1000) / 10 : 0;
  const cal = metrics.calibration || {};
  // Fator REAL chars→token medido no tráfego. `null` (não 4) quando ainda não há
  // amostra: fingir um fator seria vender palpite como medição.
  const charsPerToken = (cal.realTokens > 0 && cal.chars > 0)
    ? Math.round((cal.chars / cal.realTokens) * 100) / 100
    : null;
  // "% limpável" com o denominador CERTO (prompt inteiro). `null` quando não há
  // prompt medido — inclusive em estado legado (v2.20.2 gravava só o reconstruído):
  // sem denominador confiável, prefere NÃO responder a responder 594%.
  const ccm = metrics.cacheCycle || {};
  const clearablePct = (ccm.coldBoundaryPromptTokens > 0)
    ? Math.round((ccm.coldBoundaryClearableTokens / ccm.coldBoundaryPromptTokens) * 1000) / 10
    : null;
  // Veredito da JANELA a partir dos writes observados — mesma derivação pura que
  // alimenta `globalTtlMs` em observeCacheCycle, para as duas leituras nunca
  // divergirem por reimplementar a conta em dois lugares.
  const tt = metrics.ttl || {};
  const verdict = cacheCycle.deriveTtlVerdict(tt);
  return Object.assign({}, metrics, {
    economiaPct,
    savedUnits: Math.round((b - a) * 10) / 10,
    cacheHitPct,
    calibration: Object.assign({}, cal, { charsPerToken }),
    cacheCycle: Object.assign({}, ccm, { clearablePct }),
    ttl: Object.assign({}, tt, verdict),
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
function passthrough(rawBody, originalHeaders, res, pathOriginal, config) {
  // DESTINO: a contagem tem que ir ao MESMO lugar que a geração. Apontar isto
  // fixo na Anthropic enquanto `/v1/messages` ia para o endpoint do usuário fez
  // o Claude Code CONTAR a janela num destino e GERAR no outro — as contagens
  // divergem, o indicador de contexto oscila e a compactação dispara na hora
  // errada (bug de campo na v2.21.2). `buildHeaders` também garante que a
  // credencial da ASSINATURA não vá junto para um endpoint de terceiro.
  const upstreamTarget = byok.resolveUpstream(config, { onLimit: false }, UPSTREAM_FALLBACK);
  const headers = byok.buildHeaders(originalHeaders, upstreamTarget);
  headers['content-length'] = Buffer.byteLength(rawBody);

  const options = {
    hostname: upstreamTarget.host,
    port:     upstreamTarget.port,
    path:     pathOriginal || '/v1/messages/count_tokens',
    method:   'POST',
    headers,
  };
  const lib = upstreamTarget.protocol === 'http:' ? http : UPSTREAM_LIB;

  const upstream = lib.request(options, (upRes) => {
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
  // DESTINO desta request. Resolvido ANTES do cooldown de propósito: o cooldown
  // é sobre a janela da ANTHROPIC, e em `byok.mode=always` a Anthropic nem entra
  // no caminho — aplicar o breaker ali desviaria para o plano B uma request que
  // seria atendida normalmente pelo endpoint do usuário.
  const upstreamTarget = byok.resolveUpstream(config, { onLimit: false }, UPSTREAM_FALLBACK);
  if (upstreamTarget.misconfigured) {
    // Fail-loud: ligado sem destino não pode virar "usa o Claude e ninguém vê".
    logger.error('BYOK mal configurado — request NÃO roteada ao endpoint', { causa: upstreamTarget.misconfigured });
  }

  const cd = cooldownCfg(config);
  // Circuit breaker: janela em cooldown? vai DIRETO ao plano B (sem martelar a Anthropic).
  if (!upstreamTarget.isByok && cd.enabled && _cooldownUntil) {
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
  const headers = byok.buildHeaders(originalHeaders, upstreamTarget);
  headers['content-length'] = Buffer.byteLength(bodyStr);

  const options = {
    hostname: upstreamTarget.host,
    port:     upstreamTarget.port,
    path:     (route && route.path) || '/v1/messages',
    method:   'POST',
    headers,
  };
  const lib = upstreamTarget.protocol === 'http:' ? http : UPSTREAM_LIB;
  if (upstreamTarget.isByok) {
    logger.info('BYOK — request servida pelo endpoint do usuário', {
      host: upstreamTarget.host, port: upstreamTarget.port, mode: upstreamTarget.mode,
    });
  }

  const triggers = (config && config.fallback && Array.isArray(config.fallback.triggerStatuses))
    ? config.fallback.triggerStatuses
    : [429];

  const upstream = lib.request(options, (upRes) => {
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
      let usage = null;
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
          usage = accumulateUsage(usage, s);
        } catch (_) { void _; /* telemetria/scan nunca quebram o pipe */ }
      });
      upRes.on('end', () => {
        if (usage && (usage.in || usage.out || usage.cacheRead)) metricsTokens(usage);
        // Ciclo de cache: mede o desfecho real desta resposta (quente x rebuild)
        // e a fronteira que ela atravessou. Best-effort — telemetria jamais pode
        // derrubar o proxy, e por isso a falha é LOGADA, não engolida em silêncio.
        try {
          if (route && route.sessionKey) {
            metricsCacheCycle(observeCacheCycle(
              route.sessionKey, usage, Date.now(), config, { body: reqBody },
            ));
          }
          // Calibração in-band: o corpo que medimos em chars contra o input REAL
          // que a Anthropic acabou de reportar. De graça, em tráfego real, sem
          // credencial e sem chamada extra — o fator chars→token sai do próprio uso.
          metricsCalibration(cacheCycle.calibrationSample(
            cacheCycle.estimateTotalChars(reqBody), usage,
          ));
          // Janela contratada declarada pela própria resposta — para o detector
          // parar de assumir 5min quando a Anthropic pode ter contratado 1h.
          metricsTtl(usage);
        } catch (e) { logger.debug('observeCacheCycle falhou (ignorado)', { err: e.message }); }
      });
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

// ── Catálogo dinâmico: aquecimento (fire-and-forget) ──────────────────────────

// Monta os headers de auth p/ chamar /v1/models com a credencial de ENTRADA
// (escopo da assinatura). Sem x-api-key NEM authorization → não dá p/ escopar.
function catalogAuthHeaders(h) {
  const out = { 'anthropic-version': h['anthropic-version'] || '2023-06-01' };
  if (h['x-api-key'])      out['x-api-key']      = h['x-api-key'];
  if (h['authorization'])  out['authorization']  = h['authorization'];
  if (h['anthropic-beta']) out['anthropic-beta'] = h['anthropic-beta'];
  return out;
}

// Aquece/atualiza o catálogo com a credencial desta request. Fire-and-forget: a
// request atual NÃO espera — usa o snapshot já aquecido (ou o estático); as
// próximas pegam o catálogo fresco. Guard de TTL/inflight/backoff vive no catalog.
function maybeWarmCatalog(originalHeaders, config) {
  const cc = catalogConfig(config);
  if (!cc.enabled) return;
  const h = originalHeaders || {};
  // O catálogo tem que descrever o MESMO destino que atende a geração: com BYOK
  // ligado, listar os modelos da Anthropic enquanto o endpoint do usuário serve
  // outros é a mesma inconsistência do count_tokens. O contrato do endpoint
  // expõe /v1/models com os mesmos headers.
  const alvo = byok.resolveUpstream(config, { onLimit: false }, UPSTREAM_FALLBACK);
  // Sem BYOK, o aquecimento depende da credencial do cliente (é ela que autoriza
  // a chamada). Com BYOK, quem autoriza são os headers configurados.
  if (!alvo.isByok && !h['x-api-key'] && !h['authorization']) return;
  catalog.maybeRefresh({
    host:           alvo.host,
    port:           alvo.port,
    protocol:       alvo.protocol,
    headers:        alvo.isByok ? byok.buildHeaders(h, alvo) : catalogAuthHeaders(h),
    ttlMs:          cc.ttlMs,
    errorBackoffMs: cc.errorBackoffMs,
    onRefresh: (snap) => logger.info('Catálogo de modelos atualizado via /v1/models', {
      modelos:  snap.count,
      familias: Object.fromEntries(Object.entries(snap.byFamily).map(([f, e]) => [f, e.model])),
    }),
    onError: (err) => logger.warn('Catálogo: /v1/models indisponível — usando mapa estático (fallback)', { err: err.message }),
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

// DNS-rebinding + drive-by CSRF guard: the router binds 127.0.0.1, but a malicious
// page can still POST to http://localhost:<port>. We require BOTH a loopback Host
// AND (if the browser sent one) a loopback Origin — a cross-site page sends its own
// Origin → blocked; a curl/local same-origin call omits Origin → allowed. Applied to
// state-changing routes (/metrics/reset).
function isLoopbackHost(req) {
  const h = (req && req.headers) || {};
  const hostname = String(h.host || '').replace(/:\d+$/, '');
  const loopback = (n) => n === '127.0.0.1' || n === 'localhost' || n === '[::1]' || n === '::1';
  if (!loopback(hostname)) return false;
  if (h.origin) {
    try {
      if (!loopback(new URL(h.origin).hostname)) return false;
    } catch (err) { void err; return false; } // unparseable Origin → reject
  }
  return true;
}

async function createServer(config, mode, routerToken) {
  const server = http.createServer(async (req, res) => {
    // Health check — CONTINUA 200 p/ liveness (nunca quebra a sonda), mas agora
    // PROVA IDENTIDADE: quem ecoar o x-router-token correto recebe
    // authenticated:true; qualquer outro recebe false. É o que o cliente (ensure)
    // usa p/ confiar na porta ANTES de ativar o roteamento (verify-before-activate).
    // O token em si nunca é ecoado. routerToken ausente/'' → authenticated sempre
    // false (segredo vazio não autentica ninguém).
    if (req.method === 'GET' && req.url === '/health') {
      const authenticated = routerTokenMatches(req.headers['x-router-token'], routerToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, mode, authenticated }));
      return;
    }

    // Telemetria: snapshot dos contadores + economia estimada (lido pelo dashboard).
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metricsSnapshot()));
      return;
    }
    if (req.method === 'POST' && req.url === '/metrics/reset') {
      if (!isLoopbackHost(req)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: non-loopback Host' }));
        return;
      }
      resetMetrics();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Catálogo dinâmico (observabilidade): snapshot atual + idade (lido pelo dashboard).
    if (req.method === 'GET' && req.url === '/catalog') {
      const snap = catalog.getSnapshot();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        enabled:  catalogEnabled(config),
        warmed:   !!snap,
        ageMs:    snap ? snap.ageMs : null,
        count:    snap ? snap.count : 0,
        byFamily: snap ? snap.byFamily : {},
      }));
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
      // Aquece o catálogo dinâmico com a credencial desta request (fire-and-forget).
      // Roda ANTES do count_tokens p/ aproveitar a rajada de boot como gatilho.
      maybeWarmCatalog(req.headers, config);
      // count_tokens é o endpoint GRÁTIS de contagem (beta token-counting): repassa
      // verbatim preservando o path. Classificar/reescrever pra /v1/messages
      // converteria contagem grátis em geração paga e saturaria o RPM no boot.
      if (req.url.includes('/count_tokens')) {
        logger.debug('count_tokens — passthrough verbatim (sem rota)', { path: req.url, bytes: Buffer.byteLength(rawBody) });
        passthrough(rawBody, req.headers, res, req.url, config);
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

      // MODO 'fallback-only': PASSTHROUGH cache-safe. Encaminha o body INALTERADO ao
      // upstream (NÃO classifica, NÃO reescreve model/effort) — o prefixo do prompt
      // cache fica byte-idêntico a uma chamada direta à Anthropic. A única intervenção
      // é no 429: forwardRequest já embute a detecção de limite + cooldown + plano B,
      // que reage ao STATUS do upstream (independe de classificação). Reusamos a MESMA
      // função (sem duplicar a lógica de fallback). origTier=finalTier=modelo do body
      // → telemetria honesta (baseline == actual, zero "economia" fabricada).
      if (mode === 'fallback-only') {
        const t = modelTier(body.model || 'unknown');
        logger.debug('fallback-only — passthrough sem classificar', { model: body.model || 'unknown', bytes: Buffer.byteLength(rawBody) });
        forwardRequest(body, req.headers, res, config, { origTier: t, finalTier: t, path: req.url, sessionKey: computeSessionKey(body) });
        return;
      }

      // MODO 'sticky-tier': roteador CACHE-SAFE. O tier é escolhido UMA vez por
      // sessão (turno 0) e o modelo é FIXADO pelo resto da sessão — modelo constante
      // preserva o prompt cache quente (nada de flip turno-a-turno). Reusa o
      // classificador + o teto. O 429→plano B vive DENTRO do forwardRequest (reage ao
      // STATUS do upstream), então é reusado automaticamente — NÃO duplicamos nada.
      if (mode === 'sticky-tier') {
        const originalModel = body.model || 'unknown';
        const origTier = modelTier(originalModel);
        let dec;
        try {
          dec = await decideStickyModel(body, config, {});
        } catch (e) {
          // Falha inesperada da decisão → passthrough cache-safe (modelo do usuário).
          logger.warn('Sticky decide error — passthrough do modelo original', { err: e.message });
          forwardRequest(body, req.headers, res, config, { origTier, finalTier: origTier, path: req.url, sessionKey: computeSessionKey(body) });
          return;
        }
        body.model = dec.model;
        // Reconcilia o `effort` só quando o modelo MUDA (mesma regra do per-turn).
        let effortAdj = { action: 'none' };
        if (dec.model !== originalModel) effortAdj = reconcileEffort(body, dec.model, config);
        logger.info(dec.created ? 'Sticky — tier FIXADO (turno 0)' : 'Sticky — pin REUSADO (cache-safe)', {
          tier:     dec.tier,
          original: originalModel,
          novo:     dec.model,
          teto:     dec.blocked || undefined,
          key:      dec.key.slice(0, 8),
          effort:   effortAdj.action !== 'none' ? { acao: effortAdj.action, de: effortAdj.from, para: effortAdj.to } : undefined,
          nMsg:     Array.isArray(body.messages) ? body.messages.length : 0,
          sysLen:   systemLen(body.system),
          bytes:    Buffer.byteLength(rawBody),
          stream:   body.stream || undefined,
        });
        // Telemetria honesta: classified=true (houve decisão de tier na sessão),
        // blocked = teto barrou um upgrade do tier fixado sobre o modelo atual.
        try { metricsRoute(origTier, dec.tier, true, dec.blocked); }
        catch (e) { logger.debug('metricsRoute falhou (ignorado)', { err: e.message }); }
        forwardRequest(body, req.headers, res, config, { origTier, finalTier: modelTier(body.model), path: req.url, sessionKey: dec.key });
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

      forwardRequest(body, req.headers, res, config, { origTier, finalTier, path: req.url, sessionKey: computeSessionKey(body) });
    });
  });

  return server;
}

// ── State file ────────────────────────────────────────────────────────────────

// O `mode` é o modo em que o server REALMENTE subiu (resolveMode no boot). Persisti-
// lo aqui deixa o dashboard ler o modo rodando mesmo quando o /health estiver fora.
// O `configFingerprint` é o hash da config EFETIVA (shipped ⊕ user) que este daemon
// carregou no boot — é ele que permite ao ensure saber que o daemon detached está
// servindo uma config ANTIGA quando o user-config muda no disco (o bug do
// "Salvar & aplicar" que nunca aplicava). Persistido junto do state para o ensure
// comparar sem abrir um canal extra.
function writeState(port, mode, fingerprint) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    pid:       process.pid,
    port,
    mode,
    configFingerprint: fingerprint,
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

  // MODO (fonte única: scripts/lib/router-mode.js). 'off' = totalmente inerte → sai.
  // 'sticky-tier' = roteador cache-safe (classifica 1x/sessão e fixa o modelo; 429→
  // plano B). 'routing' = cost-routing per-turn DEPRECADO (classifica+reescreve a cada
  // request — quebra o prompt cache; inclui 429→plano B). 'fallback-only' = passthrough
  // cache-safe (NÃO classifica/reescreve) + 429→plano B. O ensure pode passar
  // BOSS_ROUTER_MODE, mas a config local é a fonte de verdade (recomputamos aqui).
  const mode = resolveMode(config);
  if (mode === 'off') {
    logger.warn('Router e fallback desabilitados (mode: off). Saindo.');
    process.exit(0);
  }
  logger.info('Modo do proxy resolvido', { mode, envHint: process.env.BOSS_ROUTER_MODE || undefined });

  // DEPRECAÇÃO: o per-turn routing reescreve o modelo a CADA request → flipa o modelo
  // turno-a-turno → QUEBRA o prompt cache (cache é POR MODELO). Continua funcionando,
  // mas avisamos p/ migrar ao sticky-tier (cache-safe: fixa o modelo por sessão).
  if (mode === 'routing') {
    logger.warn('Per-turn routing (enabled) é DEPRECADO: rotear por-request quebra o prompt cache da Anthropic. Prefira o roteador cache-safe {sticky:{enabled:true}} (/dashboard → Sticky Router).');
  }

  // O classificador local (MiniLM) é DESACOPLADO do boot: ele carrega DEPOIS que o
  // servidor está pronto (ver o callback de server.listen abaixo), fire-and-forget.
  // Assim um embedder lento/quebrado (ex.: sharp win32-x64 ausente) nunca atrasa a
  // escrita do state file — era isso que fazia o ensure dar "timeout aguardando state
  // file → roteamento desabilitado" e nunca gravar os overrides de token.

  // Token de identidade da porta fixa (verify-before-trust). Criado 1x por
  // instalação (reusado entre reinícios), lido pelo /health p/ provar que quem
  // ocupa a porta é o NOSSO roteador — o ensure só ativa o roteamento (e deixa o
  // Claude Code mandar a credencial real) se o /health provar identidade. Não
  // logamos o token; só sinalizamos que a identidade está armada.
  const routerToken = ensureRouterToken();
  logger.info('Identidade da porta fixa armada (router.token)', { file: 'router.token' });

  const server = await createServer(config, mode, routerToken);

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
    writeState(FIXED_PORT, mode, configFingerprint(config));
    process.stdout.write(`ROUTER_PORT=${FIXED_PORT}\n`);
    // DESACOPLADO: só AGORA (porta ligada + state file escrito → o ensure já enxerga o
    // router pronto) carregamos o classificador, fire-and-forget. Nos modos que
    // classificam; em 'fallback-only' é passthrough puro. Se o embedder falhar
    // (sharp/onnx ausente), o .catch isola: classifyLocal devolve null → passthrough e
    // o routing/os overrides seguem funcionando — o boot não trava mais no embedder.
    if (mode === 'routing' || mode === 'sticky-tier') {
      initClassifier(config).catch((e) =>
        logger.warn('Classificador local não inicializado — NIM ou passthrough (routing segue vivo)', { err: e && e.message }));
    } else {
      logger.info('fallback-only: classificador/anchors NÃO inicializados (passthrough cache-safe).');
    }
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
    resolveMode,
    isLoopbackHost,
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
    computeSessionKey,
    decideStickyModel,
    stickyTtlMs,
    reconcileEffort,
    effortSupportFor,
    effortConfig,
    catalogConfig,
    catalogEnabled,
    catalog,
    metricsRoute,
    metricsOutcome,
    metricsTokens,
    accumulateUsage,
    // Ciclo de cache (observação): fiado no tee do stream; exportados p/ os
    // testes provarem a medição sem tocar o Map singleton (deps.states).
    observeCacheCycle,
    metricsCacheCycle,
    metricsCalibration,
    metricsTtl,
    // BYOK: exportado p/ o teste ponta-a-ponta que prova que a credencial da
    // ASSINATURA não chega ao endpoint de terceiro (o risco central do recurso).
    forwardRequest,
    handleLimitExceeded,
    passthrough,
    metricsSnapshot,
    resetMetrics,
    newMetrics,
    // FIX 1 (identidade da porta fixa) + FIX 2 (classificação opt-in): exportados
    // p/ os testes herméticos (server /health autenticado + dispatcher de classify).
    createServer,
    initClassifier,
    ensureRouterToken,
    readRouterToken,
    routerTokenMatches,
    classify,
  };
}
