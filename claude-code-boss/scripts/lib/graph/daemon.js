'use strict';
/**
 * lib/graph/daemon.js — CLIENT-PURE discovery of the single native-java memory daemon
 * that hosts the Session Graph Engine (ADR-020). Port of copilot-memory's lib/daemon.mjs,
 * adapted to CJS + dependency injection (fetchImpl/runDir) so it is testable without a
 * live daemon.
 *
 * It reads the daemon's self-announced registry (~/.mcp-memory/run/daemon.json), health-
 * checks the URL, and reuses it. It NEVER spawns or manages the JAR — that is native-java's
 * own OS-autostart infra. When the daemon is absent/offline, discover() returns null and the
 * graph tools fail open (never throw to the host).
 */
const { readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

/** run-dir: env MCP_RUN_DIR → ~/.mcp-memory/run/ (client needs no JVM system property). */
function resolveRunDir() {
  const env = process.env.MCP_RUN_DIR;
  if (env && env.trim()) return env.trim();
  return join(homedir(), '.mcp-memory', 'run');
}

/**
 * TOLERANT read of the registry: absent/empty/corrupt → null (never throws). Only `url` is
 * required; unknown fields (port/pid/version/schemaVersion) are ignored (forward-compat).
 */
function readRegistry(runDir = resolveRunDir()) {
  try {
    const raw = readFileSync(join(runDir, 'daemon.json'), 'utf8');
    if (!raw || !raw.trim()) return null;
    const info = JSON.parse(raw);
    if (info && typeof info.url === 'string' && info.url) return info;
    return null;
  } catch (e) {
    void e; // missing/corrupt registry → treat as offline
    return null;
  }
}

/** Health-check: GET {url}/health. Alive = 200 (healthy) OR 503 (degraded). Never throws. */
async function health(url, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(String(url).replace(/\/+$/, '') + '/health', { signal: ctrl.signal });
    return res.status === 200 || res.status === 503;
  } catch (e) {
    void e; // network/timeout → offline
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Client-pure: read registry → health → DaemonInfo | null. No spawn, no side effects. */
async function discover({ fetchImpl = globalThis.fetch, runDir } = {}) {
  const info = readRegistry(runDir);
  if (!info) return null;
  const alive = await health(info.url, { fetchImpl });
  return alive ? info : null;
}

module.exports = { resolveRunDir, readRegistry, health, discover };
