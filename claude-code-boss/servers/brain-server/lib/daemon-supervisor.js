/**
 * lib/daemon-supervisor.js — version-aware auto-start for the ONE HTTP daemon
 * (ADR-001 "daemon único"; index.js has no other mode left).
 *
 * Called from the SessionStart/UserPromptSubmit hook (scripts/brain-daemon-ensure.js,
 * one ensure per session, not per spawn — there's no per-session process to spawn
 * anymore, .mcp.json points straight at the daemon's fixed-port URL). It:
 *   - finds the daemon via the fixed port + /health;
 *   - CURRENT (same pluginRoot) → no-op;
 *   - STALE (different pluginRoot = older code after an upgrade) → graceful
 *     POST /shutdown (fallback SIGTERM), wait gone, then start the new one;
 *   - ABSENT → start it (detached, survives the host).
 *
 * Never throws — the caller (the ensure-hook) treats any error as fail-open and
 * never blocks session start.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolvePort, readToken, lockFile, canonicalDataDir } from './daemon-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, '..', 'index.js');

/**
 * Probe a port for the brain daemon. Distinct outcomes — conflating these is
 * what made a foreign port-squatter look like "a daemon never came up":
 *   'daemon' : a live brain /health (pluginRoot + pid) answered;
 *   'absent' : TCP connect was refused (nothing is listening);
 *   'squat'  : TCP connect succeeded but no valid brain /health answered
 *              (unknown process, silent occupant, timeout, or wrong response) —
 *              never signal it.
 * @returns {Promise<{kind:'daemon', health:{}}|{kind:'absent'}|{kind:'squat', httpStatus?:number}>}
 */
async function probePort(port, timeoutMs = 600) {
  const connected = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(err.code !== 'ECONNREFUSED'));
  });
  if (!connected) return { kind: 'absent' };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    if (!r.ok) return { kind: 'squat', httpStatus: r.status };
    try {
      const j = await r.json();
      if (j && typeof j === 'object' && j.ok === true && typeof j.pluginRoot === 'string' && typeof j.pid === 'number' && typeof j.dataDir === 'string' && typeof j.port === 'number') {
        return { kind: 'daemon', health: j };
      }
    } catch (err) { void err; /* non-JSON / wrong shape → squat */ }
    return { kind: 'squat', httpStatus: r.status };
  } catch (err) { void err; return { kind: 'squat' }; }
}

/** Same probe, but boolean-shaped for the wait loops below. */
async function fetchHealth(port, timeoutMs = 600) {
  const p = await probePort(port, timeoutMs);
  return p.kind === 'daemon' ? p.health : null;
}

async function postShutdown(port, dataDir, env = process.env, timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // Token from the shared DATA_DIR file — harmless extra header for pre-auth
    // (<= 1.19.1) daemons, required by current ones.
    const token = readToken(dataDir, env);
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers, signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
  } catch (err) {
    // A socket drop mid-shutdown is normal (the daemon is quitting). Any other
    // failure is logged so a swallowed shutdown isn't invisible to debugging.
    const code = err?.code ?? err?.name ?? '';
    if (!['ECONNRESET', 'EPIPE', 'UND_ERR_ABORTED', 'AbortError'].includes(code)) {
      console.error(`brain daemon supervisor: POST /shutdown to port ${port} failed — ${err?.message ?? err}`);
    }
  }
}

async function waitGone(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Honesty: 'gone' means the port is actually FREE. A squat that replaced
    // the daemon is NOT gone (a foreign process owns the port) — keep waiting
    // so the caller never claims a swap succeeded against a squatter.
    const p = await probePort(port, 300);
    if (p.kind === 'absent') return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function waitCurrent(port, pluginRoot, dataDir, timeoutMs = WAIT_CURRENT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await fetchHealth(port, 300);
    if (h && samePluginData({ pluginRoot, dataDir }, h)) return h;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function normalizeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

/** Identity = pluginRoot + dataDir, each canonicalized on BOTH sides (a raw
 *  /health dataDir must not fail an identity check just for a non-canonical
 *  spelling — relative path, backslashes on Windows, mixed case). */
function samePluginData(a, b) {
  return !!(a && b
    && path.resolve(String(a.pluginRoot ?? '')) === path.resolve(String(b.pluginRoot ?? ''))
    && canonicalDataDir(a.dataDir) === canonicalDataDir(b.dataDir));
}

function sameIdentity(a, b) {
  try {
    return a && b && a.port === b.port && a.pid === b.pid && samePluginData(a, b);
  } catch (err) { void err; return false; }
}

function lockMatchesHealth(lock, health) {
  try {
    if (lock.port != null && Number(lock.port) !== health.port) return false;
    if (lock.pid != null && Number(lock.pid) !== health.pid) return false;
    if (lock.pluginRoot != null && path.resolve(String(lock.pluginRoot)) !== path.resolve(String(health.pluginRoot))) return false;
    if (lock.dataDir != null && canonicalDataDir(lock.dataDir) !== canonicalDataDir(health.dataDir)) return false;
    return true;
  } catch (err) { void err; return false; }
}

function spawnDaemon({ pluginRoot, dataDir, port, env }) {
  const childEnv = { ...process.env, ...normalizeEnv(env), CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: dataDir };
  const child = spawn(
    process.execPath,
    [INDEX, '--port', String(port), '--plugin-data', dataDir],
    { detached: true, stdio: 'ignore', env: childEnv },
  );
  child.unref();
  return child.pid;
}

/** Read the daemon's lock/census file (written by every daemon boot). Null when absent/corrupt. */
function readLock(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch (e) { void e; return null; }
}

/** Is a pluginRoot still a real install on disk (so its daemon is worth sharing)? */
function ownerRootExists(pluginRoot) {
  try {
    return fs.existsSync(path.join(pluginRoot, 'servers', 'brain-server', 'index.js'));
  } catch (e) { void e; return false; }
}

// ─── Cross-process spawn mutex ──────────────────────────────────────────────
// Two concurrent SessionStart hooks (same machine, same dataDir) can both pass
// the ABSENT probe and both spawn → the loser's child gets EADDRINUSE and exits
// 0 silently. mkdirSync is atomic, so it doubles as the lock; the winner's
// owner.json + a staleness grace handle a crashed holder (the next ensure then
// steals the lock). While the lock is live, the loser does NOT spawn — it waits
// for the winner's daemon to come up and adopts it.
const SPAWN_LOCK_STALE_MS = 15000;
const WAIT_CURRENT_MS = 9000;

function spawnLockDir(dataDir) {
  return path.join(canonicalDataDir(dataDir), 'brain-http.spawn.lock');
}

function acquireSpawnLock(dataDir) {
  const dir = spawnLockDir(dataDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false; // I/O error — never block on it
      // Held by someone. Judge age by owner.json ts, or (owner write failed)
      // by the dir mtime; steal only an abandoned lock.
      let ownerTs = 0;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
        if (owner && typeof owner.ts === 'number') ownerTs = owner.ts;
      } catch { ownerTs = 0; }
      const ageMs = Date.now() - (ownerTs || readSpawnLockMtime(dir));
      if (ageMs > SPAWN_LOCK_STALE_MS) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { void err; return false; }
        continue; // stolen — retry the mkdir
      }
      return false; // live lock → caller adopts the winner instead of spawning
    }
  }
  return false;
}

function readSpawnLockMtime(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch (err) { void err; return 0; }
}

function releaseSpawnLock(dataDir) {
  try { fs.rmSync(spawnLockDir(dataDir), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Graceful-swap + hard-kill fallback. The SIGTERM here is only ever reached
 * AFTER a live /health probe confirmed the pid — identity evidence, never a
 * lock-file-only guess (pids get reused).
 */
async function swapDaemon({ port, health, dataDir, env = process.env, waitMs = 5000 }) {
  const currentBefore = await probePort(port, 300);
  if (currentBefore.kind !== 'daemon' || !sameIdentity(currentBefore.health, health)) return;
  await postShutdown(port, dataDir, env);
  if (!(await waitGone(port, waitMs))) {
    const current = await probePort(port, 300);
    if (current.kind !== 'daemon' || !sameIdentity(current.health, health)) return;
    if (current.health.pid === health.pid) {
      try { process.kill(current.health.pid, 'SIGTERM'); } catch (e) { void e; }
    }
    await waitGone(port, 3000);
  }
}

/**
 * Migration from the OLD per-dataDir hash-derived port (v2.19.x and earlier):
 * the lock file is the census of a daemon that predates the fixed port. If the
 * lock names a port ≠ today's resolvePort(), and that port holds a LIVE brain
 * daemon whose pid matches the lock's pid (identity pin — never act on a lock
 * alone), shut it down so the new fixed-port daemon takes over the SAME data
 * dir instead of becoming a second writer (SQLITE_BUSY / diverging caches).
 * Absent, stale, or non-brain → no-op; never SIGTERM without the pid match.
 */
async function exileLegacyDaemon({ dataDir, port, env = process.env }) {
  const lock = readLock(dataDir);
  if (!lock) return;
  const lockPort = Number(lock.port);
  // A corrupt/absent port is treated as "no legacy daemon to exile" — acting on
  // a coerced NaN or a 0 would be following census data we can't trust.
  if (lock.port == null || Number.isNaN(lockPort) || !lockPort || lockPort === port) return;
  const p = await probePort(lockPort);
  if (p.kind !== 'daemon' || !p.health) return;
  if (!lockMatchesHealth(lock, p.health)) return;
  await swapDaemon({ port: lockPort, health: p.health, dataDir, env, waitMs: 3000 });
  const after = await probePort(lockPort, 300);
  if (after.kind === 'daemon') {
    throw new Error(
      `legacy brain daemon on port ${lockPort} (pid ${after.health?.pid ?? 'unknown'}) survived shutdown — ` +
      `refusing to start a second writer on ${dataDir}. Kill that process and retry.`,
    );
  }
}

/**
 * Worst case (stale-daemon swap: fetchHealth + postShutdown + waitGone incl.
 * SIGTERM fallback + waitCurrent) is ~18.4s — the SessionStart hook that calls
 * this (scripts/brain-daemon-ensure.js) is given a comfortably larger timeout
 * (see hooks/hooks.json) so it isn't killed mid-swap; if it IS killed anyway,
 * this stays safe because spawnDaemon() detaches (unref) — the new daemon keeps
 * booting in the background regardless.
 *
 * Decision rules (each is a gate finding fixed here):
 *   - a daemon with OUR pluginRoot + OUR dataDir is 'current' (no-op);
 *   - a daemon whose pluginRoot is a DIFFERENT install still ON DISK is SHARED
 *     ('current' + note). Swapping it would kill that install's live HTTP
 *     sessions and make two installs thrash on every session start;
 *   - a daemon whose pluginRoot no longer exists (install moved/removed) is
 *     STALE → swapped;
 *   - a port occupied by a NON-brain process is 'error' (never signaled), so
 *     the outage is loud instead of a silent result with zero diagnostics;
 *   - a pre-fixed-port daemon on the legacy hash port is exiled first;
 *   - concurrent spawns are serialized by a per-dataDir mutex — the loser
 *     adopts the winner's daemon instead of double-spawning (EADDRINUSE).
 *
 * @returns {Promise<{status:string, pid?:number, port?:number, note?:string, error?:string}>}
 *   status ∈ disabled|current|started|error. Never rejects.
 */
export async function ensureDaemon({ pluginRoot, dataDir, env = process.env } = {}) {
  env = (env && typeof env === 'object' && !Array.isArray(env)) ? env : process.env;
  const normalizedEnv = { ...process.env, ...normalizeEnv(env) };
  if (String(normalizedEnv.BRAIN_HTTP_AUTOSTART) === '0') return { status: 'disabled' };
  try {
    const port = resolvePort(dataDir, env);

    // Migration: reclaim the port a pre-fixed-port daemon still owns.
    await exileLegacyDaemon({ dataDir, port, env: normalizedEnv });

    const probe = await probePort(port);

    if (probe.kind === 'daemon') {
      const h = probe.health;
      if (samePluginData({ pluginRoot, dataDir }, h)) return { status: 'current', pid: h.pid, port };
      if (h.pluginRoot !== pluginRoot && ownerRootExists(h.pluginRoot)) {
        return { status: 'current', pid: h.pid, port, note: `sharing daemon owned by another install: ${h.pluginRoot}` };
      }
      await swapDaemon({ port, health: h, dataDir, env: normalizedEnv });
      // Verify the old daemon is gone before spawning; if it still owns
      // the port, spawning would get EADDRINUSE and the child would exit 0
      // silently — returning a false-positive success with no diagnostics.
      const afterSwap = await probePort(port, 300);
      if (afterSwap.kind !== 'absent') {
        const status = afterSwap.httpStatus == null ? 'no response' : `HTTP ${afterSwap.httpStatus}`;
        return { status: 'error', error: `port ${port} is still occupied after swap (${status}) — giving up`, port };
      }
    } else if (probe.kind === 'squat') {
      const status = probe.httpStatus == null ? 'no response' : `HTTP ${probe.httpStatus}`;
      return {
        status: 'error',
        error: `port ${port} is owned by a process that is not the brain daemon (no /health served, ${status}) — refusing to touch it. ` +
          `Free that port or set BRAIN_HTTP_PORT to a different one for this install.`,
        port,
      };
    }

    // ABSENT → start our daemon, guarded by a per-dataDir spawn mutex: a
    // concurrent hook may already be spawning (or just won the race) — the
    // loser adopts the winner's daemon instead of double-spawning. Stale locks
    // (crashed holder) are stolen by the next acquire.
    if (!acquireSpawnLock(dataDir)) {
      const winner = await waitCurrent(port, pluginRoot, dataDir);
      if (winner) return { status: 'current', pid: winner.pid, port };
      return {
        status: 'error',
        error: `another process holds the spawn lock for ${dataDir} but no matching daemon came up on ${port} within ${WAIT_CURRENT_MS}ms — not double-spawning`,
        port,
      };
    }
    try {
      const pid = spawnDaemon({ pluginRoot, dataDir, port, env: normalizedEnv });
      const up = await waitCurrent(port, pluginRoot, dataDir);
      if (up) return { status: 'started', pid, port };
      // Spawn came up but not healthy — diagnose: index.js exits 0 on
      // EADDRINUSE (silently), so an unseen squatter is the usual cause. A
      // third shape: the daemon booted but resolved a DIFFERENT dataDir than
      // the one this ensure asked for (data-dir.js yields to the heavier live
      // global folder) — that is not "our" daemon, say so.
      const again = await probePort(port, 300);
      if (again.kind === 'daemon') {
        const h = again.health;
        let why = 'it is on the port but returned a non-matching /health';
        if (h.pluginRoot === pluginRoot) {
          let served = h.dataDir;
          try { served = canonicalDataDir(h.dataDir); } catch { /* keep raw */ }
          why = `it serves dataDir ${JSON.stringify(served)} instead of ${JSON.stringify(canonicalDataDir(dataDir))}`;
        } else if (ownerRootExists(h.pluginRoot)) {
          why = `it belongs to another install (${h.pluginRoot})`;
        }
        return { status: 'error', error: `spawned daemon did not become OUR daemon on ${port}: ${why}`, pid, port };
      }
      if (again.kind !== 'absent') {
        const status = again.httpStatus == null ? 'no response' : `HTTP ${again.httpStatus}`;
        return {
          status: 'error',
          error: `port ${port} is owned by an unknown process — the spawned daemon exited (EADDRINUSE; ${status}). ` +
            `Free the port or set BRAIN_HTTP_PORT to a different one for this install.`,
          port,
        };
      }
      // Port free and no /health: the child genuinely failed to boot. Honest
      // 'error' beats a claim that a spawn that never served is a success.
      return {
        status: 'error',
        error: `spawned daemon (pid ${pid}) on port ${port} never became healthy and left the port free to boot elsewhere — check the plugin's logs`,
        pid,
        port,
      };
    } finally {
      releaseSpawnLock(dataDir);
    }
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// Internal helpers exported for unit tests (the pure, side-effect-free ones).
export { samePluginData, sameIdentity, lockMatchesHealth, acquireSpawnLock, releaseSpawnLock, spawnLockDir, SPAWN_LOCK_STALE_MS, WAIT_CURRENT_MS };
