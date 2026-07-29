'use strict';

// Núcleo PURO da consciência de ciclo de cache do proxy.
//
// Por que existe: o sticky de hoje fixa o tier por um TTL FIXO (6h) e é CEGO ao
// estado real do prompt cache. Este módulo lê o `usage` que a própria resposta
// devolve e reconstrói o ciclo: o prefixo está QUENTE (veio do cache) ou o
// contrato expirou e a próxima request vai pagar o rebuild?
//
// A FRONTEIRA FRIA é o instante em que a próxima request paga o rebuild do
// prefixo de qualquer jeito. Só ali trocar de modelo — ou limpar contexto — é
// efetivamente grátis. Fora dela, mexer no prefixo é destruir cache já pago.
//
// DUPLO-SINAL, de propósito: o relógio (gap > ttl) sozinho é frágil, porque a
// leitura de `usage` vem de regex sobre chunks crus de stream e um campo JSON
// pode ser partido entre dois chunks. Então a fronteira também dispara por um
// MISS observado na resposta anterior (creation>0, read=0) — um fato medido.
// Se um sinal falhar, o outro ainda é conservadoramente correto.
//
// Sem estado global, sem I/O, sem Date.now() implícito: `now` é sempre injetado.

const DEFAULT_COLD_BOUNDARY_MS = 300000; // 5min — a janela curta da Anthropic
const TTL_1H = 3600000;
const TTL_5M = 300000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Janela mínima sem tráfego a partir da qual assumimos o prefixo frio, quando
// não há TTL observado. Configurável p/ ajuste sem deploy (sticky.coldBoundaryMs).
function coldBoundaryMs(config) {
  const t = config && config.sticky && Number(config.sticky.coldBoundaryMs);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_COLD_BOUNDARY_MS;
}

// Lê o `usage` de uma resposta e diz o que ele PROVA sobre o cache.
//   read > 0     → 'hit'  (o prefixo veio do cache; ainda quente)
//   creation > 0 → 'miss' (houve rebuild — só conta como miss se NÃO houve read)
//   nada         → 'unknown' (ausência de sinal NÃO é sinal — nunca inventar)
// ttlMs só é preenchido quando a resposta revela a janela CONTRATADA no write
// (ephemeral_1h / ephemeral_5m). Um hit não revela nada: devolve null.
function parseCacheUsage(usage) {
  const u = usage || {};
  const read = num(u.cache_read_input_tokens);
  const creation = num(u.cache_creation_input_tokens);

  const detail = u.cache_creation || {};
  const h1 = num(detail.ephemeral_1h_input_tokens);
  const m5 = num(detail.ephemeral_5m_input_tokens);
  // Havendo os dois, o contrato mais LONGO manda: é o que de fato ainda protege
  // o prefixo mais adiante no tempo.
  const ttlMs = h1 > 0 ? TTL_1H : (m5 > 0 ? TTL_5M : null);

  // read DOMINA creation: um write parcial sobre um prefixo lido ainda é cache
  // quente — tratar isso como miss jogaria fora um cache vivo.
  if (read > 0) return { state: 'hit', ttlMs: null, read, creation };
  if (creation > 0) return { state: 'miss', ttlMs, read, creation };
  return { state: 'unknown', ttlMs: null, read: 0, creation: 0 };
}

// Estamos numa fronteira fria? Não decide rota — só responde se o prefixo já
// está perdido (e portanto mexer nele sai de graça).
function isColdBoundary(state, now, config) {
  if (!state || !Number.isFinite(state.lastRequestTs)) {
    return { cold: true, reason: 'no-state', gapMs: Infinity };
  }
  const ttl = Number.isFinite(state.ttlMs) && state.ttlMs > 0 ? state.ttlMs : coldBoundaryMs(config);
  const gapMs = now - state.lastRequestTs;

  // Sinal 2 (fato medido): a resposta anterior reconstruiu o prefixo do zero.
  // Vale mesmo dentro do TTL — o relógio pode mentir, o miss observado não.
  if (state.lastCacheState === 'miss') return { cold: true, reason: 'prior-miss', gapMs };

  // Sinal 1 (relógio): passou da janela contratada.
  if (gapMs > ttl) return { cold: true, reason: 'gap-expired', gapMs };

  return { cold: false, reason: 'warm', gapMs };
}

// Absorve o `usage` de uma resposta no estado da sessão. Devolve um estado NOVO
// (não muta o recebido) p/ não vazar mutação por referência entre chamadas.
//
// Duas invariantes que protegem contra o parser de stream falhar:
//  - `unknown` (não conseguimos ler o usage) NÃO apaga o estado anterior;
//  - o TTL observado só SOBE, nunca é rebaixado por uma leitura vazia.
// Todo request desliza a janela (lastRequestTs = now): um hit refresca o TTL do
// lado da Anthropic sem custo, então adiar a fronteira é o comportamento real.
function observeUsage(state, usage, now, config) {
  const prev = state || {};
  const parsed = parseCacheUsage(usage);

  const lastCacheState = parsed.state === 'unknown'
    ? (prev.lastCacheState || 'unknown')
    : parsed.state;

  const prevTtl = Number.isFinite(prev.ttlMs) && prev.ttlMs > 0 ? prev.ttlMs : 0;
  const seenTtl = Number.isFinite(parsed.ttlMs) && parsed.ttlMs > 0 ? parsed.ttlMs : 0;
  const ttlMs = Math.max(prevTtl, seenTtl) || coldBoundaryMs(config);

  return {
    ...prev,
    lastRequestTs: Number.isFinite(now) ? now : prev.lastRequestTs,
    lastCacheState,
    ttlMs,
  };
}

// ADAPTADOR de borda. O tee do stream do proxy acumula os contadores num shape
// achatado (`{ in, out, cacheRead, cacheCreate, cacheTtl1h, cacheTtl5m }`, vindo
// de regex sobre chunks crus). O núcleo acima fala UM contrato só — o shape da
// API. Esta função é a única tradução entre os dois: assim não existe um segundo
// parser de cache espalhado pelo servidor.
function usageFromAccumulator(acc) {
  const a = acc || {};
  return {
    cache_read_input_tokens: num(a.cacheRead),
    cache_creation_input_tokens: num(a.cacheCreate),
    cache_creation: {
      ephemeral_1h_input_tokens: num(a.cacheTtl1h),
      ephemeral_5m_input_tokens: num(a.cacheTtl5m),
    },
  };
}

module.exports = {
  DEFAULT_COLD_BOUNDARY_MS,
  coldBoundaryMs,
  parseCacheUsage,
  isColdBoundary,
  observeUsage,
  usageFromAccumulator,
};
