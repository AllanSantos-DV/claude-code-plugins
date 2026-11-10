'use strict';
/**
 * mcp-health.js — Single source of truth for backend health probing.
 *
 * Used by both dashboard.js (GET /api/brain/health) and brain-status.js
 * to prevent logic drift. Pure function: no side effects, no module-level state.
 *
 * Returns: { mode, connected, state, project, backend, details, latency }, where state is
 * 'ok', 'degraded' (reachable and working with a limitation; connected stays true and
 * details.reason says which) or 'unreachable' (connected false).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { redact } = require('../../engine/lib/redact.js');

const HEALTH_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 3000;

function probeTcpPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (alive) => { if (settled) return; settled = true; socket.destroy(); resolve(alive); };
    socket.setTimeout(timeoutMs || HEALTH_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// `new URL(...).port` is '' when the URL omits an explicit port (implicit
// default 80/443) — `parseInt('', 10)` is NaN, which is falsy, so a naive
// `parseInt(u.port, 10)` silently skips the probe for any daemon reachable on
// a bare host/https URL. Exported for isolated unit testing (same convention
// as mcp-wizard.js's _isLockStale).
function _derivePort(urlString) {
  const u = new URL(urlString);
  return u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const { URL } = require('url');
    let u;
    try { u = new URL(url); } catch (err) { console.error(`[mcp-health] invalid URL (${url}): ${err.message}`); return resolve(null); }
    const t0 = Date.now();
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs || HTTP_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ json: JSON.parse(body), latency: Date.now() - t0 }); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const ESSENTIAL_CHECKS = ['database', 'embedding_model'];

/**
 * Classify one parsed /health answer. mcp-memory answers {status:'healthy'} (>= 2.44) or {ok:true}
 * (older); 3.x answers {status:'degraded', checks, problems[]} when an optional part (rerank) fails
 * while the database and the embedding model, which capture and search need, still work.
 * @param {object} json
 * @returns {{state:'ok'}|{state:'degraded'|'unreachable', reason:string}}
 */
function classifyHealth(json) {
  if (json && (json.ok === true || json.status === 'healthy')) return { state: 'ok' };
  const checks = (json && json.checks) || {};
  if (json && json.status === 'degraded' && ESSENTIAL_CHECKS.every((c) => checks[c] === 'ok')) {
    const problems = Array.isArray(json.problems) ? json.problems.map(String).filter(Boolean) : [];
    return { state: 'degraded', reason: redact(problems.join('; ').slice(0, 200)).text || 'no reason reported' };
  }
  return { state: 'unreachable', reason: `health-bad:${redact(JSON.stringify(json)).text.slice(0, 120)}` };
}

async function probeHealth(config, opts = {}) {
  const backendType = (config && config.backend && config.backend.type) || 'local';
  const mcpCfg = (config && config.backend && config.backend.mcpMemory) || {};
  const project = opts.project || process.env.CCB_PROJECT_ID || 'default';

  if (backendType === 'mcp-memory') {
    const transport = mcpCfg.transport === 'http' ? 'http' : 'stdio';
    const serverUrl = mcpCfg.serverUrl || '';
    const runDir = mcpCfg.runDir || path.join(require('os').homedir(), '.mcp-memory', 'run');
    const resolveUrl = () => serverUrl || (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'daemon.json'), 'utf8')).url; } catch (err) { console.error(`[mcp-health] read daemon.json (${runDir}): ${err.message}`); return ''; } })();
    let daemonUrl = resolveUrl();

    if (daemonUrl) {
      // One probe → { ok, reason }. The reason travels in `details` so a "not
      // connected" report says WHY (an advisory once claimed "unreachable" while the
      // backend answered and nobody could tell which check had failed).
      const attempt = async (url) => {
        try {
          const port = _derivePort(url);
          if (!Number.isInteger(port) || !(await probeTcpPort(port))) return { ok: false, reason: 'tcp-closed' };
          const result = await httpGetJson(url + '/health', HTTP_TIMEOUT_MS);
          if (!result || !result.json) return { ok: false, reason: 'health-timeout-or-unparseable' };
          const c = classifyHealth(result.json);
          return c.state === 'unreachable' ? { ok: false, reason: c.reason } : { ok: true, latency: result.latency, state: c.state, reason: c.reason };
        } catch (err) {
          // probeTcpPort/httpGetJson resolve network failures themselves — reaching
          // here means something upstream broke (URL edge case). Surface it.
          console.error(`[mcp-health] probe failed for ${url}: ${err.message}`);
          return { ok: false, reason: `probe-error:${err.message}` };
        }
      };
      let r = await attempt(daemonUrl);
      if (!r.ok) {
        // One retry: the mcp-memory daemon may be mid-restart on a NEW port (its
        // daemon.json is rewritten) — re-resolve the URL instead of reporting the
        // old port as down.
        await new Promise((res) => setTimeout(res, 300));
        daemonUrl = resolveUrl() || daemonUrl;
        r = await attempt(daemonUrl);
      }
      if (r.ok) {
        const details = r.state === 'degraded' ? { transport, serverUrl: daemonUrl, reason: r.reason } : { transport, serverUrl: daemonUrl };
        return { mode: 'mcp-memory', connected: true, state: r.state, project, backend: 'mcp-memory', details, latency: r.latency };
      }
      return { mode: 'mcp-memory', connected: false, state: 'unreachable', project, backend: 'mcp-memory', details: { transport, serverUrl: daemonUrl, reason: r.reason }, latency: 0 };
    }

    const jarPath = mcpCfg.jarPath || path.join(dataDir(), 'mcp', 'mcp-memory-server.jar');
    const jarExists = fs.existsSync(jarPath);
    return { mode: 'mcp-memory', connected: false, state: 'unreachable', project, backend: 'mcp-memory', details: { transport, jarExists, jarPath }, latency: 0 };
  }

  const dbPath = path.join(dataDir(), 'brain', project, 'brain.db');
  const exists = fs.existsSync(dbPath);
  return { mode: 'local', connected: true, state: 'ok', project, backend: 'sqlite', details: { dbPath, exists }, latency: 0 };
}

module.exports = { probeHealth, classifyHealth, probeTcpPort, httpGetJson, _derivePort };
