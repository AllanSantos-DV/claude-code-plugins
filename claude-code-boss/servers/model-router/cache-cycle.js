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

// Chars por token. Aproximação grosseira e ASSUMIDA: o tokenizer real é da
// Anthropic e contá-lo aqui exigiria uma chamada paga por request. Serve para
// DIMENSIONAR uma oportunidade (é 5K ou 500K?), nunca para faturar.
const CHARS_PER_TOKEN = 4;

// Tamanho aproximado, em chars, de um valor de conteúdo que pode ser string,
// array de blocos ou objeto (o `input` de um tool_use).
function contentChars(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n, b) => n + contentChars(b), 0);
  if (typeof v === 'object') {
    // Bloco: soma os campos textuais conhecidos; senão serializa (tool_use.input).
    if (typeof v.text === 'string') return v.text.length;
    if (typeof v.thinking === 'string') return v.thinking.length;
    if (v.content != null) return contentChars(v.content);
    try { return JSON.stringify(v).length; } catch (err) { void err; return 0; }
  }
  return 0;
}

// Blocos que um `clear_tool_uses` + `clear_thinking` levaria embora.
const CLEARABLE_TYPES = new Set(['tool_result', 'tool_use', 'thinking']);

/**
 * Quanto contexto uma limpeza LIBERARIA neste request (estimativa declarada).
 *
 * Por que existe: contar fronteiras frias diz com que FREQUÊNCIA a oportunidade
 * aparece, não QUANTO ela vale — e sem isso decidir a fase seguinte é chute ("7
 * fronteiras" é muito ou pouco?). Esta função mede o prêmio com o que já está em
 * mãos, sem precisar implementar a limpeza: percorre as mensagens e soma o
 * payload dos blocos que a limpeza removeria.
 *
 * É ESTIMATIVA e se declara como tal (chars/4). Texto normal do usuário e do
 * assistente NÃO entra — a limpeza não o remove, e inflar aqui superestimaria o
 * ganho, que é justamente o erro que se quer evitar ao decidir por dado.
 *
 * @returns {{tokens: number, blocks: number, chars: number}}
 */
function estimateClearablePayload(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  let chars = 0;
  let blocks = 0;
  for (const msg of messages) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue; // content string = turno simples, nada limpável
    for (const block of content) {
      if (!block || !CLEARABLE_TYPES.has(block.type)) continue;
      blocks += 1;
      chars += block.type === 'tool_use' ? contentChars(block.input) : contentChars(block);
    }
  }
  return { tokens: Math.round(chars / CHARS_PER_TOKEN), blocks, chars };
}

/**
 * Chars do prompt INTEIRO — o denominador da calibração.
 *
 * Inclui `system`, todas as `messages` **e o array `tools`**. Os schemas de
 * ferramenta não são acessório: o Claude Code manda dezenas deles em toda
 * request, e a Anthropic os cobra como parte do prompt. Deixá-los de fora
 * enviesou o primeiro fator medido em campo — 1.674 chars/token contra os ~3.5-4
 * esperados, ou seja, chars subcontado ~2.2×.
 */
function estimateTotalChars(body) {
  const b = body || {};
  let chars = contentChars(b.system);
  const messages = Array.isArray(b.messages) ? b.messages : [];
  for (const msg of messages) {
    if (msg) chars += contentChars(msg.content);
  }
  // Serializa os schemas: a forma exata (JSON) é o que trafega e é tokenizado.
  if (Array.isArray(b.tools) && b.tools.length) {
    try { chars += JSON.stringify(b.tools).length; } catch (err) { void err; /* schema circular: ignora, sem derrubar */ }
  }
  return chars;
}

/**
 * Uma amostra de calibração chars→token, SEM API key e SEM `/count_tokens`.
 *
 * O proxy já vê, no mesmo ponto, duas coisas: o corpo que ele mediu em chars e o
 * `usage` que a Anthropic devolveu com a contagem REAL de input. A razão entre os
 * dois é o chars-por-token de verdade, medido em tráfego real e de graça — não há
 * motivo para manusear credencial ou pagar chamada só para descobrir isso.
 *
 * Devolve `null` quando não dá para calibrar (sem corpo ou sem usage): um fator
 * inventado é pior que fator nenhum, porque contaminaria toda a série.
 *
 * @param {number} chars total do corpo
 * @param {{in?:number, cacheRead?:number, cacheCreate?:number}} acc
 * @returns {{chars:number, realTokens:number, ratio:number}|null}
 */
function calibrationSample(chars, acc) {
  const a = acc || {};
  const realTokens = num(a.in) + num(a.cacheRead) + num(a.cacheCreate);
  const c = Number(chars);
  if (!Number.isFinite(c) || c <= 0 || realTokens <= 0) return null;
  return { chars: c, realTokens, ratio: c / realTokens };
}

/**
 * Janela do cache a usar, em ms. A MEDIDA vence o palpite.
 *
 * Por que existe: o detector assumia 5min do config, mas o Claude Code pode
 * contratar 1h — e a decisão não é dele nem sua. Extraído do binário:
 * `tFe()` liga 1h por `ENABLE_PROMPT_CACHING_1H`, por estado de overage, ou por
 * um **feature-flag remoto da Anthropic** (`tengu_prompt_cache_1h_config`, com
 * allowlist por `querySource`). Ou seja, a janela real pode mudar sem aviso e
 * sem nada mudar na máquina do usuário.
 *
 * Como a resposta da API **declara** a janela contratada em cada write
 * (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), basta usá-la:
 * tratar 1h como 5min classificaria fronteira fria com o cache ainda vivo — que
 * é exatamente o falso positivo observado em campo.
 *
 * @param {{observedMs?:number}|null} ttl agregado de TTL observado
 * @param {object} config
 * @returns {number} ms
 */
function ttlWindowMs(ttl, config) {
  const observed = ttl && Number(ttl.observedMs);
  if (Number.isFinite(observed) && observed > 0) return observed;
  return coldBoundaryMs(config);
}

module.exports = {
  DEFAULT_COLD_BOUNDARY_MS,
  CHARS_PER_TOKEN,
  TTL_1H,
  TTL_5M,
  coldBoundaryMs,
  ttlWindowMs,
  parseCacheUsage,
  isColdBoundary,
  observeUsage,
  usageFromAccumulator,
  estimateClearablePayload,
  estimateTotalChars,
  calibrationSample,
};
