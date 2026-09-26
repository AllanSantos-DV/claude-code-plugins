'use strict';
// Mapeamento de modelo do BYOK (origem → destino) e injeção opcional do modelo
// resolvido em campos extras do corpo ou em headers. Módulo PURO: sem I/O, sem
// logger — o router e o dashboard usam as mesmas validações.
//
// Contrato:
//   - `byok.modelMap` é um objeto `{ "<origem>": "<destino>" }`. Ausente/vazio =
//     o `model` segue VERBATIM (comportamento anterior).
//   - Ordem de match (a primeira etapa que casar decide):
//       1. ID exato da origem;
//       2. ID exato da BASE, quando a origem termina em sufixo de snapshot
//          `-AAAAMMDD` — exatamente 8 dígitos, sem validar o calendário —
//          `claude-haiku-4-5` cobre `claude-haiku-4-5-20251001`; `-5` de
//          `claude-opus-5-5` NUNCA é snapshot;
//       3. padrões com `*` (casa qualquer sequência NÃO vazia). Vence o padrão
//          com mais caracteres literais; empate → ordem de inserção.
//     Sem match → `model` verbatim. Nunca há prefixo implícito: `claude-opus-5`
//     não captura `claude-opus-5-5`, nem uma versão desconhecida é rebaixada.
//     Comparação sensível a maiúsculas, com trim nas pontas. `model` com mais
//     de 256 caracteres ou fora de ASCII visível nunca casa (segue verbatim).
//     Origem só com dígitos é recusada (não é ID de modelo, e o objeto JSON
//     reordenaria essas chaves).
//   - `byok.modelInjection` = `{ body: { "<caminho.pontilhado>": "<template>" },
//     headers: { "<Nome>": "<template>" } }`. O único placeholder é `{model}`
//     (o modelo EFETIVO enviado em `model`) e todo template precisa usá-lo;
//     o texto fixo em volta tem no máximo 64 caracteres. Nada é avaliado como
//     código. O template é CONFIGURAÇÃO, não segredo: o dashboard o exibe em
//     claro — credencial vai nos headers do BYOK (mascarados), e nomes de
//     header com cara de credencial são recusados na injeção. Headers aceitam
//     só ASCII visível e espaço interno, inclusive depois de renderizados:
//     valor inválido é erro de preparação, nunca um throw do `http.request`
//     no meio da request. Aplicada DEPOIS da tradução de protocolo, sobre
//     cópia. Caminho aninhado sobrescreve o valor existente na folha; campo de
//     TOPO que a request já traz, chave que só difere de uma existente na
//     caixa (qualquer nível), `model` e campos de protocolo são recusados. Request sem `model`
//     de texto não vazio com injeção ligada é erro. Desligada por padrão.

const SNAPSHOT_RE = /^(.+)-(\d{8})$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Credencial ou protocolo HTTP/provedor: injetar aqui trocaria autenticação,
// compressão, método, origem ou framing da resposta — nunca é "informar o modelo".
const RESERVED_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization',
  'cookie', 'openai-organization', 'openai-project', 'openai-beta',
  'content-type', 'content-length', 'content-encoding', 'host', 'accept',
  'accept-encoding', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'range', 'priority',
  'user-agent', 'origin', 'referer', 'via', 'forwarded', 'date', 'cache-control', 'pragma',
  'x-http-method', 'x-http-method-override', 'x-method-override',
  'x-real-ip', 'anthropic-version', 'anthropic-beta',
  'x-original-url', 'x-rewrite-url', 'x-original-host', 'x-host', 'max-forwards', 'digest',
]);
// Famílias de header de credencial/infra (qualquer provedor): recusadas por
// padrão de nome, não só por lista — `Ocp-Apim-Subscription-Key`,
// `X-Amz-Security-Token`, `X-Auth-Token`, `X-Forwarded-For`, `Sec-*`,
// `X-Original-*`, `X-Envoy-*`, `CF-*`, `*-Client-IP`... A lista não é
// exaustiva: é uma rede de segurança, não uma allowlist.
const RESERVED_HEADER_RE = /(auth|token|secret|pass|pwd|jwt|hmac|otp|csrf|xsrf|cert|principal|api[-_.]?key|access[-_.]?key|private|bearer|cookie|session|signature|credential|subscription-key)|(^|[-_.])key$|^(sec-|proxy-|x-forwarded-|x-amz-|x-goog-|anthropic-|openai-|if-|content-|x-original-|x-envoy-|cf-)|(client|connecting)-ip$/i;
// Campos de topo dos protocolos Anthropic/OpenAI que a injeção não pode
// sobrescrever: trocariam conversa, streaming, tools, raciocínio, amostragem,
// limites ou cobrança da request. Além desta lista, qualquer campo de topo
// que a request traduzida JÁ traga é recusado na hora de injetar.
const PROTOCOL_BODY_KEYS = new Set([
  'messages', 'system', 'tools', 'tool_choice', 'stream', 'stream_options',
  'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k',
  'stop', 'stop_sequences', 'thinking', 'response_format', 'n',
  'parallel_tool_calls', 'functions', 'function_call', 'reasoning', 'reasoning_effort',
  'service_tier', 'context_management', 'output_config', 'container', 'mcp_servers',
  'frequency_penalty', 'presence_penalty', 'seed', 'logit_bias', 'logprobs',
  'top_logprobs', 'user', 'safety_identifier', 'prompt_cache_key', 'verbosity',
  'web_search_options', 'store', 'modalities', 'audio', 'prediction',
  'output_format', 'prompt_cache_retention',
]);
// Objeto de protocolo que só aceita subcampo: `metadata` como folha trocaria
// o objeto (ex.: `metadata.user_id`) por texto.
const OBJECT_ONLY_BODY_KEYS = new Set(['metadata']);
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const MAX_INJECTIONS = 32;
const MAX_PATH_SEGMENTS = 8;
const MAX_TEMPLATE_LITERAL = 64;
// ASCII visível: IDs de modelo não têm espaço; valor de header aceita espaço
// interno. Fora disso o Node lança ERR_INVALID_CHAR ao montar a request.
const MODEL_ID_RE = /^[\x21-\x7e]+$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
// Teto do valor RENDERIZADO de um header injetado: servidores recusam headers
// longos derrubando a conexão (ECONNRESET), o que viraria um 502 enganoso.
const MAX_HEADER_VALUE = 1024;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const MAX_RULES = 500;
const MAX_LEN = 256;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ── Mapa ─────────────────────────────────────────────────────────────────────

function validateRuleSide(value, label, index) {
  if (typeof value !== 'string') throw new Error(`regra ${index + 1}: ${label} precisa ser texto`);
  const v = value.trim();
  if (!v) throw new Error(`regra ${index + 1}: ${label} vazio`);
  if (v.length > MAX_LEN) throw new Error(`regra ${index + 1}: ${label} excede ${MAX_LEN} caracteres`);
  if (/\s/.test(v)) throw new Error(`regra ${index + 1}: ${label} não pode conter espaços ("${v}")`);
  if (!MODEL_ID_RE.test(v)) throw new Error(`regra ${index + 1}: ${label} só aceita caracteres ASCII visíveis ("${v}")`);
  return v;
}

/**
 * Normaliza regras vindas do dashboard (array `[{from,to}]`) ou do config
 * (objeto `{from: to}`) para o objeto persistido. Lança em qualquer regra
 * inválida — nada é descartado em silêncio.
 * @returns {Record<string,string>}
 */
function normalizeModelMap(input) {
  let pairs;
  if (Array.isArray(input)) {
    pairs = input.map((r, i) => {
      if (!isPlainObject(r)) throw new Error(`regra ${i + 1}: formato inválido (esperado {from,to})`);
      return [r.from, r.to];
    });
  } else if (isPlainObject(input)) {
    pairs = Object.entries(input);
  } else {
    throw new Error('modelMap precisa ser uma lista de regras ou um objeto origem→destino');
  }
  if (pairs.length > MAX_RULES) throw new Error(`modelMap excede ${MAX_RULES} regras`);
  const out = {};
  pairs.forEach(([from, to], i) => {
    const f = validateRuleSide(from, 'origem', i);
    const t = validateRuleSide(to, 'destino', i);
    if (FORBIDDEN_KEYS.has(f)) throw new Error(`regra ${i + 1}: origem reservada "${f}"`);
    if (/^\d+$/.test(f)) throw new Error(`regra ${i + 1}: origem só com dígitos não é ID de modelo ("${f}")`);
    if (/\*/.test(t)) throw new Error(`regra ${i + 1}: destino não aceita "*" ("${t}")`);
    if (/\*\*/.test(f)) throw new Error(`regra ${i + 1}: origem com "**" é ambígua ("${f}")`);
    if (f.replace(/\*/g, '') === '') throw new Error(`regra ${i + 1}: origem precisa de ao menos um caractere literal`);
    if (Object.prototype.hasOwnProperty.call(out, f)) throw new Error(`regra ${i + 1}: origem duplicada "${f}"`);
    out[f] = t;
  });
  return out;
}

/**
 * Casa `pattern` (com `*` = 1+ caracteres) contra `text` SEM regex: o nome do
 * modelo vem do cliente, e `.+` repetido tem backtracking exponencial (ReDoS
 * num processo compartilhado por todas as sessões). Glob clássico de dois
 * ponteiros — cada `*` vira "um caractere qualquer" + "zero ou mais" — com
 * pior caso O(|pattern|·|text|).
 */
function wildcardMatch(pattern, text) {
  const tokens = [];
  for (const ch of pattern) {
    if (ch === '*') tokens.push({ any: true }, { star: true });
    else tokens.push({ ch });
  }
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = -1;
  while (t < text.length) {
    const tok = tokens[p];
    if (tok && !tok.star && (tok.any || tok.ch === text[t])) {
      p++;
      t++;
    } else if (tok && tok.star) {
      starP = p++;
      starT = t;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p].star) p++;
  return p === tokens.length;
}

/**
 * Resolve o modelo de destino. Devolve `{ model, rule, matched, how }`:
 * `matched:false` → `model` é a origem verbatim.
 */
function resolveTargetModel(sourceModel, modelMap) {
  // Só texto é nome de modelo: 42 ou ["x"] não viram "42"/"x" para casar regra.
  const source = typeof sourceModel === 'string' ? sourceModel.trim() : '';
  const miss = { model: source, rule: null, matched: false, how: 'none' };
  // Tipo errado NÃO é "sem mapa": normalizeModelMap lança (fail-loud) — mesmo
  // numa request sem `model`, para a regra quebrada não passar despercebida.
  if (modelMap == null) return miss;
  const map = normalizeModelMap(modelMap);
  if (!source) return miss;
  // Nenhuma regra aceita espaço/controle/não-ASCII, então um `model` assim
  // nunca casa — sem isso, o `*` (qualquer caractere) casaria "a\nb" com "a*".
  // Idem para nomes acima do teto das regras: limita o custo do casamento de
  // curinga a O(regras · 256 · 256), independente do tamanho enviado.
  if (source.length > MAX_LEN || !MODEL_ID_RE.test(source)) return miss;
  if (Object.prototype.hasOwnProperty.call(map, source)) {
    return { model: map[source], rule: source, matched: true, how: 'exact' };
  }
  const snap = SNAPSHOT_RE.exec(source);
  if (snap && Object.prototype.hasOwnProperty.call(map, snap[1])) {
    return { model: map[snap[1]], rule: snap[1], matched: true, how: 'snapshot' };
  }
  let best = null;
  for (const [from, to] of Object.entries(map)) {
    if (!from.includes('*')) continue;
    if (!wildcardMatch(from, source)) continue;
    const literal = from.replace(/\*/g, '').length;
    if (!best || literal > best.literal) best = { from, to, literal };
  }
  if (best) return { model: best.to, rule: best.from, matched: true, how: 'pattern' };
  return miss;
}

// ── Injeção ──────────────────────────────────────────────────────────────────

function validateTemplate(value, where, { header = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${where}: o template precisa ser texto`);
  if (!value.length) throw new Error(`${where}: template vazio`);
  if (value.length > MAX_LEN) throw new Error(`${where}: template excede ${MAX_LEN} caracteres`);
  // A UI apara as pontas: aceitar espaço ali quebraria a ida e volta.
  if (value !== value.trim()) throw new Error(`${where}: template não pode ter espaço nas pontas`);
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    if (m[1] !== 'model') throw new Error(`${where}: placeholder desconhecido "{${m[1]}}" (só {model} é aceito)`);
  }
  if (/[{}]/.test(value.replace(PLACEHOLDER_RE, ''))) throw new Error(`${where}: chave "{" ou "}" solta`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${where}: template não pode ter quebra de linha`);
  if (!value.includes('{model}')) throw new Error(`${where}: o template precisa conter {model}`);
  if (value.replace(PLACEHOLDER_RE, '').length > MAX_TEMPLATE_LITERAL) {
    throw new Error(`${where}: texto fixo do template excede ${MAX_TEMPLATE_LITERAL} caracteres`);
  }
  if (header && !HEADER_VALUE_RE.test(value)) throw new Error(`${where}: header só aceita caracteres ASCII visíveis`);
  return value;
}

function parseBodyPath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('caminho de corpo vazio');
  const parts = path.trim().split('.');
  if (parts.length > MAX_PATH_SEGMENTS) throw new Error(`caminho "${path}" excede ${MAX_PATH_SEGMENTS} segmentos`);
  for (const p of parts) {
    if (!p) throw new Error(`caminho "${path}" tem segmento vazio`);
    if (FORBIDDEN_KEYS.has(p)) throw new Error(`caminho "${path}" usa chave reservada "${p}"`);
    if (!PATH_SEGMENT_RE.test(p)) {
      throw new Error(`caminho "${path}": segmento "${p}" só aceita letras, dígitos, "_" e "-"`);
    }
  }
  // Sem diferenciar maiúsculas: gateways que casam chave JSON assim (ex.: Go)
  // leriam `Model`/`System` no lugar de `model`/`system`.
  const top = parts[0].toLowerCase();
  if (top === 'model') throw new Error(`caminho "${path}" não pode alterar "model" (use o mapeamento)`);
  if (PROTOCOL_BODY_KEYS.has(top)) {
    throw new Error(`caminho "${path}" sobrescreveria o campo de protocolo "${top}"`);
  }
  if (OBJECT_ONLY_BODY_KEYS.has(top) && parts[0] !== top) {
    throw new Error(`caminho "${path}": escreva "${top}" em minúsculas (variação de caixa criaria um segundo "${top}")`);
  }
  if (OBJECT_ONLY_BODY_KEYS.has(top) && parts.length === 1) {
    throw new Error(`caminho "${path}" trocaria o objeto "${top}" por texto (use "${top}.<campo>")`);
  }
  return parts;
}

/**
 * Valida e normaliza `modelInjection`. `null`/ausente → `null` (desligado).
 * @param {object} [configuredHeaders] `byok.headers` para detectar colisão.
 */
function normalizeInjection(input, configuredHeaders) {
  if (input == null) return null;
  if (!isPlainObject(input)) throw new Error('modelInjection precisa ser um objeto { body, headers }');
  for (const k of Object.keys(input)) {
    if (k !== 'body' && k !== 'headers') throw new Error(`modelInjection: chave desconhecida "${k}"`);
  }
  const out = { body: {}, headers: {} };
  if (input.body != null) {
    if (!isPlainObject(input.body)) throw new Error('modelInjection.body precisa ser um objeto caminho→template');
    if (Object.keys(input.body).length > MAX_INJECTIONS) throw new Error(`modelInjection.body excede ${MAX_INJECTIONS} caminhos`);
    const seen = [];
    for (const [path, tpl] of Object.entries(input.body)) {
      const parts = parseBodyPath(path);
      const key = parts.join('.');
      // Comparação sem caixa: `a.b` e `A.b` virariam chaves irmãs que um
      // gateway sem diferenciar maiúsculas leria como a mesma.
      const cmp = key.toLowerCase();
      for (const other of seen) {
        const o = other.toLowerCase();
        if (o === cmp) throw new Error(`modelInjection.body: caminho "${key}" duplicado`);
        if (o.startsWith(`${cmp}.`) || cmp.startsWith(`${o}.`)) {
          throw new Error(`modelInjection.body: caminhos conflitantes "${other}" e "${key}"`);
        }
      }
      seen.push(key);
      out.body[key] = validateTemplate(tpl, `modelInjection.body["${key}"]`);
    }
  }
  if (input.headers != null) {
    if (!isPlainObject(input.headers)) throw new Error('modelInjection.headers precisa ser um objeto nome→template');
    if (Object.keys(input.headers).length > MAX_INJECTIONS) throw new Error(`modelInjection.headers excede ${MAX_INJECTIONS} headers`);
    const configured = new Set(Object.keys(isPlainObject(configuredHeaders) ? configuredHeaders : {})
      .map(h => h.trim().toLowerCase()));
    const seen = new Set();
    for (const [name, tpl] of Object.entries(input.headers)) {
      const n = String(name).trim();
      if (!HEADER_NAME_RE.test(n)) throw new Error(`modelInjection.headers: nome inválido "${name}"`);
      const lower = n.toLowerCase();
      if (FORBIDDEN_KEYS.has(lower)) throw new Error(`modelInjection.headers: nome reservado "${n}"`);
      if (RESERVED_HEADERS.has(lower) || RESERVED_HEADER_RE.test(lower)) {
        throw new Error(`modelInjection.headers: "${n}" é reservado (credencial/protocolo)`);
      }
      if (configured.has(lower)) throw new Error(`modelInjection.headers: "${n}" já está nos headers do BYOK`);
      if (seen.has(lower)) throw new Error(`modelInjection.headers: "${n}" duplicado`);
      seen.add(lower);
      out.headers[n] = validateTemplate(tpl, `modelInjection.headers["${n}"]`, { header: true });
    }
  }
  if (!Object.keys(out.body).length && !Object.keys(out.headers).length) return null;
  return out;
}

/**
 * `model` para log/mensagem: o do cliente pode ter qualquer tamanho (só o
 * casamento é limitado a MAX_LEN), então o texto é cortado no mesmo teto.
 */
function modelForLog(model) {
  if (typeof model !== 'string') return `<${model === null ? 'null' : typeof model}>`;
  if (model.length <= MAX_LEN) return model;
  // Não corta no meio de um par surrogate (emoji etc.): sobraria caractere órfão.
  const code = model.charCodeAt(MAX_LEN - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? MAX_LEN - 1 : MAX_LEN;
  return `${model.slice(0, cut)}…(+${model.length - cut} caracteres)`;
}

/**
 * Erro causado pela REQUEST (não pela configuração): `model` ausente/inválido
 * para a injeção, campo que o cliente já mandou. Quem chama responde 400 em
 * vez de mandar o usuário revisar regras que estão certas.
 */
function requestError(message) {
  const err = new Error(message);
  err.code = 'BYOK_REQUEST';
  return err;
}

function renderTemplate(tpl, model) {
  return tpl.replace(PLACEHOLDER_RE, () => model);
}

/**
 * Aplica a injeção num corpo JÁ traduzido. Nunca muta `body`: clona o caminho.
 * Um segmento intermediário que exista e não seja objeto é erro (fail-loud),
 * assim como um campo de topo que a request já traz (a injeção acrescenta,
 * não reescreve o que o cliente/protocolo mandou).
 */
function injectBody(body, injection, model) {
  if (!injection || !Object.keys(injection.body || {}).length) return body;
  if (!isPlainObject(body)) throw new Error('corpo traduzido não é um objeto');
  const out = { ...body };
  for (const [path, tpl] of Object.entries(injection.body)) {
    const parts = parseBodyPath(path);
    // Campo de topo existente, com qualquer caixa: `Foo` ao lado de `foo`
    // seria lido como o mesmo campo por gateways sem diferenciar maiúsculas.
    const top = parts[0].toLowerCase();
    const clash = Object.keys(body).find(k => k.toLowerCase() === top && (parts.length === 1 || k !== parts[0]));
    if (clash !== undefined) {
      throw requestError(`modelInjection.body["${path}"]: a request já traz o campo "${clash}" — a injeção não o sobrescreve`);
    }
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      const k = parts[i];
      // Mesma regra nos níveis aninhados: `User_Id` ao lado de `user_id`
      // (ou `CFG` ao lado de `cfg`) viraria chave irmã, não sobrescrita.
      if (i > 0) {
        const lower = k.toLowerCase();
        const variant = Object.keys(cur).find(x => x !== k && x.toLowerCase() === lower);
        if (variant !== undefined) {
          throw requestError(`modelInjection.body["${path}"]: a request já traz o campo "${parts.slice(0, i).concat(variant).join('.')}" com outra caixa`);
        }
      }
      if (i === parts.length - 1) break;
      const next = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
      if (next === undefined || next === null) cur[k] = {};
      else if (isPlainObject(next)) cur[k] = { ...next };
      else throw requestError(`modelInjection.body["${path}"]: "${parts.slice(0, i + 1).join('.')}" existe e não é objeto`);
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = renderTemplate(tpl, model);
  }
  return out;
}

/**
 * Aplica a injeção de headers. Lança se o valor RENDERIZADO não couber num
 * header HTTP (ex.: `model` do cliente fora de ASCII) — prepareByokBody já
 * faz essa checagem antes, dentro do try da preparação.
 */
function injectHeaders(headers, injection, model) {
  if (!injection || !Object.keys(injection.headers || {}).length) return headers;
  const out = { ...headers };
  for (const [name, tpl] of Object.entries(injection.headers)) {
    const value = renderTemplate(tpl, model);
    // Fora de ASCII visível, ou espaço nas pontas (o `model` do cliente pode
    // trazer; o parser HTTP do outro lado cortaria em silêncio).
    if (!HEADER_VALUE_RE.test(value) || value !== value.trim()) {
      throw requestError(`modelInjection.headers["${name}"]: valor renderizado inválido para header (modelo "${modelForLog(model)}")`);
    }
    if (value.length > MAX_HEADER_VALUE) {
      throw requestError(`modelInjection.headers["${name}"]: valor renderizado com ${value.length} caracteres passa do teto de ${MAX_HEADER_VALUE} (modelo "${modelForLog(model)}")`);
    }
    // Remove variantes de caixa já presentes para não enviar o header duplicado.
    const lower = name.toLowerCase();
    for (const k of Object.keys(out)) if (k.toLowerCase() === lower) delete out[k];
    out[name] = value;
  }
  return out;
}

/**
 * Prepara o corpo BYOK: `model` ← destino mapeado (sempre em cópia rasa, pois o
 * adapter Anthropic devolve o próprio reqBody) + injeção opcional.
 * `model` é o texto usado na injeção; `logModel` é o `model` realmente enviado,
 * já pronto para log/nota (`<number>` para 42, cortado se longo).
 * @returns {{ body: object, model: string, logModel: string, resolution: object, injection: object|null }}
 */
function prepareByokBody(translatedBody, sourceModel, byokCfg) {
  const cfg = isPlainObject(byokCfg) ? byokCfg : {};
  const resolution = resolveTargetModel(sourceModel, cfg.modelMap);
  const injection = normalizeInjection(cfg.modelInjection, cfg.headers);
  if (!isPlainObject(translatedBody)) {
    // Corpo JSON que não é objeto (`[]`, `"texto"`, `null`) — na prática só no
    // count_tokens, pois /v1/messages já recusa na entrada: sem regra que case
    // nem injeção, segue verbatim como antes do recurso; com elas, é a request
    // que não tem onde receber o modelo.
    const hasInjection = !!injection && (Object.keys(injection.body).length > 0 || Object.keys(injection.headers).length > 0);
    if (!resolution.matched && !hasInjection) {
      return { body: translatedBody, model: '', logModel: modelForLog(sourceModel), resolution, injection: null };
    }
    throw requestError('o corpo da request não é um objeto JSON — não há onde aplicar o mapeamento/injeção de modelo');
  }
  let body = { ...translatedBody };
  if (resolution.matched) body.model = resolution.model;
  // `model` ausente no corpo traduzido → o da origem; presente mas não-texto
  // (42, objeto) → nenhum: nunca injeta "42" nem "[object Object]".
  let effective;
  if (body.model === undefined) effective = resolution.model;
  else effective = typeof body.model === 'string' ? body.model : '';
  if (injection && !effective.trim()) {
    throw requestError('modelInjection: a request não tem `model` de texto não vazio — não há o que injetar');
  }
  body = injectBody(body, injection, effective);
  // Valida já aqui os headers renderizados: o erro sai na preparação, não no
  // http.request (que lançaria ERR_INVALID_CHAR fora do try de quem chama).
  injectHeaders({}, injection, effective);
  const logModel = modelForLog(body.model === undefined ? resolution.model : body.model);
  return { body, model: effective, logModel, resolution, injection };
}

module.exports = {
  normalizeModelMap,
  resolveTargetModel,
  normalizeInjection,
  injectBody,
  injectHeaders,
  prepareByokBody,
  modelForLog,
  RESERVED_HEADERS,
};
