#!/usr/bin/env node
/**
 * consolidate-datadirs-hook.js — SILENT consolidation launcher.
 *
 * The engine (consolidate-datadirs.js) absorbs stray sibling data dirs into the
 * ACTIVE one. This module is the cheap, fail-open LAUNCHER for it.
 *
 * v2.16.0 — "consolidate the SESSION IN USE": the AUTHORITATIVE caller is the
 * brain-server (servers/brain-server/index.js) — the ONE process that reliably
 * receives THIS session's real --plugin-data — which invokes `run({ activeDir })`
 * with that real dir, so the engine targets the session's OWN folder, not the
 * oscillating global pointer an env-less SessionStart hook would follow (that
 * env-less trigger is retired). A standalone `main()` remains for manual use,
 * while obeying three hard constraints:
 *
 *   1. NEVER blocks session start. The cheap check (a filesystem scan, no SQLite)
 *      runs inline; the DESTRUCTIVE merge is handed to a DETACHED, unref'd child
 *      process (`node consolidate-datadirs.js --apply`) that outlives this hook's
 *      10s timeout and runs on its own. We do NOT await or read the child.
 *   2. IDEMPOTENT. Once siblings are absorbed+deleted, the scan finds no populated
 *      sibling and this is a fast no-op forever (spawns nothing).
 *   3. SILENT. It NEVER injects session context (`emitEmpty()` always) — the user
 *      doesn't know it exists. The child's audit trail is the log file under
 *      <activeDir>/.runtime/consolidate-datadirs.log.
 *
 * Concurrency is the engine's job: its apply path takes a process-level lock, so
 * this auto-apply and a manual `--apply` can never run the merge at once.
 *
 * Fail-open EVERYWHERE: any error → `emitEmpty()` + exit 0. It must never break
 * SessionStart. The heavy engine module is NOT required in-process (it pulls in
 * SQLite) — it is only ever spawned as a separate process.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readStdin, emitEmpty } = require('./lib/hook-io.js');

// Default seams — lazy requires keep the steady-state no-op cheap and avoid
// pulling SQLite into this process. doctor.js is SQLite-free (fs/path/os/http).
function dataDirDefault() {
  return require('./lib/data-dir.js').dataDir();
}
function enumerateDefault(activeDir) {
  return require('./doctor.js').findDataDirCandidates(activeDir);
}
function spawnDefault(cmd, args, opts) {
  return require('child_process').spawn(cmd, args, opts);
}

/**
 * Open an APPEND file descriptor to <activeDir>/.runtime/consolidate-datadirs.log
 * (mkdir -p the .runtime dir first). This is the detached child's stdout/stderr
 * sink and the owner's audit trail. Returns null on ANY failure so the caller
 * falls back to `stdio:'ignore'` — logging is best-effort, never a blocker.
 * @param {object} fsx fs seam
 * @param {string} activeDir resolved active data dir
 * @returns {number|null} an open fd, or null
 */
function openLogFd(fsx, activeDir) {
  try {
    const runtimeDir = path.join(activeDir, '.runtime');
    fsx.mkdirSync(runtimeDir, { recursive: true });
    return fsx.openSync(path.join(runtimeDir, 'consolidate-datadirs.log'), 'a');
  } catch (err) {
    console.error(`[consolidate-datadirs-hook] log open failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

/**
 * Core logic (deps injected for tests). Cheap filesystem check; on a populated
 * sibling, detach-spawns the engine's guarded `--apply` and returns immediately.
 * NEVER throws — every failure logs and returns a status object.
 * @param {object} [deps] injectable seams (fsx, dataDir, enumerate, spawn,
 *   enginePath, execPath)
 * @returns {{spawned:boolean, reason:string}}
 */
function run(deps = {}) {
  const fsx = deps.fsx || fs;
  const dataDir = deps.dataDir || dataDirDefault;
  const enumerate = deps.enumerate || enumerateDefault;
  const spawn = deps.spawn || spawnDefault;
  const enginePath = deps.enginePath || path.join(__dirname, 'consolidate-datadirs.js');
  const execPath = deps.execPath || process.execPath;

  try {
    const activeDir = deps.activeDir || dataDir();
    const candidates = enumerate(activeDir) || [];
    const hasSibling = candidates.some(
      (c) => c && c.populated && path.resolve(c.path) !== path.resolve(activeDir),
    );

    // Steady state (siblings already absorbed+deleted): fast no-op, spawn nothing.
    if (!hasSibling) return { spawned: false, reason: 'no-siblings' };

    // A populated sibling exists → hand off to a DETACHED, unref'd child running
    // the engine's guarded `--apply`. Return immediately: the merge runs in the
    // child (unbounded by this hook's timeout) and never blocks SessionStart.
    const logFd = openLogFd(fsx, activeDir);
    const stdio = logFd != null ? ['ignore', logFd, logFd] : 'ignore';
    try {
      // When an explicit target dir is provided (the brain-server passes THIS
      // session's real --plugin-data), forward it so the engine consolidates the
      // SESSION IN USE instead of resolving via the oscillating global pointer.
      const engineArgs = deps.activeDir
        ? [enginePath, '--apply', '--active-dir', deps.activeDir]
        : [enginePath, '--apply'];
      const child = spawn(execPath, engineArgs, { detached: true, windowsHide: true, stdio });
      child.unref();
    } finally {
      // Close the parent's copy of the fd (the child dup'd its own at spawn). A
      // double/bad close must never throw out of the hook.
      if (logFd != null) { try { fsx.closeSync(logFd); } catch (err) { void err; } }
    }
    return { spawned: true, reason: 'spawned' };
  } catch (err) {
    console.error(`[consolidate-datadirs-hook] ${err && err.message ? err.message : err}`);
    return { spawned: false, reason: 'error' };
  }
}

async function main() {
  try {
    await readStdin(); // read + discard, mirroring the other SessionStart hooks
    run();
  } catch (err) {
    console.error(`[consolidate-datadirs-hook] crashed: ${err && err.message ? err.message : err}`);
  }
  emitEmpty(); // ALWAYS empty — this hook is silent (never injects session context)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[consolidate-datadirs-hook] crashed: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

// Exported for deterministic unit tests (inject the spawn / fs / enumerate seams).
module.exports = { run, openLogFd };
