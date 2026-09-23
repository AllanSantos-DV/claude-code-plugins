'use strict';

const { DEFAULT_ALIAS_PREFIX } = require('./catalog.js');
const VALID_WIRE_PROTOCOLS = new Set(['anthropic', 'openai']);

const DEFAULT_PATHS = {
  anthropic: {
    models: 'v1/models',
    generate: 'v1/messages',
    countTokens: 'v1/messages/count_tokens',
  },
  openai: {
    models: 'v1/models',
    generate: 'v1/chat/completions',
  },
};

const ENV_FIELDS = {
  upstream: {
    enabled: 'ROUTER_UPSTREAM_ENABLED',
    baseUrl: 'ROUTER_UPSTREAM_BASE_URL',
    wireProtocol: 'ROUTER_UPSTREAM_WIRE_PROTOCOL',
    modelAliasPrefix: 'ROUTER_UPSTREAM_MODEL_ALIAS_PREFIX',
    endpoints: {
      models: 'ROUTER_UPSTREAM_MODELS_URL',
      generate: 'ROUTER_UPSTREAM_GENERATE_URL',
      countTokens: 'ROUTER_UPSTREAM_COUNT_TOKENS_URL',
      classify: 'ROUTER_UPSTREAM_CLASSIFY_URL',
    },
  },
  byok: {
    enabled: 'ROUTER_BYOK_ENABLED',
    baseUrl: 'ROUTER_BYOK_BASE_URL',
    wireProtocol: 'ROUTER_BYOK_WIRE_PROTOCOL',
    modelAliasPrefix: 'ROUTER_BYOK_MODEL_ALIAS_PREFIX',
    endpoints: {
      models: 'ROUTER_BYOK_MODELS_URL',
      generate: 'ROUTER_BYOK_GENERATE_URL',
      countTokens: 'ROUTER_BYOK_COUNT_TOKENS_URL',
      classify: 'ROUTER_BYOK_CLASSIFY_URL',
    },
  },
};

function mergeRouterSection(base, override) {
  const a = (base && typeof base === 'object') ? base : {};
  const b = (override && typeof override === 'object') ? override : {};
  const merged = { ...a, ...b };
  if (a.endpoints || b.endpoints) {
    merged.endpoints = {
      ...((a.endpoints && typeof a.endpoints === 'object') ? a.endpoints : {}),
      ...((b.endpoints && typeof b.endpoints === 'object') ? b.endpoints : {}),
    };
  }
  return merged;
}

function parseBooleanEnv(name, value) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} inválida: use true/false, 1/0, yes/no ou on/off`);
}

function envSection(base, env, kind) {
  const spec = ENV_FIELDS[kind];
  const patch = {};
  for (const key of ['enabled', 'baseUrl', 'wireProtocol', 'modelAliasPrefix']) {
    const name = spec[key];
    if (!Object.prototype.hasOwnProperty.call(env, name) || String(env[name]).trim() === '') continue;
    patch[key] = key === 'enabled' ? parseBooleanEnv(name, env[name]) : String(env[name]).trim();
  }
  const endpoints = {};
  for (const [operation, name] of Object.entries(spec.endpoints)) {
    if (!Object.prototype.hasOwnProperty.call(env, name) || String(env[name]).trim() === '') continue;
    endpoints[operation] = String(env[name]).trim();
  }
  if (Object.keys(endpoints).length) patch.endpoints = endpoints;
  return mergeRouterSection(base, patch);
}

function applyRouterEnvironment(config, env) {
  const base = (config && typeof config === 'object') ? config : {};
  const source = (env && typeof env === 'object') ? env : {};
  return {
    ...base,
    upstream: envSection(base.upstream, source, 'upstream'),
    byok: envSection(base.byok, source, 'byok'),
  };
}

function targetKind(target) {
  if (target && target.isByok) return 'byok';
  if (target && target.isCustomEndpoint) return 'upstream';
  return 'anthropic';
}

function configuredSection(config, target) {
  const kind = targetKind(target);
  if (kind === 'anthropic') return {};
  const section = config && config[kind];
  return (section && typeof section === 'object') ? section : {};
}

function normalizeWireProtocol(value) {
  const wireProtocol = String(value || 'anthropic').trim().toLowerCase();
  if (!VALID_WIRE_PROTOCOLS.has(wireProtocol)) {
    return { ok: false, error: `wireProtocol inválido: ${JSON.stringify(value)} (use "anthropic" ou "openai")` };
  }
  return { ok: true, wireProtocol };
}

function validHttpUrl(raw, operation) {
  let parsed;
  try { parsed = new URL(raw); } catch (err) {
    return { ok: false, error: `URL inválida para ${operation}: ${err.message}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `URL inválida para ${operation}: protocolo deve ser http ou https` };
  }
  return { ok: true, url: parsed.toString(), parsed };
}

function targetBaseUrl(target) {
  if (!target || !target.host || !target.protocol) return '';
  const defaultPort = target.protocol === 'https:' ? 443 : 80;
  const port = Number(target.port);
  const authority = Number.isFinite(port) && port > 0 && port !== defaultPort
    ? `${target.host}:${port}`
    : target.host;
  return `${target.protocol}//${authority}/`;
}

function derivedUrl(baseUrl, relativePath, operation) {
  const base = validHttpUrl(baseUrl, operation);
  if (!base.ok) return base;
  const normalizedBase = base.url.endsWith('/') ? base.url : `${base.url}/`;
  return validHttpUrl(new URL(relativePath, normalizedBase).toString(), operation);
}

function resolveOperationProfile(config, target, operation) {
  const kind = targetKind(target);
  const section = configuredSection(config, target);
  const wire = normalizeWireProtocol(section.wireProtocol);
  if (!wire.ok) return wire;

  const endpoints = (section.endpoints && typeof section.endpoints === 'object')
    ? section.endpoints
    : {};
  let explicit = typeof endpoints[operation] === 'string' ? endpoints[operation].trim() : '';
  if (operation === 'classify' && !explicit) {
    explicit = typeof endpoints.generate === 'string' ? endpoints.generate.trim() : '';
  }

  let resolved;
  if (explicit) {
    resolved = validHttpUrl(explicit, operation);
  } else {
    const defaultOperation = operation === 'classify' ? 'generate' : operation;
    const relativePath = DEFAULT_PATHS[wire.wireProtocol][defaultOperation];
    if (!relativePath) {
      return {
        ok: false,
        error: `${operation} não tem endpoint padrão no protocolo ${wire.wireProtocol}; configure a URL explicitamente`,
      };
    }
    const configuredBase = (typeof section.baseUrl === 'string' && section.baseUrl.trim())
      ? section.baseUrl.trim()
      : '';
    const baseUrl = configuredBase || (kind === 'anthropic' ? targetBaseUrl(target) : '');
    if (!baseUrl) {
      return { ok: false, error: `URL ausente para ${operation}: configure endpoints.${operation} ou baseUrl` };
    }
    resolved = derivedUrl(baseUrl, relativePath, operation);
  }
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    kind,
    operation,
    url: resolved.url,
    parsed: resolved.parsed,
    wireProtocol: wire.wireProtocol,
    target,
  };
}

function resolveAliasPolicy(config, target) {
  const enabled = !!(target && target.isCustomEndpoint);
  const section = configuredSection(config, target);
  const configured = typeof section.modelAliasPrefix === 'string'
    ? section.modelAliasPrefix.trim()
    : '';
  return { enabled, prefix: configured || DEFAULT_ALIAS_PREFIX };
}

module.exports = {
  DEFAULT_ALIAS_PREFIX,
  VALID_WIRE_PROTOCOLS,
  DEFAULT_PATHS,
  mergeRouterSection,
  applyRouterEnvironment,
  normalizeWireProtocol,
  resolveOperationProfile,
  resolveAliasPolicy,
  targetKind,
};
