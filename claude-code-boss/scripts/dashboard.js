#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

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
  catch { return null; }
}

// ─── API: Status ───────────────────────────────────────────────────

function getStatus(req, res) {
  const models = readJSON(path.join(ROOT, 'config', 'model-router.json'));
  const pipelines = readJSON(path.join(ROOT, 'config', 'pipelines.json'));
  const hooksRaw = readJSON(path.join(ROOT, 'hooks', 'hooks.json'));
  const agents = models?.agents || {};
  const tiers = models?.tiers || {};

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
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const p of fs.readdirSync(projectsDir)) {
      const dbPath = path.join(projectsDir, p, 'brain', 'brain.db');
      if (fs.existsSync(dbPath)) {
        try {
          const store = require('./brain-store.js');
          store.init({ project: p });
          const count = store.count();
          brainProjects.push({ project: p, entries: count });
          brainTotal += count;
        } catch {}
      }
    }
  }

  let billingTotal = 0, billingToday = 0;
  const logFile = path.join(DATA, 'cost-tracker.log');
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    for (const line of lines.slice(-100)) {
      const m = line.match(/\| x([\d.]+) \|/);
      if (m) {
        const mult = parseFloat(m[1]);
        billingTotal += mult;
        if (line.startsWith(today)) billingToday += mult;
      }
    }
  }

  let backendMode = 'local', backendConnected = false;
  try {
    const backend = require('./brain-backend.js');
    backend.init({ project: 'default' });
    const s = backend.getStatus();
    backendMode = s.mode || 'local';
    backendConnected = s.connected !== undefined ? s.connected : true;
  } catch {}

  json(res, {
    uptime: process.uptime().toFixed(0),
    models: {
      agents: Object.keys(agents).length,
      tiers: Object.keys(tiers).length,
    },
    pipelines: pipelines?.pipelines?.length || 0,
    brain: { projects: brainProjects, totalEntries: brainTotal, backend: backendMode, connected: backendConnected },
    hooks: { total: hooksTotal, active: hooksActive },
    billing: { todayCost: billingToday, totalCost: billingTotal },
  });
}

// ─── API: Models ───────────────────────────────────────────────────

function getModels(req, res) {
  const data = readJSON(path.join(ROOT, 'config', 'model-router.json'));
  if (!data) return fail(res, 'model-router.json not found', 404);
  json(res, data);
}

async function saveModels(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    fs.writeFileSync(path.join(ROOT, 'config', 'model-router.json'), JSON.stringify(parsed, null, 2));
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

// ─── API: Pipelines ────────────────────────────────────────────────

function getPipelines(req, res) {
  const data = readJSON(path.join(ROOT, 'config', 'pipelines.json'));
  if (!data) return fail(res, 'pipelines.json not found', 404);
  json(res, data);
}

async function savePipelines(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    fs.writeFileSync(path.join(ROOT, 'config', 'pipelines.json'), JSON.stringify(parsed, null, 2));
    json(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

// ─── API: Brain Backend Status ──────────────────────────────────────

function getBrainBackend(req, res) {
  try {
    const backend = require('./brain-backend.js');
    backend.init({ project: 'default' });
    const status = backend.getStatus();
    json(res, status);
  } catch {
    json(res, { mode: 'local', error: 'brain-backend not available', fallback: true });
  }
}

// ─── API: Brain ────────────────────────────────────────────────────

function getBrainProjects(req, res) {
  const projects = [];
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return json(res, []);
  for (const p of fs.readdirSync(projectsDir)) {
    const dbPath = path.join(projectsDir, p, 'brain', 'brain.db');
    if (fs.existsSync(dbPath)) {
      try {
        const store = require('./brain-store.js');
        store.init({ project: p });
        const count = store.count();
        const stats = fs.statSync(dbPath);
        projects.push({ project: p, entries: count, dbSize: stats.size, lastModified: stats.mtime });
      } catch {}
    }
  }
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
      if (vec) results = await store.search(vec, { topK: k, minScore: 0.1 });
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

// ─── API: Billing ──────────────────────────────────────────────────

function getBillingLogs(req, res) {
  const logFile = path.join(DATA, 'cost-tracker.log');
  if (!fs.existsSync(logFile)) return json(res, []);
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
  const entries = lines.map(line => {
    const parts = line.split(' | ');
    const multMatch = line.match(/\| x([\d.]+) \|/);
    return {
      raw: line,
      timestamp: parts[0] || '',
      agent: parts[1] || '',
      model: parts[2] || '',
      multiplier: multMatch ? parseFloat(multMatch[1]) : 0,
      message: parts.slice(4).join(' | ') || '',
    };
  });
  json(res, entries.reverse());
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

// ─── Router ────────────────────────────────────────────────────────

function handleAPI(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  if (p === '/api/status' && m === 'GET') return getStatus(req, res);
  if (p === '/api/models' && m === 'GET') return getModels(req, res);
  if (p === '/api/models' && m === 'PUT') return saveModels(req, res);
  if (p === '/api/pipelines' && m === 'GET') return getPipelines(req, res);
  if (p === '/api/pipelines' && m === 'PUT') return savePipelines(req, res);
  if (p === '/api/brain/backend' && m === 'GET') return getBrainBackend(req, res);
  if (p === '/api/brain/projects' && m === 'GET') return getBrainProjects(req, res);
  if (p === '/api/brain/search' && m === 'GET') return searchBrain(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'GET') return getBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/entry\//) && m === 'DELETE') return deleteBrainEntry(req, res, url);
  if (p.match(/^\/api\/brain\/related\//) && m === 'GET') return getBrainRelated(req, res, url);
  if (p === '/api/billing/logs' && m === 'GET') return getBillingLogs(req, res);
  if (p === '/api/hooks' && m === 'GET') return getHooks(req, res);
  if (p.match(/^\/api\/hooks\/toggle\//) && m === 'PUT') return toggleHook(req, res, url);

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
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(index);
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleAPI(req, res, url);
  serveStatic(req, res);
});

const PORT = process.env.DASHBOARD_PORT || 0;
server.listen(PORT, () => {
  const port = server.address().port;
  console.log(`\n  \u{1F4CA} Plugin Dashboard: http://localhost:${port}\n`);
  const browser = { win32: 'start', darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (browser && !process.env.DASHBOARD_NO_OPEN) {
    try { execSync(`${browser} http://localhost:${port}`, { stdio: 'ignore', timeout: 5000 }); } catch {}
  }
});
