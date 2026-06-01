#!/usr/bin/env node
/**
 * Brain Index — Inverted index management for the knowledge base.
 *
 * Maintains a keyword → entryId mapping for fast text-based lookup,
 * complementing the vector search in brain-store.js.
 *
 * Usage:
 *   const index = require('./brain-index');
 *   await index.init({ project: 'my-project' });
 *   await index.index(entry);
 *   const ids = await index.lookup(['test', 'pattern']);
 *   await index.deindex(entryId);
 */
const fs = require('fs');
const _textUtils = require('./lib/text-utils.js');
const path = require('path');
const os = require('os');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

let _project = 'default';
let _indexPath = null;
let _index = null;
let _initialized = false;

function getIndexPath() {
  const dir = path.join(STORE_DIR, 'brain', _project);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'index.json');
}

async function init(opts = {}) {
  if (_initialized) return;
  _project = opts.project || 'default';
  _indexPath = getIndexPath();

  if (fs.existsSync(_indexPath)) {
    try {
      _index = JSON.parse(fs.readFileSync(_indexPath, 'utf-8'));
    } catch {
      _index = null;
    }
  }

  if (!_index) {
    _index = {
      version: 1,
      updatedAt: new Date().toISOString(),
      keywords: {},
      tags: {},
      projects: {},
      types: {},
    };
  }
  _initialized = true;
}

function save() {
  if (!_indexPath) return;
  _index.updatedAt = new Date().toISOString();
  fs.writeFileSync(_indexPath, JSON.stringify(_index, null, 2));
}

function extractKeywords(text) {
  // minLen 3 / allowPath false preserved from original implementation.
  // Indexer keeps narrower regime than retrievers (minLen 4 / allowPath true)
  // to avoid bloating the inverted index with path fragments.
  return [...new Set(_textUtils.extractKeywords(text, { minLen: 3, maxTokens: 1000, allowPath: false }))];
}

async function index(entry) {
  if (!_initialized) await init();
  const id = entry.id;
  if (!id) return;

  // Index by tags
  if (entry.tags && Array.isArray(entry.tags)) {
    for (const tag of entry.tags) {
      const key = tag.toLowerCase();
      if (!_index.tags[key]) _index.tags[key] = [];
      if (!_index.tags[key].includes(id)) _index.tags[key].push(id);
    }
  }

  // Index by extracted keywords from title + summary
  const allText = `${entry.title} ${entry.summary} ${entry.content?.detail || ''}`;
  const keywords = extractKeywords(allText);
  for (const kw of keywords) {
    if (!_index.keywords[kw]) _index.keywords[kw] = [];
    if (!_index.keywords[kw].includes(id)) _index.keywords[kw].push(id);
  }

  // Index by project
  if (entry.project) {
    if (!_index.projects[entry.project]) _index.projects[entry.project] = [];
    if (!_index.projects[entry.project].includes(id)) _index.projects[entry.project].push(id);
  }

  // Index by type
  if (entry.type) {
    if (!_index.types[entry.type]) _index.types[entry.type] = [];
    if (!_index.types[entry.type].includes(id)) _index.types[entry.type].push(id);
  }

  save();
}

async function deindex(id) {
  if (!_initialized) await init();

  for (const map of ['keywords', 'tags', 'projects', 'types']) {
    for (const key of Object.keys(_index[map])) {
      _index[map][key] = _index[map][key].filter(eid => eid !== id);
      if (_index[map][key].length === 0) delete _index[map][key];
    }
  }
  save();
}

async function lookup(keywords, opts = {}) {
  if (!_initialized) await init();
  const type = opts.type || null;
  const project = opts.project || _project;
  const topK = opts.topK || 50;

  const normalized = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) return [];

  const scores = {};

  // Score by keyword matches
  for (const kw of normalized) {
    const ids = _index.keywords[kw] || _index.tags[kw] || [];
    for (const id of ids) {
      scores[id] = (scores[id] || 0) + 1;
    }
  }

  // Filter by project
  const projectIds = new Set(_index.projects[project] || []);

  // Filter by type
  const typeIds = type ? new Set(_index.types[type] || []) : null;

  const results = Object.entries(scores)
    .filter(([id]) => projectIds.has(id))
    .filter(([id]) => !typeIds || typeIds.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score: score / Math.max(normalized.length, 1) }));

  return results;
}

async function search(textQuery, opts = {}) {
  return lookup(extractKeywords(textQuery), opts);
}

async function clear() {
  _index = {
    version: 1,
    updatedAt: new Date().toISOString(),
    keywords: {},
    tags: {},
    projects: {},
    types: {},
  };
  save();
}

function getStatus() {
  if (!_index) return { initialized: false };
  return {
    initialized: true,
    project: _project,
    keywordCount: Object.keys(_index.keywords).length,
    tagCount: Object.keys(_index.tags).length,
    projectCount: Object.keys(_index.projects).length,
    typeCount: Object.keys(_index.types).length,
  };
}

module.exports = { init, index, deindex, lookup, search, clear, getStatus };
