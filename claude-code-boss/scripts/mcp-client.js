#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

class McpClient extends EventEmitter {
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
    this.transport = opts.transport === 'http' ? 'http' : 'stdio';
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
  }

  async connect() {
    if (this._initialized) return;

    if (this.transport === 'http') {
      await this._connectHttp();
      this._initialized = true;
      return;
    }

    const jarExists = fs.existsSync(this.jarPath);
    if (!jarExists && this.downloadUrl) {
      await this._downloadJar();
    }
    if (!fs.existsSync(this.jarPath)) {
      throw new Error(
        `MCP Memory Server JAR not found at ${this.jarPath}. ` +
        `Set "backend.mcpMemory.downloadUrl" in config/brain-config.json or ` +
        `download manually from https://github.com/AllanSantos-DV/mcp-memory-server-releases`
      );
    }

    const javaCmd = this._findJava();
    if (!javaCmd) {
      throw new Error('Java 21+ not found. Install Java 21 or later.');
    }

    const args = this.javaArgs.concat([
      '-jar', this.jarPath,
      '--workspace', this.workspacePath,
      '--transport', 'stdio',
    ]);

    this._process = spawn(javaCmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._process.stdout.on('data', (chunk) => {
      this._buffer += chunk.toString();
      this._processBuffer();
    });

    this._process.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('SLF4J') && !text.includes('INFO') && !text.includes('DEBUG')) {
        console.error(`[MCP-STDERR] ${text.trim()}`);
      }
    });

    this._process.on('exit', (code) => {
      this._initialized = false;
      const runtime = Date.now() - this._startTime;
      if (this._startTime > 0 && runtime < 5000 && code !== 0) {
        console.error(`[MCP] Process exited early (code ${code}) after ${runtime}ms`);
      }
      for (const [id, { reject }] of this._pending) {
        reject(new Error(`MCP process exited (code ${code})`));
        this._pending.delete(id);
      }
      this.emit('disconnect');
    });

    this._startTime = Date.now();
    await this._handshake();
    this._initialized = true;
  }

  // ─── HTTP (StreamableHTTP /mcp) transport ──────────────────────────────────

  /** Connect to an already-running daemon over /mcp (no process spawn). */
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
    const reg = path.join(this.runDir, 'daemon.json');
    try {
      const raw = JSON.parse(fs.readFileSync(reg, 'utf8'));
      if (raw && raw.url && raw.port) return String(raw.url);
      console.error(`[MCP] daemon.json at ${reg} missing url/port`);
      return '';
    } catch (err) {
      console.error(`[MCP] daemon registry not found/readable (${reg}): ${err.message}`);
      return '';
    }
  }

  /** GET <url>/health — 200 or 503 both mean "process alive". Returns boolean. */
  _httpHealth(baseUrl) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(baseUrl + '/health'); }
      catch (err) { console.error(`[MCP] bad server URL "${baseUrl}": ${err.message}`); return resolve(false); }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200 || res.statusCode === 503);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  /** POST one JSON-RPC message to <url>/mcp. Resolves the unwrapped result (or void for notifications). */
  _httpSend(method, params, isNotification) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(this._resolvedUrl + '/mcp'); }
      catch (err) { return reject(new Error(`MCP bad URL: ${err.message}`)); }
      const payload = { jsonrpc: '2.0', method };
      if (!isNotification) payload.id = ++this._requestId;
      if (params !== undefined) payload.params = params;
      const data = Buffer.from(JSON.stringify(payload), 'utf8');

      const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
      // NOTE: deliberately NO `Origin` header — the daemon 403s a non-loopback Origin; absent = allowed.
      if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;

      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: this.requestTimeout },
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
              return reject(new Error(`MCP "${method}" HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
            }
            let msg;
            try { msg = JSON.parse(body); }
            catch (err) { return reject(new Error(`MCP "${method}" bad JSON: ${err.message}`)); }
            if (msg.error) return reject(new Error(`MCP "${method}" error: ${JSON.stringify(msg.error)}`));
            resolve(this._unwrapResult(msg.result));
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`MCP request "${method}" timed out after ${this.requestTimeout}ms`)); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  _findJava() {
    const candidates = ['java', 'java.exe'];
    for (const cmd of candidates) {
      try {
        const result = require('child_process').execSync(`${cmd} -version 2>&1`, { stdio: 'pipe' });
        const out = result.toString();
        const match = out.match(/(?:openjdk|java|jdk) (?:version "?)?(\d+)/i);
        if (match && parseInt(match[1]) >= 21) return cmd;
      } catch (err) { console.error(`[MCP] Java detection failed for ${cmd}: ${err.message}`); }
    }
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      const exe = path.join(javaHome, 'bin', 'java.exe');
      if (fs.existsSync(exe)) return exe;
      const nix = path.join(javaHome, 'bin', 'java');
      if (fs.existsSync(nix)) return nix;
    }
    return null;
  }

  /** Resolve the latest JAR download URL from GitHub Releases API. */
  _resolveLatestUrl() {
    const GITHUB_REPO = 'AllanSantos-DV/mcp-memory-server-releases';
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    return new Promise((resolve, reject) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'claude-code-boss', 'Accept': 'application/vnd.github+json' } }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const asset = (data.assets || []).find(a => a.name.endsWith('.jar'));
            if (asset) {
              console.error(`[MCP] Latest release: ${data.tag_name} → ${asset.name}`);
              resolve(asset.browser_download_url);
            } else {
              reject(new Error(`No .jar asset found in latest release of ${GITHUB_REPO}`));
            }
          } catch (e) {
            reject(new Error(`GitHub API parse error: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  /** Download a JAR from a URL, following redirects, into this.jarPath. */
  _fetchJar(url) {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(this.jarPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempFile = this.jarPath + '.download';

      const doGet = (targetUrl, redirectsLeft = 5) => {
        const file = fs.createWriteStream(tempFile);
        https.get(targetUrl, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            file.close();
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            return doGet(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            file.close();
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.renameSync(tempFile, this.jarPath);
            console.error(`[MCP] Downloaded to ${this.jarPath}`);
            resolve();
          });
          file.on('error', err => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            reject(err);
          });
        }).on('error', err => {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          reject(err);
        });
      };

      doGet(url);
    });
  }

  async _downloadJar() {
    console.error('[MCP] Resolving latest release from GitHub...');
    let url;
    try {
      url = await this._resolveLatestUrl();
    } catch (e) {
      // Fallback to static downloadUrl in config if GitHub API is unreachable
      if (this.downloadUrl) {
        console.error(`[MCP] GitHub API failed (${e.message}), falling back to configured URL`);
        url = this.downloadUrl;
      } else {
        throw new Error(`Cannot resolve JAR URL: ${e.message}`);
      }
    }
    console.error(`[MCP] Downloading ${url}`);
    await this._fetchJar(url);

    // Compute SHA-256 of the downloaded JAR.
    const computedSha = await this._computeSha256(this.jarPath);
    if (this.expectedSha256 && this.expectedSha256.trim()) {
      if (computedSha !== this.expectedSha256.trim().toLowerCase()) {
        fs.unlinkSync(this.jarPath);
        throw new Error(
          `[MCP] JAR checksum mismatch! Expected: ${this.expectedSha256.trim()}, Got: ${computedSha}. ` +
          `JAR has been deleted. Possible supply-chain attack. Update "backend.mcpMemory.expectedSha256" in brain-config.json if this was a legitimate update.`
        );
      }
      console.error(`[MCP] Checksum verified: ${computedSha}`);
    } else {
      // No expected SHA configured — log computed value so user can pin it.
      console.error(`[MCP] WARNING: No expectedSha256 configured. Computed SHA-256: ${computedSha}. Pin this in config/brain-config.json backend.mcpMemory.expectedSha256`);
    }
  }

  /** Compute SHA-256 of a file, returns hex string. */
  _computeSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async _handshake() {
    await this._sendRequest('initialize', {
      protocolVersion: this._protocolVersion,
      capabilities: {},
      clientInfo: { name: 'claude-code-brain', version: '1.0.0' },
      // Frozen contract: stamps the unified-DB scope for this whole session.
      ...(this.projectId ? { projectId: this.projectId } : {}),
    });

    this._sendNotification('notifications/initialized');

    const tools = await this._sendRequest('tools/list');
    this._availableTools = (tools?.tools || tools?.result?.tools || []).map(t => t.name);
  }

  async callTool(name, args = {}) {
    if (!this._initialized) await this.connect();
    return this._sendRequest('tools/call', { name, arguments: args });
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

  _sendRequest(method, params) {
    if (this.transport === 'http') return this._httpSend(method, params, false);
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
      }, this.requestTimeout);

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

  close() {
    if (this.transport === 'http') {
      // Best-effort DELETE /mcp to end the daemon session; never throw on close.
      if (this._sessionId && this._resolvedUrl) {
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
      this._sendNotification('notifications/exit');
      setTimeout(() => {
        if (this._process && !this._process.killed) {
          this._process.kill();
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
