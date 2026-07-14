/**
 * self-review-retrieve.js — embedder-free KB retrieval for the D1 self-review
 * Stop detector.
 *
 * HARD CONSTRAINT: never load the embedding model in the hook process. Two paths:
 *   1. PRIMARY — the warm brain-server HTTP daemon (model already loaded there).
 *      Minimal token-aware MCP-over-HTTP call to `brain_search`. Best-effort:
 *      guarded by lock-file presence + a short timeout; ANY failure returns null.
 *   2. FALLBACK — keyword-only via the inverted `brain-index` + `brain-store.get`
 *      (no embedder). Always available.
 *
 * The pure helpers (parse/gate/filter) are exported for unit tests; the network
 * + store I/O is isolated so tests can drive a fake daemon or a seeded store.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

function dataDir() {
  return require('./data-dir.js').dataDir();
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a brain_search MCP tool result envelope into an entries array.
 * The tool returns `{ content:[{ type:'text', text:'<json>' }] }` where the JSON
 * is `{ results:[...] }`. Tolerant: returns [] on any shape mismatch.
 * @param {object} toolResult
 * @returns {object[]}
 */
function parseSearchResult(toolResult) {
  try {
    const text = toolResult && toolResult.content && toolResult.content[0] && toolResult.content[0].text;
    if (!text) return [];
    const obj = JSON.parse(text);
    return Array.isArray(obj.results) ? obj.results : [];
  } catch (err) {
    console.error(`[self-review-retrieve] parse failed: ${err.message}`);
    return [];
  }
}

/**
 * Keep only entries whose type is in `types` (case-insensitive). Empty/absent
 * `types` keeps all.
 * @param {object[]} entries
 * @param {string[]} types
 * @returns {object[]}
 */
function filterByType(entries, types) {
  if (!Array.isArray(entries)) return [];
  if (!Array.isArray(types) || types.length === 0) return entries;
  const set = new Set(types.map(t => String(t || '').toLowerCase()));
  return entries.filter(e => set.has(String((e && e.type) || '').toLowerCase()));
}

/**
 * Apply the relevance gate + cap: keep entries with score >= minScore (entries
 * without a numeric score pass — keyword fallback scores differ), sort by score
 * desc, take topK.
 * @param {object[]} entries
 * @param {{minScore:number, topK:number}} opts
 * @returns {object[]}
 */
function applyGate(entries, { minScore = 0.2, topK = 2 } = {}) {
  if (!Array.isArray(entries)) return [];
  const gated = entries.filter(e => {
    const s = e && typeof e.score === 'number' ? e.score : null;
    return s === null ? true : s >= minScore;
  });
  gated.sort((a, b) => (Number(b && b.score) || 0) - (Number(a && a.score) || 0));
  return gated.slice(0, Math.max(0, topK));
}

// ── Primary path: warm HTTP daemon (token-aware, best-effort) ─────────────────

function lockPath(dir) { return path.join(dir, 'brain-http.lock.json'); }
function tokenPath(dir) { return path.join(dir, 'brain-http.token'); }

/** Read {port} from the daemon lock file, or null when absent/unreadable. */
function readDaemonPort(dir) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    return Number.isInteger(lock.port) && lock.port > 0 ? lock.port : null;
  } catch (err) { void err; return null; }
}

function readDaemonToken(dir) {
  const env = (process.env.BRAIN_HTTP_TOKEN || '').trim();
  if (env) return env;
  try { return fs.readFileSync(tokenPath(dir), 'utf8').trim() || null; }
  catch (err) { void err; return null; }
}

/**
 * One token-authenticated JSON-RPC POST to the daemon's /mcp. Resolves the parsed
 * response body; rejects on non-2xx / timeout / bad JSON. Captures the
 * mcp-session-id response header via `onHeaders`.
 */
function daemonPost({ port, token, sessionId, body, timeoutMs }, onHeaders) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': data.length,
      'Authorization': `Bearer ${token}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        if (typeof onHeaders === 'function') onHeaders(res.headers);
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
          if (!buf) return resolve(undefined); // notification ack
          try { resolve(JSON.parse(buf)); }
          catch (err) { reject(new Error(`bad JSON: ${err.message}`)); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Query the warm daemon's `brain_search`. Returns entries[] on success, or null
 * when the daemon is unavailable / the handshake fails (caller falls back).
 * @param {string} query
 * @param {{dataDir?:string, project:string, topK:number, minScore:number, timeoutMs?:number}} opts
 * @returns {Promise<object[]|null>}
 */
async function retrieveViaDaemon(query, opts = {}) {
  const dir = opts.dataDir || dataDir();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1500;
  const port = readDaemonPort(dir);
  const token = readDaemonToken(dir);
  if (!port || !token) return null;

  try {
    let sessionId = null;
    const init = await daemonPost({
      port, token, timeoutMs,
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-review', version: '1' } },
      },
    }, (h) => { sessionId = h['mcp-session-id'] || null; });
    if (!init || init.error || !sessionId) return null;

    // Required by the StreamableHTTP lifecycle before other requests.
    await daemonPost({
      port, token, sessionId, timeoutMs,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    }).catch(() => { /* notification ack is best-effort */ });

    const call = await daemonPost({
      port, token, sessionId, timeoutMs,
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'brain_search',
          arguments: { query, project: opts.project, topK: (opts.topK || 2) + 4, minScore: opts.minScore, scope: 'both' },
        },
      },
    });
    // Fail to null (→ keyword fallback) on BOTH a JSON-RPC transport error AND a
    // tool-level error: the server returns brain_search failures as a successful
    // response whose result is { isError:true, content:[...] }, so `call.error`
    // alone misses them and we'd otherwise parse the error text → [] (no fallback).
    if (!call || call.error || (call.result && call.result.isError)) return null;
    return parseSearchResult(call.result);
  } catch (err) {
    console.error(`[self-review-retrieve] daemon query failed: ${err.message}`);
    return null;
  }
}

// ── Fallback path: keyword inverted index (embedder-free) ─────────────────────

/**
 * Keyword-only retrieval: brain-index.lookup(keywords) → brain-store.get(id).
 * No embedder is loaded. Returns entries[] (possibly empty).
 *
 * `opts._store`/`opts._index` inject isolated module instances (tests only) so
 * the shared singletons aren't raced by concurrent test bodies; production omits
 * them and uses the process singletons.
 * @param {string[]} keywords
 * @param {{project:string, topK:number, _store?:object, _index?:object}} opts
 * @returns {Promise<object[]>}
 */
async function retrieveViaIndex(keywords, opts = {}) {
  const project = opts.project || 'default';
  const topK = opts.topK || 2;
  try {
    const index = opts._index || require('../brain-index.js');
    const store = opts._store || require('../brain-store.js');
    await index.init({ project });
    await store.init({ project, skipEmbedder: true });
    const hits = await index.lookup(keywords, { project, topK: topK + 6 });
    const out = [];
    for (const h of hits) {
      const entry = await store.get(h.id);
      if (entry) out.push({ ...entry, score: h.score });
    }
    return out;
  } catch (err) {
    console.error(`[self-review-retrieve] index query failed: ${err.message}`);
    return [];
  }
}

/**
 * Retrieve relevant lessons/failures for the self-review detector. Tries the warm
 * daemon first (semantic), falls back to keyword. Never loads the embedder here.
 * @param {{query:string, keywords:string[]}} q
 * @param {{dataDir?:string, project:string, topK:number, minScore:number, types:string[], timeoutMs?:number, _store?:object, _index?:object}} opts
 * @returns {Promise<{entries:object[], source:'daemon'|'index'|'none'}>}
 */
async function retrieve(q, opts = {}) {
  const { query, keywords } = q || {};
  const topK = opts.topK || 2;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.2;
  const types = opts.types || ['lesson', 'failure'];

  let entries = await retrieveViaDaemon(query, { dataDir: opts.dataDir, project: opts.project, topK, minScore, timeoutMs: opts.timeoutMs });
  let source = 'daemon';
  if (entries === null) {
    entries = await retrieveViaIndex(keywords || [], { project: opts.project, topK, _store: opts._store, _index: opts._index });
    source = 'index';
  }

  const gated = applyGate(filterByType(entries, types), { minScore, topK });
  return { entries: gated, source: gated.length ? source : 'none' };
}

module.exports = {
  retrieve,
  retrieveViaDaemon,
  retrieveViaIndex,
  parseSearchResult,
  filterByType,
  applyGate,
  readDaemonPort,
  readDaemonToken,
};
