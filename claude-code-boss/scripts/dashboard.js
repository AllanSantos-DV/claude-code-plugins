#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const { getShellsConfigPath } = require('./curation-paths.js');

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
  const provider = body.provider;
  const model = (body.model || '').trim();
  if (!['transformers', 'ollama', 'voyage'].includes(provider)) return fail(res, 'Invalid provider', 400);
  if (!model) return fail(res, 'Model is required', 400);
  const t0 = Date.now();
  try {
    if (provider === 'transformers') {
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', model, { quantized: true });
      const out = await extractor('test', { pooling: 'mean', normalize: true });
      const dim = out.data.length;
      return json(res, { ok: true, dim, ms: Date.now() - t0 });
    }
    if (provider === 'ollama') {
      const { spawn } = require('child_process');
      const pullResult = await new Promise((resolve) => {
        const p = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', (err) => resolve({ ok: false, error: `Ollama not installed or not in PATH: ${err.message}` }));
        p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `ollama pull exited ${code}: ${stderr.slice(-200)}` }));
      });
      if (!pullResult.ok) return json(res, pullResult);
      const embedRes = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'test' }),
      }).catch(err => ({ ok: false, _err: err.message }));
      if (embedRes._err) return json(res, { ok: false, error: `Ollama embed call failed: ${embedRes._err}` });
      if (!embedRes.ok) return json(res, { ok: false, error: `Ollama embed HTTP ${embedRes.status}` });
      const data = await embedRes.json();
      const dim = (data.embedding || []).length;
      if (!dim) return json(res, { ok: false, error: 'Ollama returned empty embedding' });
      return json(res, { ok: true, dim, ms: Date.now() - t0 });
    }
    if (provider === 'voyage') {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) return json(res, { ok: false, error: 'VOYAGE_API_KEY env var not set. Set it before starting the dashboard.' });
      const r = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test', model }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return json(res, { ok: false, error: `Voyage HTTP ${r.status}: ${txt.slice(0, 200)}` });
      }
      const data = await r.json();
      const dim = (data.data?.[0]?.embedding || []).length;
      if (!dim) return json(res, { ok: false, error: 'Voyage returned empty embedding' });
      return json(res, { ok: true, dim, ms: Date.now() - t0 });
    }
  } catch (err) {
    return json(res, { ok: false, error: err.message });
  }
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
  if (!q || !project) return json(res, []);
  try {
    const embedder = require('./brain-embedder.js');
    await embedder.init();
    const store = require('./brain-store.js');
    store.init({ project });

    let results = [];
    if (embedder.getStatus().ready) {
      const vec = await embedder.embed(q);
      if (vec) results = await store.search(vec, { topK: k, minScore: 0.05 });
    }
    if (results.length < 2) {
      const index = require('./brain-index.js');
      index.init({ project });
      const kw = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
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
  if (p === '/api/brain/projects' && m === 'GET') return getBrainProjects(req, res);
  if (p === '/api/brain/search' && m === 'GET') return searchBrain(req, res, url);
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

  json(res, { error: 'Not found' }, 404);
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? path.join(DASHBOARD_DIR, 'index.html') : path.join(DASHBOARD_DIR, req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    let content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    // Inject session token into index.html so the SPA can authenticate API calls.
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
    console.error(`[DASHBOARD] Static serve error: ${err.message}`);
    const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'));
    const html = index.toString('utf-8').replace(
      '</head>',
      `<script>window.__DASHBOARD_TOKEN__ = '${SESSION_TOKEN}';</script>\n</head>`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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
