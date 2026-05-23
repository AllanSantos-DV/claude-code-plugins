#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
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
  }

  async connect() {
    if (this._initialized) return;

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
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-code-brain', version: '1.0.0' },
    });

    this._sendNotification('notifications/initialized');

    const tools = await this._sendRequest('tools/list');
    this._availableTools = (tools?.tools || tools?.result?.tools || []).map(t => t.name);
  }

  async callTool(name, args = {}) {
    if (!this._initialized) await this.connect();
    return this._sendRequest('tools/call', { name, arguments: args });
  }

  _sendRequest(method, params) {
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
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    }) + '\n';
    this._process.stdin.write(msg);
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
        const content = msg.result?.content;
        if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
          try {
            resolve({ text: content[0].text, raw: msg.result });
          } catch {
            resolve({ text: content[0].text, raw: msg.result });
          }
        } else {
          resolve(msg.result || {});
        }
      }
    }
  }

  isConnected() {
    return this._initialized && this._process !== null && !this._process.killed;
  }

  close() {
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
