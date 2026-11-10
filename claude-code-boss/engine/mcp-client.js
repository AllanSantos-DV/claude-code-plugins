#!/usr/bin/env node
const { readDaemonUrl } = require('../scripts/lib/mcp-bootstrap/registry.js');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const EventEmitter = require('events');

/** The rejection for a call cancelled through its AbortSignal (no retry, not a transport failure). */
function abortError(method, signal) {
  const why = signal && signal.reason && signal.reason.message ? `: ${signal.reason.message}` : '';
  return Object.assign(new Error(`MCP request "${method}" aborted${why}`), { code: 'ABORTED', name: 'AbortError' });
}

/** The error of a call whose budget ran out; `step` names where (connect, probes, reconnect, retry). */
function deadlineError(name, ms, step) {
  return Object.assign(new Error(`MCP call "${name}" timed out: its ${ms} ms budget ran out during ${step}`), { code: 'DEADLINE' });
}

/** One budget per call, from its `timeoutMs` and `signal`: the connect, probes, reconnect and retry all draw from it. */
function callBudget(name, opts) {
  const ms = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  return { name, ms, deadline: ms ? Date.now() + ms : 0, signal: opts.signal };
}

/** Connection-phase failures: the request never left this machine, so repeating it cannot duplicate it. */
const UNDELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH']);
/** Failures after the request may have reached the daemon (reset, timeout, hang up): outcome unknown. */
const AMBIGUOUS_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);
/** mcp-memory tools that change nothing: always safe to repeat. Anything else counts as a write. */
const READ_TOOLS = new Set([
  'search_memory', 'get_context', 'compose_recall', 'get_document', 'get_recent',
  'list_documents', 'summarize_memory', 'get_project', 'lookup_scoped_rules',
]);

/** @returns {'undelivered'|'ambiguous'|null} how a transport error relates to delivery of the request. */
function classifyTransportError(err) {
  if (!err || err.code === 'ABORTED') return null;
  const code = err.code || (err.cause && err.cause.code) || '';
  if (UNDELIVERED_CODES.has(code)) return 'undelivered';
  if (AMBIGUOUS_CODES.has(code)) return 'ambiguous';
  const m = String(err.message || '');
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH/.test(m)) return 'undelivered';
  if (/timed out|timeout|ECONNRESET|socket hang up|EPIPE/i.test(m)) return 'ambiguous';
  return null;
}

class McpClient extends EventEmitter {
  #reconnectP = null;

  constructor(opts = {}) {
    super();
    this.requestTimeout = opts.timeout || 60000;
    this._requestId = 0;
    this._initialized = false;

    // StreamableHTTP /mcp against the ONE per-user daemon (native-java ADR-023). The stdio
    // transport (a private JAR process per client) is gone.
    this.transport = 'http';
    // Explicit daemon base URL (e.g. http://127.0.0.1:61756). Empty in http mode
    // → auto-discover via the daemon registry (~/.mcp-memory/run/daemon.json).
    this.serverUrl = opts.serverUrl || '';
    // project_id stamped into the MCP `initialize` handshake so the unified DB
    // scopes this connection to the caller's project (frozen contract param).
    this.projectId = opts.projectId || '';
    this.runDir = opts.runDir || process.env.MCP_RUN_DIR
      || path.join(os.homedir(), '.mcp-memory', 'run');
    this._protocolVersion = '2025-06-18';
    this._sessionId = '';
    this._resolvedUrl = '';
    // Tool names advertised by the daemon's tools/list at handshake. Populated in
    // _handshake; initialized here so hasToolAvailable() is safe before connect().
    this._availableTools = [];
    this._serverInfo = null;
    this.autoRestart = opts.autoRestart !== false;
    // 'wait' (default: CLIs can afford the boot) or 'background' (the brain daemon — see _ensureDaemon).
    this.restartMode = opts.restartMode === 'background' ? 'background' : 'wait';
    this._kickLauncher = typeof opts.kickLauncher === 'function' ? opts.kickLauncher : null; // test seam
    this._runLauncher = typeof opts.runLauncher === 'function' ? opts.runLauncher : null; // test seam
    // One restart per outage: a later one only after the cooldown, so a daemon that cannot start is reported, not hammered.
    this.restartWaitMs = Number.isFinite(opts.restartWaitMs) ? opts.restartWaitMs : 5000;
    this.restartTimeoutMs = Number.isFinite(opts.restartTimeoutMs) ? opts.restartTimeoutMs : 60000;
    this.restartCooldownMs = Number.isFinite(opts.restartCooldownMs) ? opts.restartCooldownMs : 60000;
    this._lastRestartAt = 0;
    // Backoff of the probes after a refused connection, before the launcher may be started.
    this.refusedRetryDelaysMs = Array.isArray(opts.refusedRetryDelaysMs) ? opts.refusedRetryDelaysMs : [250, 500, 1000];
  }

  /**
   * A refused connection is usually the server restarting: probe the announced server now and then
   * after each backoff step, so a brief restart is waited out instead of starting the launcher.
   * @param {AbortSignal} [signal] the caller's cancellation, checked between probes
   * @returns {Promise<boolean>} true when an announced server answered healthy
   */
  async _awaitRestartedServer(signal) {
    for (const ms of [0, ...this.refusedRetryDelaysMs]) {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      if (signal && signal.aborted) return false;
      const url = this.serverUrl || this._discoverDaemonUrl();
      if (url && await this._httpHealth(url)) return true;
    }
    return false;
  }

  async connect() {
    if (this._initialized) return;
    // The server is ONE per-user HTTP daemon, started only by its own launcher (native-java
    // ADR-023 — clients never run the jar). A "stdio" config (the old default) is served the
    // same way: it used to start a private server process per client.
    await this._ensureDaemon();
    await this._connectHttp();
    this._initialized = true;
    this._lastRestartAt = 0;
  }

  /** Ensure the Java daemon is actually running before attempting connection. */
  async _ensureDaemon() {
    const url = this.serverUrl || this._discoverDaemonUrl();
    if (url && await this._httpHealth(url)) return;
    // A server the user pointed to (serverUrl) is not ours to start.
    if (this.serverUrl || !this.autoRestart) return;
    const since = Date.now() - this._lastRestartAt;
    if (this._lastRestartAt && since < this.restartCooldownMs) {
      const err = new Error(`the memory server is down: its launcher was already tried ${Math.round(since / 1000)} s ago and it is still not announcing a healthy server (${path.join(this.runDir, 'daemon.json')}) — not retrying; run backend_setup or see ~/.mcp-memory/logs/daemon.log`);
      err.code = 'MEMORY_SERVER_DOWN';
      throw err;
    }
    this._lastRestartAt = Date.now();
    if (this.restartMode === 'background') {
      // The brain daemon answers MCP tools inside a session: waiting for a full boot outlasted the
      // tool's timeout (BACKLOG Q59), so the wait is short: start the launcher detached, watch the
      // announcement for restartWaitMs, and answer with a clear, retryable error if it is not up.
      const kicked = (this._kickLauncher || require('../scripts/lib/mcp-bootstrap/launcher.js').kickLauncher)();
      if (kicked && await this._waitAnnounced(this.restartWaitMs)) return;
      const err = new Error(kicked
        ? `the memory server is not running — its launcher was started in the background and the server did not announce itself within ${this.restartWaitMs} ms; retry in a few seconds`
        : 'the memory server is not running and its launcher was not found (~/.mcp-memory/bin) — run backend_setup');
      err.code = 'MEMORY_SERVER_RESTARTING';
      throw err;
    }
    console.error('[MCP] memory server not running — asking its launcher to start it...');
    const runLauncher = this._runLauncher || require('../scripts/lib/mcp-bootstrap/launcher.js').runLauncher;
    const r = await runLauncher({ timeoutMs: this.restartTimeoutMs });
    if (!r.ok) console.error(`[MCP] the launcher could not start the memory server: ${r.error}`);
    // _connectHttp does the final health check and fails loud.
  }

  /** Poll the daemon announcement until it names a healthy server, at most `ms`. True when it does. */
  async _waitAnnounced(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const url = this._discoverDaemonUrl();
      if (url && await this._httpHealth(url)) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
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

  /** POST one JSON-RPC message to <url>/mcp. Resolves the unwrapped result (or void for notifications).
   *  `signal` (AbortSignal) cancels the request for real: the socket is destroyed, so a caller's
   *  deadline does not leave the call running in the background until the 60 s client timeout. */
  _httpSend(method, params, isNotification, timeoutMs = this.requestTimeout, signal = undefined) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError(method, signal));
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
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: timeoutMs, ...(signal ? { signal } : {}) },
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
      req.on('error', (err) => reject(signal && signal.aborted ? abortError(method, signal) : err));
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

  /**
   * Waits for `promise` only while the call's budget lasts. Past the deadline (or on abort) the caller gets the
   * error at once; the step itself keeps running and only its late failure is logged.
   */
  async _within(promise, budget, step) {
    if (!budget || (!budget.deadline && !budget.signal)) return promise;
    let timer;
    let onAbort;
    let gaveUp = false;
    const guard = new Promise((_, reject) => {
      const giveUp = (err) => { gaveUp = true; reject(err); };
      if (budget.signal && budget.signal.aborted) return giveUp(abortError(budget.name, budget.signal));
      if (budget.deadline) {
        const left = budget.deadline - Date.now();
        if (left <= 0) return giveUp(deadlineError(budget.name, budget.ms, step));
        timer = setTimeout(() => giveUp(deadlineError(budget.name, budget.ms, step)), left);
      }
      if (budget.signal) {
        onAbort = () => giveUp(abortError(budget.name, budget.signal));
        budget.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer);
      if (onAbort) budget.signal.removeEventListener('abort', onAbort);
      if (gaveUp) promise.catch((late) => console.error(`[MCP] ${step} for "${budget.name}" failed after its caller gave up: ${late && late.message}`));
    }
  }

  /**
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts] `timeoutMs` is the budget of the WHOLE call
   *   (connect, the request, a reconnect and its one retry), so a hook with a hard deadline gets an answer or an
   *   error before it; `signal` cancels it.
   */
  async callTool(name, args = {}, opts = {}, _retryCount = 0, _budget = callBudget(name, opts)) {
    if (!this._initialized) await this._within(this.connect(), _budget, 'connect');
    try {
      const left = _budget.deadline ? _budget.deadline - Date.now() : 0;
      if (_budget.deadline && left <= 0) throw deadlineError(name, _budget.ms, 'the retry');
      return await this._sendRequest('tools/call', { name, arguments: args }, _budget.deadline ? { ...opts, timeoutMs: left } : opts);
    } catch (err) {
      // The caller gave up (its deadline): retrying would only redo the slow call.
      if (err && (err.code === 'ABORTED' || err.code === 'DEADLINE')) throw err;
      // The daemon dropped our HTTP session (idle TTL, ~30min). Reconnect (fresh
      // initialize → new session id) and retry the SAME call exactly ONCE. This
      // keeps long-lived stdio brain-servers (opencode/Claude Code sessions that
      // sit idle) from going permanently deaf after the session silently expired.
      if (err && err.code === 'SESSION_EXPIRED' && this.transport === 'http') {
        if (_retryCount >= 1) throw err; // max 1 retry — no infinite loop
        try {
          await this._within(this._reconnect(), _budget, 'the reconnect');
        } catch (reconnectErr) {
          if (reconnectErr.code === 'ABORTED' || reconnectErr.code === 'DEADLINE') throw reconnectErr;
          // Wrap original error with reconnect failure context for debugging
          const wrapped = new Error(`SESSION_EXPIRED: reconnect failed: ${reconnectErr.message}`);
          wrapped.code = 'SESSION_EXPIRED';
          wrapped.originalError = err;
          wrapped.reconnectError = reconnectErr;
          throw wrapped;
        }
        return this.callTool(name, args, opts, _retryCount + 1, _budget);
      }

      // Daemon restarted on a new port (daemon.json updated), or is down: re-read the announcement,
      // start the launcher once if it is down, and retry ONCE. A request that may already have been
      // delivered (reset/timeout mid-call) is repeated only when the tool is a read.
      if (this.transport === 'http' && _retryCount === 0) {
        const kind = classifyTransportError(err);
        if (kind === 'ambiguous' && !READ_TOOLS.has(name)) {
          const ambiguous = new Error(`${err.message} — "${name}" may already have been recorded by the memory server; not repeated, check before retrying`);
          ambiguous.code = err.code || 'AMBIGUOUS_WRITE';
          ambiguous.ambiguous = true;
          ambiguous.originalError = err;
          throw ambiguous;
        }
        if (kind) {
          console.error(`[MCP] Connection error (${err.code || err.message}), re-discovering daemon URL and retrying once`);
          if (kind === 'undelivered') await this._within(this._awaitRestartedServer(opts.signal), _budget, 'the restart probes');
          try {
            await this._within(this._reconnect(err.code || err.message), _budget, 'the reconnect');
          } catch (reconnectErr) {
            if (reconnectErr.code === 'ABORTED' || reconnectErr.code === 'DEADLINE') throw reconnectErr;
            const wrapped = new Error(`DAEMON_RESTART: reconnect failed: ${reconnectErr.message}`);
            wrapped.code = 'DAEMON_RESTART';
            wrapped.originalError = err;
            wrapped.reconnectError = reconnectErr;
            throw wrapped;
          }
          return this.callTool(name, args, opts, _retryCount + 1, _budget);
        }
      }

      throw err;
    }
  }

  /** Re-run the HTTP handshake after a session expired server-side (TTL eviction)
   *  or when the daemon restarts on a new port (daemon.json updated). */
  _reconnect(reason = 'session') {
    // Single flight: concurrent callers share one rediscovery, and all see its outcome.
    if (!this.#reconnectP) {
      this.#reconnectP = this._doReconnect(reason).finally(() => { this.#reconnectP = null; });
    }
    return this.#reconnectP;
  }

  /**
   * Emits `rediscovered` ({from, to, changed, reason}) once the announced server answered a healthy
   * probe — an event, not an error: nothing here counts as a failure for a caller's breaker.
   */
  async _doReconnect(reason) {
    const from = this._resolvedUrl;
    this._sessionId = '';
    this._initialized = false;
    this._requestId = 0;
    // Force re-discovery of daemon URL in case the port changed on restart.
    this._resolvedUrl = '';
    await this.connect();
    this.emit('rediscovered', { from, to: this._resolvedUrl, changed: from !== this._resolvedUrl, reason: String(reason) });
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
    return this._httpSend(method, params, false, timeoutMs, opts.signal);
  }

  _sendNotification(method, params) {
    this._httpSend(method, params, true).catch(err => console.error(`[MCP] notification "${method}": ${err.message}`));
  }

  /** Unwrap a JSON-RPC result into {text, raw} when it's MCP text content, else the raw result. */
  _unwrapResult(result) {
    const content = result?.content;
    if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
      return { text: content[0].text, raw: result };
    }
    return result || {};
  }

  isConnected() {
    return this._initialized;
  }

  close({ skipRemote = false } = {}) {
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
    this._sessionId = '';
    this._initialized = false;
  }
}

module.exports = McpClient;
