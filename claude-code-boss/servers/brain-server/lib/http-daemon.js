/**
 * lib/http-daemon.js — the long-lived HTTP service (opt-in, additive).
 *
 * StreamableHTTP in STATEFUL mode: each MCP client `initialize` mints a session
 * (mcp-session-id) backed by its own createBrainServer()+transport, kept in a Map.
 * All sessions share the process-wide kb-worker POOL (ADR-014); createBrainServer's
 * per-slot mutex pool serializes KB ops that land on the same sticky worker, while
 * different projects on different workers run in parallel. A single daemon serves
 * N workspaces/clients instead of N stdio processes.
 *
 * Singleton-of-process: the caller binds a fixed port; EADDRINUSE means another
 * daemon already owns it (port IS the lock). `/health` exposes pluginRoot+pid so a
 * newer launcher can detect a stale daemon and swap it (see daemon-supervisor.js).
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBrainServer, createKbLockPool } from './mcp-server.js';
import { createKbWorkerPool } from './kb-worker-client.js';
import { createHookWorker } from './hook-worker-client.js';
import { createEmbedWorker } from './embed-worker-client.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { HEALTH_PATH, MCP_PATH, lockFile, ensureToken, requestAllowed, tokenFile, canonicalDataDir } from './daemon-common.js';

const SESSION_IDLE_MS = 30 * 60 * 1000; // reap sessions idle > 30 min
// SSE comment on the open GET stream: well under Claude Code's ~6 min idle timeout.
const SSE_KEEPALIVE_MS = Number(process.env.CCB_SSE_KEEPALIVE_MS) || 30_000;

const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_SESSIONS = 50; // limite de sessões simultâneas para evitar exaustão de FDs

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { void e; return undefined; }
}

/**
 * @param {{ pluginRoot:string, dataDir:string, port:number, host?:string, version?:string }} opts
 * @returns {Promise<{ httpServer, sessions:Map, shutdown:()=>Promise<void>, port:number }>}
 *   Rejects with an Error whose `.code === 'EADDRINUSE'` if the port is taken.
 */
export async function startHttpDaemon({ pluginRoot, dataDir, port, host = '127.0.0.1', version = '2.0.0', sseKeepaliveMs = SSE_KEEPALIVE_MS, sessionIdleMs = SESSION_IDLE_MS, reapIntervalMs = 60_000 }) {
  const sessions = new Map(); // sessionId -> { server, transport, lastSeen }
  const startedAt = Date.now();
  // ONE pool of N workers for the whole daemon process (not per session): moves
  // brain-store.js's synchronous SQLite calls off this main thread, so GET /health
  // and every other session's HTTP traffic keep responding while a KB call is in
  // flight elsewhere. Sticky per-project routing (ADR-014) — see lib/kb-worker-client.js.
  const kbWorker = createKbWorkerPool({ pluginRoot });
  // ONE heavy-lane hook worker for the whole daemon (G2): Stop + PostToolUse hooks
  // run there, off the thread that serves every session's HTTP and fast guards.
  const hookWorker = createHookWorker({ pluginRoot });
  // C4c: per-hook latency (process-wide accumulator shared by every session's hookTools).
  // Read at /health time; an unloadable module must not stop the boot — reported, not hidden.
  const hookLatencyStats = () => {
    try {
      return createRequire(import.meta.url)(path.join(pluginRoot, 'scripts', 'lib', 'hook-tools.js')).hookLatencyStats();
    } catch (err) {
      return { unavailable: err.message };
    }
  };
  // ONE embedder worker (G12): the model and its inference leave the main thread that
  // serves every session's HTTP and guards; brain-embedder delegates to it in-process.
  const embedWorker = createEmbedWorker({ pluginRoot });
  // The embedder is optional (keyword fallback) and was only ever loaded on demand:
  // an unloadable module must not stop the daemon from booting — say so and go on.
  let embedderModule = null;
  try {
    embedderModule = createRequire(import.meta.url)(path.join(pluginRoot, 'scripts', 'brain-embedder.js'));
    embedderModule.setDelegate(embedWorker);
  } catch (err) {
    console.error(`[brain-http] embedder module unavailable (${err.message}) — semantic search off, keyword fallback only`);
  }
  // ONE lock pool (one mutex per kb-worker slot) for the whole daemon process (not
  // per session): dispatchKbTool only serializes KB tool calls that land on the SAME
  // slot across sessions if every session's createBrainServer shares this same pool
  // — see createKbLockPool()'s doc comment in mcp-server.js.
  const kbLock = createKbLockPool(kbWorker.poolSize);
  // Shared local token (dashboard pattern): /shutdown and /mcp require it. Claude Code
  // gets it for /mcp from the .mcp.json `headersHelper` (scripts/mcp-headers.js), which
  // reads this same file. /health stays open so any version's supervisor can probe
  // stale-vs-current.
  const token = ensureToken(dataDir);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = (req.url || '').split('?')[0];

      // Health — the supervisor reads pluginRoot here to decide stale-vs-current.
      if (req.method === 'GET' && url === HEALTH_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, pluginRoot, dataDir, version, pid: process.pid, port,
          sessions: sessions.size, hookWorker: hookWorker.stats(), hookLatency: hookLatencyStats(), startedAt, uptimeMs: Date.now() - startedAt,
        }));
        return;
      }

      // /shutdown is destructive (kills the singleton daemon) and is never called by
      // Claude Code's MCP client — full token gate, same as before.
      if (req.method === 'POST' && url === '/shutdown') {
        const gate = requestAllowed(req, token, dataDir);
        if (!gate.ok) {
          res.writeHead(gate.code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: gate.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shuttingDown: true }));
        // Let the response flush before we force connections shut.
        setTimeout(() => { shutdown(); }, 100);
        return;
      }

      if (url !== MCP_PATH) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      // /mcp: origin guard + the local token (sent by Claude Code through the
      // headersHelper). Without it any local process — another OS user's included —
      // could read/write the KB and drive the hook tools through the fixed port.
      const gate = requestAllowed(req, token, dataDir);
      if (!gate.ok) {
        res.writeHead(gate.code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: gate.error }));
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const existing = sessionId ? sessions.get(sessionId) : null;
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;

      if (existing) {
        existing.lastSeen = Date.now();
        // The GET is the client's long-lived SSE stream; the SDK sends nothing on it
        // until there is an event. Claude Code 2.1.283 times an idle stream out at ~6
        // min ("SSE stream disconnected: TimeoutError"), and 3 in a row close the whole
        // transport — every session cycled through reconnects all day, and a reconnect
        // that met a daemon restart gave up for good. An SSE comment line keeps it alive
        // (readers ignore it); written only between whole events, after the headers.
        if (req.method === 'GET') {
          const ka = setInterval(() => {
            if (res.headersSent && !res.writableEnded) res.write(': keepalive\n\n');
          }, sseKeepaliveMs);
          ka.unref();
          // An open stream = a connected client, however quiet: the idle reaper must not
          // take it (it did, after 30 min — the next prompt's mcp_tool hooks then hit
          // "Session not found" and showed "UserPromptSubmit hook error / Connection closed").
          existing.openStreams = (existing.openStreams || 0) + 1;
          res.on('close', () => {
            clearInterval(ka);
            existing.openStreams = Math.max(0, existing.openStreams - 1);
            existing.lastSeen = Date.now();
          });
        }
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      // No session yet: only an initialize POST may create one.
      if (req.method === 'POST' && isInitializeRequest(body)) {
        if (sessions.size >= MAX_SESSIONS) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: (body && body.id) ?? null }));
          return;
        }
        // requestRestart: a backend switch (backend_setup) needs a fresh daemon — every module
        // caches the backend mode. Shut down after the reply; the clients' headersHelper respawns it.
        const server = createBrainServer({ pluginRoot, mode: 'http', kbWorker, kbLock, hookWorker, requestRestart: () => { setTimeout(() => { shutdown(); }, 1500); } });
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

      // A session id we don't know (daemon swapped/restarted, or the idle reaper took
      // it) MUST be 404: the MCP spec (2025-06-18, Streamable HTTP › Session
      // Management 3–4) makes 404 the client's cue to re-initialize; a 400 leaves it
      // stuck on a dead session. 400 stays for a non-initialize request with NO id.
      const unknown = !!sessionId;
      res.writeHead(unknown ? 404 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: unknown ? 'Session not found (re-initialize)' : 'No valid session ID (send an initialize request first)' }, id: (body && body.id) ?? null }));
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
      if (!s.openStreams && now - s.lastSeen > sessionIdleMs) {
        try { s.transport.close(); } catch (e) { void e; }
        sessions.delete(sid);
      }
    }
  }, reapIntervalMs);
  reaper.unref();

  // Bind — the port is the singleton lock. EADDRINUSE bubbles to the caller.
  await new Promise((resolve, reject) => {
    const onErr = (err) => { httpServer.removeListener('error', onErr); reject(err); };
    httpServer.once('error', onErr);
    httpServer.listen(port, host, () => { httpServer.removeListener('error', onErr); resolve(); });
  });
  try {
    // Record the CANONICAL dataDir — a lockfile that stored a different spelling than
    // callers pass is the very confusion this normalization fixes.
    fs.writeFileSync(lockFile(dataDir), JSON.stringify({ pid: process.pid, port, pluginRoot, dataDir: canonicalDataDir(dataDir), version, startedAt }, null, 2));
  } catch (e) { void e; }
  console.error(`[brain-http] listening on http://${host}:${port}${MCP_PATH}  (pluginRoot=${pluginRoot}, token: ${tokenFile(dataDir)})`);

  let _shuttingDown = false;
  async function shutdown() {
    if (_shuttingDown) return;
    _shuttingDown = true;
    setTimeout(() => {}, 2500).unref(); // fallback de tempo — o supervisor gerencia o ciclo de vida
    clearInterval(reaper);
    for (const [, s] of sessions) { try { await s.transport.close(); } catch (e) { void e; } }
    sessions.clear();
    try { const cur = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(lockFile(dataDir)); } catch (e) { void e; }
    try { httpServer.closeAllConnections?.(); } catch (e) { void e; } // drop keep-alive so close() resolves
    await new Promise((r) => httpServer.close(r));
    try { await kbWorker.shutdown(); } catch (e) { void e; }
    try { await hookWorker.shutdown(); } catch (e) { void e; }
    if (embedderModule) embedderModule.setDelegate(null); // never leave the module pointing at a closed worker
    try { await embedWorker.shutdown(); } catch (e) { void e; }
  }
  process.once('SIGTERM', () => { shutdown().finally(() => {}); });
  process.once('SIGINT', () => { shutdown().finally(() => {}); });

  return { httpServer, sessions, shutdown, port };
}
