'use strict';
/**
 * config-testers/mcp-memory.js — validates a brain-config.backend.mcpMemory subtree.
 * Input:  { transport?, serverUrl?, runDir?, jarPath, javaArgs?, downloadUrl?, expectedSha256? }
 * Output: { ok, details?, error?, ms }
 *
 * transport 'http'  → probe an already-running daemon (/health), no JAR involved.
 * transport 'stdio' → cheap local checks (Java present, JAR magic, optional sha256).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MIN_JAVA_MAJOR = 21;

/** Resolve the daemon base URL from an explicit serverUrl or the daemon registry. */
function resolveDaemonUrl(input) {
  if (input && input.serverUrl && input.serverUrl.trim()) return input.serverUrl.trim();
  const runDir = (input && input.runDir && input.runDir.trim())
    || process.env.MCP_RUN_DIR || path.join(os.homedir(), '.mcp-memory', 'run');
  const reg = path.join(runDir, 'daemon.json');
  try {
    const raw = JSON.parse(fs.readFileSync(reg, 'utf8'));
    return raw && raw.url ? String(raw.url) : '';
  } catch (err) {
    console.error(`[mcp-memory tester] daemon registry unreadable (${reg}): ${err.message}`);
    return '';
  }
}

/** GET <url>/health — 200 or 503 both mean "process alive". */
function httpHealth(baseUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(baseUrl.replace(/\/+$/, '') + '/health'); }
    catch (err) { return resolve({ ok: false, error: `bad URL: ${err.message}` }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200 || res.statusCode === 503, status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

async function checkRemote(input, t0) {
  const url = resolveDaemonUrl(input);
  if (!url) {
    return { ok: false, error: 'http mode: no serverUrl and no daemon.json found — start the Native Java daemon or set serverUrl', ms: Date.now() - t0 };
  }
  const h = await httpHealth(url);
  if (!h.ok) {
    return { ok: false, error: `daemon /health failed at ${url}: ${h.error || ('HTTP ' + h.status)}`, ms: Date.now() - t0 };
  }
  let info = {};
  try { info = JSON.parse(h.body); } catch (err) { console.error(`[mcp-memory tester] health parse: ${err.message}`); }
  return {
    ok: true,
    details: { action: 'remote-daemon', serverUrl: url, daemonStatus: info.status || 'ok', daemonVersion: info.version || '' },
    ms: Date.now() - t0,
  };
}

function detectJava() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf-8', timeout: 5000 });
  if (r.error) {
    if (r.error.code === 'ENOENT') return { ok: false, error: 'Java not installed or not in PATH (install JDK 21+)' };
    return { ok: false, error: `java -version failed: ${r.error.message}` };
  }
  const out = (r.stderr || '') + (r.stdout || '');
  // openjdk version "21.0.4" 2024-07-16  /  java version "21.0.1" 2023-10-17
  const m = out.match(/version "(\d+)(?:\.(\d+))?(?:\.(\d+))?[^"]*"/);
  if (!m) return { ok: false, error: `Java present but version unparseable: ${out.split('\n')[0]}` };
  const major = parseInt(m[1], 10);
  if (major < MIN_JAVA_MAJOR) return { ok: false, error: `Java ${MIN_JAVA_MAJOR}+ required, found ${m[1]}.${m[2] || 0}` };
  return { ok: true, version: m[0].replace(/.*"([^"]+)".*/, '$1') };
}

async function checkDownloadUrl(url) {
  if (!url) return { ok: false, error: 'downloadUrl is empty and jarPath is empty — nothing to test' };
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timeout);
    if (!r.ok) return { ok: false, error: `downloadUrl HTTP ${r.status}` };
    const size = parseInt(r.headers.get('content-length') || '0', 10);
    return { ok: true, size };
  } catch (err) {
    const error = `downloadUrl unreachable: ${err.message}`;
    return { ok: false, error };
  }
}

function checkJarMagic(jarPath) {
  const fd = fs.openSync(jarPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    // ZIP/JAR magic: PK\x03\x04 (most common) or PK\x05\x06 (empty) or PK\x07\x08 (spanned)
    return buf[0] === 0x50 && buf[1] === 0x4B;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

async function test(input) {
  const t0 = Date.now();
  const transport = (input && input.transport || 'stdio').trim();

  // Remote mode — probe the running daemon; no JAR/Java needed.
  if (transport === 'http') return checkRemote(input, t0);

  const jarPath = (input && input.jarPath || '').trim();
  const downloadUrl = (input && input.downloadUrl || '').trim();
  const expectedSha256 = (input && input.expectedSha256 || '').trim().toLowerCase();

  // Path A — no jar yet; verify downloadUrl reachable.
  if (!jarPath) {
    const url = await checkDownloadUrl(downloadUrl);
    if (!url.ok) return { ok: false, error: url.error, ms: Date.now() - t0 };
    const java = detectJava();
    return {
      ok: java.ok,
      error: java.ok ? undefined : java.error,
      details: { action: 'will-download', downloadSize: url.size, javaVersion: java.version },
      ms: Date.now() - t0,
    };
  }

  // Path B — jarPath set.
  if (!fs.existsSync(jarPath)) {
    return { ok: false, error: `JAR file not found: ${jarPath}`, ms: Date.now() - t0 };
  }
  let stat;
  try { stat = fs.statSync(jarPath); } catch (err) {
    const error = `JAR stat failed: ${err.message}`;
    return { ok: false, error, ms: Date.now() - t0 };
  }
  if (!stat.isFile()) return { ok: false, error: `jarPath is not a regular file: ${jarPath}`, ms: Date.now() - t0 };
  try {
    if (!checkJarMagic(jarPath)) {
      return { ok: false, error: `File is not a valid JAR (missing PK magic): ${jarPath}`, ms: Date.now() - t0 };
    }
  } catch (err) {
    const error = `Failed to read JAR magic: ${err.message}`;
    return { ok: false, error, ms: Date.now() - t0 };
  }

  let sha256;
  if (expectedSha256) {
    // Cap full-hash cost — never hash files > 200 MB here (UX latency).
    if (stat.size > 200 * 1024 * 1024) {
      return { ok: false, error: `expectedSha256 set but JAR too large to hash here (${stat.size} bytes). Verify manually.`, ms: Date.now() - t0 };
    }
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(jarPath));
    sha256 = h.digest('hex');
    if (sha256 !== expectedSha256) {
      return { ok: false, error: `sha256 mismatch — expected ${expectedSha256.slice(0,16)}…, got ${sha256.slice(0,16)}…`, ms: Date.now() - t0 };
    }
  }

  const java = detectJava();
  if (!java.ok) {
    return { ok: false, error: java.error, details: { jarPath, jarSize: stat.size, sha256 }, ms: Date.now() - t0 };
  }

  return {
    ok: true,
    details: {
      action: 'use-existing',
      jarPath,
      jarSize: stat.size,
      javaVersion: java.version,
      sha256: sha256 || null,
    },
    ms: Date.now() - t0,
  };
}

module.exports = { domain: 'mcp-memory', test };
