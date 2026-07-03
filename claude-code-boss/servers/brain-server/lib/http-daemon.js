/**
 * lib/http-daemon.js — the long-lived HTTP service (opt-in, additive).
 *
 * StreamableHTTP in STATEFUL mode: each MCP client `initialize` mints a session
 * (mcp-session-id) backed by its own createBrainServer()+transport, kept in a Map.
 * All sessions share the process-singleton KB; createBrainServer's mutex serializes
 * the KB ops across them. A single daemon serves N workspaces/clients (one model,
 * one SQLite) instead of N stdio processes.
 *
 * Singleton-of-process: the caller binds a fixed port; EADDRINUSE means another
 * daemon already owns it (port IS the lock). `/health` exposes pluginRoot+pid so a
 * newer launcher can detect a stale daemon and swap it (see daemon-supervisor.js).
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBrainServer } from './mcp-server.js';
import fs from 'node:fs';
import { HEALTH_PATH, MCP_PATH, lockFile, ensureToken, requestAllowed, tokenFile } from './daemon-common.js';

const SESSION_IDLE_MS = 30 * 60 * 1000; // reap sessions idle > 30 min

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { void e; return undefined; }
}

/**
 * @param {{ pluginRoot:string, dataDir:string, port:number, host?:string, version?:string }} opts
 * @returns {Promise<{ httpServer, sessions:Map, shutdown:()=>Promise<void>, port:number }>}
 *   Rejects with an Error whose `.code === 'EADDRINUSE'` if the port is taken.
 */
export async function startHttpDaemon({ pluginRoot, dataDir, port, host = '127.0.0.1', version = '2.0.0' }) {
  const sessions = new Map(); // sessionId -> { server, transport, lastSeen }
  const startedAt = Date.now();
  // Shared local token (dashboard pattern): /mcp and /shutdown require it;
  // /health stays open so any version's supervisor can probe stale-vs-current.
  const token = ensureToken(dataDir);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = (req.url || '').split('?')[0];

      // Health — the supervisor reads pluginRoot here to decide stale-vs-current.
      if (req.method === 'GET' && url === HEALTH_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, pluginRoot, dataDir, version, pid: process.pid, port,
          sessions: sessions.size, startedAt, uptimeMs: Date.now() - startedAt,
        }));
        return;
      }

      // Everything else (KB access, shutdown) is token-gated.
      const gate = requestAllowed(req, token, dataDir);
      if (!gate.ok) {
        res.writeHead(gate.code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: gate.error }));
        return;
      }

      // Graceful swap hook (localhost only) — the supervisor POSTs here on upgrade.
      if (req.method === 'POST' && url === '/shutdown') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shuttingDown: true }));
        // Let the response flush before we force connections shut.
        setTimeout(() => { shutdown().finally(() => process.exit(0)); }, 100);
        return;
      }

      if (url !== MCP_PATH) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const existing = sessionId ? sessions.get(sessionId) : null;
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;

      if (existing) {
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      // No session yet: only an initialize POST may create one.
      if (req.method === 'POST' && isInitializeRequest(body)) {
        const server = createBrainServer({ pluginRoot, mode: 'http' });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => { sessions.set(sid, { server, transport, lastSeen: Date.now() }); },
          onsessionclosed: (sid) => { sessions.delete(sid); },
        });
        transport.onclose = () => { const sid = transport.sessionId; if (sid) sessions.delete(sid); };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID (send an initialize request first)' }, id: (body && body.id) ?? null }));
    } catch (err) {
      console.error(`[brain-http] request error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  // Reap idle sessions (free their per-session server + transport).
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS) {
        try { s.transport.close(); } catch (e) { void e; }
        sessions.delete(sid);
      }
    }
  }, 60_000);
  reaper.unref();

  // Bind — the port is the singleton lock. EADDRINUSE bubbles to the caller.
  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    httpServer.once('error', onErr);
    httpServer.listen(port, host, () => { httpServer.removeListener('error', onErr); resolve(); });
  });
  try {
    fs.writeFileSync(lockFile(dataDir), JSON.stringify({ pid: process.pid, port, pluginRoot, dataDir, version, startedAt }, null, 2));
  } catch (e) { void e; }
  console.error(`[brain-http] listening on http://${host}:${port}${MCP_PATH}  (pluginRoot=${pluginRoot}, token: ${tokenFile(dataDir)})`);

  let _shuttingDown = false;
  async function shutdown() {
    if (_shuttingDown) return;
    _shuttingDown = true;
    setTimeout(() => process.exit(0), 2500).unref(); // hard fallback if close() hangs on keep-alive
    clearInterval(reaper);
    for (const [, s] of sessions) { try { await s.transport.close(); } catch (e) { void e; } }
    sessions.clear();
    try { const cur = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(lockFile(dataDir)); } catch (e) { void e; }
    try { httpServer.closeAllConnections?.(); } catch (e) { void e; } // drop keep-alive so close() resolves
    await new Promise((r) => httpServer.close(r));
  }
  process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });

  return { httpServer, sessions, shutdown, port };
}
