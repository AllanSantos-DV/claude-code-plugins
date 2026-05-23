#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');
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

function loadConfig() {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error(`[BRAIN-BACKEND] Config parse error: ${e.message}`);
  }
  _config = _config || {};
  return _config;
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// ── MCP mode wrappers ──

function parseResult(result) {
  if (!result || !result.text) return null;
  try { return JSON.parse(result.text); }
  catch { return { text: result.text }; }
}

function parseResultArray(result) {
  if (!result || !result.text) return [];
  try {
    const parsed = JSON.parse(result.text);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function initMcp() {
  const config = loadConfig();
  const mcpCfg = (config.backend && config.backend.mcpMemory) || {};
  const jarDir = path.join(DATA_DIR, 'mcp');
  if (!fs.existsSync(jarDir)) fs.mkdirSync(jarDir, { recursive: true });
  const jarPath = mcpCfg.jarPath || path.join(jarDir, 'mcp-memory-server.jar');
  const McpClient = require('./mcp-client.js');
  _mcp = new McpClient({
    jarPath,
    workspacePath: path.join(DATA_DIR, 'brain', _project),
    javaArgs: mcpCfg.javaArgs || ['-Xmx512m'],
    downloadUrl: mcpCfg.downloadUrl || '',
    expectedSha256: mcpCfg.expectedSha256 || '',
    timeout: mcpCfg.timeout || 60000,
  });
  await _mcp.connect();
}

async function saveMcp(entry) {
  const result = await _mcp.callTool('add_document', {
    title: entry.title || '',
    summary: entry.summary || '',
    detail: typeof entry.content === 'string' ? entry.content
      : JSON.stringify(entry.content || {}),
    type: entry.type || 'note',
    tags: entry.tags || [],
    confidence: entry.confidence || 0.5,
    source: JSON.stringify(entry.source || {}),
    sessionId: entry.session_id || '',
  });
  const data = parseResult(result) || {};
  return data.id || entry.id || uuid();
}

async function getMcp(id) {
  const result = await _mcp.callTool('get_document', { id });
  const data = parseResult(result);
  if (!data) return null;
  return normalizeEntry(data);
}

function normalizeEntry(data) {
  const entry = { ...data };
  entry.id = data.id || data.documentId || '';
  entry.title = data.title || '';
  entry.summary = data.summary || '';
  entry.type = data.type || 'note';
  entry.tags = data.tags || [];
  entry.content = data.content || {};
  entry.source = data.source || {};
  entry.confidence = data.confidence || 0.5;
  entry.session_id = data.sessionId || data.session_id || '';
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
    minScore,
    typeFilter: opts.type || '',
  });
  const items = parseResultArray(result);
  return items.slice(0, topK).map(item => normalizeSearchItem(item));
}

function normalizeSearchItem(item) {
  return {
    id: item.id || item.documentId || '',
    title: item.title || '',
    summary: item.summary || '',
    type: item.type || 'note',
    score: item.score || item.relevance || 0,
    confidence: item.confidence || 0.5,
    createdAt: item.createdAt || item.created_at || '',
    accessCount: item.accessCount || item.access_count || 0,
  };
}

async function searchByKeywordsMcp(keywords, opts = {}) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  return searchMcp(keywords.join(' '), opts);
}

async function deleteMcp(id) {
  await _mcp.callTool('delete_document', { id });
}

async function listMcp(type, project) {
  const result = await _mcp.callTool('list_documents', {
    ...(type ? { typeFilter: type } : {}),
    ...(project ? { project } : {}),
  });
  return parseResultArray(result);
}

async function countMcp() {
  const result = await _mcp.callTool('summarize_memory', {});
  const data = parseResult(result);
  if (data && typeof data.count === 'number') return data.count;
  if (data && typeof data.totalDocuments === 'number') return data.totalDocuments;
  return 0;
}

async function getRelatedMcp(id) {
  const result = await _mcp.callTool('get_related_documents', { id, topK: 10 });
  const items = parseResultArray(result);
  return items.map(item => ({
    id: item.id || item.documentId || '',
    title: item.title || '',
    type: item.type || 'note',
    score: item.score || item.relevance || 0,
    edgeType: item.edgeType || item.relation || 'related',
  }));
}

// ── Local mode: wraps store + index + graph + embedder ──

async function initLocal() {
  _store = require('./brain-store.js');
  _index = require('./brain-index.js');
  _graph = require('./brain-graph.js');
  _embedder = require('./brain-embedder.js');
  await _store.init({ project: _project });
  await _index.init({ project: _project });
  if (_graph.init) await _graph.init({ project: _project });
  await _embedder.init();
}

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s/._-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
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
    const entries = [];
    for (const r of kwResults.slice(0, topK)) {
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
  const id = await _store.save(entry);
  const embedOk = _embedder && _embedder.getStatus && _embedder.getStatus().ready;
  if (embedOk) {
    const text = `${entry.title} ${entry.summary} ${entry.content?.detail || ''}`;
    const vector = await _embedder.embed(text);
    if (vector) {
      const store2 = _store;
      const entry2 = await store2.get(id);
      if (entry2) {
        await store2.save({ ...entry2, id }, vector);
      }
    }
  }
  const keywords = extractKeywords(`${entry.title} ${entry.summary} ${JSON.stringify(entry.content || {})}`);
  if (keywords.length > 0) {
    await _index.index(entry);
  }
  if (_graph && _graph.registerNode) {
    await _graph.registerNode(id, entry.type || 'note');
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

async function init(opts = {}) {
  if (_initialized) return;
  _project = opts.project || 'default';
  const config = loadConfig();
  _mode = (config.backend && config.backend.type) || 'local';

  if (_mode === 'mcp-memory') {
    await initMcp();
  } else {
    await initLocal();
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

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from', 'was', 'are',
  'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will', 'just',
  'been', 'were', 'they', 'them', 'their', 'what', 'when', 'where',
  'which', 'who', 'how', 'about', 'into', 'over', 'such', 'each',
  'than', 'then', 'these', 'those', 'also', 'very', 'because',
  'para', 'que', 'com', 'uma', 'mais', 'mas', 'como', 'por',
  'dos', 'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
  'node', 'npm', 'npx', 'file', 'path', 'src', 'lib', 'test',
]);

module.exports = {
  init, save, get, search, searchByKeywords,
  delete: delete_, list, count, getRelated, close,
  getStatus, getMode,
};
