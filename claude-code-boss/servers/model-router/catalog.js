'use strict';
/**
 * model-router/catalog.js — catálogo DINÂMICO de modelos por assinatura.
 *
 * Em vez de hardcodar "sonnet → claude-sonnet-4-6", consulta o endpoint oficial
 * `GET /v1/models` da Anthropic (escopado pela credencial que o Claude Code já
 * manda — logo, reflete a ASSINATURA do usuário: Pro/Max/API key) e dele extrai,
 * por família (haiku/sonnet/opus):
 *   • o modelo MAIS NOVO (maior `created_at`) — pega lançamentos sozinho;
 *   • os níveis de `effort` suportados (`capabilities.effort`) — destrava o
 *     reconcile de effort sem mapa estático defasado.
 *
 * Desenho à prova de hot path:
 *   • Cache em memória com TTL. O refresh é FIRE-AND-FORGET (maybeRefresh não
 *     retorna promise; a request em curso NUNCA espera a rede).
 *   • Falha (offline, 401/403 de token OAuth sem escopo de listagem, timeout) →
 *     o snapshot fica null/anterior e o chamador cai no mapa ESTÁTICO do config.
 *     Backoff curto evita martelar o /v1/models quando dá erro.
 *   • Singleton de módulo: index.js e os testes compartilham a MESMA instância
 *     (Node cacheia require por path), então o snapshot aquecido é visível a todos.
 *
 * CommonJS (igual ao resto do model-router).
 */

const http  = require('http');
const https = require('https');

// Ordem canônica de capacidade do effort (asc). Espelha routing.effort.order.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// Famílias conhecidas pelo classificador (haiku < sonnet < opus). Modelos de uma
// família NÃO listada (ex.: um tier novo no futuro) são ignorados aqui — não
// quebram nada; o roteamento cai no estático. Extender taxonomia = mudança maior.
function familyOf(modelId) {
  const s = (modelId || '').toLowerCase();
  if (s.includes('haiku'))  return 'haiku';
  if (s.includes('opus'))   return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  return null;
}

// Extrai os níveis de effort suportados de um ModelInfo do /v1/models.
// `capabilities.effort` = { supported, low:{supported}, medium:{...}, ... }.
// Retorna array em ordem canônica (ex.: ['low','medium','high','max']) ou [] se o
// modelo não suporta effort (ex.: haiku). [] é uma resposta VÁLIDA (≠ "desconheço").
function effortLevelsFrom(model) {
  const e = model && model.capabilities && model.capabilities.effort;
  if (!e || !e.supported) return [];
  return EFFORT_ORDER.filter((lvl) => e[lvl] && e[lvl].supported);
}

// Constrói o snapshot a partir do array bruto de ModelInfo (campo `data` do
// /v1/models). Agrupa por família e elege o mais novo por `created_at`.
// Retorna { models, support, byFamily, builtAt, count }:
//   • models[id]   = ModelInfo cru (para inspeção/observabilidade);
//   • support[id]  = níveis de effort suportados (array; [] = sem effort);
//   • byFamily[fam]= { model, effort, display_name, createdMs } do mais novo.
function buildCatalog(rawModels) {
  const models   = {};
  const support  = {};
  const byFamily = {};
  for (const m of Array.isArray(rawModels) ? rawModels : []) {
    if (!m || typeof m.id !== 'string') continue;
    models[m.id]  = m;
    const levels  = effortLevelsFrom(m);
    support[m.id] = levels;
    const fam = familyOf(m.id);
    if (!fam) continue;
    const createdMs = Date.parse(m.created_at || '') || 0;
    const cur = byFamily[fam];
    if (!cur || createdMs > cur.createdMs) {
      byFamily[fam] = {
        model:        m.id,
        effort:       levels,
        display_name: m.display_name || m.id,
        createdMs,
      };
    }
  }
  return { models, support, byFamily, builtAt: Date.now(), count: Object.keys(models).length };
}

// Busca o /v1/models (paginado via cursor after_id, seguindo has_more/last_id).
// Usa a credencial de ENTRADA (headers) — o resultado já vem escopado pela
// assinatura. Callback(err, models[]). Status != 200 (incl. 401/403) → err, e o
// chamador faz fallback pro estático. Timeout curto pra não segurar nada.
function fetchModels(opts, cb) {
  const {
    host, port, protocol = 'https:', headers = {},
    limit = 1000, timeoutMs = 4000, maxPages = 20,
  } = opts || {};
  const lib = protocol === 'http:' ? http : https;
  const all = [];
  let pages = 0;

  const requestPage = (afterId) => {
    pages += 1;
    let qs = `limit=${encodeURIComponent(limit)}`;
    if (afterId) qs += `&after_id=${encodeURIComponent(afterId)}`;
    const options = {
      hostname: host,
      port,
      path:     `/v1/models?${qs}`,
      method:   'GET',
      headers,
      timeout:  timeoutMs,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          cb(new Error(`/v1/models HTTP ${res.statusCode}`));
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          cb(new Error(`/v1/models resposta ilegível: ${e.message}`));
          return;
        }
        const page = Array.isArray(json.data) ? json.data : [];
        for (const m of page) all.push(m);
        if (json.has_more && json.last_id && pages < maxPages) {
          requestPage(json.last_id);
        } else {
          cb(null, all);
        }
      });
    });
    req.on('error', (e) => cb(e));
    req.on('timeout', () => { req.destroy(new Error('/v1/models timeout')); });
    req.end();
  };

  requestPage(null);
}

// ── Singleton de cache ────────────────────────────────────────────────────────

let _snapshot    = null; // último catálogo construído (ou null = nunca aquecido)
let _lastFetchAt = 0;    // epoch ms do último fetch BEM-SUCEDIDO
let _lastErrorAt = 0;    // epoch ms do último erro (p/ backoff)
let _inflight    = false; // há um refresh em curso? (evita rajada concorrente)

// Dispara um refresh SE o cache estiver vazio/stale, sem outro em curso e fora do
// backoff de erro. Fire-and-forget: não retorna nada útil ao hot path. As callbacks
// onRefresh/onError são só p/ log do chamador. Idempotente sob concorrência.
function maybeRefresh(opts) {
  const o = opts || {};
  const ttlMs          = Number.isFinite(o.ttlMs) ? o.ttlMs : 3600000;       // 1h
  const errorBackoffMs = Number.isFinite(o.errorBackoffMs) ? o.errorBackoffMs : 300000; // 5min
  const now = Date.now();

  if (_inflight) return;
  if (_snapshot && (now - _lastFetchAt) < ttlMs) return;             // ainda fresco
  if (_lastErrorAt && (now - _lastErrorAt) < errorBackoffMs) return; // em backoff

  _inflight = true;
  fetchModels(o, (err, models) => {
    _inflight = false;
    if (err) {
      _lastErrorAt = Date.now();
      if (typeof o.onError === 'function') o.onError(err);
      return;
    }
    _snapshot    = buildCatalog(models);
    _lastFetchAt = Date.now();
    _lastErrorAt = 0;
    if (typeof o.onRefresh === 'function') o.onRefresh(_snapshot);
  });
}

// Snapshot atual (ou null). Inclui idade p/ observabilidade.
function getSnapshot() {
  if (!_snapshot) return null;
  return { ..._snapshot, ageMs: Date.now() - _lastFetchAt };
}

// Família → id do modelo MAIS NOVO no catálogo. null se indisponível (sem aquecer
// ou família ausente) → chamador usa o mapa estático.
function modelForFamily(family) {
  if (!_snapshot) return null;
  const e = _snapshot.byFamily[family];
  return e ? e.model : null;
}

// Níveis de effort de um modelo (match exato; senão por PREFIXO, p/ cobrir sufixo
// de data tipo "claude-sonnet-4-6-20251101"). Retorna array (possivelmente []) ou
// null = catálogo não conhece este modelo (chamador usa o estático).
function effortForModel(modelId) {
  if (!_snapshot || !modelId) return null;
  if (Object.prototype.hasOwnProperty.call(_snapshot.support, modelId)) {
    return _snapshot.support[modelId];
  }
  const key = Object.keys(_snapshot.support).find((k) => modelId.startsWith(k));
  return key ? _snapshot.support[key] : null;
}

// ── Hooks de teste (determinísticos, sem rede) ────────────────────────────────

function _setSnapshot(rawModels) {
  _snapshot    = buildCatalog(rawModels);
  _lastFetchAt = Date.now();
  _lastErrorAt = 0;
  _inflight    = false;
  return _snapshot;
}

function _reset() {
  _snapshot    = null;
  _lastFetchAt = 0;
  _lastErrorAt = 0;
  _inflight    = false;
}

module.exports = {
  EFFORT_ORDER,
  familyOf,
  effortLevelsFrom,
  buildCatalog,
  fetchModels,
  maybeRefresh,
  getSnapshot,
  modelForFamily,
  effortForModel,
  _setSnapshot,
  _reset,
};
