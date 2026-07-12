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
const { aggregateSkillRoi } = require('./lib/skill-roi.js');
const { aggregateCaptureRate } = require('./lib/capture-rate.js');
const { loadSqlite } = require('./lib/sqlite-compat.js');
const pluginUpdater = require('./lib/plugin-updater.js');
const { resolveMode } = require('./lib/router-mode.js');
const hooksConfig = require('./lib/hooks-config.js');

// Session token — generated at boot, injected into index.html, required on all /api/* requests.
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || resolveBestDataDir();
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');

// model-router (F3) — shipped defaults vs. user override (key + toggles).
// The override lives only in DATA_DIR and is NEVER committed.
const ROUTER_SHIPPED_CONFIG = path.join(ROOT, 'config', 'router-config.json');
const ROUTER_USER_CONFIG = path.join(DATA_DIR, 'model-router', 'user-config.json');
const ROUTER_STATE_FILE = path.join(DATA_DIR, 'model-router', 'state.json');
const ROUTER_METRICS_FILE = path.join(DATA_DIR, 'model-router', 'metrics.json');

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
  const Database = loadSqlite();
  if (!Database) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM entries').get();
    db.close();
    return row?.c || 0;
  } catch (err) {
    console.error(`[dashboard] countEntriesInDb(${dbPath}) failed: ${err.message}`);
    return 0;
  }
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

/**
 * Absolute path to the script a hook runs, supporting both hook forms:
 *   exec form  → { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/x.js"] }
 *   shell form → { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/x.js"' }
 * Returns '' when no script path can be extracted.
 */
function hookScriptPath(hook) {
  const expand = (s) => String(s).replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/gi, ROOT.replace(/\\/g, '/'));
  const isScript = (s) => /\.(?:js|mjs|cjs)$/.test(s);
  if (Array.isArray(hook && hook.args)) {
    for (const a of hook.args) {
      const c = expand(a);
      if (isScript(c)) return path.normalize(c);
    }
    return '';
  }
  const cmd = (hook && hook.command) || '';
  const m = expand(cmd).match(/node\s+"?([^"\s]+(?:\.js|\.mjs|\.cjs))"?/);
  return m ? path.normalize(m[1]) : '';
}

/** Human-readable command string for display (joins exec-form args). */
function hookDisplayCmd(hook) {
  if (hook && hook.type === 'mcp_tool') return `[mcp_tool] ${hook.server || '?'} / ${hook.tool || '?'}`;
  if (Array.isArray(hook && hook.args)) return `${hook.command} ${hook.args.join(' ')}`.trim();
  return (hook && hook.command) || '';
}

// ─── Config validators ────────────────────────────────────────────

function validateBrainConfig(data) {
  if (!data || typeof data !== 'object') return 'root must be an object';
  if ('backend' in data) {
    if (typeof data.backend !== 'object') return 'backend must be object';
    if ('type' in data.backend && !['local', 'mcp-memory'].includes(data.backend.type)) {
      return `backend.type must be "local" or "mcp-memory"`;
    }
    if ('mcpMemory' in data.backend) {
      if (typeof data.backend.mcpMemory !== 'object') return 'backend.mcpMemory must be object';
      const tr = data.backend.mcpMemory.transport;
      if (tr !== undefined && !['stdio', 'http'].includes(tr)) {
        return 'backend.mcpMemory.transport must be "stdio" or "http"';
      }
    }
    if ('ingestion' in data.backend) {
      if (typeof data.backend.ingestion !== 'object') return 'backend.ingestion must be object';
      if ('enabled' in data.backend.ingestion && typeof data.backend.ingestion.enabled !== 'boolean') {
        return 'backend.ingestion.enabled must be a boolean';
      }
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
          const cmd = hookDisplayCmd(hook);
          const isMcp = hook && hook.type === 'mcp_tool';
          const fullPath = hookScriptPath(hook);
          const scriptFile = isMcp ? `${hook.server}/${hook.tool}` : (fullPath ? path.relative(ROOT, fullPath).replace(/\\/g, '/') : '');
          if (isMcp || (fullPath && fs.existsSync(fullPath) && !fullPath.endsWith('.disabled'))) {
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

// Per-user override lives here; the shipped config is the factory default.
const BRAIN_USER_CONFIG = path.join(DATA_DIR, 'brain', 'user-config.json');

function getBrainConfig(req, res) {
  try {
    const brainConfig = require('./lib/brain-config.js');
    brainConfig._resetCache(); // reflect any on-disk change since the last read
    json(res, brainConfig.load()); // shipped ⊕ DATA_DIR/brain/user-config.json
  } catch (e) {
    fail(res, `brain-config load failed: ${e.message}`, 500);
  }
}

async function saveBrainConfig(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    const err = validateBrainConfig(parsed);
    if (err) return fail(res, `Invalid brain-config.json: ${err}`, 400);
    // Persist ONLY to the per-user override, and only the delta vs the shipped
    // defaults. The shipped config stays untouched so users who never open the
    // dashboard (and don't run the external daemon) keep working on the local
    // backend, and the override survives plugin auto-update.
    const brainConfig = require('./lib/brain-config.js');
    const shipped = readJSON(path.join(ROOT, 'config', 'brain-config.json')) || {};
    const delta = brainConfig.deepDiff(shipped, parsed);
    fs.mkdirSync(path.dirname(BRAIN_USER_CONFIG), { recursive: true });
    atomicWriteJSON(BRAIN_USER_CONFIG, delta);
    brainConfig._resetCache();
    json(res, { ok: true, requiresRestart: true });
  } catch (e) { fail(res, e.message); }
}

// Read the .claude-boss-project marker for a given folder (project identity).
function getProjectMarker(req, res, url) {
  const folder = (url.searchParams.get('folder') || '').trim();
  if (!folder) return fail(res, 'folder query param required', 400);
  const projectIdLib = require('./lib/project-id.js');
  const markerPath = path.join(folder, projectIdLib.MARKER_FILE);
  let current = '';
  try { if (fs.existsSync(markerPath)) current = projectIdLib.sanitize(fs.readFileSync(markerPath, 'utf-8')); }
  catch (err) { console.error(`[DASHBOARD] read marker: ${err.message}`); }
  // Also report what the resolver would pick for that folder right now.
  const resolved = projectIdLib.resolveProjectId({ cwd: folder });
  json(res, { folder, projectId: current, exists: !!current, resolved });
}

// Write (or clear) the .claude-boss-project marker inside a user-named folder.
async function saveProjectMarker(req, res) {
  const body = await readBody(req);
  try {
    const { folder, projectId } = JSON.parse(body || '{}');
    const dir = (folder || '').trim();
    if (!dir) return fail(res, 'folder is required', 400);
    let stat;
    try { stat = fs.statSync(dir); } catch (err) { void err; return fail(res, `folder not found: ${dir}`, 400); }
    if (!stat.isDirectory()) return fail(res, `not a directory: ${dir}`, 400);
    const projectIdLib = require('./lib/project-id.js');
    const clean = projectIdLib.sanitize(projectId);
    const markerPath = path.join(dir, projectIdLib.MARKER_FILE);
    if (!clean) {
      // Empty name → remove the marker (revert to basename default).
      try { if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath); }
      catch (err) { return fail(res, `could not remove marker: ${err.message}`); }
      return json(res, { ok: true, projectId: '', removed: true });
    }
    fs.writeFileSync(markerPath, clean + '\n', 'utf-8');
    json(res, { ok: true, projectId: clean, path: markerPath });
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
  catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }
  const out = await configTesters.run('embedder', body);
  // Legacy shape: {ok, dim, ms} flat — keep for backwards-compat.
  if (out.ok) return json(res, { ok: true, dim: out.dim, ms: out.ms });
  return json(res, { ok: false, error: out.error, ms: out.ms });
}

async function testConfig(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }
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

    const startProject = scope === 'user' ? USER_SENTINEL : project;
    await store.init({ project: startProject });

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
    if (results.length < 2 && scope !== 'both') {
      const index = require('./brain-index.js');
      await index.init({ project: startProject });
      const kw = extractKeywords(q);
      if (kw.length > 0) {
        const kwResults = await index.lookup(kw, { topK: k });
        for (const r of kwResults) {
          if (!results.find(e => e.id === r.id)) {
            const entry = await store.get(r.id);
            if (entry) results.push({ ...entry, score: r.score });
          }
        }
      }
    }
    if (startProject !== project) await store.init({ project });
    json(res, results.slice(0, k));
  } catch (e) { fail(res, e.message); }
}

async function getBrainEntry(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const store = require('./brain-store.js');
    await store.init({ project });
    const entry = await store.get(id);
    if (!entry) return fail(res, 'Not found', 404);
    json(res, entry);
  } catch (e) { fail(res, e.message); }
}

async function deleteBrainEntry(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const store = require('./brain-store.js');
    const index = require('./brain-index.js');
    await store.init({ project });
    await index.init({ project });
    await store.delete(id);
    index.deindex(id);
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

async function moveBrainEntryScope(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 2];
  const srcProject = url.searchParams.get('project') || '';
  if (!id || !srcProject) return fail(res, 'Missing id or project', 400);
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body || '{}'); }
  catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }
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

    await store.init({ project: srcProject });
    const entry = await store.get(id);
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

    await index.init({ project: srcProject });
    await graph.init({ project: srcProject });
    await store.delete({ id });
    index.deindex(id);
    await graph.unregisterNode(id);

    await store.init({ project: dstProject });
    await index.init({ project: dstProject });
    await graph.init({ project: dstProject });
    await store.save(safeEntry);
    await index.index(safeEntry);
    await graph.registerNode(safeEntry);

    await store.init({ project: srcProject });
    json(res, { ok: true, id: safeEntry.id, scope: targetScope, project: dstProject });
  } catch (e) { fail(res, e.message); }
}

// Export entries as portable JSON bundle.
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
    await store.init({ project });
    const listed = await store.list();
    const db = store._getDbForTests && store._getDbForTests();
    const vectors = new Map();
    if (db) {
      const rows = db.prepare('SELECT entry_id, vector, dimensions FROM embeddings').all();
      for (const r of rows) {
        if (r.vector) vectors.set(r.entry_id, { vector: Array.from(new Float32Array(r.vector.buffer || r.vector)), dimensions: r.dimensions });
      }
    }
    // store.list() is a LOSSY projection (id/title/type/summary/confidence/
    // created_at/access_count) — it omits content/tags/scope/source/recurrence.
    // Re-read each entry via getRaw (SELECT * -> rowToEntry) so the exported bundle
    // round-trips with FULL fidelity; otherwise import silently drops lesson bodies.
    const out = [];
    for (const it of listed) {
      const full = store.getRaw(it.id);
      if (!full) continue;
      const v = vectors.get(full.id);
      out.push(v ? { ...full, vector: v.vector, dimensions: v.dimensions } : full);
    }
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

// Import entries from a JSON bundle.
// POST /api/brain/import  body: { project?, scope?, conflict, entries }
//   conflict: 'skip' | 'overwrite' | 'merge' (default: 'skip')
//   project: destination override (else uses bundle.project / __user__ if scope=user)
async function importBrain(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let bundle;
  try { bundle = JSON.parse(body || '{}'); }
  catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }

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
    await store.init({ project: dstProject });
    await index.init({ project: dstProject });
    await graph.init({ project: dstProject });

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
            // Keep the search index + graph consistent with the merged body,
            // mirroring the add/overwrite branches (else the update isn't findable).
            const mergedEntry = store.getRaw(existing.id);
            if (mergedEntry) { await index.index(mergedEntry); await graph.registerNode(mergedEntry); }
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

async function getBrainRelated(req, res, url) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];
  const project = url.searchParams.get('project') || '';
  if (!id || !project) return fail(res, 'Missing id or project', 400);
  try {
    const graph = require('./brain-graph.js');
    const store = require('./brain-store.js');
    await store.init({ project });
    await graph.init({ project });
    const related = graph.getRelated(id);
    const full = await Promise.all(related.map(async r => {
      const entry = await store.get(r.id);
      return entry ? { ...entry, edgeType: r.edgeType } : null;
    }));
    json(res, full.filter(Boolean));
  } catch (e) { fail(res, e.message); }
}

// ─── API: Skill Promotion ───────────────────────────────────────────
// Lessons/patterns whose recurrence + confidence cleared the threshold can be
// drafted into staged SKILL.md files, then approved into ~/.claude/skills/.
// Backed by scripts/brain-promote.js (CLI). The dashboard shells out to it so
// the CLI and UI agree on logic and avoid sqlite lock conflicts.

const SKILL_STAGING_DIR = path.join(DATA_DIR, 'skills-pending');
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function runBrainPromote(args) {
  const scriptPath = path.join(ROOT, 'scripts', 'brain-promote.js');
  const out = execSync(`"${process.execPath}" "${scriptPath}" ${args}`, {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function getSkillPromotionConfig(req, res) {
  let cfg = { enabled: true, minRecurrence: 3, minConfidence: 0.8, types: ['lesson', 'pattern'] };
  try {
    const cfgPath = path.join(ROOT, 'config', 'brain-config.json');
    const sp = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))?.kb?.skillPromotion;
    if (sp) cfg = { ...cfg, ...sp };
  } catch { /* defaults */ }
  const brainDir = path.join(DATA_DIR, 'brain');
  const projects = fs.existsSync(brainDir)
    ? fs.readdirSync(brainDir).filter(d => fs.existsSync(path.join(brainDir, d, 'brain.db')))
    : [];
  json(res, { ok: true, config: cfg, projects, stagingDir: SKILL_STAGING_DIR, globalSkillsDir: GLOBAL_SKILLS_DIR });
}

async function scanSkillCandidates(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }
  try {
    const argv = ['scan'];
    if (parsed.project) argv.push('--project', JSON.stringify(parsed.project));
    if (parsed.minRecurrence) argv.push('--min-recurrence', String(parsed.minRecurrence));
    if (parsed.minConfidence) argv.push('--min-confidence', String(parsed.minConfidence));
    json(res, runBrainPromote(argv.join(' ')));
  } catch (e) { fail(res, e.message); }
}

function listSkillDrafts(req, res) {
  if (!fs.existsSync(SKILL_STAGING_DIR)) return json(res, { ok: true, pending: [] });
  const slugs = fs.readdirSync(SKILL_STAGING_DIR)
    .filter(d => fs.existsSync(path.join(SKILL_STAGING_DIR, d, 'SKILL.md')));
  const pending = slugs.map(slug => {
    const file = path.join(SKILL_STAGING_DIR, slug, 'SKILL.md');
    const stat = fs.statSync(file);
    let title = slug, description = '';
    try {
      const md = fs.readFileSync(file, 'utf-8');
      const titleMatch = md.match(/^#\s+(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
      const descMatch = md.match(/^description:\s*"([^"]*)"/m);
      if (descMatch) description = descMatch[1];
    } catch { /* leave defaults */ }
    return { slug, title, description, mtime: stat.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
  json(res, { ok: true, pending });
}

function getSkillDraft(req, res, url) {
  const slug = (url.searchParams.get('slug') || '').replace(/[^a-z0-9-]/gi, '');
  if (!slug) return fail(res, 'slug required', 400);
  const file = path.join(SKILL_STAGING_DIR, slug, 'SKILL.md');
  if (!fs.existsSync(file)) return fail(res, 'draft not found', 404);
  json(res, { ok: true, slug, content: fs.readFileSync(file, 'utf-8') });
}

async function approveSkillDraft(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { /* malformed JSON body → 400 */ return fail(res, 'Invalid JSON body', 400); }
  const slug = (parsed.slug || '').replace(/[^a-z0-9-]/gi, '');
  if (!slug) return fail(res, 'slug required', 400);
  try {
    json(res, runBrainPromote(`approve ${slug}`));
  } catch (e) { fail(res, e.message); }
}

function discardSkillDraft(req, res, url) {
  const slug = (url.searchParams.get('slug') || '').replace(/[^a-z0-9-]/gi, '');
  if (!slug) return fail(res, 'slug required', 400);
  const dir = path.join(SKILL_STAGING_DIR, slug);
  if (!fs.existsSync(dir)) return fail(res, 'draft not found', 404);
  fs.rmSync(dir, { recursive: true, force: true });
  json(res, { ok: true, discarded: slug });
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

// Active profile — read/written UPDATE-SAFE (DATA_DIR/hooks/user-config.json),
// never the shipped file, so a plugin auto-update can't revert the user's choice.
function getHooksProfile(req, res) {
  hooksConfig._resetCache(); // long-running server: reflect any out-of-band edit
  json(res, { profile: hooksConfig.getProfile(), names: hooksConfig.profileNames() });
}

async function setHooksProfile(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    const name = String((parsed && parsed.profile) || '').trim().toLowerCase();
    hooksConfig.saveProfile(name); // validates + writes DATA_DIR + resets cache
    json(res, { ok: true, profile: hooksConfig.getProfile() });
  } catch (e) { fail(res, e.message, 400); }
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
        const cmd = hookDisplayCmd(hook);
        const isMcp = hook && hook.type === 'mcp_tool';
        const fullPath = hookScriptPath(hook);
        const exists = isMcp ? true : (fullPath ? fs.existsSync(fullPath) : false);
        const disabled = fullPath.endsWith('.disabled');
        const active = exists && !disabled;
        result.push({
          event,
          matcher,
          command: cmd,
          scriptFile: isMcp ? `${hook.server}/${hook.tool}` : (fullPath ? path.basename(fullPath) : ''),
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

async function postBrainConsolidate(req, res, url) {
  try {
    const project = url.searchParams.get('project');
    const apply = url.searchParams.get('apply') === 'true';
    if (!project) return fail(res, 'project required', 400);
    const { consolidate } = require('./brain-consolidate.js');
    const store = require('./brain-store.js');
    try { await store.close(); } catch (e) { void e; }
    const result = await consolidate({ project, apply });
    json(res, result);
  } catch (err) {
    console.error(`[DASHBOARD] /api/brain/consolidate failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function getDoctor(req, res) {
  try {
    const doctor = require('./doctor.js');
    const results = doctor.runChecks(await doctor.gatherContext());
    json(res, { results, summary: doctor.summarize(results) });
  } catch (err) {
    console.error(`[DASHBOARD] /api/doctor failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function getValueSummary(req, res, url) {
  try {
    const range = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));
    const sinceTs = Date.now() - range * 86400_000;
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    const EVENTS = ['curation.flagged', 'lesson.captured', 'retrieve.cited', 'retrieve.injected'];

    const rows = [];
    for (const ev of EVENTS) {
      const perProject = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: ev, limit: 500 }));
      for (const { value } of perProject) {
        for (const r of value) { if (r.ts >= sinceTs) rows.push(r); }
      }
    }

    const { summarize } = require('./lib/value-summary.js');
    const summary = summarize(rows, projectFilter ? { project: projectFilter } : {});
    json(res, { rangeDays: range, projects, ...summary });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/value-summary failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function getProfileImpact(req, res, url) {
  try {
    const range = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '7', 10)));
    const sinceTs = Date.now() - range * 86400_000;
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    const perProject = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: 'stop.dispatch', limit: 2000 }));
    const rows = [];
    for (const { value } of perProject) {
      for (const r of value) { if (r.ts >= sinceTs) rows.push(r); }
    }
    const { aggregateProfileImpact } = require('./lib/profile-impact.js');
    json(res, { rangeDays: range, ...aggregateProfileImpact(rows) });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/profile-impact failed: ${err.message}`);
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

async function getSkillRoi(req, res, url) {
  try {
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    if (projects.length === 0) return json(res, { skills: [] });

    const inv = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: 'skill.invoked', limit: 2000 }));
    const out = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: 'skill.outcome', limit: 2000 }));
    const allInv = []; for (const { value } of inv) allInv.push(...value);
    const allOut = []; for (const { value } of out) allOut.push(...value);
    json(res, { skills: aggregateSkillRoi(allInv, allOut) });
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/skill-roi failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

// ─── API: Model Router (F3) ────────────────────────────────────────

/**
 * Merge the POST body ({ enabled, stickyEnabled?, fallbackEnabled?, acceptedTerms, nimApiKey?, routing? })
 * into DATA_DIR/model-router/user-config.json. Never clobbers an existing NVIDIA
 * key unless nimApiKey === null (clear) or a non-empty string (replace).
 * `stickyEnabled` is the RECOMMENDED cache-safe router switch (opt-in), persisted
 * as {sticky:{enabled}} so the shipped sticky.ttlMs survives the shipped⊕user
 * deep-merge in ensure/server. `fallbackEnabled` is the INDEPENDENT limit
 * safety-net switch (opt-in), persisted as {fallback:{enabled}} so the shipped
 * fallback.triggerStatuses/cooldown survive the deep-merge.
 */
function writeRouterOverride(body) {
  fs.mkdirSync(path.dirname(ROUTER_USER_CONFIG), { recursive: true });
  const existing = fs.existsSync(ROUTER_USER_CONFIG) ? (readJSON(ROUTER_USER_CONFIG) || {}) : {};
  const out = { ...existing };
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.acceptedTerms === 'boolean') out.acceptedTerms = body.acceptedTerms;

  if (typeof body.stickyEnabled === 'boolean') {
    out.sticky = { ...(existing.sticky || {}), enabled: body.stickyEnabled };
  }

  if (typeof body.fallbackEnabled === 'boolean') {
    out.fallback = { ...(existing.fallback || {}), enabled: body.fallbackEnabled };
  }

  const nim = { ...(existing.nim || {}) };
  if (body.nimApiKey === null) {
    nim.apiKey = '';
  } else if (typeof body.nimApiKey === 'string' && body.nimApiKey.trim() !== '') {
    nim.apiKey = body.nimApiKey.trim();
  } // else: omitted/empty → keep existing nim.apiKey untouched
  out.nim = nim;

  if (body.routing && typeof body.routing === 'object') {
    out.routing = { ...(existing.routing || {}), ...body.routing };
  }
  atomicWriteJSON(ROUTER_USER_CONFIG, out);
  return out;
}

// Deriva os 3 flags EFETIVOS (shipped ⊕ override) — fonte única p/ /config e /status.
// Espelha exatamente a precedência do server: override.<flag> vence o shipped; ausência
// no override cai no default do shipped. Usado para computar o modo CONFIGURADO.
function resolveRouterFlags() {
  const shipped = readJSON(ROUTER_SHIPPED_CONFIG) || {};
  const override = fs.existsSync(ROUTER_USER_CONFIG) ? (readJSON(ROUTER_USER_CONFIG) || {}) : {};
  const enabled = override.enabled !== undefined ? override.enabled !== false : shipped.enabled !== false;
  const shippedSticky = (shipped.sticky && shipped.sticky.enabled === true);
  const stickyEnabled = (override.sticky && override.sticky.enabled !== undefined)
    ? override.sticky.enabled === true
    : shippedSticky;
  const shippedFb = (shipped.fallback && shipped.fallback.enabled === true);
  const fallbackEnabled = (override.fallback && override.fallback.enabled !== undefined)
    ? override.fallback.enabled === true
    : shippedFb;
  return { shipped, override, enabled, stickyEnabled, fallbackEnabled };
}

// Modo CONFIGURADO (o que o proxy DEVERIA rodar após um reload) via a fonte única.
function configuredRouterMode() {
  const { enabled, stickyEnabled, fallbackEnabled } = resolveRouterFlags();
  return resolveMode({
    enabled,
    sticky:   { enabled: stickyEnabled },
    fallback: { enabled: fallbackEnabled },
  });
}

function getRouterConfig(req, res) {
  try {
    const { shipped, override, enabled, stickyEnabled, fallbackEnabled } = resolveRouterFlags();
    const nim = { ...(shipped.nim || {}), ...(override.nim || {}) };
    const routing = { ...(shipped.routing || {}), ...(override.routing || {}) };
    const key = String(nim.apiKey || '').trim();
    json(res, {
      enabled,
      stickyEnabled,
      fallbackEnabled,
      acceptedTerms: override.acceptedTerms === true,
      hasNvidiaKey: key.length > 0,
      nimMasked: key.length >= 4 ? key.slice(-4) : '',
      routing,
      shippedPort: shipped.port || 13456,
    });
  } catch (err) {
    console.error(`[DASHBOARD] /api/router/config failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

async function saveRouterConfig(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    writeRouterOverride(body);
    json(res, { ok: true, restartRequired: true });
  } catch (err) {
    console.error(`[DASHBOARD] /api/router/config (POST) failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

function getRouterStatus(req, res) {
  return getRouterStatusAsync(req, res).catch(err => {
    console.error(`[DASHBOARD] /api/router/status failed: ${err.message}`);
    fail(res, err.message, 500);
  });
}

async function getRouterStatusAsync(req, res) {
  const shipped = readJSON(ROUTER_SHIPPED_CONFIG) || {};
  const state = fs.existsSync(ROUTER_STATE_FILE) ? (readJSON(ROUTER_STATE_FILE) || {}) : {};
  const port = state.port || shipped.port || 13456;
  // Modo RODANDO: o /health ao vivo é a verdade (o proxy só sobe quando mode!=='off');
  // se o /health estiver fora mas o state file existir, cai nele; se nada responde, o
  // proxy está fora → modo rodando = 'off'. O CONFIGURADO vem dos flags mesclados: se
  // divergir do rodando, há reload pendente (o dashboard sinaliza).
  const health = await routerHttpGetJson(port, '/health');
  const running = !!(health && health.status === 'ok');
  const runningMode = running ? (health.mode || state.mode || 'off') : 'off';
  const configuredMode = configuredRouterMode();
  json(res, { running, port, pid: state.pid, lastError: state.lastError, runningMode, configuredMode });
}

async function applyRouter(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    writeRouterOverride(body);
    const ensureScript = path.join(ROOT, 'scripts', 'model-router-ensure.js');
    const child = require('child_process').spawn(process.execPath, [ensureScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: DATA_DIR },
    });
    child.unref();
    json(res, { ok: true, restartRequired: true });
  } catch (err) {
    console.error(`[DASHBOARD] /api/router/apply failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

// GET http://127.0.0.1:<port><pathName> → JSON (ou null se o router estiver fora).
function routerHttpGetJson(port, pathName) {
  return new Promise((resolve) => {
    const r = http.get(`http://127.0.0.1:${port}${pathName}`, { timeout: 800 }, (resp) => {
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { console.error(`[DASHBOARD] router ${pathName} parse: ${e.message}`); resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}

function routerHttpPost(port, pathName) {
  return new Promise((resolve) => {
    const r = http.request(`http://127.0.0.1:${port}${pathName}`, { method: 'POST', timeout: 800 }, (resp) => {
      resp.resume();
      resolve(resp.statusCode >= 200 && resp.statusCode < 300);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.end();
  });
}

function getRouterMetrics(req, res) {
  return getRouterMetricsAsync(req, res).catch(err => {
    console.error(`[DASHBOARD] /api/router/metrics failed: ${err.message}`);
    fail(res, err.message, 500);
  });
}

async function getRouterMetricsAsync(req, res) {
  const shipped = readJSON(ROUTER_SHIPPED_CONFIG) || {};
  const state = fs.existsSync(ROUTER_STATE_FILE) ? (readJSON(ROUTER_STATE_FILE) || {}) : {};
  const port = state.port || shipped.port || 13456;
  // Fresco: tenta o /metrics ao vivo; se o router estiver fora, lê o arquivo persistido.
  let m = await routerHttpGetJson(port, '/metrics');
  const live = !!m;
  if (!m) m = fs.existsSync(ROUTER_METRICS_FILE) ? (readJSON(ROUTER_METRICS_FILE) || null) : null;
  json(res, { live, metrics: m });
}

async function resetRouterMetrics(req, res) {
  try {
    const shipped = readJSON(ROUTER_SHIPPED_CONFIG) || {};
    const state = fs.existsSync(ROUTER_STATE_FILE) ? (readJSON(ROUTER_STATE_FILE) || {}) : {};
    const port = state.port || shipped.port || 13456;
    const ok = await routerHttpPost(port, '/metrics/reset');
    json(res, { ok });
  } catch (err) {
    console.error(`[DASHBOARD] /api/router/metrics/reset failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

// ─── API: Plugin version + self-update (F4) ───────────────────────
// The plugin is installed from a LOCAL marketplace, so Claude Code's /plugin
// command never pulls updates for it — the dashboard is the update surface.
let _updateCheckCache = null; // { at, data } — cached to avoid hammering GitHub

function getPluginVersion(req, res) {
  try {
    const info = pluginUpdater.getInstalledInfo(ROOT);
    const repo = pluginUpdater.readPluginRepo(ROOT);
    json(res, { installed: info.version, sha: info.sha, node: info.node, repo, installPath: info.installPath });
  } catch (err) {
    console.error(`[DASHBOARD] /api/plugin/version failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

function checkPluginUpdate(req, res, url) {
  const force = !!(url && url.searchParams.get('force') === '1');
  const TTL = 6 * 60 * 60 * 1000;
  if (!force && _updateCheckCache && (Date.now() - _updateCheckCache.at) < TTL) {
    return json(res, { ..._updateCheckCache.data, cached: true });
  }
  pluginUpdater.checkForUpdate(ROOT)
    .then((data) => { _updateCheckCache = { at: Date.now(), data }; json(res, { ...data, cached: false }); })
    .catch((err) => {
      console.error(`[DASHBOARD] /api/plugin/update-check failed: ${err.message}`);
      fail(res, err.message, 502);
    });
}

function postPluginUpdate(req, res) {
  pluginUpdater.performUpdate(ROOT)
    .then((result) => { _updateCheckCache = null; json(res, result); })
    .catch((err) => {
      console.error(`[DASHBOARD] /api/plugin/update failed: ${err.message}`);
      fail(res, err.message, 500);
    });
}

async function getCaptureRate(req, res, url) {
  try {
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    if (projects.length === 0) return json(res, { byKind: {}, spontaneous: {} });

    const nud = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: 'nudge.emitted', limit: 2000 }));
    const cap = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName: 'lesson.captured', limit: 2000 }));
    const events = [];
    for (const { value } of nud) events.push(...value);
    for (const { value } of cap) events.push(...value);
    json(res, aggregateCaptureRate(events));
  } catch (err) {
    console.error(`[DASHBOARD] /api/metrics/capture-rate failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

// ─── Router ────────────────────────────────────────────────────────

async function getTuningRecommendations(req, res, url) {
  try {
    const range = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '7', 10)));
    const sinceTs = Date.now() - range * 86400_000;
    const projectFilter = url.searchParams.get('project') || '';
    const projects = projectFilter ? [projectFilter] : listMetricsProjects();
    const gather = async (eventName) => {
      const per = await aggregateAcrossProjects(projects, s => s.getEventLog({ eventName, limit: 2000 }));
      const rows = [];
      for (const { value } of per) for (const r of value) { if (r.ts >= sinceTs) rows.push(r); }
      return rows;
    };
    const dispatch = await gather('stop.dispatch');
    const nudges = await gather('nudge.emitted');
    const caps = await gather('lesson.captured');
    const fired = (await gather('retrieve.fired')).length;
    const cited = (await gather('retrieve.cited')).length;
    const { aggregateProfileImpact } = require('./lib/profile-impact.js');
    const { analyze } = require('./lib/tuning-advisor.js');
    const activeProfile = hooksConfig.getProfile();
    const out = analyze({
      activeProfile,
      impact: aggregateProfileImpact(dispatch),
      captureRate: aggregateCaptureRate([...nudges, ...caps]),
      retrieval: { fired, cited },
    });
    json(res, { rangeDays: range, activeProfile, ...out });
  } catch (err) {
    console.error(`[DASHBOARD] /api/tuning/recommendations failed: ${err.message}`);
    fail(res, err.message, 500);
  }
}

function handleAPI(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  if (p === '/api/status' && m === 'GET') return getStatus(req, res);
  if (p === '/api/brain/backend' && m === 'GET') return getBrainBackend(req, res);
  if (p === '/api/brain/backend-config' && m === 'GET') return getBrainConfig(req, res);
  if (p === '/api/brain/backend-config' && m === 'PUT') return saveBrainConfig(req, res);
  if (p === '/api/brain/project-marker' && m === 'GET') return getProjectMarker(req, res, url);
  if (p === '/api/brain/project-marker' && m === 'POST') return saveProjectMarker(req, res);
  if (p === '/api/brain/backend-restart' && m === 'POST') return restartDashboard(req, res);
  if (p === '/api/brain/embedder/test' && m === 'POST') return testEmbedder(req, res);
  if (p === '/api/config/test' && m === 'POST') return testConfig(req, res);
  if (p === '/api/config/domains' && m === 'GET') return listConfigDomains(req, res);
  if (p === '/api/brain/projects' && m === 'GET') return getBrainProjects(req, res);
  if (p === '/api/brain/search' && m === 'GET') return searchBrain(req, res, url);
  if (p === '/api/brain/export' && m === 'GET') return exportBrain(req, res, url);
  if (p === '/api/brain/import' && m === 'POST') return importBrain(req, res);
  if (p === '/api/skill-promotion/config' && m === 'GET') return getSkillPromotionConfig(req, res);
  if (p === '/api/skill-promotion/scan' && m === 'POST') return scanSkillCandidates(req, res);
  if (p === '/api/skill-promotion/pending' && m === 'GET') return listSkillDrafts(req, res);
  if (p === '/api/skill-promotion/draft' && m === 'GET') return getSkillDraft(req, res, url);
  if (p === '/api/skill-promotion/draft' && m === 'DELETE') return discardSkillDraft(req, res, url);
  if (p === '/api/skill-promotion/approve' && m === 'POST') return approveSkillDraft(req, res);
  if (p.match(/^\/api\/brain\/entry\/[^/]+\/scope$/) && m === 'PATCH') return moveBrainEntryScope(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'GET') return getBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'DELETE') return deleteBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/related\//) && m === 'GET') return getBrainRelated(req, res, url);
  if (p === '/api/hooks' && m === 'GET') return getHooks(req, res);
  if (p.match(/^\/api\/hooks\/toggle\//) && m === 'PUT') return toggleHook(req, res, url);
  if (p === '/api/hooks/config' && m === 'GET') return getHooksConfig(req, res);
  if (p === '/api/hooks/config' && m === 'PUT') return saveHooksConfig(req, res);
  if (p === '/api/hooks/profile' && m === 'GET') return getHooksProfile(req, res);
  if (p === '/api/hooks/profile' && m === 'PUT') return setHooksProfile(req, res);
  if (p === '/api/curation/projects' && m === 'GET') return getCurationProjects(req, res);
  if (p === '/api/curation/shells' && m === 'GET') return getCurationShells(req, res, url);
  if (p.match(/^\/api\/curation\/shells\/\d+$/) && m === 'DELETE') return deleteCurationShell(req, res, url);
  if (p === '/api/logs' && m === 'GET') return getLogs(req, res);
  if (p === '/api/logs/clear' && m === 'POST') return clearLogs(req, res);
  if (p === '/api/metrics/summary' && m === 'GET') return getMetricsSummary(req, res, url);
  if (p === '/api/metrics/value-summary' && m === 'GET') return getValueSummary(req, res, url);
  if (p === '/api/doctor' && m === 'GET') return getDoctor(req, res);
  if (p === '/api/brain/consolidate' && m === 'POST') return postBrainConsolidate(req, res, url);
  if (p === '/api/metrics/event-log' && m === 'GET') return getMetricsEventLog(req, res, url);
  if (p === '/api/metrics/cleanup' && m === 'POST') return postMetricsCleanup(req, res, url);
  if (p === '/api/metrics/skill-roi' && m === 'GET') return getSkillRoi(req, res, url);
  if (p === '/api/router/config' && m === 'GET') return getRouterConfig(req, res);
  if (p === '/api/router/config' && m === 'POST') return saveRouterConfig(req, res);
  if (p === '/api/router/status' && m === 'GET') return getRouterStatus(req, res);
  if (p === '/api/router/apply' && m === 'POST') return applyRouter(req, res);
  if (p === '/api/router/metrics' && m === 'GET') return getRouterMetrics(req, res);
  if (p === '/api/router/metrics/reset' && m === 'POST') return resetRouterMetrics(req, res);
  if (p === '/api/metrics/capture-rate' && m === 'GET') return getCaptureRate(req, res, url);
  if (p === '/api/metrics/profile-impact' && m === 'GET') return getProfileImpact(req, res, url);
  if (p === '/api/tuning/recommendations' && m === 'GET') return getTuningRecommendations(req, res, url);
  if (p === '/api/plugin/version' && m === 'GET') return getPluginVersion(req, res);
  if (p === '/api/plugin/update-check' && m === 'GET') return checkPluginUpdate(req, res, url);
  if (p === '/api/plugin/update' && m === 'POST') return postPluginUpdate(req, res);

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
