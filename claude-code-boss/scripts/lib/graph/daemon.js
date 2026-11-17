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
const { resolveBearer, tokenFromVault } = require('../../../engine/lib/mcp-auth.js');

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

/** A GET probe of `path` under `base`, in the shape resolveBearer expects. Never throws. */
function fetchProbe(base, fetchImpl) {
  return async (path, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, { signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch (e) { void e; /* no JSON body */ }
      return { alive: res.status === 200 || res.status === 503, statusCode: res.status, health: body };
    } catch (e) {
      return { alive: false, error: e && e.message };
    } finally {
      clearTimeout(t);
    }
  };
}

/**
 * SAME-SERVER resolver factory (ADR-020 coherence). Produce a discover()-shaped async fn bound to
 * the mcp-memory backend's OWN daemon resolution, so the graph rides the SAME server the KB backend
 * targets — never a daemon it discovers independently (which could be a DIFFERENT process). The
 * precedence MIRRORS mcp-client._connectHttp (and config-testers/mcp-memory.resolveDaemonUrl):
 *   1. explicit serverUrl  → use THAT base directly, health-checked (no registry read);
 *   2. else                → discover via the configured runDir's daemon.json;
 *   3. runDir unset        → discover falls back to the default run dir (resolveRunDir).
 * DI-friendly (fetchImpl) so it stays testable without a live daemon. Returns null when the
 * resolved daemon is unreachable/absent, so the graph tools fail open (never throw).
 * An explicit serverUrl that advertises `features.auth` also yields the Bearer from the system vault
 * (`bearer`), which graphBase hands to every graph call; a daemon found in the registry is local and needs none.
 * @param {{serverUrl?:string, runDir?:string, loadToken?:Function, authProbeTimeoutMs?:number}} cfg
 * @returns {(opts?:{fetchImpl?:Function}) => Promise<{url:string, bearer?:string}|null>}
 */
function makeResolver({ serverUrl = '', runDir = '', loadToken = tokenFromVault, authProbeTimeoutMs = 5000 } = {}) {
  const url = String(serverUrl || '').trim();
  const dir = String(runDir || '').trim();
  return async ({ fetchImpl = globalThis.fetch } = {}) => {
    if (url) {
      // Explicit base = the SAME daemon the KB backend points at. Health-check it (200/503 alive)
      // and use it directly; do NOT read a registry (which could name a different, foreign daemon).
      const alive = await health(url, { fetchImpl });
      if (!alive) return null;
      const base = url.replace(/\/+$/, '');
      const bearer = await resolveBearer({ baseUrl: base, probe: fetchProbe(base, fetchImpl), loadToken, timeoutMs: authProbeTimeoutMs });
      return bearer ? { url: base, bearer } : { url: base };
    }
    // No explicit URL → discover from the configured runDir (default run dir only when unset).
    return discover({ fetchImpl, runDir: dir || undefined });
  };
}

module.exports = { resolveRunDir, readRegistry, health, discover, makeResolver };
