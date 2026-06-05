#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const { getShellsConfigPath } = require('./curation-paths.js');
const configTesters = require('./config-testers');
const { USER_SENTINEL, prepareForUserScope } = require('./lib/scope-sanitizer.js');
const { searchTwoPass } = require('./lib/scope-search.js');
const { extractKeywords } = require('./lib/text-utils.js');

// Session token — generated at boot, injected into index.html, required on all /api/* requests.
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || resolveBestDataDir();
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');

// Pick the most populated brain data dir among ~/.claude/plugins/data/claude-code-boss*.
// Fall back to the canonical bare name if nothing is populated yet.
function resolveBestDataDir() {
  const base = path.join(require('os').homedir(), '.claude', 'plugins', 'data');
  const fallback = path.join(base, 'claude-code-boss');
  if (!fs.existsSync(base)) return fallback;
  const candidates = fs.readdirSync(base)
    .filter(d => /^claude-code-boss/.test(d))
    .map(d => path.join(base, d))
    .filter(p => fs.existsSync(path.join(p, 'brain')));
  if (candidates.length === 0) return fallback;
  let best = candidates[0], bestCount = -1;
  for (const dir of candidates) {
    let total = 0;
    const brainDir = path.join(dir, 'brain');
    for (const proj of fs.readdirSync(brainDir)) {
      const dbPath = path.join(brainDir, proj, 'brain.db');
      if (fs.existsSync(dbPath)) total += countEntriesInDb(dbPath);
    }
    if (total > bestCount) { bestCount = total; best = dir; }
  }
  return best;
}

function countEntriesInDb(dbPath) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return 0; }
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM entries').get();
    db.close();
    return row?.c || 0;
  } catch { return 0; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ─── In-memory log ring buffer ─────────────────────────────────────
const LOG_RING_SIZE = 500;
const _logRing = [];
const SERVER_START_TIME = new Date().toISOString();

function _pushLog(level, source, message) {
  if (_logRing.length >= LOG_RING_SIZE) _logRing.shift();
  _logRing.push({ ts: new Date().toISOString(), level, source, message });
}

// Wrap console methods within this module to capture to ring buffer
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log = (...args) => { const m = args.join(' '); _pushLog('info', 'dashboard', m); _origLog(m); };
console.warn = (...args) => { const m = args.join(' '); _pushLog('warn', 'dashboard', m); _origWarn(m); };
console.error = (...args) => { const m = args.join(' '); _pushLog('error', 'dashboard', m); _origError(m); };

const HOOK_ERRORS_PATH = path.join(RUNTIME_DIR, 'hook-errors.jsonl');

/** Read up to N most-recent hook error lines from .runtime/hook-errors.jsonl */
function readHookErrors(n = 200) {
  if (!fs.existsSync(HOOK_ERRORS_PATH)) return [];
  try {
    const lines = fs.readFileSync(HOOK_ERRORS_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => {
      try { return JSON.parse(l); }
      catch (err) {
        console.error(`[DASHBOARD] hook-errors.jsonl parse error: ${err.message}`);
        return { ts: '', level: 'error', source: 'hook', message: l };
      }
    });
  } catch (err) {
    console.error(`[DASHBOARD] Failed to read hook-errors.jsonl: ${err.message}`);
    return [];
  }
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function fail(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (err) {
    console.error(`[DASHBOARD] readJSON failed (${path.basename(file)}): ${err.message}`);
    return null;
  }
}

// ─── Config validators ────────────────────────────────────────────

function validateBrainConfig(data) {
  if (!data || typeof data !== 'object') return 'root must be an object';
  if ('backend' in data) {
    if (typeof data.backend !== 'object') return 'backend must be object';
    if ('type' in data.backend && !['local', 'mcp-memory'].includes(data.backend.type)) {
      return `backend.type must be "local" or "mcp-memory"`;
    }
  }
  if ('embedder' in data) {
    if (typeof data.embedder !== 'object') return 'embedder must be object';
    if ('provider' in data.embedder && !['transformers', 'ollama', 'voyage'].includes(data.embedder.provider)) {
      return `embedder.provider must be "transformers", "ollama", or "voyage"`;
    }
  }
  if ('curation' in data) {
    if (typeof data.curation !== 'object') return 'curation must be object';
    if ('maxOutputChars' in data.curation && typeof data.curation.maxOutputChars !== 'number') return 'curation.maxOutputChars must be number';
    if ('maxOutputLines' in data.curation && typeof data.curation.maxOutputLines !== 'number') return 'curation.maxOutputLines must be number';
  }
  return null;
}

function validateHooksConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'root must be an object';
  return null;
}

/** Atomic JSON write: write to tmpfile then rename. */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── API: Status ───────────────────────────────────────────────────

function getStatus(req, res) {
  return getStatusAsync(req, res).catch(err => {
    console.error(`[DASHBOARD] /api/status failed: ${err.message}`);
    fail(res, err.message, 500);
  });
}

async function getStatusAsync(req, res) {
  const hooksRaw = readJSON(path.join(ROOT, 'hooks', 'hooks.json'));

  let hooksTotal = 0, hooksActive = 0, hookEntries = [];
  if (hooksRaw?.hooks) {
    for (const [event, handlers] of Object.entries(hooksRaw.hooks)) {
      for (const h of handlers) {
        for (const hook of (h.hooks || [])) {
          hooksTotal++;
          const cmd = hook.command || '';
          const scriptFile = cmd.replace(/^node\s+"?\${?CLAUDE_PLUGIN_ROOT}?(?:\/|\\)?/i, '').replace(/"?$/, '');
          const fullPath = path.join(ROOT, scriptFile);
          if (fs.existsSync(fullPath) && !fullPath.endsWith('.disabled')) {
            hooksActive++;
          }
          hookEntries.push({ event, script: scriptFile, cmd });
        }
      }
    }
  }

  let brainProjects = [], brainTotal = 0;
  const brainBaseDir = path.join(DATA_DIR, 'brain');
  if (fs.existsSync(brainBaseDir)) {
    for (const p of fs.readdirSync(brainBaseDir)) {
      const dbPath = path.join(brainBaseDir, p, 'brain.db');
      if (fs.existsSync(dbPath)) {
        const count = countEntriesInDb(dbPath);
        brainTotal += count;
        if (count > 0) brainProjects.push({ project: p, entries: count });
      }
    }
    brainProjects.sort((a, b) => b.entries - a.entries);
  }

  let backendMode = 'local', backendConnected = false;
  try {
    const backend = require('./brain-backend.js');
    backend.init({ project: 'default' });
    const s = backend.getStatus();
    backendMode = s.mode || 'local';
    backendConnected = s.connected !== undefined ? s.connected : true;
  } catch (err) { console.error(`[DASHBOARD] Brain backend status error: ${err.message}`); }

  json(res, {
    uptime: process.uptime().toFixed(0),
    brain: { projects: brainProjects, totalEntries: brainTotal, backend: backendMode, connected: backendConnected },
    hooks: { total: hooksTotal, active: hooksActive },
  });
}

// ─── API: Brain Backend Status ──────────────────────────────────────

function getBrainBackend(req, res) {
  try {
    const backend = require('./brain-backend.js');
    backend.init({ project: 'default' });
    const status = backend.getStatus();
    json(res, status);
  } catch (err) {
    console.error(`[DASHBOARD] Brain backend unavailable: ${err.message}`);
    json(res, { mode: 'local', error: 'brain-backend not available', fallback: true });
  }
}

// ─── API: Brain Backend Config (read/write brain-config.json) ────────

function getBrainConfig(req, res) {
  const configPath = path.join(ROOT, 'config', 'brain-config.json');
  const data = readJSON(configPath);
  if (!data) return fail(res, 'brain-config.json not found', 404);
  json(res, data);
}

async function saveBrainConfig(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    const err = validateBrainConfig(parsed);
    if (err) return fail(res, `Invalid brain-config.json: ${err}`, 400);
    const configPath = path.join(ROOT, 'config', 'brain-config.json');
    atomicWriteJSON(configPath, parsed);
    json(res, { ok: true, requiresRestart: true });
  } catch (e) { fail(res, e.message); }
}

function restartDashboard(req, res) {
  const port = server.address().port;
  json(res, { ok: true, port, restarting: true });
  setTimeout(() => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(ROOT, 'scripts', 'dashboard.js')],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1' },
      }
    );
    child.unref();
    process.exit(0);
  }, 500);
}

async function testEmbedder(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return fail(res, 'Invalid JSON body', 400); }
  const out = await configTesters.run('embedder', body);
  // Legacy shape: {ok, dim, ms} flat — keep for backwards-compat.
  if (out.ok) return json(res, { ok: true, dim: out.dim, ms: out.ms });
  return json(res, { ok: false, error: out.error, ms: out.ms });
}

async function testConfig(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return fail(res, 'Invalid JSON body', 400); }
  const domain = body && body.domain;
  if (!domain) return fail(res, 'Missing "domain"', 400);
  const out = await configTesters.run(domain, body.input || {});
  json(res, out);
}

function listConfigDomains(req, res) {
  json(res, { domains: configTesters.list() });
}

// ─── API: Brain ────────────────────────────────────────────────────

function getBrainProjects(req, res) {
  const projects = [];
  const brainBaseDir = path.join(DATA_DIR, 'brain');
  if (!fs.existsSync(brainBaseDir)) return json(res, []);
  for (const p of fs.readdirSync(brainBaseDir)) {
    const dbPath = path.join(brainBaseDir, p, 'brain.db');
    if (fs.existsSync(dbPath)) {
      try {
        const count = countEntriesInDb(dbPath);
        if (count === 0) continue;
        const stats = fs.statSync(dbPath);
        projects.push({ project: p, entries: count, dbSize: stats.size, lastModified: stats.mtime });
      } catch (err) { console.error(`[DASHBOARD] Brain project stat error (${p}): ${err.message}`); }
    }
  }
  projects.sort((a, b) => b.entries - a.entries);
  json(res, projects);
}

async function searchBrain(req, res, url) {
  const q = url.searchParams.get('q') || '';
  const project = url.searchParams.get('project') || '';
  const k = parseInt(url.searchParams.get('k') || '10', 10);
  const scope = url.searchParams.get('scope') || 'project'; // 'project' | 'user' | 'both'
  if (!q || !project) return json(res, []);
  try {
    const embedder = require('./brain-embedder.js');
    await embedder.init();
    const store = require('./brain-store.js');

    // For scope=user, swap to __user__ DB; for project/both stay on requested project.
    const startProject = scope === 'user' ? USER_SENTINEL : project;
    store.init({ project: startProject });

    let vec = null;
    if (embedder.getStatus().ready) vec = await embedder.embed(q);

    let results = [];
    if (vec) {
      if (scope === 'both') {
        results = await searchTwoPass(store, project, vec, { topK: k, minScore: 0.05 });
      } else {
        results = await store.search(vec, { topK: k, minScore: 0.05 });
      }
    }
    // Keyword fallback (project/user scope only — keep simple, no two-pass kw)
    if (results.length < 2 && scope !== 'both') {
      const index = require('./brain-index.js');
      index.init({ project: startProject });
      const kw = extractKeywords(q);
      if (kw.length > 0) {
        const kwResults = await index.lookup(kw, { topK: k });
        for (const r of kwResults) {
          if (!results.find(e => e.id === r.id)) {
            const entry = store.get(r.id);
            if (entry) results.push({ ...entry, score: r.score });
          }
        }
      }
    }
    // Restore singleton to the requested project so subsequent calls don't drift.
    if (startProject !== project) store.init({ project });
    json(res, results.slice(0, k));
  } catch (e) { fail(res, e.message); }
}

function getBrainEntry(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const store = require('./brain-store.js');
    store.init({ project });
    const entry = store.get(id);
    if (!entry) return fail(res, 'Not found', 404);
    json(res, entry);
  } catch (e) { fail(res, e.message); }
}

function deleteBrainEntry(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const store = require('./brain-store.js');
    const index = require('./brain-index.js');
    store.init({ project });
    index.init({ project });
    store.delete(id);
    index.deindex(id);
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

// Plan #7 — move an entry between scopes (project ↔ user).
// PATCH /api/brain/entry/:id/scope?project=<src>
// body: { scope: 'user'|'project', targetProject?: '<name>' }
// targetProject is required when demoting user→project (src is __user__, can't infer destination).
async function moveBrainEntryScope(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 2];
  const srcProject = url.searchParams.get('project') || '';
  if (!id || !srcProject) return fail(res, 'Missing id or project', 400);
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body || '{}'); }
  catch { return fail(res, 'Invalid JSON body', 400); }
  const targetScope = String(parsed.scope || '').toLowerCase();
  const targetProject = String(parsed.targetProject || '').trim();
  if (targetScope !== 'user' && targetScope !== 'project') {
    return fail(res, 'scope must be "user" or "project"', 400);
  }

  let dstProject;
  if (targetScope === 'user') {
    dstProject = USER_SENTINEL;
  } else if (srcProject !== USER_SENTINEL) {
    dstProject = srcProject;
  } else if (targetProject && targetProject !== USER_SENTINEL) {
    dstProject = targetProject;
  } else {
    return fail(res, 'targetProject required when demoting from user scope', 400);
  }

  try {
    const store = require('./brain-store.js');
    const index = require('./brain-index.js');
    const graph = require('./brain-graph.js');

    store.init({ project: srcProject });
    const entry = store.get(id);
    if (!entry) return fail(res, 'Entry not found', 404);

    const currentScope = entry.scope || 'project';
    if (currentScope === targetScope && srcProject === dstProject) {
      return json(res, { ok: true, status: 'noop', scope: currentScope });
    }

    let safeEntry = { ...entry, scope: targetScope, project: dstProject };
    if (targetScope === 'user') {
      const detail = (entry.content && entry.content.detail) || entry.detail || '';
      const prep = prepareForUserScope({ title: entry.title, summary: entry.summary, detail }, srcProject);
      if (prep.rejected) {
        return fail(res, `Refused: ${prep.reason}. Strip before moving to user scope.`, 400);
      }
      safeEntry.title = prep.safe.title;
      safeEntry.summary = prep.safe.summary;
      safeEntry.detail = prep.safe.detail;
      safeEntry.content = { ...(entry.content || {}), detail: prep.safe.detail };
    }
    delete safeEntry.id;

    index.init({ project: srcProject });
    graph.init({ project: srcProject });
    store.delete(id);
    index.deindex(id);
    await graph.unregisterNode(id);

    store.init({ project: dstProject });
    index.init({ project: dstProject });
    graph.init({ project: dstProject });
    await store.save(safeEntry);
    await index.index(safeEntry);
    await graph.registerNode(safeEntry);

    store.init({ project: srcProject });
    json(res, { ok: true, id: safeEntry.id, scope: targetScope, project: dstProject });
  } catch (e) { fail(res, e.message); }
}

// Plan #7 — export entries as portable JSON bundle.
// GET /api/brain/export?scope=user
// GET /api/brain/export?project=<name>
// Response: { version, exportedAt, project, scope, entries: [{...entry, vector?}] }
async function exportBrain(req, res, url) {
  const scope = url.searchParams.get('scope') || '';
  const projectArg = url.searchParams.get('project') || '';
  const project = scope === 'user' ? USER_SENTINEL : projectArg;
  if (!project) return fail(res, 'Missing scope=user or project=<name>', 400);
  try {
    const store = require('./brain-store.js');
    store.init({ project });
    const entries = await store.list();
    const db = store._getDbForTests && store._getDbForTests();
    const vectors = new Map();
    if (db) {
      const rows = db.prepare('SELECT entry_id, vector, dimensions FROM embeddings').all();
      for (const r of rows) {
        if (r.vector) vectors.set(r.entry_id, { vector: Array.from(new Float32Array(r.vector.buffer || r.vector)), dimensions: r.dimensions });
      }
    }
    const out = entries.map(e => {
      const v = vectors.get(e.id);
      return v ? { ...e, vector: v.vector, dimensions: v.dimensions } : e;
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="brain-${project}-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    res.end(JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      project,
      scope: scope || 'project',
      count: out.length,
      entries: out,
    }, null, 2));
  } catch (e) { fail(res, e.message); }
}

// Plan #7 — import entries from a JSON bundle.
// POST /api/brain/import  body: { project?, scope?, conflict, entries }
//   conflict: 'skip' | 'overwrite' | 'merge' (default: 'skip')
//   project: destination override (else uses bundle.project / __user__ if scope=user)
async function importBrain(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let bundle;
  try { bundle = JSON.parse(body || '{}'); }
  catch { return fail(res, 'Invalid JSON body', 400); }

  const conflict = String(bundle.conflict || 'skip').toLowerCase();
  if (!['skip', 'overwrite', 'merge'].includes(conflict)) {
    return fail(res, 'conflict must be skip|overwrite|merge', 400);
  }
  const entries = Array.isArray(bundle.entries) ? bundle.entries : null;
  if (!entries) return fail(res, 'entries[] required', 400);

  const dstProject = bundle.scope === 'user' || bundle.project === USER_SENTINEL
    ? USER_SENTINEL
    : (bundle.project || '');
  if (!dstProject) return fail(res, 'project or scope=user required', 400);

  try {
    const store = require('./brain-store.js');
    const index = require('./brain-index.js');
    const graph = require('./brain-graph.js');
    store.init({ project: dstProject });
    index.init({ project: dstProject });
    graph.init({ project: dstProject });

    let added = 0, skipped = 0, overwritten = 0, merged = 0, failed = 0;
    for (const e of entries) {
      try {
        const incoming = { ...e, project: dstProject, scope: e.scope === 'user' ? 'user' : 'project' };
        const vector = Array.isArray(e.vector) ? e.vector : null;
        delete incoming.vector;
        delete incoming.dimensions;

        const existing = incoming.id ? store.getRaw(incoming.id) : null;
        if (existing) {
          if (conflict === 'skip') { skipped++; continue; }
          if (conflict === 'merge') {
            await store.merge(existing.id, { summary: incoming.summary, content: incoming.content, confidence: incoming.confidence });
            merged++;
            continue;
          }
          await store.save(incoming, vector);
          await index.index(incoming);
          await graph.registerNode(incoming);
          overwritten++;
        } else {
          await store.save(incoming, vector);
          await index.index(incoming);
          await graph.registerNode(incoming);
          added++;
        }
      } catch (err) {
        console.error(`[DASHBOARD] import entry failed: ${err.message}`);
        failed++;
      }
    }
    json(res, { ok: true, project: dstProject, conflict, total: entries.length, added, skipped, overwritten, merged, failed });
  } catch (e) { fail(res, e.message); }
}

function getBrainRelated(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const graph = require('./brain-graph.js');
    const store = require('./brain-store.js');
    store.init({ project });
    graph.init({ project });
    const related = graph.getRelated(id);
    const full = related.map(r => {
      const entry = store.get(r.id);
      return entry ? { ...entry, edgeType: r.edgeType } : null;
    }).filter(Boolean);
    json(res, full);
  } catch (e) { fail(res, e.message); }
}

// ─── API: Curation ─────────────────────────────────────────────────

function getCurationProjects(req, res) {
  // Collect unique cwd values from detect-curation payloads (pending + processed)
  const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA ||
    path.join(require('os').homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
  const dirs = [
    path.join(DATA_DIR, 'detect-curation'),
    path.join(DATA_DIR, 'detect-curation', 'processed'),
  ];
  const seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (d.cwd) seen.add(d.cwd);
      } catch (err) { console.error(`[DASHBOARD] Curation payload parse error (${f}): ${err.message}`); }
    }
  }
  // For each cwd, check if a curated shells config exists (configurable path)
  const projects = [...seen].map(cwd => {
    const shellsPath = getShellsConfigPath(cwd);
    const hasShells = !!shellsPath && fs.existsSync(shellsPath);
    let shellCount = 0;
    if (hasShells) {
      try { shellCount = JSON.parse(fs.readFileSync(shellsPath, 'utf-8')).shells?.length || 0; } catch (err) { console.error(`[DASHBOARD] Shells count read error: ${err.message}`); }
    }
    return { cwd, hasShells, shellCount, shellsPath };
  });
  json(res, projects);
}

function getCurationShells(req, res, url) {
  const cwd = url.searchParams.get('cwd') || '';
  const shellsPath = cwd ? getShellsConfigPath(cwd) : null;
  if (!shellsPath || !fs.existsSync(shellsPath)) {
    return json(res, { shells: [], whitelist: [], cwd, found: false });
  }
  try {
    const data = JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
    // Enrich each shell with script existence check.
    // Schema: `script` is the canonical field; legacy `command` accepted as fallback.
    const shells = (data.shells || []).map(s => {
      const scriptRel = s.script || s.command;
      const scriptPath = scriptRel && cwd ? path.resolve(cwd, scriptRel) : null;
      const scriptExists = scriptPath ? fs.existsSync(scriptPath) : false;
      let scriptContent = null;
      if (scriptExists) {
        try { scriptContent = fs.readFileSync(scriptPath, 'utf-8').slice(0, 2000); } catch (err) { console.error(`[DASHBOARD] Script content read error: ${err.message}`); }
      }
      return { ...s, script: scriptRel, scriptExists, scriptPath, scriptContent };
    });
    json(res, { shells, whitelist: data.whitelist || [], cwd, found: true });
  } catch (e) { fail(res, e.message); }
}

async function deleteCurationShell(req, res, url) {
  const cwd = url.searchParams.get('cwd') || '';
  const idx = parseInt(url.pathname.split('/').pop());
  const shellsPath = cwd ? getShellsConfigPath(cwd) : null;
  if (!shellsPath || !fs.existsSync(shellsPath)) return fail(res, 'shells config not found', 404);
  try {
    const data = JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
    data.shells.splice(idx, 1);
    fs.writeFileSync(shellsPath, JSON.stringify(data, null, 2));
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

// ─── API: Hooks Config ─────────────────────────────────────────────

function getHooksConfig(req, res) {
  const configPath = path.join(ROOT, 'config', 'hooks-config.json');
  const data = readJSON(configPath);
  if (!data) return fail(res, 'hooks-config.json not found', 404);
  json(res, data);
}

async function saveHooksConfig(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    const err = validateHooksConfig(parsed);
    if (err) return fail(res, `Invalid hooks-config.json: ${err}`, 400);
    const configPath = path.join(ROOT, 'config', 'hooks-config.json');
    atomicWriteJSON(configPath, parsed);
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

// ─── API: Hooks ────────────────────────────────────────────────────

function getHooks(req, res) {
  const hooksRaw = readJSON(path.join(ROOT, 'hooks', 'hooks.json'));
  if (!hooksRaw) return json(res, []);
  const result = [];
  for (const [event, handlers] of Object.entries(hooksRaw.hooks)) {
    for (const h of handlers) {
      const matcher = h.matcher || '*';
      for (const hook of (h.hooks || [])) {
        const cmd = hook.command || '';
        let scriptPath = '';
        const m = cmd.match(/node\s+"[^"]*\/scripts\/([^"]+)"/);
        if (m) {
          scriptPath = path.join(ROOT, 'scripts', m[1]);
        }
        const fullPath = path.normalize(scriptPath);
        const exists = fs.existsSync(fullPath);
        const disabled = fullPath.endsWith('.disabled');
        const active = exists && !disabled;
        result.push({
          event,
          matcher,
          command: cmd,
          scriptFile: path.basename(scriptPath),
          active,
          exists,
        });
      }
    }
  }
  json(res, result);
}

function toggleHook(req, res, url) {
  const parts = url.pathname.split('/');
  const name = parts[parts.length - 1];
  if (!name) return fail(res, 'Missing hook name', 400);

  const scriptPath = path.join(ROOT, 'scripts', name);
  const disabledPath = scriptPath + '.disabled';

  if (fs.existsSync(scriptPath)) {
    fs.renameSync(scriptPath, disabledPath);
    return json(res, { ok: true, active: false });
  }
  if (fs.existsSync(disabledPath)) {
    fs.renameSync(disabledPath, scriptPath);
    return json(res, { ok: true, active: true });
  }
  fail(res, 'Hook script not found', 404);
}

// ─── API: Logs ─────────────────────────────────────────────────────

function getLogs(req, res) {
  const hookErrors = readHookErrors(200);
  const combined = [..._logRing, ...hookErrors]
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  json(res, {
    serverStartTime: SERVER_START_TIME,
    uptimeSeconds: process.uptime().toFixed(0),
    entries: combined,
  });
}

function clearLogs(req, res) {
  _logRing.length = 0;
  if (fs.existsSync(HOOK_ERRORS_PATH)) {
    try { fs.writeFileSync(HOOK_ERRORS_PATH, ''); }
    catch (err) { console.error(`[DASHBOARD] Failed to clear hook-errors.jsonl: ${err.message}`); }
  }
  json(res, { ok: true });
}

// ─── API: Metrics (Plan #5) ────────────────────────────────────────

function listMetricsProjects() {
  const brainBaseDir = path.join(DATA_DIR, 'brain');
  if (!fs.existsSync(brainBaseDir)) return [];
  return fs.readdirSync(brainBaseDir)
    .filter(p => fs.existsSync(path.join(brainBaseDir, p, 'brain.db')));
}

async function aggregateAcrossProjects(projects, op) {
  const store = require('./brain-store.js');
  const results = [];
  for (const project of projects) {
    try {
      // Cycle the store per-project (single-instance module).
      try { await store.close(); } catch { /* noop */ }
      await store.init({ project, skipEmbedder: true });
      results.push({ project, value: op(store) });
    } catch (err) {
      console.error(`[DASHBOARD] metrics aggregate failed (${project}): ${err.message}`);
    }
  }
  return results;
}

async function getMetricsSummary(req, res, url) {
  try {
    const range = Math.max(1, Math.min(90, parseInt(url.searchParams.get('range') || '7', 10)));
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    if (projects.length === 0) {
      return json(res, { rangeDays: range, totals: {}, daily: [], projects: [] });
    }

    const perProject = await aggregateAcrossProjects(projects, s => s.getMetricsSummary(range));

    const totals = {};
    const dailyMap = new Map(); // `${date}|${event}` → count
    for (const { value } of perProject) {
      for (const [name, n] of Object.entries(value.totals || {})) {
        totals[name] = (totals[name] || 0) + n;
      }
      for (const row of value.daily || []) {
        const key = `${row.date}|${row.event_name}`;
        dailyMap.set(key, (dailyMap.get(key) || 0) + row.count);
      }
    }
    const daily = [...dailyMap.entries()].map(([k, count]) => {
      const [date, event_name] = k.split('|');
      return { date, event_name, count };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.event_name.localeCompare(b.event_name));

    json(res, {
      rangeDays: range,
      projects: projects,
      totals,
      daily,
    });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/summary failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function getMetricsEventLog(req, res, url) {
  try {
    const eventName = url.searchParams.get('event') || null;
    const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10)));
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();

    const perProject = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName, limit }));
    const all = [];
    for (const { value } of perProject) all.push(...value);
    all.sort((a, b) => b.ts - a.ts);
    json(res, { events: all.slice(0, limit) });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/event-log failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function postMetricsCleanup(req, res, url) {
  try {
    const keepDays = Math.max(1, Math.min(365, parseInt(url.searchParams.get('keepDays') || '30', 10)));
    const projects = listMetricsProjects();
    const per = await aggregateAcrossProjects(projects, s => s.cleanupMetrics(keepDays));
    const deleted = per.reduce((s, p) => s + (p.value || 0), 0);
    json(res, { ok: true, keepDays, deleted, projects: per.map(p => ({ project: p.project, deleted: p.value })) });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/cleanup failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

// ─── Router ────────────────────────────────────────────────────────

function handleAPI(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  if (p === '/api/status' && m === 'GET') return getStatus(req, res);
  if (p === '/api/brain/backend' && m === 'GET') return getBrainBackend(req, res);
  if (p === '/api/brain/backend-config' && m === 'GET') return getBrainConfig(req, res);
  if (p === '/api/brain/backend-config' && m === 'PUT') return saveBrainConfig(req, res);
  if (p === '/api/brain/backend-restart' && m === 'POST') return restartDashboard(req, res);
  if (p === '/api/brain/embedder/test' && m === 'POST') return testEmbedder(req, res);
  if (p === '/api/config/test' && m === 'POST') return testConfig(req, res);
  if (p === '/api/config/domains' && m === 'GET') return listConfigDomains(req, res);
  if (p === '/api/brain/projects' && m === 'GET') return getBrainProjects(req, res);
  if (p === '/api/brain/search' && m === 'GET') return searchBrain(req, res, url);
  if (p === '/api/brain/export' && m === 'GET') return exportBrain(req, res, url);
  if (p === '/api/brain/import' && m === 'POST') return importBrain(req, res);
  if (p.match(/^\/api\/brain\/entry\/[^/]+\/scope$/) && m === 'PATCH') return moveBrainEntryScope(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'GET') return getBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'DELETE') return deleteBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/related\//) && m === 'GET') return getBrainRelated(req, res, url);
  if (p === '/api/hooks' && m === 'GET') return getHooks(req, res);
  if (p.match(/^\/api\/hooks\/toggle\//) && m === 'PUT') return toggleHook(req, res, url);
  if (p === '/api/hooks/config' && m === 'GET') return getHooksConfig(req, res);
  if (p === '/api/hooks/config' && m === 'PUT') return saveHooksConfig(req, res);
  if (p === '/api/curation/projects' && m === 'GET') return getCurationProjects(req, res);
  if (p === '/api/curation/shells' && m === 'GET') return getCurationShells(req, res, url);
  if (p.match(/^\/api\/curation\/shells\/\d+$/) && m === 'DELETE') return deleteCurationShell(req, res, url);
  if (p === '/api/logs' && m === 'GET') return getLogs(req, res);
  if (p === '/api/logs/clear' && m === 'POST') return clearLogs(req, res);
  if (p === '/api/metrics/summary' && m === 'GET') return getMetricsSummary(req, res, url);
  if (p === '/api/metrics/event-log' && m === 'GET') return getMetricsEventLog(req, res, url);
  if (p === '/api/metrics/cleanup' && m === 'POST') return postMetricsCleanup(req, res, url);

  json(res, { error: 'Not found' }, 404);
}

function serveStatic(req, res) {
  // Browsers always probe /favicon.ico — no asset, no log spam.
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  let filePath = req.url === '/' ? path.join(DASHBOARD_DIR, 'index.html') : path.join(DASHBOARD_DIR, req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    let content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    if (filePath === path.join(DASHBOARD_DIR, 'index.html')) {
      const html = content.toString('utf-8').replace(
        '</head>',
        `<script>window.__DASHBOARD_TOKEN__ = '${SESSION_TOKEN}';</script>\n</head>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // SPA fallback only for navigation (no extension or .html); other missing
      // assets get a quiet 404 so browser asset probes don't spam the log.
      const ext = path.extname(filePath);
      if (ext && ext !== '.html') {
        res.writeHead(404);
        return res.end('Not found');
      }
      const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'));
      const html = index.toString('utf-8').replace(
        '</head>',
        `<script>window.__DASHBOARD_TOKEN__ = '${SESSION_TOKEN}';</script>\n</head>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    console.error(`[DASHBOARD] Static serve error: ${err.message}`);
    res.writeHead(500);
    res.end('Server error');
  }
}

// ─── Auth helpers ─────────────────────────────────────────────────

function isValidHost(host, port) {
  if (!host) return false;
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

function checkAuth(req, res, port) {
  const host = req.headers['host'] || '';
  if (!isValidHost(host, port)) {
    json(res, { error: 'Forbidden: invalid Host header' }, 403);
    return false;
  }
  const token = req.headers['x-dashboard-token'] || '';
  const expected = Buffer.from(SESSION_TOKEN);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    json(res, { error: 'Unauthorized' }, 401);
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const port = server.address()?.port;
    if (!checkAuth(req, res, port)) return;
    return handleAPI(req, res, url);
  }
  serveStatic(req, res);
});

const PORT = process.env.DASHBOARD_PORT || 0;
server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`\n  \u{1F4CA} Plugin Dashboard: http://localhost:${port}  (token: ${SESSION_TOKEN})\n`);
  // Write discovery file for dashboard-start.js and other consumers
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUNTIME_DIR, 'dashboard.json'),
      JSON.stringify({ port, token: SESSION_TOKEN, startTime: SERVER_START_TIME, pid: process.pid })
    );
  } catch (err) { console.error(`[DASHBOARD] Failed to write dashboard.json: ${err.message}`); }
  const browser = { win32: 'start', darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (browser && !process.env.DASHBOARD_NO_OPEN) {
    try { execSync(`${browser} http://localhost:${port}`, { stdio: 'ignore', timeout: 5000 }); } catch (err) { console.error(`[DASHBOARD] Browser open failed: ${err.message}`); }
  }
});
