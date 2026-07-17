'use strict';
/**
 * lib/graph/client.js — REST client of the Session Graph Engine (native-java). CONSUMER only;
 * reimplements nothing of the server. Faithful CJS port of copilot-memory's lib/graphClient.mjs,
 * with dependency injection (fetchImpl/sleepImpl/discover) so the whole state machine is testable
 * without a live daemon.
 *
 * Contract: POST {daemon}/api/v1/graph/{status|ingest|symbols|search|callers|references}, body is
 * just `{ path, ...args }`. PATH-AUTHORITATIVE: the daemon derives project_id from `path` and
 * returns it on every response, so we send only the path and DISPLAY the daemon-returned
 * project_id — no client-side id derivation (that would risk drift vs the daemon's ProjectIdResolver
 * and is unnecessary since the path is the single source of truth). Key rules preserved:
 *   - status-first: only ingest if not_indexed/failed (or refresh); ready → read directly (reuse).
 *   - TYPED error (GraphError) preserving status/code/body — never a bare string.
 *   - ROOT_CONFLICT (worktrees; mapped/requested root) surfaced with both roots.
 *   - clamps on limit/topK/hops; capability probe (200 ok, 404 daemon<2.23, 503 graph off).
 *   - poll with backoff + deadline (never infinite); 429 QUEUE_SATURATED → return Retry-After.
 */
const { resolve: pathResolve } = require('path');
const { realpathSync, existsSync } = require('fs');
const { homedir } = require('os');

class GraphError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || ('HTTP ' + status));
    this.name = 'GraphError';
    this.status = status;
    this.code = code || null;
    Object.assign(this, extra); // mappedRoot, requestedRoot, retryAfter, hint, state
  }
}

const clampInt = (v, def, max) => {
  const n = Number.isFinite(+v) ? Math.floor(+v) : def;
  return Math.max(1, Math.min(max, n));
};

/**
 * GraphContext: resolve the TARGET root, canonicalized via realpath (symlink/case) so the daemon
 * maps it consistently. rootArg empty = own project (cwd). No project_id is derived client-side —
 * the daemon is authoritative and returns it on every response.
 */
function graphContextFor(rootArg, cwd) {
  let root = rootArg && String(rootArg).trim() ? pathResolve(String(rootArg).trim()) : String(cwd || process.cwd());
  try { root = realpathSync(root); } catch (e) { void e; /* missing → assertSafeRoot rejects later */ }
  return { root };
}

/**
 * Root safety guard (spec §6.1): the daemon WALKS+reads+hashes the filesystem at `path`. Refuse
 * roots that are too broad (disk root, UNC share, whole home) and missing ones — prevents DoS /
 * indexing an arbitrary tree. Returns null if OK, else an error message.
 */
function assertSafeRoot(root) {
  if (!root || !existsSync(root)) return 'the path does not exist: ' + (root || '(empty)');
  const norm = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(norm) || norm === '') return 'a disk root is too broad — pass a specific project path.';
  if (/^\/\/[^/]+(\/[^/]+)?$/.test(norm)) return 'a network share root (UNC) is too broad — pass a specific project.';
  const home = String(homedir()).replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && norm.toLowerCase() === home.toLowerCase()) return 'the whole home folder is too broad — pass a specific project.';
  return null;
}

/** Discover the live daemon; return the base URL (no trailing slash) or null (offline → fail-open). */
async function graphBase({ discover, fetchImpl = globalThis.fetch } = {}) {
  if (typeof discover !== 'function') throw new GraphError(0, 'NO_DISCOVER', 'graphBase requires an injected discover()');
  const info = await discover({ fetchImpl });
  if (!info || !info.url) return null;
  return String(info.url).replace(/\/+$/, '');
}

/**
 * Raw POST to a subpath. Returns { status, json }. Throws GraphError on 4xx/5xx (structured body).
 * 200 (incl. non-ready reads {state,hint}) and 202 (ingest accepted) are success.
 */
async function post(base, sub, ctx, extra = {}, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const body = { path: ctx.root, ...extra };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/v1/graph/${sub}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    // timeout still ACTIVE here → also bounds reading the BODY (not just headers). clearTimeout in finally.
    let json = null;
    try { json = await res.json(); } catch (e) { void e; /* non-JSON body */ }
    if (res.status === 200 || res.status === 202) return { status: res.status, json: json || {} };
    const code = (json && (json.code || json.error)) || httpCodeName(res.status);
    const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    throw new GraphError(res.status, code, (json && json.message) || code, {
      mappedRoot: json && json.mappedRoot, requestedRoot: json && json.requestedRoot,
      retryAfter: retryAfter ? Number(retryAfter) || retryAfter : undefined,
      hint: json && json.hint, state: json && json.state,
    });
  } catch (e) {
    if (e instanceof GraphError) throw e; // don't re-wrap a typed error as NETWORK
    throw new GraphError(0, 'NETWORK', 'failed/timeout talking to the graph: ' + (e && e.message || e));
  } finally {
    clearTimeout(t);
  }
}

function httpCodeName(s) {
  return ({ 400: 'BAD_FIELD', 404: 'SUBPATH_OR_API_MISSING', 405: 'METHOD_NOT_ALLOWED', 503: 'GRAPH_DISABLED' })[s] || ('HTTP_' + s);
}

/**
 * Capability probe (cheap, cached 1×/base): confirm /api/v1/graph exists. 200→ok; 404→daemon<2.23;
 * 503→graph off. Distinguishes "old daemon" from "wrong route" (discover accepts 503 as alive).
 */
const _capCache = new Map();
function __clearCapCache() { _capCache.clear(); } // test seam
async function ensureCapable(base, ctx, { fetchImpl = globalThis.fetch } = {}) {
  if (_capCache.get(base)) return true;
  try {
    await post(base, 'status', ctx, {}, { fetchImpl, timeoutMs: 8000 });
    _capCache.set(base, true);
    return true;
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) {
      throw new GraphError(404, 'GRAPH_API_MISSING', 'the memory daemon does not expose the Graph API — update the native-java memory daemon to a version with /api/v1/graph (install the new JAR in ~/.mcp-memory/lib and restart).');
    }
    throw e;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple /status. */
async function status(base, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const { json } = await post(base, 'status', ctx, {}, { fetchImpl });
  return json; // {project_id, root, state, nodes, edges, topHubs?, report?, error?, hint?}
}

/**
 * NORMATIVE state machine (spec §5c): ensure the graph is usable and return the last /status.
 *   ready→(refresh?ingest+poll:use); indexing→poll; not_indexed→ingest+poll; failed→1 retry; 429→return state.
 * Never polls forever (deadline). Returns { state, nodes, edges, report?, timedOut?, queued?, retryAfter? }.
 */
async function ensureReady(base, ctx, { refresh = false, deadlineMs = 180000, onProgress, fetchImpl = globalThis.fetch, sleepImpl = realSleep } = {}) {
  let st = await status(base, ctx, { fetchImpl });
  const report0 = st.report; // capture the first read's report (expires after TTL)
  if (st.state === 'ready' && !refresh) return st;

  // If the INITIAL state is already failed, the ingest below is the "1 try" (spec §5c) → don't repeat in the loop.
  let triedFailedRetry = st.state === 'failed';
  const started = Date.now();
  // Fire ingest only when it MAKES SENSE: not_indexed/failed, or ready+refresh. NEVER on indexing (already running).
  const shouldIngest = st.state === 'not_indexed' || st.state === 'failed' || (refresh && st.state === 'ready');
  if (shouldIngest) {
    try {
      const ing = await post(base, 'ingest', ctx, {}, { fetchImpl });
      if (ing.status === 202) st = { ...st, state: 'indexing' };
    } catch (e) {
      if (e instanceof GraphError && e.status === 429) {
        return { ...st, queued: true, retryAfter: e.retryAfter };
      }
      throw e;
    }
  }

  // poll with backoff until ready|failed|deadline
  let wait = 2000;
  while (st.state === 'indexing') {
    if (Date.now() - started > deadlineMs) return { ...st, timedOut: true, report: st.report || report0 };
    await sleepImpl(wait);
    wait = Math.min(wait * 2, 15000);
    st = await status(base, ctx, { fetchImpl });
    if (onProgress) { try { onProgress(st.state, st.nodes); } catch (e) { void e; } }
    if (st.state === 'failed' && !triedFailedRetry) {
      triedFailedRetry = true;
      try { await post(base, 'ingest', ctx, {}, { fetchImpl }); st = { ...st, state: 'indexing' }; wait = 2000; }
      catch (e) { if (e instanceof GraphError && e.status === 429) return { ...st, queued: true, retryAfter: e.retryAfter }; throw e; }
    } else if (st.state === 'failed') {
      return st; // failed again → stop (caller shows st.error)
    }
  }
  return { ...st, report: st.report || report0 };
}

// Reads (never ingest). Clamps applied here.
async function symbols(base, ctx, { query = '', limit, fetchImpl = globalThis.fetch } = {}) {
  const { json } = await post(base, 'symbols', ctx, { query: query || '', limit: clampInt(limit, 20, 100) }, { fetchImpl });
  return json; // {symbols:[...], truncated?}
}
async function search(base, ctx, { query, topK, hops, fetchImpl = globalThis.fetch } = {}) {
  if (!query || !String(query).trim()) throw new GraphError(0, 'BAD_FIELD', "graph_search requires 'query'.");
  const { json } = await post(base, 'search', ctx, { query: String(query), topK: clampInt(topK, 8, 25), hops: clampInt(hops, 1, 2) }, { fetchImpl });
  return json; // {seed:[...], expanded:[...], truncated?}
}
async function callers(base, ctx, { id, limit, fetchImpl = globalThis.fetch } = {}) {
  if (!id) throw new GraphError(0, 'BAD_FIELD', "graph_callers requires 'id'.");
  // Cut 1: /callers accepts ONLY {id} (no pagination). Fetch the whole list and TRUNCATE client-side.
  const { json } = await post(base, 'callers', ctx, { id: String(id) }, { fetchImpl });
  return capList(json, 'callers', clampInt(limit, 50, 100));
}
async function references(base, ctx, { id, limit, fetchImpl = globalThis.fetch } = {}) {
  if (!id) throw new GraphError(0, 'BAD_FIELD', "graph_references requires 'id'.");
  const { json } = await post(base, 'references', ctx, { id: String(id) }, { fetchImpl });
  return capList(json, 'references', clampInt(limit, 50, 100));
}

/**
 * Truncate CLIENT-side (Cut 1 server does not paginate callers/references): keep the top-N by
 * PageRank and mark truncated. Protects the agent context on a giant hub without server support.
 */
function capList(json, key, cap) {
  const arr = Array.isArray(json && json[key]) ? json[key] : [];
  if (arr.length <= cap) return json;
  const sorted = arr.slice().sort((a, b) => ((b && b.pagerank) || 0) - ((a && a.pagerank) || 0)).slice(0, cap);
  return { ...json, [key]: sorted, truncated: true, totalCount: arr.length };
}

/**
 * CALLS-by-extension caveat (spec §8/§10): only Java extracts CALLS in Cut 1. Empty in another
 * language = "no CALLS extracted", not "no callers".
 */
const CALLS_LANGS = new Set(['java']);
function callsCaveatFor(nodeOrFile) {
  let f = typeof nodeOrFile === 'string' ? nodeOrFile : (nodeOrFile && nodeOrFile.file);
  if (typeof f === 'string' && f.includes('::')) f = f.split('::')[0]; // node id (file::symbol) → file part
  const ext = String(f || '').split('.').pop();
  const lower = ext && ext.toLowerCase();
  return lower && !CALLS_LANGS.has(lower)
    ? `Note: CALLS is only extracted for Java in Cut 1; the list for .${lower} may be incomplete (no calls extracted).`
    : null;
}

/** Honest "0 nodes" message (spec §8): use report when present; conservative otherwise. */
function zeroNodesMessage(st) {
  const r = st && st.report;
  if (!r) return 'empty graph; the cause (unsupported language vs empty repo) is unavailable because the report expired. Run graph_ingest with refresh:true to regenerate (pays a re-walk).';
  if (r.scanned > 0 && r.files === 0) return `${r.scanned} file(s) present, but none of a language the graph supports (e.g. extensions outside the list).`;
  if ((r.scanned || 0) === 0) return 'empty repo or only pruned directories.';
  if ((r.files || 0) > 0) return `${r.files} code file(s) read, but no symbols extracted.`;
  return 'empty graph.';
}

module.exports = {
  GraphError, clampInt, httpCodeName, graphContextFor, assertSafeRoot, graphBase, post,
  ensureCapable, status, ensureReady, symbols, search, callers, references, capList,
  callsCaveatFor, zeroNodesMessage, __clearCapCache,
};
