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
// chamador faz fallback pro estático. Timeout curto pra não segurar nada — mesmo
// contra um gateway alternativo/BYOK (maybeWarmCatalog em index.js resolve pro
// MESMO destino do passthrough): é fire-and-forget, a request em curso NUNCA
// espera, e falha aqui só troca o catálogo dinâmico pelo mapa estático (sem
// erro visível). 6s (vs. os 4s originais) só absorve o hop de rede extra de um
// gateway antes do backoff — não é o teto de geração (BYOK_UPSTREAM_TIMEOUT_MS),
// que não se aplica aqui por não haver reasoning nessa chamada (é só listagem).
function fetchModels(opts, cb) {
  const {
    host, port, protocol = 'https:', headers = {},
    url, limit = 1000, timeoutMs = 6000, maxPages = 20,
  } = opts || {};
  let endpoint;
  try {
    endpoint = url
      ? new URL(url)
      : new URL(`${protocol}//${host}${port ? `:${port}` : ''}/v1/models`);
  } catch (err) {
    cb(new Error(`URL de catálogo inválida: ${err.message}`));
    return;
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    cb(new Error(`URL de catálogo inválida: protocolo ${endpoint.protocol} não suportado`));
    return;
  }
  const lib = endpoint.protocol === 'http:' ? http : https;
  const all = [];
  let pages = 0;

  const requestPage = (afterId) => {
    pages += 1;
    const pageUrl = new URL(endpoint.toString());
    pageUrl.searchParams.set('limit', String(limit));
    if (afterId) pageUrl.searchParams.set('after_id', afterId);
    else pageUrl.searchParams.delete('after_id');
    const options = {
      hostname: pageUrl.hostname,
      port:     pageUrl.port || (pageUrl.protocol === 'https:' ? 443 : 80),
      path:     `${pageUrl.pathname}${pageUrl.search}`,
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

// ── Cache por destino/tenant/credencial ──────────────────────────────────────

const DEFAULT_SCOPE = '_';
const MAX_SCOPES = 64;
const _states = new Map();

function normalizeScope(scope) {
  return (typeof scope === 'string' && scope) ? scope : DEFAULT_SCOPE;
}

function stateFor(scope, create) {
  const key = normalizeScope(scope);
  let state = _states.get(key);
  if (!state && create) {
    if (_states.size >= MAX_SCOPES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [candidate, value] of _states) {
        if (!value.inflight && value.touchedAt < oldestAt) {
          oldestKey = candidate;
          oldestAt = value.touchedAt;
        }
      }
      if (oldestKey !== null) _states.delete(oldestKey);
    }
    state = { snapshot: null, lastFetchAt: 0, lastErrorAt: 0, inflight: false, touchedAt: Date.now() };
    _states.set(key, state);
  }
  if (state) state.touchedAt = Date.now();
  return state || null;
}

// Dispara um refresh SE o cache estiver vazio/stale, sem outro em curso e fora do
// backoff de erro. Fire-and-forget: não retorna nada útil ao hot path. As callbacks
// onRefresh/onError são só p/ log do chamador. Idempotente sob concorrência.
function maybeRefresh(opts) {
  const o = opts || {};
  const ttlMs          = Number.isFinite(o.ttlMs) ? o.ttlMs : 3600000;       // 1h
  const errorBackoffMs = Number.isFinite(o.errorBackoffMs) ? o.errorBackoffMs : 300000; // 5min
  const now = Date.now();
  const state = stateFor(o.scope, true);

  if (state.inflight) return;
  if (state.snapshot && (now - state.lastFetchAt) < ttlMs) return;             // ainda fresco
  if (state.lastErrorAt && (now - state.lastErrorAt) < errorBackoffMs) return; // em backoff

  state.inflight = true;
  fetchModels(o, (err, models) => {
    state.inflight = false;
    state.touchedAt = Date.now();
    if (err) {
      state.lastErrorAt = Date.now();
      if (typeof o.onError === 'function') o.onError(err);
      return;
    }
    state.snapshot = buildCatalog(models);
    state.lastFetchAt = Date.now();
    state.lastErrorAt = 0;
    if (typeof o.onRefresh === 'function') o.onRefresh(state.snapshot);
  });
}

// Snapshot atual (ou null). Inclui idade p/ observabilidade.
function getSnapshot(scope) {
  const state = stateFor(scope, false);
  if (!state || !state.snapshot) return null;
  return { ...state.snapshot, ageMs: Date.now() - state.lastFetchAt };
}

// Família → id do modelo MAIS NOVO no catálogo. null se indisponível (sem aquecer
// ou família ausente) → chamador usa o mapa estático.
function modelForFamily(family, scope) {
  const state = stateFor(scope, false);
  if (!state || !state.snapshot) return null;
  const e = state.snapshot.byFamily[family];
  return e ? e.model : null;
}

// Níveis de effort de um modelo (match exato; senão por PREFIXO, p/ cobrir sufixo
// de data tipo "claude-sonnet-4-6-20251101"). Retorna array (possivelmente []) ou
// null = catálogo não conhece este modelo (chamador usa o estático).
function effortForModel(modelId, scope) {
  const state = stateFor(scope, false);
  if (!state || !state.snapshot || !modelId) return null;
  if (Object.prototype.hasOwnProperty.call(state.snapshot.support, modelId)) {
    return state.snapshot.support[modelId];
  }
  const key = Object.keys(state.snapshot.support).find((k) => modelId.startsWith(k));
  return key ? state.snapshot.support[key] : null;
}

// ── Alias de id p/ o picker `/model` (só usado sob BYOK) ──────────────────────
// O picker `/model` do Claude Code filtra fora qualquer entrada cujo `id` não
// contenha "claude"/"anthropic" — um modelo BYOK custom (ex.: "gpt-4",
// "llama-3") nunca aparece na lista. Disfarçamos o id com um prefixo
// configurável (default "anthropic-") só pra passar no filtro; o nome real
// vai no `display_name`, e o prefixo é removido de volta antes de rotear
// (ver unaliasModelId) — o resto do pipeline nunca vê o id disfarçado.
const DEFAULT_ALIAS_PREFIX = 'anthropic-';
const INTERNAL_ALIAS_ID = 'ccb-alias-';

// Id que já contém "claude"/"anthropic" passa no filtro do picker sozinho —
// prefixar de novo duplicaria (relevante num catálogo misto BYOK+Anthropic).
function looksAnthropic(id) {
  const s = (id || '').toLowerCase();
  return s.includes('claude') || s.includes('anthropic');
}

function aliasModelId(id, prefix) {
  if (typeof id !== 'string' || !id) return id;
  const p = prefix || DEFAULT_ALIAS_PREFIX;
  if (id.startsWith(`${p}${INTERNAL_ALIAS_ID}`) || looksAnthropic(id)) return id;
  return `${p}${INTERNAL_ALIAS_ID}${id}`;
}

// Inverso de aliasModelId — usado ao ler `body.model` de uma request de volta
// do cliente, para que classificação/roteamento/upstream vejam o id REAL.
// O sistema remove o prefixo do usuário + o identificador interno.
function unaliasModelId(id, prefix) {
  if (typeof id !== 'string' || !id) return id;
  const p = prefix || DEFAULT_ALIAS_PREFIX;
  const fullPrefix = `${p}${INTERNAL_ALIAS_ID}`;
  if (id.startsWith(fullPrefix)) return id.slice(fullPrefix.length);
  return id;
}

// Snapshot.models travestido pro picker: ids que passam no filtro, com o nome
// real preservado em display_name. Entradas já "anthropic-like" saem intactas.
function aliasedModelList(snapshot, prefix) {
  if (!snapshot || !snapshot.models) return [];
  return Object.values(snapshot.models).map((m) => {
    const realId = m.id;
    const id = aliasModelId(realId, prefix);
    if (id === realId) return m;
    return Object.assign({}, m, { id, display_name: m.display_name || realId });
  });
}

// ── Hooks de teste (determinísticos, sem rede) ────────────────────────────────

function _setSnapshot(rawModels, scope) {
  const state = stateFor(scope, true);
  state.snapshot = buildCatalog(rawModels);
  state.lastFetchAt = Date.now();
  state.lastErrorAt = 0;
  state.inflight = false;
  return state.snapshot;
}

const setSnapshot = _setSnapshot;

function _reset(scope) {
  if (arguments.length === 0) {
    _states.clear();
    return;
  }
  _states.delete(normalizeScope(scope));
}

module.exports = {
  EFFORT_ORDER,
  DEFAULT_ALIAS_PREFIX,
  familyOf,
  effortLevelsFrom,
  buildCatalog,
  fetchModels,
  maybeRefresh,
  getSnapshot,
  modelForFamily,
  effortForModel,
  aliasModelId,
  unaliasModelId,
  aliasedModelList,
  setSnapshot,
  _setSnapshot,
  _reset,
};
