#!/usr/bin/env node
const { readDaemonUrl } = require('./lib/mcp-registry.js');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const EventEmitter = require('events');

const { dataDir } = require('./lib/data-dir.js');
const DATA_DIR = dataDir();

class McpClient extends EventEmitter {
  #reconnecting = false;

  constructor(opts = {}) {
    super();
    this.jarPath = opts.jarPath || path.join(DATA_DIR, 'mcp-memory-server.jar');
    this.workspacePath = opts.workspacePath || DATA_DIR;
    this.javaArgs = opts.javaArgs || ['-Xmx512m'];
    this.downloadUrl = opts.downloadUrl || '';
    this.expectedSha256 = opts.expectedSha256 || '';
    this.requestTimeout = opts.timeout || 60000;
    this._requestId = 0;
    this._pending = new Map();
    this._buffer = '';
    this._process = null;
    this._initialized = false;
    this._startTime = 0;

    // ── HTTP (StreamableHTTP /mcp) transport — talk to an already-running daemon ──
    // transport: 'stdio' (default, spawns the JAR) | 'http' (connects to a daemon).
    this.transport = 'http'; // the only transport (native-java ADR-023: one HTTP daemon per user)
    // Explicit daemon base URL (e.g. http://127.0.0.1:61756). Empty in http mode
    // → auto-discover via the daemon registry (~/.mcp-memory/run/daemon.json).
    this.serverUrl = opts.serverUrl || '';
    // project_id stamped into the MCP `initialize` handshake so the unified DB
    // scopes this connection to the caller's project (frozen contract param).
    this.projectId = opts.projectId || '';
    this.runDir = opts.runDir || process.env.MCP_RUN_DIR
      || path.join(os.homedir(), '.mcp-memory', 'run');
    this._protocolVersion = this.transport === 'http' ? '2025-06-18' : '2024-11-05';
    this._sessionId = '';
    this._resolvedUrl = '';
    // Tool names advertised by the daemon's tools/list at handshake. Populated in
    // _handshake; initialized here so hasToolAvailable() is safe before connect().
    this._availableTools = [];
    this._serverInfo = null;
    this.autoRestart = opts.autoRestart !== false;
  }

  async connect() {
    if (this._initialized) return;
    // The server is ONE per-user HTTP daemon, started only by its own launcher (native-java
    // ADR-023 — clients never run the jar). A "stdio" config (the old default) is served the
    // same way: it used to start a private server process per client.
    await this._ensureDaemon();
    await this._connectHttp();
    this._initialized = true;
  }

  /** Ensure the Java daemon is actually running before attempting connection. */
  async _ensureDaemon() {
    const url = this.serverUrl || this._discoverDaemonUrl();
    if (url && await this._httpHealth(url)) return;
    // A server the user pointed to (serverUrl) is not ours to start.
    if (this.serverUrl || !this.autoRestart) return;
    console.error('[MCP] memory server not running — asking its launcher to start it...');
    const r = await require('./lib/mcp-launcher.js').runLauncher({ timeoutMs: 60000 });
    if (!r.ok) console.error(`[MCP] the launcher could not start the memory server: ${r.error}`);
    // _connectHttp does the final health check and fails loud.
  }

  /**
   * Execute a tool exactly once. Intended for non-idempotent operations such as
   * the server's self-update: a connection reset may mean the operation already
   * succeeded and restarted the daemon, so retrying could apply it twice.
   */
  async callToolOnce(name, args = {}, opts = {}) {
    if (!this._initialized) await this.connect();
    return this._sendRequest('tools/call', { name, arguments: args }, opts);
  }

  async _connectHttp() {
    this._resolvedUrl = (this.serverUrl || this._discoverDaemonUrl() || '').replace(/\/+$/, '');
    if (!this._resolvedUrl) {
      throw new Error(
        'MCP remote mode: no server URL. Set "backend.mcpMemory.serverUrl" in ' +
        'config/brain-config.json or start the Native Java daemon so it announces ' +
        `itself in ${path.join(this.runDir, 'daemon.json')}.`,
      );
    }
    const alive = await this._httpHealth(this._resolvedUrl);
    if (!alive) {
      throw new Error(`MCP daemon at ${this._resolvedUrl} is not reachable (/health failed). Is it running?`);
    }
    this._startTime = Date.now();
    await this._handshake();
  }

  /** Read the daemon registry (~/.mcp-memory/run/daemon.json) and return its base URL. */
  _discoverDaemonUrl() {
    return readDaemonUrl(this.runDir, { label: 'MCP', requirePort: true }) || '';
  }

  /** GET <url>/health — 200 or 503 both mean "process alive". Returns boolean. */
  _httpHealth(baseUrl) {
    return this.readHealth({ baseUrl }).then((result) => result.alive);
  }

  /**
   * Read structured daemon health without connecting an MCP session.
   * `rediscover` re-reads daemon.json on every call so a restart that changed
   * ports can be observed by lifecycle code.
   */
  readHealth({ baseUrl, rediscover = false } = {}) {
    return new Promise((resolve) => {
      const resolved = baseUrl
        || (rediscover ? this._discoverDaemonUrl() : '')
        || this.serverUrl
        || this._resolvedUrl;
      let u;
      try { u = new URL(String(resolved || '').replace(/\/+$/, '') + '/health'); }
      catch (err) {
        console.error(`[MCP] bad server URL "${resolved}": ${err.message}`);
        return resolve({ alive: false, url: resolved || '', error: err.message });
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', chunk => { if (body.length < 65536) body += chunk; });
        res.on('end', () => {
          const alive = res.statusCode === 200 || res.statusCode === 503;
          if (!alive) return resolve({ alive: false, url: resolved, statusCode: res.statusCode });
          try {
            const health = JSON.parse(body);
            resolve({ alive: true, url: resolved, statusCode: res.statusCode, health });
          } catch (err) {
            resolve({ alive: true, url: resolved, statusCode: res.statusCode, health: null, parseError: err.message });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ alive: false, url: resolved, error: 'health timeout' }); });
      req.on('error', err => resolve({ alive: false, url: resolved, error: err.message }));
    });
  }

  /** POST one JSON-RPC message to <url>/mcp. Resolves the unwrapped result (or void for notifications). */
  _httpSend(method, params, isNotification, timeoutMs = this.requestTimeout) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(this._resolvedUrl + '/mcp'); }
      catch (err) { return reject(new Error(`MCP bad URL: ${err.message}`)); }
      const payload = { jsonrpc: '2.0', method };
      if (!isNotification) payload.id = ++this._requestId;
      if (params !== undefined) payload.params = params;
      const data = Buffer.from(JSON.stringify(payload), 'utf8');

      const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Accept': 'application/json, text/event-stream' };
      // NOTE: deliberately NO `Origin` header — the daemon 403s a non-loopback Origin; absent = allowed.
      if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;

      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: timeoutMs },
        (res) => {
          // The initialize response carries the session id every later call must echo.
          const sid = res.headers['mcp-session-id'];
          if (sid) this._sessionId = sid;
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (isNotification) {
              if (res.statusCode !== 202 && res.statusCode !== 204 && res.statusCode !== 200) {
                console.error(`[MCP] notification "${method}" unexpected HTTP ${res.statusCode}`);
              }
              return resolve(undefined);
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              // A 400 with -32600 means the daemon evicted our HTTP session (idle
              // TTL, ~30min). Tag the error so callTool() can transparently
              // reconnect (new initialize → fresh session id) and retry ONCE
              // instead of failing every call after the session silently died.
              const err = new Error(`MCP "${method}" HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
              if (res.statusCode === 400 && body.includes('-32600')) err.code = 'SESSION_EXPIRED';
              return reject(err);
            }
            let msg;
            try { msg = JSON.parse(body); }
            catch (err) { return reject(new Error(`MCP "${method}" bad JSON: ${err.message}`)); }
            if (msg.error) return reject(new Error(`MCP "${method}" error: ${JSON.stringify(msg.error)}`));
            resolve(this._unwrapResult(msg.result));
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`)); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async _handshake() {
    const initialized = await this._sendRequest('initialize', {
      protocolVersion: this._protocolVersion,
      capabilities: {},
      clientInfo: { name: 'claude-code-brain', version: '1.0.0' },
      // Frozen contract: stamps the unified-DB scope for this whole session.
      ...(this.projectId ? { projectId: this.projectId } : {}),
    });
    this._serverInfo = initialized && initialized.serverInfo || null;

    this._sendNotification('notifications/initialized');

    const tools = await this._sendRequest('tools/list');
    this._availableTools = (tools?.tools || tools?.result?.tools || []).map(t => t.name);
  }

  async callTool(name, args = {}, _retryCount = 0) {
    if (!this._initialized) await this.connect();
    try {
      return await this._sendRequest('tools/call', { name, arguments: args });
    } catch (err) {
      // The daemon dropped our HTTP session (idle TTL, ~30min). Reconnect (fresh
      // initialize → new session id) and retry the SAME call exactly ONCE. This
      // keeps long-lived stdio brain-servers (opencode/Claude Code sessions that
      // sit idle) from going permanently deaf after the session silently expired.
      if (err && err.code === 'SESSION_EXPIRED' && this.transport === 'http') {
        if (_retryCount >= 1) throw err; // max 1 retry — no infinite loop
        try {
          await this._reconnect();
        } catch (reconnectErr) {
          // Wrap original error with reconnect failure context for debugging
          const wrapped = new Error(`SESSION_EXPIRED: reconnect failed: ${reconnectErr.message}`);
          wrapped.code = 'SESSION_EXPIRED';
          wrapped.originalError = err;
          wrapped.reconnectError = reconnectErr;
          throw wrapped;
        }
        return this.callTool(name, args, _retryCount + 1);
      }

      // Daemon restarted on a new port (daemon.json updated): connection refused,
      // timeout, or other network error. Re-discover URL and retry ONCE.
      if (this.transport === 'http' && _retryCount === 0) {
        const isConnectionError = err.code === 'ECONNREFUSED'
          || err.code === 'ETIMEDOUT'
          || err.code === 'ENOTFOUND'
          || err.message?.includes('ECONNREFUSED')
          || err.message?.includes('timeout')
          || err.message?.includes('connect');
        if (isConnectionError) {
          console.error(`[MCP] Connection error (${err.code || err.message}), re-discovering daemon URL and retrying once`);
          try {
            await this._reconnect();
          } catch (reconnectErr) {
            const wrapped = new Error(`DAEMON_RESTART: reconnect failed: ${reconnectErr.message}`);
            wrapped.code = 'DAEMON_RESTART';
            wrapped.originalError = err;
            wrapped.reconnectError = reconnectErr;
            throw wrapped;
          }
          return this.callTool(name, args, _retryCount + 1);
        }
      }

      throw err;
    }
  }

  /** Re-run the HTTP handshake after a session expired server-side (TTL eviction)
   *  or when the daemon restarts on a new port (daemon.json updated). */
  async _reconnect() {
    if (this.#reconnecting) {
      while (this.#reconnecting) await new Promise(r => setTimeout(r, 10));
      return;
    }
    this.#reconnecting = true;
    try {
      this._sessionId = '';
      this._initialized = false;
      this._requestId = 0;
      // Force re-discovery of daemon URL in case the port changed on restart.
      this._resolvedUrl = '';
      await this.connect();
    } finally {
      this.#reconnecting = false;
    }
  }

  /**
   * True iff the daemon advertised `name` in its tools/list at handshake.
   * Safe to call before connect() (returns false). This is the fail-loud guard
   * the recall path uses to REQUIRE compose_recall rather than silently falling
   * back to the flat search_memory paradigm.
   */
  hasToolAvailable(name) {
    return Array.isArray(this._availableTools) && this._availableTools.includes(name);
  }

  getServerInfo() {
    return this._serverInfo;
  }

  _sendRequest(method, params, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : this.requestTimeout;
    if (this.transport === 'http') return this._httpSend(method, params, false, timeoutMs);
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }) + '\n';

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.requestTimeout}ms`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer, method });
      this._process.stdin.write(msg);
    });
  }

  _sendNotification(method, params) {
    if (this.transport === 'http') {
      this._httpSend(method, params, true).catch(err => console.error(`[MCP] notification "${method}": ${err.message}`));
      return;
    }
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    }) + '\n';
    this._process.stdin.write(msg);
  }

  /** Unwrap a JSON-RPC result into {text, raw} when it's MCP text content, else the raw result. */
  _unwrapResult(result) {
    const content = result?.content;
    if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
      return { text: content[0].text, raw: result };
    }
    return result || {};
  }

  _processBuffer() {
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (err) { console.error(`[MCP] Buffer parse error: ${err.message}`); }
    }
  }

  _handleMessage(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer, method } = this._pending.get(msg.id);
      clearTimeout(timer);
      this._pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(`MCP "${method}" error: ${JSON.stringify(msg.error)}`));
      } else {
        resolve(this._unwrapResult(msg.result));
      }
    }
  }

  isConnected() {
    if (this.transport === 'http') return this._initialized;
    return this._initialized && this._process !== null && !this._process.killed;
  }

  close({ skipRemote = false } = {}) {
    if (this.transport === 'http') {
      // Best-effort DELETE /mcp to end the daemon session; never throw on close.
      if (!skipRemote && this._sessionId && this._resolvedUrl) {
        try {
          const u = new URL(this._resolvedUrl + '/mcp');
          const lib = u.protocol === 'https:' ? https : http;
          const req = lib.request(
            { hostname: u.hostname, port: u.port, path: u.pathname, method: 'DELETE', headers: { 'Mcp-Session-Id': this._sessionId }, timeout: 3000 },
            (res) => res.resume(),
          );
          req.on('timeout', () => req.destroy());
          req.on('error', (err) => console.error(`[MCP] close DELETE: ${err.message}`));
          req.end();
        } catch (err) { console.error(`[MCP] close DELETE: ${err.message}`); }
      }
      for (const [id, { reject }] of this._pending) {
        reject(new Error('MCP client closed'));
        this._pending.delete(id);
      }
      this._sessionId = '';
      this._initialized = false;
      return;
    }
    if (this._process) {
      const proc = this._process; // capture BEFORE nulling, else the 2s fallback kill sees null and never fires (JVM leak)
      this._sendNotification('notifications/exit');
      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill();
        }
      }, 2000);
      for (const [id, { reject }] of this._pending) {
        reject(new Error('MCP client closed'));
        this._pending.delete(id);
      }
      this._initialized = false;
      this._process = null;
    }
  }
}

module.exports = McpClient;
