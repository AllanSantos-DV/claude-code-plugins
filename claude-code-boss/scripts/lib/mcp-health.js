'use strict';
/**
 * mcp-health.js — Single source of truth for backend health probing.
 *
 * Used by both dashboard.js (GET /api/brain/health) and brain-status.js
 * to prevent logic drift. Pure function: no side effects, no module-level state.
 *
 * Returns: { mode, connected, project, backend, details, latency }
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { dataDir } = require('./data-dir.js');

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

async function probeHealth(config) {
  const backendType = (config && config.backend && config.backend.type) || 'local';
  const mcpCfg = (config && config.backend && config.backend.mcpMemory) || {};
  const project = process.env.CCB_PROJECT_ID || 'default';

  if (backendType === 'mcp-memory') {
    const transport = mcpCfg.transport === 'http' ? 'http' : 'stdio';
    const serverUrl = mcpCfg.serverUrl || '';
    const runDir = mcpCfg.runDir || path.join(require('os').homedir(), '.mcp-memory', 'run');
    const daemonUrl = serverUrl || (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'daemon.json'), 'utf8')).url; } catch (err) { console.error(`[mcp-health] read daemon.json (${runDir}): ${err.message}`); return ''; } })();

    if (daemonUrl) {
      try {
        const port = _derivePort(daemonUrl);
        if (Number.isInteger(port) && await probeTcpPort(port)) {
          const result = await httpGetJson(daemonUrl + '/health', HTTP_TIMEOUT_MS);
          if (result && result.json && result.json.ok) {
            return { mode: 'mcp-memory', connected: true, project, backend: 'mcp-memory', details: { transport, serverUrl: daemonUrl }, latency: result.latency };
          }
        }
      } catch (err) {
        // probeTcpPort/httpGetJson already resolve network failures to false/null —
        // reaching here means something upstream of them broke (bad daemon.json,
        // URL edge case). Surface it instead of silently reporting "disconnected"
        // for a reason nobody can see.
        console.error(`[mcp-health] probe failed for ${daemonUrl}: ${err.message}`);
      }
      return { mode: 'mcp-memory', connected: false, project, backend: 'mcp-memory', details: { transport, serverUrl: daemonUrl }, latency: 0 };
    }

    const jarPath = mcpCfg.jarPath || path.join(dataDir(), 'mcp', 'mcp-memory-server.jar');
    const jarExists = fs.existsSync(jarPath);
    return { mode: 'mcp-memory', connected: false, project, backend: 'mcp-memory', details: { transport, jarExists, jarPath }, latency: 0 };
  }

  const dbPath = path.join(dataDir(), 'brain', project, 'brain.db');
  const exists = fs.existsSync(dbPath);
  return { mode: 'local', connected: true, project, backend: 'sqlite', details: { dbPath, exists }, latency: 0 };
}

module.exports = { probeHealth, probeTcpPort, httpGetJson, _derivePort };
