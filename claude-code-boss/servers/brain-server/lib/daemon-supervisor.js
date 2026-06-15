/**
 * lib/daemon-supervisor.js — version-aware auto-start for the HTTP daemon.
 *
 * Called best-effort from the stdio launcher (every host spawn). It:
 *   - finds the daemon via the deterministic port + /health;
 *   - CURRENT (same pluginRoot) → no-op;
 *   - STALE (different pluginRoot = older code after an upgrade) → graceful
 *     POST /shutdown (fallback SIGTERM), wait gone, then start the new one;
 *   - ABSENT → start it (detached, survives the host).
 *
 * Never throws into the stdio path — the stdio server stays self-contained.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePort } from './daemon-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, '..', 'index.js');

async function fetchHealth(port, timeoutMs = 600) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch (e) { void e; return null; }
}

async function postShutdown(port, timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(t);
  } catch { /* daemon may drop the socket before responding — that's fine */ }
}

async function waitGone(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(port, 300))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function waitCurrent(port, pluginRoot, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await fetchHealth(port, 300);
    if (h && h.pluginRoot === pluginRoot) return h;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function spawnDaemon({ pluginRoot, dataDir, port, env }) {
  const child = spawn(
    process.execPath,
    [INDEX, '--http', '--port', String(port), '--plugin-data', dataDir],
    { detached: true, stdio: 'ignore', env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: dataDir } },
  );
  child.unref();
  return child.pid;
}

/**
 * @returns {Promise<{status:string, pid?:number, port?:number, error?:string}>}
 *   status ∈ disabled|current|started|spawned|error. Never rejects.
 */
export async function ensureDaemon({ pluginRoot, dataDir, env = process.env } = {}) {
  if (env.BRAIN_HTTP_AUTOSTART === '0') return { status: 'disabled' };
  try {
    const port = resolvePort(dataDir);
    const health = await fetchHealth(port);

    if (health) {
      if (health.pluginRoot === pluginRoot) return { status: 'current', pid: health.pid, port };
      // Stale daemon from an older plugin version → swap it for this one.
      await postShutdown(port);
      const gone = await waitGone(port);
      if (!gone) {
        try { if (health.pid) process.kill(health.pid, 'SIGTERM'); } catch (e) { void e; }
        await waitGone(port, 3000);
      }
    }

    const pid = spawnDaemon({ pluginRoot, dataDir, port, env });
    const up = await waitCurrent(port, pluginRoot);
    return { status: up ? 'started' : 'spawned', pid, port };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}
