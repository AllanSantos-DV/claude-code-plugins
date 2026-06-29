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

async function classifyLocal(prompt, anchors) {
  if (!_embedder) return null;
  const vec = await _embedder.embed(prompt);
  if (!vec) return null;
  let best = null, bestScore = -Infinity;
  for (const [tier, anchor] of Object.entries(anchors)) {
    const score = cosineSim(vec, anchor);
    if (score > bestScore) { bestScore = score; best = tier; }
  }
  logger.debug('Classificação local', { tier: best, score: bestScore.toFixed(3) });
  return best;
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
  if (_anchors) return await classifyLocal(prompt, _anchors);
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

const ANTHROPIC_API_HOST = 'api.anthropic.com';

function forwardRequest(reqBody, originalHeaders, res) {
  const bodyStr = JSON.stringify(reqBody);
  const headers = {
    'content-type':      'application/json',
    'content-length':    Buffer.byteLength(bodyStr),
    'anthropic-version': originalHeaders['anthropic-version'] || '2023-06-01',
  };
  if (originalHeaders['x-api-key'])     headers['x-api-key']     = originalHeaders['x-api-key'];
  if (originalHeaders['authorization']) headers['authorization'] = originalHeaders['authorization'];
  if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta'];

  const options = {
    hostname: ANTHROPIC_API_HOST,
    path:     '/v1/messages',
    method:   'POST',
    headers,
  };

  const upstream = https.request(options, (upRes) => {
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

      forwardRequest(body, req.headers, res);
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

  // Tenta porta configurada; se ocupada, tenta até +10
  const basePort = config.port || 13456;
  let tried = 0;
  const tryBind = (port) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      logger.info(`=== Servidor pronto em http://127.0.0.1:${actual} ===`, { port: actual });
      writeState(actual);
      if (actual !== basePort) {
        logger.warn(`ATENÇÃO: servidor na porta ${actual} mas config tem ${basePort}. Atualize ANTHROPIC_BASE_URL no sistema para http://127.0.0.1:${actual}`);
      }
      process.stdout.write(`ROUTER_PORT=${actual}\n`);
    });
  };

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tried < 10) {
      tried++;
      logger.warn(`Porta ${basePort + tried - 1} ocupada, tentando ${basePort + tried}...`);
      server.removeAllListeners('error');
      server.on('error', (e2) => {
        logger.error('Server error fatal', { err: e2.message });
        process.exit(1);
      });
      tryBind(basePort + tried);
      return;
    }
    logger.error('Server error fatal', { err: e.message });
    process.exit(1);
  });

  tryBind(basePort);

  server.on('error', (e) => {
    logger.error('Server error fatal', { err: e.message });
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => { logger.info('SIGTERM recebido, encerrando'); server.close(() => process.exit(0)); });
  process.on('SIGINT',  () => { logger.info('SIGINT recebido, encerrando');  server.close(() => process.exit(0)); });
}

main().catch(e => {
  logger.error('Fatal startup error', { err: e.message, stack: e.stack });
  process.exit(1);
});
