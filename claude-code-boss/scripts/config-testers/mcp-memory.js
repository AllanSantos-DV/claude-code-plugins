'use strict';
/**
 * config-testers/mcp-memory.js — validates a brain-config.backend.mcpMemory subtree.
 * Input:  { jarPath, javaArgs?, downloadUrl?, expectedSha256? }
 * Output: { ok, details?, error?, ms }
 *
 * Phase 1 (this PR): cheap checks only — no JAR download, no full sha256 over very
 * large files (guarded), no MCP handshake. `deepTest:true` is a no-op placeholder.
 */
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MIN_JAVA_MAJOR = 21;

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
