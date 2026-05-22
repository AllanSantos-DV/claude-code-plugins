#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
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
        const out = result.stderr?.toString() || result.stdout?.toString() || '';
        const match = out.match(/(?:openjdk|java|jdk) (?:version "?)?(\d+)/i);
        if (match && parseInt(match[1]) >= 21) return cmd;
      } catch {}
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

  _downloadJar() {
    return new Promise((resolve, reject) => {
      const url = this.downloadUrl;
      if (!url) return reject(new Error('No downloadUrl configured'));
      const dir = path.dirname(this.jarPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempFile = this.jarPath + '.download';
      const file = fs.createWriteStream(tempFile);
      console.error(`[MCP] Downloading ${url}`);
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          fs.unlinkSync(tempFile);
          const redirectUrl = res.headers.location;
          return https.get(redirectUrl, (r2) => {
            r2.pipe(file);
            file.on('finish', () => {
              file.close();
              fs.renameSync(tempFile, this.jarPath);
              console.error(`[MCP] Downloaded to ${this.jarPath}`);
              resolve();
            });
          });
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(tempFile);
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.renameSync(tempFile, this.jarPath);
          console.error(`[MCP] Downloaded to ${this.jarPath}`);
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        reject(err);
      });
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
      } catch {}
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
