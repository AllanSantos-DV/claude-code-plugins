#!/usr/bin/env node
/**
 * Brain Store — SQLite wrapper for knowledge base with JSON fallback.
 *
 * Storage: SQLite via the built-in node:sqlite (better-sqlite3 fallback if present).
 * Fallback: JSON files (when no SQLite backend is available).
 *
 * Usage:
 *   const store = require('./brain-store');
 *   await store.init({ project: 'my-project' });
 *   await store.save(entry, vector);
 *   const results = await store.search(queryVector, { topK: 5 });
 *   const entry = await store.get(id);
 *   await store.delete(id);
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { loadSqlite, getSqliteBackend } = require('./lib/sqlite-compat');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

let _db = null;
let _useSqlite = false;
let _useJson = false;
let _project = 'default';
let _initialized = false;

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Rerank with decay (BRAIN-PLAN §2.2) ──
// Combined score = weighted sum of relevance (cosine) + recency (exp decay) +
// frequency (access_count) + importance (confidence), min-max normalized over the
// candidate set. Grounded in Generative Agents (Stanford) retrieval scoring.

const DEFAULT_RERANK = {
  enabled: true,
  weights: { relevance: 0.5, recency: 0.2, frequency: 0.15, confidence: 0.15 },
  halfLifeDays: 30,
  citationBoost: { enabled: true, alpha: 0.1, cap: 1.5 },
};
let _rerankCfg = null;

function loadRerankConfig() {
  if (_rerankCfg) return _rerankCfg;
  _rerankCfg = DEFAULT_RERANK;
  try {
    const cfgPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'),
      'config', 'brain-config.json'
    );
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const r = cfg?.kb?.rerank;
    if (r) {
      _rerankCfg = {
        enabled: r.enabled !== false,
        weights: { ...DEFAULT_RERANK.weights, ...(r.weights || {}) },
        halfLifeDays: r.halfLifeDays || DEFAULT_RERANK.halfLifeDays,
        citationBoost: { ...DEFAULT_RERANK.citationBoost, ...(r.citationBoost || {}) },
      };
    }
  } catch { /* defaults */ }
  return _rerankCfg;
}

function recencyScore(iso, halfLifeDays, nowMs) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / 86400000);
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.0001)); // exp decay by half-life
}

/**
 * Multiplicative citation boost — entries that were actually cited in a past
 * agent reply get re-ranked up softly. log1p damps so a single cite doesn't
 * dominate; cap prevents runaway dominance for ancient hits.
 * pure → unit-testable.
 */
function citationMultiplier(citedCount, cfg) {
  if (!cfg || cfg.enabled === false) return 1;
  const c = Math.max(0, Number(citedCount) || 0);
  const alpha = typeof cfg.alpha === 'number' ? cfg.alpha : 0.1;
  const cap = typeof cfg.cap === 'number' ? cfg.cap : 1.5;
  const raw = 1 + alpha * Math.log1p(c);
  return Math.min(raw, cap);
}

/**
 * Rerank candidates by combined score. Each candidate: { score (cosine),
 * confidence, accessCount, createdAt, lastAccessed, citedCount, ... }. minScore
 * already applied on cosine (relevance gate) before calling this.
 */
function applyRerank(candidates, opts = {}) {
  const cfg = loadRerankConfig();
  if (opts.rerank === false || cfg.enabled === false || candidates.length === 0) {
    return candidates.sort((a, b) => b.score - a.score);
  }
  const nowMs = Date.now();
  const w = cfg.weights;

  // Precompute raw components
  const rows = candidates.map(c => ({
    c,
    rel: c.score || 0,
    rec: recencyScore(c.lastAccessed || c.createdAt, cfg.halfLifeDays, nowMs),
    freq: c.accessCount || 0,
    conf: typeof c.confidence === 'number' ? c.confidence : 0.5,
  }));

  // Min-max normalize rel, rec, freq over the candidate set (conf already 0-1)
  const norm = (key) => {
    const vals = rows.map(r => r[key]);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min;
    return (v) => (span <= 0 ? (max > 0 ? 1 : 0) : (v - min) / span);
  };
  const nRel = norm('rel'), nRec = norm('rec'), nFreq = norm('freq');

  const cb = cfg.citationBoost || {};
  for (const r of rows) {
    r.c.relevanceScore = r.rel;
    const base =
      w.relevance * nRel(r.rel) +
      w.recency * nRec(r.rec) +
      w.frequency * nFreq(r.freq) +
      w.confidence * r.conf;
    const mult = citationMultiplier(r.c.citedCount || 0, cb);
    r.c.citationMultiplier = mult;
    r.c.rerankScore = base * mult;
  }
  return rows.sort((a, b) => b.c.rerankScore - a.c.rerankScore).map(r => r.c);
}

// Query-independent utility for eviction (AMV-L / Priority Decay): confidence +
// recency + frequency(access+recurrence). No relevance term (no query at prune).
function entryUtility(entry, nowMs, halfLifeDays) {
  const rec = recencyScore(entry.last_accessed || entry.created_at, halfLifeDays, nowMs);
  const freq = entry.access_count || 0;
  const reinforce = entry.recurrence || 1;
  const freqNorm = 1 - 1 / (1 + freq + reinforce); // 0..1, saturating
  const conf = typeof entry.confidence === 'number' ? entry.confidence : 0.5;
  return 0.4 * conf + 0.4 * rec + 0.2 * freqNorm;
}

function loadKbLimits() {
  const out = { maxEntriesPerProject: 10000, archiveAfterDays: 90, halfLifeDays: loadRerankConfig().halfLifeDays };
  try {
    const cfgPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'),
      'config', 'brain-config.json'
    );
    const kb = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))?.kb || {};
    if (kb.maxEntriesPerProject) out.maxEntriesPerProject = kb.maxEntriesPerProject;
    if (kb.archiveAfterDays) out.archiveAfterDays = kb.archiveAfterDays;
  } catch { /* defaults */ }
  return out;
}

function getProjectDir() {
  const dir = path.join(STORE_DIR, 'brain', _project);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

// ── SQLite implementation ──

async function tryInitSqlite() {
  try {
    const Database = loadSqlite();
    if (!Database) return false;
    const dbPath = path.join(getProjectDir(), 'brain.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    createTablesSqlite();
    migrateSqlite();
    _useSqlite = true;
    return true;
  } catch (err) {
    console.error(`[BRAIN-STORE] sqlite init failed, falling back to JSON: ${err.message}`);
    return false;
  }
}

function createTablesSqlite() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      recurrence INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL DEFAULT 'project',
      last_accessed TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      entry_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT 'default',
      FOREIGN KEY (entry_id) REFERENCES entries(id)
    );
    CREATE TABLE IF NOT EXISTS keywords (
      entry_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (entry_id, keyword),
      FOREIGN KEY (entry_id) REFERENCES entries(id)
    );
    CREATE TABLE IF NOT EXISTS graph_edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (from_id, to_id, type),
      FOREIGN KEY (from_id) REFERENCES entries(id),
      FOREIGN KEY (to_id) REFERENCES entries(id)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);
    CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
    CREATE TABLE IF NOT EXISTS entries_archive (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS metrics_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload TEXT,
      session_id TEXT,
      project TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_event_ts ON metrics_event(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_event_name ON metrics_event(event_name);
  `);
}

// Idempotent migrations for existing DBs (CREATE TABLE IF NOT EXISTS won't add
// columns to pre-existing tables).
function migrateSqlite() {
  try {
    const cols = _db.prepare(`PRAGMA table_info(entries)`).all().map(c => c.name);
    if (!cols.includes('recurrence')) {
      _db.exec(`ALTER TABLE entries ADD COLUMN recurrence INTEGER NOT NULL DEFAULT 1`);
    }
    if (!cols.includes('cited_count')) {
      _db.exec(`ALTER TABLE entries ADD COLUMN cited_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('last_cited_ts')) {
      _db.exec(`ALTER TABLE entries ADD COLUMN last_cited_ts INTEGER`);
    }
    if (!cols.includes('scope')) {
      _db.exec(`ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope, project)`);
    const tables = _db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
    if (!tables.includes('metrics_event')) {
      _db.exec(`
        CREATE TABLE metrics_event (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          event_name TEXT NOT NULL,
          payload TEXT,
          session_id TEXT,
          project TEXT
        );
        CREATE INDEX idx_metrics_event_ts ON metrics_event(ts);
        CREATE INDEX idx_metrics_event_name ON metrics_event(event_name);
      `);
    }
  } catch (err) {
    console.error(`[BRAIN-STORE] migration error: ${err.message}`);
  }
}

function vectorToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function blobToVector(blob) {
  // better-sqlite3 returns a Node Buffer; node:sqlite returns a Uint8Array whose
  // byteOffset may be non-zero. slice() yields a fresh, offset-0 ArrayBuffer of the
  // exact length, which we reinterpret as Float32 (vectors are written as Float32Array).
  const u8 = blob instanceof Uint8Array ? blob : Uint8Array.from(blob);
  const copy = u8.slice();
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength >> 2));
}

async function saveSqlite(entry, vector) {
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO entries
      (id, type, project, session_id, title, summary, content, source, tags,
       confidence, access_count, recurrence, scope, last_accessed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.id, entry.type, entry.project, entry.session_id || '',
    entry.title, entry.summary || '', JSON.stringify(entry.content || {}),
    JSON.stringify(entry.source || {}), JSON.stringify(entry.tags || []),
    entry.confidence || 0.5, entry.access_count || 0, entry.recurrence || 1,
    entry.scope || 'project',
    entry.last_accessed || null, entry.created_at || now()
  );

  if (vector) {
    const dim = vector.length;
    const vecStmt = _db.prepare(`
      INSERT OR REPLACE INTO embeddings (entry_id, vector, dimensions, model)
      VALUES (?, ?, ?, ?)
    `);
    vecStmt.run(entry.id, vectorToBlob(vector), dim, 'default');
  }

  if (entry.tags && entry.tags.length > 0) {
    const kwStmt = _db.prepare(`
      INSERT OR REPLACE INTO keywords (entry_id, keyword, weight)
      VALUES (?, ?, ?)
    `);
    for (const tag of entry.tags) {
      kwStmt.run(entry.id, tag.toLowerCase(), 1.0);
    }
  }
}

async function getSqlite(id) {
  const row = _db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!row) return null;
  const entry = rowToEntry(row);

  // Increment access count
  _db.prepare('UPDATE entries SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
    .run(now(), id);

  return entry;
}

function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    session_id: row.session_id,
    title: row.title,
    summary: row.summary,
    content: safeJson(row.content),
    source: safeJson(row.source),
    tags: safeJson(row.tags),
    confidence: row.confidence,
    access_count: row.access_count,
    recurrence: row.recurrence != null ? row.recurrence : 1,
    scope: row.scope || 'project',
    last_accessed: row.last_accessed,
    created_at: row.created_at,
  };
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (err) {
    console.error(`[BRAIN-STORE] JSON parse error in safeJson: ${err.message}`);
    return {};
  }
}

async function searchSqlite(queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0;
  const type = opts.type || null;
  const project = opts.project || _project;

  // Load all vectors + entries for this project
  const rows = _db.prepare(`
    SELECT e.id, e.title, e.summary, e.type, e.confidence, e.created_at,
           e.last_accessed, e.access_count, e.cited_count, e.last_cited_ts,
           em.vector, em.dimensions
    FROM entries e
    LEFT JOIN embeddings em ON em.entry_id = e.id
    WHERE e.project = ? ${type ? 'AND e.type = ?' : ''}
  `).all(...[project, type].filter(Boolean));

  const scored = [];
  for (const row of rows) {
    const vec = row.vector ? blobToVector(row.vector) : null;
    let score = 0;
    if (queryVector && vec && vec.length === queryVector.length) {
      score = cosineSimilarity(queryVector, vec);
    }
    if (score >= minScore) {
      scored.push({
        id: row.id,
        title: row.title,
        summary: row.summary,
        type: row.type,
        confidence: row.confidence,
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        accessCount: row.access_count,
        citedCount: row.cited_count || 0,
        lastCitedTs: row.last_cited_ts || null,
        score,
      });
    }
  }

  // Relevance gate (minScore on cosine) already applied; rerank survivors by
  // combined score (relevance + recency + frequency + confidence).
  return applyRerank(scored, opts).slice(0, topK);
}

/**
 * Vector search against an ARBITRARY project DB via a throwaway connection,
 * WITHOUT touching the module singleton (`_db`/`_project`). This is what makes
 * cross-scope retrieval (project + __user__) safe on the long-lived MCP server:
 * the old approach of close()/init()-ing the singleton mid-search corrupted
 * shared state across concurrent tool calls. Read-only; returns [] if the DB
 * file or sqlite backend is unavailable.
 */
async function searchIsolated(project, queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0;
  const type = opts.type || null;
  const Database = loadSqlite();
  if (!Database) return [];
  const dbPath = path.join(STORE_DIR, 'brain', project, 'brain.db');
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try { db = new Database(dbPath); } catch (e) { console.error('[brain] isolated DB open failed:', dbPath, e.message); return []; }
  try {
    const rows = db.prepare(`
      SELECT e.id, e.title, e.summary, e.type, e.confidence, e.created_at,
             e.last_accessed, e.access_count, e.cited_count, e.last_cited_ts,
             em.vector, em.dimensions
      FROM entries e
      LEFT JOIN embeddings em ON em.entry_id = e.id
      WHERE e.project = ? ${type ? 'AND e.type = ?' : ''}
    `).all(...[project, type].filter(Boolean));
    const scored = [];
    for (const row of rows) {
      const vec = row.vector ? blobToVector(row.vector) : null;
      let score = 0;
      if (queryVector && vec && vec.length === queryVector.length) {
        score = cosineSimilarity(queryVector, vec);
      }
      if (score >= minScore) {
        scored.push({
          id: row.id, title: row.title, summary: row.summary, type: row.type,
          confidence: row.confidence, createdAt: row.created_at,
          lastAccessed: row.last_accessed, accessCount: row.access_count,
          citedCount: row.cited_count || 0, lastCitedTs: row.last_cited_ts || null,
          score,
        });
      }
    }
    return applyRerank(scored, opts).slice(0, topK);
  } finally {
    try { db.close(); } catch { /* throwaway connection */ }
  }
}

async function searchByKeywordsSqlite(keywords, opts = {}) {
  const topK = opts.topK || 5;
  const type = opts.type || null;

  const placeholders = keywords.map(() => '?').join(',');
  const params = keywords.map(k => k.toLowerCase());
  if (type) params.push(type);

  const rows = _db.prepare(`
    SELECT e.id, e.title, e.summary, e.type, e.confidence,
           COUNT(k.keyword) AS match_count
    FROM keywords k
    JOIN entries e ON e.id = k.entry_id
    WHERE k.keyword IN (${placeholders})
      ${type ? 'AND e.type = ?' : ''}
    GROUP BY e.id
    ORDER BY match_count DESC, e.confidence DESC
    LIMIT ?
  `).all(...params, topK);

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    type: r.type,
    confidence: r.confidence,
    score: r.match_count / Math.max(keywords.length, 1),
    matchCount: r.match_count,
  }));
}

async function deleteSqlite(id) {
  _db.prepare('DELETE FROM embeddings WHERE entry_id = ?').run(id);
  _db.prepare('DELETE FROM keywords WHERE entry_id = ?').run(id);
  _db.prepare('DELETE FROM graph_edges WHERE from_id = ? OR to_id = ?').run(id, id);
  _db.prepare('DELETE FROM entries WHERE id = ?').run(id);
}

async function listSqlite(type, project) {
  const rows = _db.prepare(`
    SELECT id, title, type, summary, confidence, created_at, access_count
    FROM entries
    WHERE project = ? ${type ? 'AND type = ?' : ''}
    ORDER BY created_at DESC
  `).all(...[project || _project, type].filter(Boolean));
  return rows;
}

// ── JSON fallback implementation ──

async function initJson() {
  const dir = getProjectDir();
  for (const sub of ['entries', 'vectors', 'keywords']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  _useJson = true;
}

async function saveJson(entry, vector) {
  const dir = getProjectDir();
  const entryPath = path.join(dir, 'entries', `${entry.id}.json`);
  fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

  if (vector) {
    const vecPath = path.join(dir, 'vectors', `${entry.id}.json`);
    fs.writeFileSync(vecPath, JSON.stringify({ vector, dimensions: vector.length }));
  }

  if (entry.tags && entry.tags.length > 0) {
    for (const tag of entry.tags) {
      const kwDir = path.join(dir, 'keywords', tag.toLowerCase());
      if (!fs.existsSync(kwDir)) fs.mkdirSync(kwDir, { recursive: true });
      fs.writeFileSync(path.join(kwDir, `${entry.id}.json`), JSON.stringify({ id: entry.id, weight: 1.0 }));
    }
  }
}

async function getJson(id) {
  const dir = getProjectDir();
  const entryPath = path.join(dir, 'entries', `${id}.json`);
  if (!fs.existsSync(entryPath)) return null;
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8'));
  entry.access_count = (entry.access_count || 0) + 1;
  entry.last_accessed = now();
  fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));
  return entry;
}

async function searchJson(queryVector, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0;
  const type = opts.type || null;
  const project = opts.project || _project;
  const dir = getProjectDir();

  const candidates = fs.readdirSync(path.join(dir, 'entries'))
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const e = JSON.parse(fs.readFileSync(path.join(dir, 'entries', f), 'utf-8'));
      if (e.project !== project) return null;
      if (type && e.type !== type) return null;
      const vecPath = path.join(dir, 'vectors', `${e.id}.json`);
      let vec = null;
      if (fs.existsSync(vecPath)) {
        vec = JSON.parse(fs.readFileSync(vecPath, 'utf-8')).vector;
      }
      let score = 0;
      if (queryVector && vec) {
        score = cosineSimilarity(queryVector, vec);
      }
      return {
        id: e.id, title: e.title, summary: e.summary,
        type: e.type, confidence: e.confidence,
        createdAt: e.created_at, lastAccessed: e.last_accessed,
        accessCount: e.access_count, score,
      };
    })
    .filter(Boolean)
    .filter(e => e.score >= minScore);

  return applyRerank(candidates, opts).slice(0, topK);
}

async function searchByKeywordsJson(keywords, opts = {}) {
  const topK = opts.topK || 5;
  const dir = getProjectDir();
  const matchCounts = {};

  for (const kw of keywords) {
    const kwDir = path.join(dir, 'keywords', kw.toLowerCase());
    if (fs.existsSync(kwDir)) {
      for (const f of fs.readdirSync(kwDir)) {
        const id = f.replace('.json', '');
        matchCounts[id] = (matchCounts[id] || 0) + 1;
      }
    }
  }

  const sorted = Object.entries(matchCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  return sorted.map(([id, count]) => {
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'entries', `${id}.json`), 'utf-8'));
    return {
      id: e.id, title: e.title, summary: e.summary,
      type: e.type, confidence: e.confidence,
      score: count / Math.max(keywords.length, 1), matchCount: count,
    };
  });
}

async function deleteJson(id) {
  const dir = getProjectDir();
  for (const p of [
    path.join(dir, 'entries', `${id}.json`),
    path.join(dir, 'vectors', `${id}.json`),
  ]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // Remove from keyword dirs
  const kwDir = path.join(dir, 'keywords');
  if (fs.existsSync(kwDir)) {
    for (const sub of fs.readdirSync(kwDir)) {
      const f = path.join(kwDir, sub, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

async function listJson(type, project) {
  const dir = getProjectDir();
  return fs.readdirSync(path.join(dir, 'entries'))
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const e = JSON.parse(fs.readFileSync(path.join(dir, 'entries', f), 'utf-8'));
      return e.project === (project || _project) && (!type || e.type === type)
        ? { id: e.id, title: e.title, type: e.type, summary: e.summary,
            confidence: e.confidence, created_at: e.created_at, access_count: e.access_count }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.created_at?.localeCompare(a.created_at));
}

// ── Public API ──

async function init(opts = {}) {
  const newProject = opts.project || 'default';
  if (_initialized && _project === newProject) return;
  if (_initialized) await close();
  _project = newProject;
  const _dir = getProjectDir();

  const sqliteOk = await tryInitSqlite();
  if (!sqliteOk) await initJson();
  _initialized = true;
}

async function save(entry, vector) {
  if (!entry.id) entry.id = uuid();
  if (!entry.created_at) entry.created_at = now();
  entry.project = entry.project || _project;
  entry.access_count = entry.access_count || 0;

  // Return the id so callers (brain-backend.saveLocal, brain-cli) can chain a
  // get()/embed step. saveSqlite/saveJson are side-effecting and return nothing.
  if (_useSqlite) await saveSqlite(entry, vector);
  else await saveJson(entry, vector);
  return entry.id;
}

async function get(id) {
  if (_useSqlite) return getSqlite(id);
  return getJson(id);
}

async function search(queryVector, opts = {}) {
  if (_useSqlite) return searchSqlite(queryVector, opts);
  return searchJson(queryVector, opts);
}

async function searchByKeywords(keywords, opts = {}) {
  const normalized = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) return [];

  // Try vector search first, fall back to keyword
  if (opts.useVector !== false && _useSqlite) {
    return searchSqlite(null, opts); // vector-less search returns all, sorted by confidence
  }
  if (_useSqlite) return searchByKeywordsSqlite(normalized, opts);
  return searchByKeywordsJson(normalized, opts);
}

async function delete_({ id, type, project } = {}) {
  if (id) {
    if (_useSqlite) return deleteSqlite(id);
    return deleteJson(id);
  }
  if (type || project) {
    const entries = await list(type, project);
    for (const e of entries) {
      if (_useSqlite) deleteSqlite(e.id);
      else deleteJson(e.id);
    }
  }
}

async function list(type, project) {
  if (_useSqlite) return listSqlite(type, project);
  return listJson(type, project);
}

async function count(type, project) {
  const entries = await list(type, project);
  return entries.length;
}

// Raw read (no access_count bump) — for merge/admission flows.
function getRaw(id) {
  if (_useSqlite) {
    const row = _db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    return row ? rowToEntry(row) : null;
  }
  const entryPath = path.join(getProjectDir(), 'entries', `${id}.json`);
  if (!fs.existsSync(entryPath)) return null;
  try { return JSON.parse(fs.readFileSync(entryPath, 'utf-8')); }
  catch (err) { console.error(`[BRAIN-STORE] readEntry failed for ${id}: ${err.message}`); return null; }
}

/**
 * Merge a duplicate into an existing entry (admission control "merge" decision).
 * Bumps recurrence, refreshes last_accessed, keeps the higher confidence, and
 * applies an optional patch (summary/content/tags). Preserves the existing
 * embedding (no vector passed). Returns the merged entry, or null if id missing.
 */
async function merge(id, patch = {}) {
  const existing = getRaw(id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    recurrence: (existing.recurrence || 1) + 1,
    last_accessed: now(),
    confidence: Math.max(existing.confidence || 0.5, patch.confidence || 0),
  };
  if (_useSqlite) await saveSqlite(merged);
  else await saveJson(merged);
  return merged;
}

function archiveSqlite(entry, reason) {
  _db.prepare(`INSERT OR REPLACE INTO entries_archive (id, data, archived_at, reason) VALUES (?, ?, ?, ?)`)
    .run(entry.id, JSON.stringify(entry), now(), reason);
  deleteSqlite(entry.id);
}

/**
 * Prune the KB (graceful archive, not delete) — BRAIN-PLAN §2.3.
 * 1. Stale: entries older than archiveAfterDays with no access and no recurrence.
 * 2. Over cap: if still over maxEntriesPerProject, archive lowest-utility.
 * Archived rows move to entries_archive (recoverable). SQLite only; JSON no-op.
 */
async function prune(opts = {}) {
  if (!_useSqlite) return { archivedStale: 0, archivedOverCap: 0, remaining: await count() };
  const lim = loadKbLimits();
  const maxEntries = opts.maxEntries || lim.maxEntriesPerProject;
  const archiveAfterDays = opts.archiveAfterDays || lim.archiveAfterDays;
  const nowMs = Date.now();
  const project = opts.project || _project;
  let archivedStale = 0, archivedOverCap = 0;

  const all = _db.prepare(`SELECT * FROM entries WHERE project = ?`).all(project).map(rowToEntry);

  // 1) Stale
  const cutoff = nowMs - archiveAfterDays * 86400000;
  for (const e of all) {
    const created = Date.parse(e.created_at);
    if (Number.isFinite(created) && created < cutoff && (e.access_count || 0) === 0 && (e.recurrence || 1) <= 1) {
      archiveSqlite(e, `stale>${lim.archiveAfterDays}d`);
      archivedStale++;
    }
  }

  // 2) Over cap → archive lowest-utility
  const live = _db.prepare(`SELECT * FROM entries WHERE project = ?`).all(project).map(rowToEntry);
  if (live.length > maxEntries) {
    const ranked = live
      .map(e => ({ e, u: entryUtility(e, nowMs, lim.halfLifeDays) }))
      .sort((a, b) => a.u - b.u);
    const toRemove = live.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      archiveSqlite(ranked[i].e, 'over-capacity');
      archivedOverCap++;
    }
  }

  return { archivedStale, archivedOverCap, remaining: await count(undefined, project) };
}

async function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
  _initialized = false;
}

function getStorageType() { return _useSqlite ? 'sqlite' : 'json'; }

/**
 * Mark an entry as cited (the agent actually used it in its reply). Bumps
 * cited_count and refreshes last_cited_ts. SQLite-only; JSON fallback is a
 * no-op (feedback loop only meaningful when persistence supports counters).
 * Returns the new cited_count, or 0 on no-op / not-found.
 */
function recordCitation(id) {
  if (!id || !_useSqlite) return 0;
  try {
    const ts = Date.now();
    const info = _db.prepare(
      `UPDATE entries SET cited_count = cited_count + 1, last_cited_ts = ? WHERE id = ?`
    ).run(ts, id);
    if (info.changes === 0) return 0;
    const row = _db.prepare(`SELECT cited_count FROM entries WHERE id = ?`).get(id);
    return row ? (row.cited_count || 0) : 0;
  } catch (err) {
    console.error(`[BRAIN-STORE] recordCitation(${id}) failed: ${err.message}`);
    return 0;
  }
}

function getStatus() {
  return {
    storage: _useSqlite ? 'sqlite' : (_useJson ? 'json' : 'none'),
    backend: _useSqlite ? getSqliteBackend() : (_useJson ? 'json' : 'none'),
    project: _project,
    dir: getProjectDir(),
    initialized: _initialized,
  };
}

// ── Plan #5: metrics ─────────────────────────────────────────────────────

const VALID_EVENT_NAME = /^[a-z][a-z0-9._-]{1,63}$/;

/** Append a single event row. Returns inserted id (or 0 on no-op). */
function recordMetric(eventName, payload, sessionId) {
  if (!_useSqlite || !eventName || !VALID_EVENT_NAME.test(eventName)) return 0;
  try {
    const info = _db.prepare(
      `INSERT INTO metrics_event (ts, event_name, payload, session_id, project) VALUES (?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      eventName,
      payload ? JSON.stringify(payload) : null,
      sessionId || null,
      _project || null,
    );
    return Number(info.lastInsertRowid) || 0;
  } catch (err) {
    console.error(`[BRAIN-STORE] recordMetric(${eventName}) failed: ${err.message}`);
    return 0;
  }
}

/**
 * Aggregate counts per event_name within a time window (days back from now).
 * Returns { totals: {evt: n}, daily: [{date, event_name, count}], windowMs }.
 */
function getMetricsSummary(rangeDays = 7) {
  const empty = { totals: {}, daily: [], windowMs: rangeDays * 86400_000, sinceTs: 0 };
  if (!_useSqlite) return empty;
  try {
    const sinceTs = Date.now() - rangeDays * 86400_000;
    const totalRows = _db.prepare(
      `SELECT event_name, COUNT(*) AS count FROM metrics_event WHERE ts >= ? GROUP BY event_name`
    ).all(sinceTs);
    const totals = {};
    for (const r of totalRows) totals[r.event_name] = r.count;

    const dailyRows = _db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS date, event_name, COUNT(*) AS count
         FROM metrics_event WHERE ts >= ?
         GROUP BY date, event_name
         ORDER BY date ASC, event_name ASC`
    ).all(sinceTs);

    return { totals, daily: dailyRows, windowMs: rangeDays * 86400_000, sinceTs };
  } catch (err) {
    console.error(`[BRAIN-STORE] getMetricsSummary failed: ${err.message}`);
    return empty;
  }
}

/** List recent raw events (newest first). Filterable by event name. */
function getEventLog({ eventName = null, limit = 50 } = {}) {
  if (!_useSqlite) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  try {
    const rows = eventName
      ? _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event WHERE event_name = ? ORDER BY ts DESC LIMIT ?`).all(eventName, cap)
      : _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event ORDER BY ts DESC LIMIT ?`).all(cap);
    return rows.map(r => ({
      id: r.id,
      ts: r.ts,
      eventName: r.event_name,
      payload: safeParseJson(r.payload),
      sessionId: r.session_id,
      project: r.project,
    }));
  } catch (err) {
    console.error(`[BRAIN-STORE] getEventLog failed: ${err.message}`);
    return [];
  }
}

function safeParseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { /* non-JSON value: null */ return null; }
}

/** Delete metrics_event rows older than `keepDays`. Returns count deleted. */
function cleanupMetrics(keepDays = 30) {
  if (!_useSqlite) return 0;
  try {
    const cutoff = Date.now() - keepDays * 86400_000;
    const info = _db.prepare(`DELETE FROM metrics_event WHERE ts < ?`).run(cutoff);
    return info.changes || 0;
  } catch (err) {
    console.error(`[BRAIN-STORE] cleanupMetrics failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  init, save, get, getRaw, merge, prune, search, searchByKeywords, searchIsolated,
  delete: delete_, list, count, close,
  getStorageType, getStatus, cosineSimilarity,
  recordCitation, citationMultiplier,
  recordMetric, getMetricsSummary, getEventLog, cleanupMetrics,
  _getDbForTests: () => _db,
};
