#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { buildEmbedText } = require('./lib/embed-text.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

let _config = null;
let _mode = null;
let _project = 'default';
let _initialized = false;
let _store = null;
let _index = null;
let _graph = null;
let _embedder = null;
let _mcp = null;

// Shipped config (config/brain-config.json) ⊕ per-user override
// (DATA_DIR/brain/user-config.json). Delegating to lib/brain-config keeps the
// merge in ONE place: this is what lets a user enable the mcp-memory backend +
// ingestion for THEMSELVES without editing the shipped file (which would break
// everyone who installs the plugin without the external daemon), and the
// override survives plugin auto-update.
function loadConfig() {
  if (_config) return _config;
  try {
    _config = require('./lib/brain-config.js').load();
  } catch (e) {
    console.error(`[BRAIN-BACKEND] Config load error: ${e.message}`);
    _config = {};
  }
  return _config;
}

/** Test/dashboard hook: drop cached config + mode so the next load re-reads disk. */
function _resetConfig() {
  _config = null;
  _mode = null;
  try { require('./lib/brain-config.js')._resetCache(); } catch (err) { void err; }
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// ── MCP mode wrappers ──
//
// These target the Native Java mcp-memory-server tool contract (v2.10.x):
//   add_document    { content, metadata?, documentId? } → "Document added with ID: <uuid>"
//   search_memory   { query, topK?, minScore?, metadata? } → {results:[{text,score,documentId,chunkIndex}]}
//   get_document    { documentId }    delete_document { documentId }
//   list_documents  { metadata? }     summarize_memory { query?, maxItems?, metadata? }
// There is no get_related_documents — relatedness is emulated via a semantic search.
// Project scope is set ONCE at the MCP `initialize` handshake (projectId), so the
// per-call payloads never repeat it.

function parseResult(result) {
  if (!result || !result.text) return null;
  try { return JSON.parse(result.text); }
  catch (err) {
    console.error(`[BRAIN-BACKEND] parseResult: ${err.message}`);
    return { text: result.text };
  }
}

/** search_memory returns an OBJECT {results:[...]}, not a bare array. */
function parseSearchResults(result) {
  const data = parseResult(result);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.documents)) return data.documents;
  return [];
}

/** list_documents may return an array or {documents|results|items:[...]}. */
function parseListResults(result) {
  const data = parseResult(result);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.documents || data.results || data.items || [];
}

/** add_document returns plain text "Document added with ID: <uuid>" (not JSON). */
function parseAddedId(result) {
  if (!result || !result.text) return '';
  const m = String(result.text).match(/ID:\s*([0-9a-fA-F-]{8,})/);
  return m ? m[1] : '';
}

/** Build a one-line title from free text when the daemon returns no metadata. */
function deriveTitle(text) {
  const first = String(text || '').split(/\r?\n/)[0].trim();
  return first.length > 80 ? `${first.slice(0, 77)}...` : (first || 'memory');
}

async function initMcp() {
  const config = loadConfig();
  const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
  const transport = mcpCfg.transport === 'http' ? 'http' : 'stdio';
  const McpClient = require('./mcp-client.js');

  if (transport === 'http') {
    // Remote mode: talk to an already-running daemon. URL is explicit or
    // auto-discovered from ~/.mcp-memory/run/daemon.json. No JAR, no spawn.
    _mcp = new McpClient({
      transport: 'http',
      serverUrl: mcpCfg.serverUrl || '',
      runDir: mcpCfg.runDir || '',
      projectId: mcpCfg.projectId || _project,
      timeout: mcpCfg.timeout || 60000,
    });
    await _mcp.connect();
    return;
  }

  const jarDir = path.join(DATA_DIR, 'mcp');
  if (!fs.existsSync(jarDir)) fs.mkdirSync(jarDir, { recursive: true });
  const jarPath = mcpCfg.jarPath || path.join(jarDir, 'mcp-memory-server.jar');
  _mcp = new McpClient({
    jarPath,
    workspacePath: path.join(DATA_DIR, 'brain', _project),
    javaArgs: mcpCfg.javaArgs || ['-Xmx512m'],
    downloadUrl: mcpCfg.downloadUrl || '',
    expectedSha256: mcpCfg.expectedSha256 || '',
    projectId: mcpCfg.projectId || _project,
    timeout: mcpCfg.timeout || 60000,
  });
  await _mcp.connect();
}

/** Pack a Boss entry into a single searchable content blob for the daemon. */
function entryToContent(entry) {
  const detail = typeof entry.content === 'string'
    ? entry.content
    : (entry.content && entry.content.detail) || '';
  return [entry.title, entry.summary, detail].map(s => (s || '').trim()).filter(Boolean).join('\n\n')
    || JSON.stringify(entry.content || {});
}

async function saveMcp(entry) {
  const metadata = {
    title: entry.title || '',
    type: entry.type || 'note',
    tags: entry.tags || [],
    confidence: entry.confidence || 0.5,
    scope: entry.scope || '',
    sessionId: entry.session_id || '',
    source: entry.source || {},
    ...(entry.id ? { brainId: entry.id } : {}),
  };
  const result = await _mcp.callTool('add_document', {
    content: entryToContent(entry),
    metadata,
  });
  return parseAddedId(result) || entry.id || uuid();
}

async function getMcp(id) {
  const result = await _mcp.callTool('get_document', { documentId: id });
  const data = parseResult(result);
  if (!data) return null;
  return normalizeEntry(data);
}

function normalizeEntry(data) {
  const meta = data.metadata || {};
  const entry = { ...data };
  entry.id = data.documentId || data.id || meta.brainId || '';
  entry.title = data.title || meta.title || deriveTitle(data.content || data.text || '');
  entry.summary = data.summary || meta.summary || (typeof data.content === 'string' ? data.content : data.text || '');
  entry.type = data.type || meta.type || 'note';
  entry.tags = data.tags || meta.tags || [];
  entry.content = data.content || {};
  entry.source = data.source || meta.source || {};
  entry.confidence = data.confidence || meta.confidence || 0.5;
  entry.session_id = data.sessionId || meta.sessionId || data.session_id || '';
  entry.created_at = data.createdAt || data.created_at || now();
  entry.access_count = data.accessCount || data.access_count || 0;
  if (typeof entry.content === 'string') {
    try { entry.content = JSON.parse(entry.content); } catch { entry.content = { text: entry.content }; }
  }
  if (typeof entry.source === 'string') {
    try { entry.source = JSON.parse(entry.source); } catch { entry.source = { url: entry.source }; }
  }
  return entry;
}

async function searchMcp(query, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0;
  const result = await _mcp.callTool('search_memory', {
    query: typeof query === 'string' ? query : '',
    topK,
    ...(minScore > 0 ? { minScore } : {}),
    ...(opts.type ? { metadata: { type: opts.type } } : {}),
    ...(opts.includeHome ? { includeHome: true } : {}),
  });
  return parseSearchResults(result).slice(0, topK).map(item => normalizeSearchItem(item));
}

function normalizeSearchItem(item) {
  const meta = item.metadata || {};
  const text = item.text || item.summary || '';
  return {
    id: item.documentId || item.id || '',
    title: item.title || meta.title || deriveTitle(text),
    summary: item.summary || text,
    type: item.type || meta.type || 'memory',
    score: item.score || item.relevance || 0,
    confidence: item.confidence || meta.confidence || 0.5,
    createdAt: item.createdAt || item.created_at || '',
    accessCount: item.accessCount || item.access_count || 0,
  };
}

async function searchByKeywordsMcp(keywords, opts = {}) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  return searchMcp(keywords.join(' '), opts);
}

// ── compose_recall: the two-level relevance-injected entry point (server >=2.18) ──
// FACT blocks carry the matched `text` inline (grounding); CAPABILITY blocks stay
// pointers (progressive disclosure). scope === 'home' is the never-filtered spine.
const COMPOSE_FACT_BLOCKS = new Set(['procedural', 'knowledge']);
const COMPOSE_CAPABILITY_BLOCKS = new Set(['skill', 'skill_global', 'setup']);

/** ADR-008 lifecycle: hard-exclude invalidated items client-side (annotation ships since 2.12). */
function isInvalidated(item) {
  const ls = item && item.lifecycleState;
  const status = ls && (ls.status || ls.state);
  return String(status || '').toLowerCase() === 'invalidated';
}

/**
 * Split a compose_recall envelope into grounding FACTS (with inline text, a title
 * derived from `text` when the raw doc has name=null — DH4) and CAPABILITY pointers.
 * Pure → unit-testable against the live envelope shape.
 */
function splitComposeBlocks(blocks) {
  const facts = [];
  const capabilities = [];
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    const block = b && b.block;
    const scope = (b && b.scope) || '';
    const items = (b && Array.isArray(b.items)) ? b.items : [];
    for (const it of items) {
      if (!it || isInvalidated(it)) continue;
      const id = it.id || it.documentId || '';
      const score = it.score || 0;
      if (COMPOSE_FACT_BLOCKS.has(block)) {
        const text = typeof it.text === 'string' ? it.text : '';
        const title = it.name || deriveTitle(text) || deriveTitle(it.description || '') || '(memory)';
        facts.push({ id, title, type: it.type || block, scope, summary: text || it.description || '', text, score });
      } else if (COMPOSE_CAPABILITY_BLOCKS.has(block)) {
        capabilities.push({ id, name: it.name || '(unnamed)', description: it.description || '', type: it.type || block, scope, score });
      }
    }
  }
  return { facts, capabilities };
}

/** compose_recall envelope → { blocks:[...] } → structured {facts, capabilities, entries}. */
function parseComposeEnvelope(result) {
  const data = parseResult(result);
  const blocks = (data && Array.isArray(data.blocks)) ? data.blocks : [];
  const { facts, capabilities } = splitComposeBlocks(blocks);
  // entries mirrors the legacy flat shape so retrieval telemetry (% cited) keeps working.
  const entries = facts.map(f => ({ id: f.id, title: f.title, type: f.type, summary: f.summary, score: f.score }));
  return { facts, capabilities, entries };
}

async function composeMcp(query, opts = {}) {
  const args = { query: typeof query === 'string' ? query : '', includeLifecycleState: true };
  if (opts.metadata && typeof opts.metadata === 'object') args.metadata = opts.metadata;
  if (opts.setup) args.setup = true;
  const result = await _mcp.callTool('compose_recall', args);
  return parseComposeEnvelope(result);
}

// ── cooperative ingestion: send raw transcript; the server distills/types/scopes ──
async function ingestConversationMcp(raw, opts = {}) {
  const result = await _mcp.callTool('ingest_conversation', {
    consumerId: opts.consumerId || 'claude-code-boss',
    sessionId: opts.sessionId || 'default',
    raw: String(raw == null ? '' : raw),
  });
  return parseResult(result) || {};
}

async function ingestStatusMcp(opts = {}) {
  const result = await _mcp.callTool('ingest_status', {
    consumerId: opts.consumerId || 'claude-code-boss',
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  return parseResult(result) || {};
}

async function deleteMcp(id) {
  await _mcp.callTool('delete_document', { documentId: id });
}

async function listMcp(type, _project) {
  const result = await _mcp.callTool('list_documents', {
    ...(type ? { metadata: { type } } : {}),
  });
  return parseListResults(result).map(item => normalizeSearchItem(item));
}

async function countMcp() {
  // No dedicated count tool — list (scoped by the session projectId) and count.
  const result = await _mcp.callTool('list_documents', {});
  const data = parseResult(result);
  if (data && typeof data.count === 'number') return data.count;
  if (data && typeof data.totalDocuments === 'number') return data.totalDocuments;
  return parseListResults(result).length;
}

async function getRelatedMcp(id) {
  // The daemon has no relatedness tool — emulate it: fetch the doc, then run a
  // semantic search with its own text and drop the seed document from the hits.
  let seed;
  try { seed = await getMcp(id); }
  catch (err) { console.error(`[BRAIN-BACKEND] getRelatedMcp seed: ${err.message}`); return []; }
  if (!seed) return [];
  const queryText = [seed.title, seed.summary].filter(Boolean).join(' ').trim()
    || deriveTitle(seed.content && seed.content.text);
  if (!queryText) return [];
  const hits = await searchMcp(queryText, { topK: 11 });
  return hits.filter(h => h.id && h.id !== id).slice(0, 10).map(h => ({
    id: h.id,
    title: h.title,
    type: h.type,
    score: h.score,
    edgeType: 'related',
  }));
}

// ── Local mode: wraps store + index + graph + embedder ──

async function initLocal(opts = {}) {
  _store = require('./brain-store.js');
  _index = require('./brain-index.js');
  _graph = require('./brain-graph.js');
  _embedder = require('./brain-embedder.js');
  await _store.init({ project: _project });
  await _index.init({ project: _project });
  if (_graph.init) await _graph.init({ project: _project });
  // Skipping the embedder init avoids loading the @xenova/transformers ONNX
  // model (~tens of MB into memory + cold-start latency). The hot retrieval
  // path (PreToolUse / UserPromptSubmit hooks) only needs keyword fallback,
  // so callers pass {skipEmbedder:true} to keep hook latency low. searchLocal
  // already handles missing embedder gracefully (embedOk=false → keyword path).
  if (!opts.skipEmbedder) await _embedder.init();
}

function extractKeywords(text) {
  return _textUtils.extractKeywords(text, { minLen: 4, maxTokens: 50 });
}

async function searchLocal(query, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0;
  const typeFilter = opts.type || null;
  const filterOpts = { topK, minScore };
  if (typeFilter) filterOpts.type = typeFilter;

  if (typeof query === 'string') {
    const embedOk = _embedder && _embedder.getStatus && _embedder.getStatus().ready;
    if (embedOk) {
      const vector = await _embedder.embed(query);
      if (vector) {
        const results = await _store.search(vector, filterOpts);
        if (results.length >= topK) return results;
      }
    }
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];
    const kwResults = await _index.lookup(keywords, { topK: Math.max(topK * 3, 15), type: typeFilter });
    // _index.lookup ignores minScore — apply it here so callers get a consistent contract
    // regardless of which path (embed vs keyword) served the result.
    const filtered = minScore > 0
      ? kwResults.filter(r => (typeof r.score === 'number' ? r.score : 0) >= minScore)
      : kwResults;
    const entries = [];
    for (const r of filtered.slice(0, topK)) {
      const entry = await _store.get(r.id);
      if (entry) entries.push({ ...entry, score: r.score });
    }
    return entries;
  }

  return _store.search(query, filterOpts);
}

async function saveLocal(entry) {
  if (!entry.id) entry.id = uuid();
  if (!entry.created_at) entry.created_at = now();
  // Embed title+summary ONLY (buildEmbedText) — including `detail` dilutes the
  // vector below the retrieval gate (measured cos 0.51→0.13). Single write WITH
  // the vector: the old path did save() then get()+re-save, which double-wrote and
  // bumped access_count on brand-new entries (skewing the frequency rerank term).
  // A failing embed must NOT lose the entry — persist it without a vector (a later
  // brain-reembed can backfill), matching the old save-first durability.
  const embedOk = _embedder && _embedder.getStatus && _embedder.getStatus().ready;
  let vector = null;
  if (embedOk) {
    try { vector = await _embedder.embed(buildEmbedText(entry)); }
    catch (err) { console.error(`[brain] embed failed, saving entry without vector: ${err.message}`); }
  }
  const id = await _store.save(entry, vector || undefined);
  const keywords = extractKeywords(`${entry.title} ${entry.summary} ${JSON.stringify(entry.content || {})}`);
  if (keywords.length > 0) {
    await _index.index(entry);
  }
  if (_graph && _graph.registerNode) {
    // registerNode expects the full entry (uses entry.id, entry.type, entry.title, ...).
    await _graph.registerNode({ ...entry, id });
  }
  return id;
}

async function getLocal(id) {
  return _store.get(id);
}

async function searchByKeywordsLocal(keywords, opts = {}) {
  const normalized = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) return [];
  const kwResults = await _index.lookup(normalized, { topK: opts.topK || 5, type: opts.type || null });
  const entries = [];
  for (const r of kwResults.slice(0, opts.topK || 5)) {
    const entry = await _store.get(r.id);
    if (entry) entries.push({ ...entry, score: r.score });
  }
  return entries;
}

async function deleteLocal(id) {
  return _store.delete({ id });
}

async function listLocal(type, project) {
  return _store.list(type, project);
}

async function countLocal() {
  return _store.count();
}

async function getRelatedLocal(id) {
  if (!_graph || !_graph.getRelated) return [];
  const related = await _graph.getRelated(id);
  const full = [];
  for (const r of related) {
    const entry = await _store.get(r.id);
    if (entry) full.push({ ...entry, edgeType: r.edgeType, score: r.weight || 0 });
  }
  return full;
}

function statusLocal() {
  const storeStatus = _store ? _store.getStatus() : {};
  const indexStatus = _index ? _index.getStatus() : {};
  return {
    mode: 'local',
    project: _project,
    dir: storeStatus.dir || '',
    storage: storeStatus.storage || 'none',
    initialized: _initialized,
    entries: { indexes: indexStatus.keywordCount || 0 },
  };
}

function statusMcp() {
  return {
    mode: 'mcp-memory',
    project: _project,
    connected: _mcp ? _mcp.isConnected() : false,
    initialized: _initialized,
  };
}

// ── Public API ──

/**
 * Whether an already-initialized backend must RE-initialize because the caller
 * asked for a DIFFERENT project. The project scopes the MCP handshake (projectId
 * in mcp-memory mode) and the local store path — reusing the first project's
 * client/store for a second project silently cross-contaminates scope (the
 * persistent brain-server serves multiple sessions). A project-less call
 * (no `requestedProject`) NEVER clobbers the current scope. Pure → unit-testable.
 */
function needsReinit(state, requestedProject) {
  if (!state || !state.initialized) return false;
  if (requestedProject == null || requestedProject === '') return false;
  return requestedProject !== state.project;
}

async function init(opts = {}) {
  if (_initialized) {
    if (!needsReinit({ initialized: _initialized, mode: _mode, project: _project }, opts.project)) {
      return;
    }
    // Explicit different project → tear down the first-project client/store and
    // re-scope, so recall/save never leak across projects.
    await close();
  }
  _project = opts.project || 'default';
  const config = loadConfig();
  _mode = (config.backend && config.backend.type) || 'local';

  if (_mode === 'mcp-memory') {
    await initMcp();
  } else {
    await initLocal({ skipEmbedder: !!opts.skipEmbedder });
  }
  _initialized = true;
}

async function save(entry) {
  if (!entry) throw new Error('save: entry is required');
  if (_mode === 'mcp-memory') return saveMcp(entry);
  return saveLocal(entry);
}

async function get(id) {
  if (!id) return null;
  if (_mode === 'mcp-memory') return getMcp(id);
  return getLocal(id);
}

async function search(query, opts = {}) {
  if (_mode === 'mcp-memory') return searchMcp(query, opts);
  return searchLocal(query, opts);
}

/** True iff the mcp-memory daemon advertised compose_recall (fail-loud guard). */
function hasCompose() {
  return _mode === 'mcp-memory' && !!_mcp && _mcp.hasToolAvailable('compose_recall');
}

/**
 * Two-level relevance recall via compose_recall. mcp-memory ONLY — compose is a
 * server capability; the local flat backend has no equivalent. Returns
 * { facts, capabilities, entries }.
 */
async function compose(query, opts = {}) {
  if (_mode !== 'mcp-memory') throw new Error('compose is only available on the mcp-memory backend');
  return composeMcp(query, opts);
}

/**
 * Ship a raw conversation transcript to the server's cooperative ingestion
 * (`ingest_conversation`). The server distills/types/scopes/curates + dedups by
 * event-id — the client is the "dumb consumer". mcp-memory ONLY.
 */
async function ingestConversation(raw, opts = {}) {
  if (_mode !== 'mcp-memory') throw new Error('ingestConversation is only available on the mcp-memory backend');
  return ingestConversationMcp(raw, opts);
}

/** Staging observability for a consumer×session (pending/cooldown/success/…). mcp-memory ONLY. */
async function ingestStatus(opts = {}) {
  if (_mode !== 'mcp-memory') throw new Error('ingestStatus is only available on the mcp-memory backend');
  return ingestStatusMcp(opts);
}

/**
 * Pool-warming exposure (ADR-017, server >=2.20). Runs a home-FEDERATED
 * `search_memory` (`includeHome:true`) so HOME-scoped docs — the ingested
 * conversation pool — become candidates and the server records recall telemetry
 * (`recordTopRecall`) on the top hit. This is the graduation signal: docs that
 * prove useful across queries get promoted (async Dreaming) into procedural[HOME],
 * which compose then reads. Results are NOT injected into the user prompt — this
 * is a signal-generation pass only. mcp-memory ONLY; best-effort at the call site.
 */
async function warmPool(query, opts = {}) {
  if (_mode !== 'mcp-memory') return [];
  return searchMcp(query, { topK: opts.topK || 5, includeHome: true });
}

async function searchByKeywords(keywords, opts = {}) {
  if (_mode === 'mcp-memory') return searchByKeywordsMcp(keywords, opts);
  return searchByKeywordsLocal(keywords, opts);
}

async function delete_(id) {
  if (!id) return;
  if (_mode === 'mcp-memory') return deleteMcp(id);
  return deleteLocal(id);
}

async function list(type, project) {
  if (_mode === 'mcp-memory') return listMcp(type, project);
  return listLocal(type, project);
}

async function count() {
  if (_mode === 'mcp-memory') return countMcp();
  return countLocal();
}

async function getRelated(id) {
  if (!id) return [];
  if (_mode === 'mcp-memory') return getRelatedMcp(id);
  return getRelatedLocal(id);
}

async function close() {
  if (_mcp) {
    _mcp.close();
    _mcp = null;
  }
  if (_store && _store.close) await _store.close();
  _initialized = false;
}

function getStatus() {
  if (_mode === 'mcp-memory') return statusMcp();
  return statusLocal();
}

function getMode() { return _mode; }

/** Read the configured backend type WITHOUT connecting (for hot-path routing). */
function peekMode() {
  if (_mode) return _mode;
  const config = loadConfig();
  return (config.backend && config.backend.type) || 'local';
}

// text utilities centralized in lib/text-utils.js (STOP_WORDS + extractKeywords)
const _textUtils = require('./lib/text-utils.js');

module.exports = {
  init, save, get, search, searchByKeywords,
  compose, hasCompose, ingestConversation, ingestStatus, warmPool,
  delete: delete_, list, count, getRelated, close,
  getStatus, getMode, peekMode, _resetConfig,
  // Exposed for deterministic offline tests of the MCP-tool mappings.
  __testHooks: {
    parseSearchResults, parseListResults, parseAddedId, deriveTitle,
    entryToContent, normalizeSearchItem, normalizeEntry,
    needsReinit, splitComposeBlocks, parseComposeEnvelope,
    /** Inject a config object so a freshly-required module can init() a mode
     *  without touching env/files (avoids global-state races in the runner). */
    _injectConfig: (cfg) => { _config = cfg; },
  },
};
