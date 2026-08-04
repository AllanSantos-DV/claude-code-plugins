'use strict';

// byok.js — núcleo PURO do roteamento para um endpoint Anthropic-compatible.
//
// O boss trata isto como um endpoint GENÉRICO. Ele não conhece o provedor, não
// sabe de onde veio o token e não tem nada disso no código: recebe do dashboard
// uma Base URL e um MAPA de headers, e anexa esses headers em toda request.
//
// O contrato é Anthropic nativo em `/v1/messages` — zero tradução — e o `model`
// é repassado VERBATIM: o endpoint normaliza os nomes sozinho
// (`claude-haiku-4-5` → `claude-haiku-4.5`) e erra alto no inexistente. Mapear
// nome aqui só criaria uma segunda fonte de verdade para divergir da primeira.
//
// SEGURANÇA — a regra que manda neste arquivo: o header `authorization` /
// `x-api-key` que chega do Claude Code carrega o token da ASSINATURA do usuário.
// Repassá-lo a um endpoint de terceiro seria VAZAR a credencial. Na rota BYOK
// esses headers são REMOVIDOS e valem apenas os que o usuário configurou.
//
// Sem I/O, sem estado global: tudo entra por parâmetro.

const DEFAULT_HOST = 'api.anthropic.com';
const DEFAULT_PORT = 443;
const DEFAULT_PROTOCOL = 'https:';

// Headers que carregam credencial e NÃO podem sair para um destino de terceiro.
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key'];
// Headers de protocolo que valem em qualquer destino Anthropic-compatible.
const PROTOCOL_HEADERS = ['anthropic-version', 'anthropic-beta'];

/**
 * Quebra a Base URL em host/porta/protocolo. O PATH é ignorado de propósito: o
 * endpoint fala `/v1/messages`, e deixar um path da base entrar aqui produziria
 * URLs como `/qualquer/coisa/v1/messages`.
 * @returns {{host:string, port:number, protocol:string}|null} null quando não dá
 *   para extrair um destino — nunca um default inventado.
 */
function parseBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  let u;
  try { u = new URL(baseUrl.trim()); } catch (err) { void err; return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: u.hostname, port, protocol: u.protocol };
}

function byokCfg(config) {
  const b = config && config.byok;
  return (b && typeof b === 'object') ? b : {};
}

/**
 * Para onde ESTA request deve ir.
 *
 * `mode`:
 *   - `always`   → o endpoint atende tudo (não depende da assinatura Claude).
 *   - `on-limit` → o Claude atende normalmente e o endpoint só entra no 429.
 *
 * Ligado sem `baseUrl` NÃO cai em silêncio no Anthropic: devolve `misconfigured`
 * com a causa, para a camada de cima poder gritar em vez de fingir que funcionou.
 *
 * `fallback` é o destino padrão quando o BYOK não assume — injetado pelo chamador
 * para que o override de env do server (`ROUTER_UPSTREAM_HOST/PORT/PROTOCOL`, que
 * existe para apontar o proxy a um servidor fake em teste) continue valendo em
 * TODAS as rotas. Ausente → Anthropic.
 *
 * @param {object} config
 * @param {{onLimit?: boolean}} opts onLimit = estamos no caminho do 429
 * @param {{host?:string, port?:number, protocol?:string}} [fallback]
 */
function resolveUpstream(config, opts, fallback) {
  const b = byokCfg(config);
  const fb = fallback || {};
  const anthropic = {
    host: fb.host || DEFAULT_HOST,
    port: Number.isFinite(fb.port) ? fb.port : DEFAULT_PORT,
    protocol: fb.protocol || DEFAULT_PROTOCOL,
    isByok: false,
    headers: null,
  };
  if (b.enabled !== true) return anthropic;

  const mode = b.mode === 'always' ? 'always' : 'on-limit';
  const wants = mode === 'always' || !!(opts && opts.onLimit);
  if (!wants) return anthropic;

  const dest = parseBaseUrl(b.baseUrl);
  if (!dest) {
    return Object.assign({}, anthropic, {
      misconfigured: 'byok.enabled=true mas baseUrl ausente ou inválida — configure a Base URL no dashboard',
    });
  }
  return {
    host: dest.host, port: dest.port, protocol: dest.protocol,
    isByok: true, mode,
    headers: (b.headers && typeof b.headers === 'object') ? b.headers : {},
  };
}

/**
 * Headers da request ao upstream.
 *
 * Na rota BYOK a credencial da assinatura é REMOVIDA (ver o aviso de segurança no
 * topo) e valem os headers configurados pelo usuário — um mapa genérico, para que
 * um endpoint que amanhã exija outro header (chave de gateway, tenant id, dois
 * headers) seja resolvido na config, não no código.
 *
 * Na rota Anthropic o comportamento anterior é preservado: a credencial segue,
 * porque o destino é o dono dela.
 */
function buildHeaders(clientHeaders, upstream) {
  const src = clientHeaders || {};
  const out = { 'content-type': 'application/json' };

  const version = src['anthropic-version'];
  out['anthropic-version'] = version || '2023-06-01';
  if (src['anthropic-beta']) out['anthropic-beta'] = src['anthropic-beta'];

  if (upstream && upstream.isByok) {
    // Credencial da assinatura NÃO sai da máquina: só o que o usuário configurou.
    const configured = (upstream.headers && typeof upstream.headers === 'object') ? upstream.headers : {};
    for (const [k, v] of Object.entries(configured)) {
      if (typeof v === 'string' && v.length) out[k] = v;
    }
    return out;
  }

  for (const h of CREDENTIAL_HEADERS) {
    if (src[h]) out[h] = src[h];
  }
  return out;
}

/**
 * Mensagem acionável que o endpoint mandou no corpo (`{ error: { message } }`).
 *
 * Devolve `''` quando não há: corpo vazio, não-JSON, ou `message` ausente/vazia.
 * Nunca lança — um corpo malformado não pode derrubar a classificação de erro,
 * que é justamente o caminho em que já deu algo errado.
 */
function endpointMessage(body) {
  if (typeof body !== 'string' || !body.trim()) return '';
  let parsed;
  try { parsed = JSON.parse(body); } catch (err) { void err; return ''; }
  const msg = parsed && parsed.error && parsed.error.message;
  return (typeof msg === 'string' && msg.trim()) ? msg.trim() : '';
}

/**
 * O que fazer com a resposta do endpoint, conforme o contrato:
 *   200                        → pipe normal
 *   401 / 403 / 404 / 5xx      → fail loud (repetir não resolve)
 *   429                        → retentável (teto por credencial), respeitar retry-after
 *   corpo "model is not supported" → fail loud, mesmo num 200
 */
function classifyResponse(status, body) {
  const text = typeof body === 'string' ? body : '';
  if (/model is not supported/i.test(text)) {
    return { ok: false, failLoud: true, retryable: false, reason: 'o endpoint não serve este modelo' };
  }
  if (status === 429) {
    return { ok: false, failLoud: false, retryable: true, reason: 'teto por credencial no endpoint (429)' };
  }
  if (status === 401) {
    // 401 = credencial NÃO reconhecida. O diagnóstico certo é do NOSSO lado
    // (headers no dashboard), então não repassamos a mensagem do endpoint aqui.
    return { ok: false, failLoud: true, retryable: false, reason: 'credencial recusada pelo endpoint — revise os headers no dashboard' };
  }
  if (status === 403) {
    // 403 = credencial RECONHECIDA, mas não vale agora (expirada, revogada,
    // limite de origem...). A ação é do outro lado, e o endpoint devolve no
    // corpo um texto escrito para o usuário final dizendo exatamente o que
    // fazer. Um genérico nosso mandaria ele conferir Base URL, header e rede —
    // e nenhum dos três é o problema.
    const msg = endpointMessage(body);
    return {
      ok: false, failLoud: true, retryable: false,
      reason: msg || 'endpoint recusou a credencial (403) — sem detalhe no corpo',
    };
  }
  if (status === 404) {
    return { ok: false, failLoud: true, retryable: false, reason: 'endpoint não expõe /v1/messages nesta Base URL' };
  }
  if (status >= 500) {
    return { ok: false, failLoud: true, retryable: false, reason: `endpoint fora do ar (${status})` };
  }
  if (status >= 400) {
    return { ok: false, failLoud: true, retryable: false, reason: `endpoint recusou a request (${status})` };
  }
  return { ok: true, failLoud: false, retryable: false, reason: '' };
}

/**
 * Texto do dashboard ("Nome: valor" por linha) → mapa de headers.
 *
 * O usuário digita isto à mão, então o parser precisa ser tolerante ao que é
 * inofensivo (linha vazia, espaço sobrando) e EXPLÍCITO no que não é: uma linha
 * sem `:` é devolvida em `invalid` em vez de sumir. Header que o usuário achou
 * que configurou mas não foi enviado é exatamente o tipo de falha silenciosa que
 * faz perder horas depurando o endpoint errado.
 *
 * Só o PRIMEIRO `:` separa — valores legitimamente contêm `:` (`Bearer`, URLs
 * com porta).
 *
 * @returns {{headers: Object, invalid: string[]}}
 */
function parseHeaderLines(text) {
  const headers = {};
  const invalid = [];
  const linhas = String(text || '').split(/\r?\n/);
  for (const linha of linhas) {
    const l = linha.trim();
    if (!l) continue;
    const i = l.indexOf(':');
    if (i <= 0) { invalid.push(l); continue; }
    const nome = l.slice(0, i).trim();
    const valor = l.slice(i + 1).trim();
    if (!nome || !valor) { invalid.push(l); continue; }
    headers[nome] = valor;
  }
  return { headers, invalid };
}

/** Mapa de headers → texto do dashboard (o inverso de `parseHeaderLines`). */
function formatHeaderLines(headers) {
  if (!headers || typeof headers !== 'object') return '';
  return Object.entries(headers)
    .filter(([k, v]) => k && typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/**
 * Texto que o USUÁRIO vê quando o endpoint recusa — o diagnóstico e o conselho
 * têm que apontar para o MESMO lugar.
 *
 * Isto existe porque um texto-envelope genérico anula o diagnóstico: dizer
 * "revise a Base URL e os headers" num 403 manda o usuário caçar em três
 * lugares onde o problema não está. Cada status ganha o conselho que
 * corresponde a ele:
 *   403 → a ação é do outro lado; a mensagem do endpoint JÁ diz qual. Sem
 *         conselho nosso, que só atrapalharia.
 *   401 → credencial não reconhecida: revisar os headers.
 *   404 → caminho errado: revisar a Base URL.
 *   5xx → a config está certa; o endpoint é que está fora.
 */
function userAdvice(status, cls, hint) {
  const extra = hint ? `\n\n⏳ ${hint}.` : '';
  const cabeca = `⚠️ O endpoint BYOK recusou a request: ${cls.reason} (HTTP ${status}).`;
  let conselho;
  if (status === 403) conselho = '';                       // a mensagem acima já diz a ação
  else if (status === 401) conselho = 'Revise os headers em /dashboard → BYOK.';
  else if (status === 404) conselho = 'Revise a Base URL em /dashboard → BYOK.';
  else if (status >= 500) conselho = 'O endpoint está fora do ar — a sua configuração não é a causa.';
  else conselho = 'Revise a Base URL e os headers em /dashboard → BYOK.';
  return conselho ? `${cabeca}\n\n${conselho}${extra}` : `${cabeca}${extra}`;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROTOCOL,
  CREDENTIAL_HEADERS,
  PROTOCOL_HEADERS,
  parseBaseUrl,
  resolveUpstream,
  buildHeaders,
  classifyResponse,
  endpointMessage,
  userAdvice,
  parseHeaderLines,
  formatHeaderLines,
};
