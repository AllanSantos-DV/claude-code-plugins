#!/usr/bin/env node
/**
 * dashboard-start — ensure the local dashboard is running (idempotent across
 * Claude sessions: PID file + a live HTTP probe of the port it published).
 *
 * `ensureDashboard()` is shared by the CLI below and by the `/dashboard` hook
 * (dashboard-command.js), which answers the slash command WITHOUT the model.
 *
 * Paths follow dashboard.js exactly (`CLAUDE_PLUGIN_DATA` when set, else the
 * canonical data dir), so the PID / discovery files are the ones it writes.
 *
 * CLI contract: writes one JSON line to stdout and exits 0.
 */
const fs = require('fs');
const { pidAlive } = require('./lib/process-lock.js');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DASHBOARD_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'dashboard.js');

function runtimeDir() {
  const { dataDir, validEnvDir } = require('./lib/data-dir.js');
  return path.join(validEnvDir(process.env.CLAUDE_PLUGIN_DATA) || dataDir(), '.runtime');
}

const isAlive = pidAlive; // lib/process-lock

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (err) { if (err.code !== 'ENOENT') console.error(`[DASHBOARD-START] read ${file}: ${err.message}`); return null; }
}

/** GET / on the published port: the dashboard serves its page without auth. */
function probe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs, headers: { host: `localhost:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** The live dashboard ({port, pid}) if its discovery file points at a responding server. */
async function liveDashboard(dir) {
  const d = readJson(path.join(dir, 'dashboard.json'));
  if (!d || !Number.isInteger(d.port) || !isAlive(d.pid)) return null;
  return (await probe(d.port)) ? { port: d.port, pid: d.pid } : null;
}

/**
 * One starter at a time (O_EXCL lock): two sessions running /dashboard together used to
 * spawn two servers — the last discovery write won, the other waited and answered "não
 * respondeu", leaving an orphan. A lock whose owner died or that outlived a start
 * attempt is taken over. Returns a release function, or null when another start is live.
 */
function acquireStartLock(file, staleMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') console.error(`[DASHBOARD-START] release lock: ${err.message}`); } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readJson(file);
      if (held && isAlive(held.pid) && Date.now() - Number(held.at) < staleMs) return null;
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return null;
}

/**
 * Make sure the dashboard is up and answering. Never opens a browser itself
 * (the caller decides). Resolves {ok:true, status:'already-running'|'started',
 * port, pid, url} or {ok:false, error} — never throws.
 */
async function ensureDashboard({ waitMs = 8000 } = {}) {
  const dir = runtimeDir();
  const live = await liveDashboard(dir);
  if (live) return { ok: true, status: 'already-running', ...live, url: `http://localhost:${live.port}` };

  const lockFile = path.join(dir, 'dashboard.starting');
  let release;
  try { release = acquireStartLock(lockFile, waitMs + 2000); }
  catch (err) { return { ok: false, error: `não foi possível travar a subida do dashboard (${lockFile}): ${err.message}` }; }
  if (!release) {
    // Another session is starting it: wait for THAT server instead of spawning a second.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const up = await liveDashboard(dir);
      if (up) return { ok: true, status: 'already-running', ...up, url: `http://localhost:${up.port}` };
    }
    return { ok: false, error: `outra sessão está subindo o dashboard e ele não respondeu em ${Math.round(waitMs / 1000)}s (trava ${lockFile})` };
  }
  try { return await spawnAndWait(dir, waitMs); }
  finally { release(); }
}

async function spawnAndWait(dir, waitMs) {
  let child;
  try {
    child = spawn(process.execPath, [DASHBOARD_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // dashboard.js opens a browser unless DASHBOARD_NO_OPEN is set to ANY value
      // (the old '0' meant "don't open" too — so it never opened). Opening is the
      // caller's call, after the server is known to answer.
      env: { ...process.env, DASHBOARD_NO_OPEN: '1', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    child.unref();
  } catch (err) {
    return { ok: false, error: `não foi possível iniciar o dashboard: ${err.message}` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dashboard.pid'), String(child.pid));
  } catch (err) {
    console.error(`[DASHBOARD-START] Failed to write PID file: ${err.message}`);
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const up = await liveDashboard(dir);
    if (up && up.pid === child.pid) return { ok: true, status: 'started', ...up, url: `http://localhost:${up.port}` };
    if (!isAlive(child.pid)) {
      return { ok: false, error: `o processo do dashboard (pid ${child.pid}) terminou ao subir — rode \`node "${DASHBOARD_SCRIPT}"\` para ver o erro` };
    }
  }
  return { ok: false, error: `o dashboard (pid ${child.pid}) não respondeu em ${Math.round(waitMs / 1000)}s — discovery esperado em ${path.join(dir, 'dashboard.json')}` };
}

if (require.main === module) {
  ensureDashboard().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); });
}

module.exports = { ensureDashboard, probe, runtimeDir };
