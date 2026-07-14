#!/usr/bin/env node
/**
 * doctor.js — zero-config health check (U3).
 *
 * Runs a set of diagnostics and prints OK / WARN / FAIL per item, each with a
 * one-line fix. Also exposed to the dashboard (button) and to a cheap SessionStart
 * advisory (critical items only, with cooldown).
 *
 * The individual checks are PURE functions over a `ctx` snapshot (so they're
 * trivially testable); `gatherContext()` does the real environment/network/FS
 * probing and is best-effort (never throws).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const MIN_NODE = [22, 13, 0]; // node:sqlite requires >= 22.13

// Claude Code's documented hook events. Anything outside this set is either a
// typo (fail) or a runtime-dependent extension (warn).
const STANDARD_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
  'Stop', 'SubagentStop', 'PreCompact', 'Notification',
]);
// Used by this plugin but only honored by some runtimes (VS Code Copilot / newer
// Claude Code). If unsupported in the user's runtime they silently no-op.
const RUNTIME_DEPENDENT_EVENTS = new Set(['UserPromptExpansion', 'PostToolUseFailure']);

// ── Pure checks ───────────────────────────────────────────────────────────────

function _cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); }
  return 0;
}

function checkNode(ctx) {
  const raw = String(ctx.nodeVersion || '').replace(/^v/, '');
  const parts = raw.split('.').map(n => parseInt(n, 10));
  const ok = parts.length >= 2 && _cmpVersion(parts, MIN_NODE) >= 0;
  return {
    id: 'node', label: 'Node.js runtime',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `v${raw} (>= 22.13)` : `v${raw || '?'} is too old`,
    fix: ok ? '' : 'Install Node >= 22.13 (node:sqlite requirement) and restart Claude Code.',
    critical: true,
  };
}

function _envResolved(v) { return typeof v === 'string' && v.length > 0 && !v.includes('${'); }

function checkEnv(ctx) {
  const root = ctx.env && ctx.env.root;
  const data = ctx.env && ctx.env.data;
  const rootOk = _envResolved(root);
  const dataOk = _envResolved(data);
  const ok = rootOk && dataOk;
  const bad = [];
  if (!rootOk) bad.push('CLAUDE_PLUGIN_ROOT');
  if (!dataOk) bad.push('CLAUDE_PLUGIN_DATA');
  return {
    id: 'env', label: 'Plugin env variables',
    status: ok ? 'ok' : 'fail',
    detail: ok ? 'CLAUDE_PLUGIN_ROOT + CLAUDE_PLUGIN_DATA resolved' : `unresolved: ${bad.join(', ')}`,
    fix: ok ? '' : 'The launcher left a literal ${...} — ensure the plugin is loaded so Claude Code expands these, or set them explicitly.',
    critical: true,
  };
}

function checkDataDirs(ctx) {
  const populated = (ctx.dataDirCandidates || []).filter(d => d && d.populated);
  if (populated.length <= 1) {
    return {
      id: 'data-dir', label: 'Data directory',
      status: 'ok',
      detail: populated.length === 1 ? `single store: ${populated[0].path}` : 'no populated store yet',
      fix: '', critical: false,
    };
  }
  const active = ctx.env && ctx.env.data;
  return {
    id: 'data-dir', label: 'Data directory',
    status: 'warn',
    detail: `${populated.length} populated data dirs (fragmentation): ${populated.map(d => d.path).join(', ')}`,
    fix: `Consolidate into the active dir (${active}) via the dashboard export/import (smoke-export-import) so lessons aren't split.`,
    critical: false,
  };
}

function checkModel(ctx) {
  if (ctx.modelPresent) {
    return { id: 'model', label: 'Embedding model', status: 'ok', detail: `cached at ${ctx.modelCacheDir}`, fix: '', critical: false };
  }
  return {
    id: 'model', label: 'Embedding model',
    status: 'warn',
    detail: 'model not found in the durable cache (semantic search runs in keyword mode until present)',
    fix: 'Run `npm run setup:brain` (or let it download on first use) to fetch the bge-m3 model.',
    critical: false,
  };
}

function checkDaemon(ctx) {
  const d = ctx.daemon || {};
  if (!d.lockPresent) {
    return { id: 'daemon', label: 'Brain HTTP daemon', status: 'ok', detail: 'not running (optional; retrieval falls back fine)', fix: '', critical: false };
  }
  if (d.healthy && d.tokenReadable) {
    return { id: 'daemon', label: 'Brain HTTP daemon', status: 'ok', detail: `healthy on port ${d.port}`, fix: '', critical: false };
  }
  const why = !d.healthy ? 'lock present but /health failed (stale lock?)' : 'health OK but token unreadable';
  return {
    id: 'daemon', label: 'Brain HTTP daemon',
    status: 'warn', detail: why,
    fix: !d.healthy ? 'Remove the stale brain-http.lock.json or restart the daemon.' : 'Ensure brain-http.token is readable (chmod 600) or set BRAIN_HTTP_TOKEN.',
    critical: false,
  };
}

function checkHooksEvents(ctx) {
  const events = ctx.hooksEvents || [];
  const unknown = events.filter(e => !STANDARD_EVENTS.has(e) && !RUNTIME_DEPENDENT_EVENTS.has(e));
  const runtimeDep = events.filter(e => RUNTIME_DEPENDENT_EVENTS.has(e));
  if (unknown.length) {
    return {
      id: 'hooks-events', label: 'Hook events',
      status: 'fail', detail: `unrecognized event(s): ${unknown.join(', ')}`,
      fix: 'Fix the event name in hooks/hooks.json (typo or unsupported event).', critical: false,
    };
  }
  if (runtimeDep.length) {
    return {
      id: 'hooks-events', label: 'Hook events',
      status: 'warn',
      detail: `runtime-dependent event(s): ${runtimeDep.join(', ')} — honored by VS Code Copilot / newer Claude Code, no-op elsewhere`,
      fix: 'If those features seem inactive, your runtime may not fire these events — safe to ignore otherwise.',
      critical: false,
    };
  }
  return { id: 'hooks-events', label: 'Hook events', status: 'ok', detail: `${events.length} event(s), all standard`, fix: '', critical: false };
}

const CHECKS = [checkNode, checkEnv, checkDataDirs, checkModel, checkDaemon, checkHooksEvents];

/** Run every pure check over a ctx snapshot. */
function runChecks(ctx) {
  return CHECKS.map(fn => {
    try { return fn(ctx || {}); }
    catch (err) { return { id: fn.name, label: fn.name, status: 'warn', detail: `check errored: ${err.message}`, fix: '', critical: false }; }
  });
}

function summarize(results) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const criticalFail = results.some(r => r.status === 'fail' && r.critical);
  return { counts, criticalFail, ok: counts.fail === 0 };
}

// ── Context gathering (real IO; best-effort) ─────────────────────────────────

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

/**
 * Candidate data dirs to detect fragmentation. Marks which hold a populated KB.
 *
 * The REAL fragmentation shape (captured as a Brain lesson): every install mode
 * gets its own SIBLING directory directly under `~/.claude/plugins/data/`, named
 * by prefix — `claude-code-boss` (legacy/bare), `claude-code-boss-inline` (dev /
 * `--plugin-dir`), `claude-code-boss-<marketplace-name>` (marketplace install).
 * They are NOT nested under a marketplace folder. Mirrors dashboard.js's
 * `resolveBestDataDir()` scan so both surfaces agree on where the KB lives.
 */
function findDataDirCandidates(active) {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'data');
  const candidates = new Set();
  if (active) candidates.add(active);
  candidates.add(path.join(base, 'claude-code-boss'));
  try {
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base)) {
        if (/^claude-code-boss/.test(entry)) candidates.add(path.join(base, entry));
      }
    }
  } catch (e) { void e; }
  return [...candidates].map(p => ({ path: p, populated: _hasKb(p) }));
}

function _hasKb(dir) {
  try {
    const brain = path.join(dir, 'brain');
    if (!fs.existsSync(brain)) return false;
    return fs.readdirSync(brain).some(proj => fs.existsSync(path.join(brain, proj, 'brain.db')));
  } catch (e) { void e; return false; }
}

function _modelPresent(cacheDir) {
  try {
    if (!cacheDir || !fs.existsSync(cacheDir)) return false;
    // Any .onnx weight anywhere under the cache = model materialized.
    const stack = [cacheDir];
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/\.onnx$/i.test(e.name)) return true;
      }
    }
    return false;
  } catch (e) { void e; return false; }
}

function _daemonHealth(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function gatherContext() {
  const root = process.env.CLAUDE_PLUGIN_ROOT || '';
  const data = dataDir();
  const activeDataResolved = process.env.CLAUDE_PLUGIN_DATA || '';

  let modelCacheDir = '';
  let modelPresent = false;
  try {
    modelCacheDir = require('./brain-embedder.js').getModelCacheDir();
    modelPresent = _modelPresent(modelCacheDir);
  } catch (e) { void e; }

  // Daemon: lock + token + health.
  const daemon = { lockPresent: false, port: null, tokenReadable: false, healthy: false };
  try {
    const lockP = path.join(data, 'brain-http.lock.json');
    if (fs.existsSync(lockP)) {
      daemon.lockPresent = true;
      const lock = JSON.parse(fs.readFileSync(lockP, 'utf8'));
      daemon.port = Number.isInteger(lock.port) ? lock.port : null;
      daemon.tokenReadable = !!(process.env.BRAIN_HTTP_TOKEN
        || (() => { try { return fs.readFileSync(path.join(data, 'brain-http.token'), 'utf8').trim(); } catch (e) { void e; return ''; } })());
      daemon.healthy = await _daemonHealth(daemon.port);
    }
  } catch (e) { void e; }

  let hooksEvents = [];
  try {
    const hp = path.join(pluginRoot(), 'hooks', 'hooks.json');
    hooksEvents = Object.keys(JSON.parse(fs.readFileSync(hp, 'utf8')).hooks || {});
  } catch (e) { void e; }

  return {
    nodeVersion: process.version,
    env: { root, data: activeDataResolved || data },
    dataDirCandidates: findDataDirCandidates(data),
    modelCacheDir, modelPresent,
    daemon,
    hooksEvents,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const ICON = { ok: '✓', warn: '!', fail: '✗' };

function formatReport(results) {
  const lines = ['Claude Code Boss — doctor', ''];
  for (const r of results) {
    lines.push(`  [${ICON[r.status] || '?'}] ${r.label}: ${r.detail}`);
    if (r.status !== 'ok' && r.fix) lines.push(`        → ${r.fix}`);
  }
  const s = summarize(results);
  lines.push('');
  lines.push(`  ${s.counts.ok} ok · ${s.counts.warn} warn · ${s.counts.fail} fail`);
  return lines.join('\n');
}

if (require.main === module) {
  (async () => {
    const asJson = process.argv.includes('--json');
    const results = runChecks(await gatherContext());
    if (asJson) {
      process.stdout.write(JSON.stringify({ results, summary: summarize(results) }, null, 2));
    } else {
      process.stdout.write(formatReport(results) + '\n');
    }
    process.exit(summarize(results).ok ? 0 : 1);
  })().catch(err => { console.error(`[doctor] ${err.message}`); process.exit(1); });
}

module.exports = {
  runChecks, summarize, gatherContext, formatReport,
  checkNode, checkEnv, checkDataDirs, checkModel, checkDaemon, checkHooksEvents,
  findDataDirCandidates,
  STANDARD_EVENTS, RUNTIME_DEPENDENT_EVENTS, MIN_NODE,
};
