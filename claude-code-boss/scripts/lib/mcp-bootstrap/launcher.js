'use strict';
/**
 * launcher.js — the ONLY way this plugin starts the mcp-memory server daemon.
 *
 * Official contract (native-java docs/contracts/daemon-launcher-contract.md, ADR-023): a client
 * never starts the jar itself; it runs the launcher ~/.mcp-memory/bin/mcp-memory-daemon(.cmd),
 * reads the ONE JSON line it prints ({url,port,pid,version,spawned}) and connects. Exit 1 means
 * failure with a "[FATAL] …" reason on stderr — shown to the user, no fallback. The launcher is
 * installed once by `java -jar mcp-memory-server-X.Y.Z.jar --install-launcher` (server ≥ 2.45.5),
 * which also registers it to start at logon (the reboot case).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MIN_LAUNCHER_VERSION = '2.45.5';
const JAR_RE = /^mcp-memory-server-(\d+)\.(\d+)\.(\d+)\.jar$/; // contract C-3: exact X.Y.Z only

function home(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function launcherPath(env = process.env, platform = process.platform) {
  return path.join(home(env), '.mcp-memory', 'bin', platform === 'win32' ? 'mcp-memory-daemon.cmd' : 'mcp-memory-daemon');
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Newest exact mcp-memory-server-X.Y.Z.jar across ~/.mcp-memory/lib and /server (contract C-3). */
function newestInstalledJar(env = process.env) {
  let best = null;
  for (const sub of ['lib', 'server']) {
    const dir = path.join(home(env), '.mcp-memory', sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') console.error(`[mcp-launcher] cannot list ${dir}: ${err.message}`); continue; }
    for (const n of names) {
      const m = JAR_RE.exec(n);
      if (!m) continue;
      const version = `${m[1]}.${m[2]}.${m[3]}`;
      if (!best || compareVersions(version, best.version) > 0) best = { path: path.join(dir, n), version };
    }
  }
  return best;
}

/** The launcher's own Java choice (contract C-4) — used to run --install-launcher. */
function bundledJava(env = process.env, platform = process.platform) {
  const p = path.join(home(env), '.mcp-memory', 'server', 'runtime', 'bin', platform === 'win32' ? 'java.exe' : 'java');
  return fs.existsSync(p) ? p : null;
}

function run(file, args, { env, timeoutMs, platform = process.platform, execImpl = null }) {
  // A .cmd is not an executable for CreateProcess: run it through cmd.exe.
  const [cmd, argv] = platform === 'win32' && /\.cmd$/i.test(file) ? ['cmd.exe', ['/d', '/c', file, ...args]] : [file, args];
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    };
    if (execImpl) execImpl(cmd, argv, { env, timeout: timeoutMs }, done); // tests only
    else execFile(cmd, argv, { env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, done);
  });
}

const fatalOf = (stderr, fallback) => (String(stderr).split(/\r?\n/).find((l) => /\[FATAL\]/.test(l)) || fallback).trim();

/**
 * Run the launcher. { ok:true, url, port, pid, version, spawned } or { ok:false, error }.
 * javaHome: a Java the plugin found that may not be on PATH (just installed) — the launcher
 * honours JAVA_HOME when there is no bundled runtime.
 */
async function runLauncher({ env = process.env, platform = process.platform, timeoutMs = 200000, javaHome = '', execImpl } = {}) {
  const file = launcherPath(env, platform);
  if (!fs.existsSync(file)) return { ok: false, missing: true, error: `the mcp-memory launcher is not installed (${file})` };
  const runEnv = javaHome ? { ...env, JAVA_HOME: javaHome } : env;
  const r = await run(file, [], { env: runEnv, timeoutMs, platform, execImpl });
  if (r.code !== 0) return { ok: false, error: fatalOf(r.stderr, `the launcher failed (exit ${r.code})${r.error && r.error.killed ? ' — timed out' : ''}; see ~/.mcp-memory/logs/daemon.log`) };
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return { ok: false, error: `the launcher printed ${lines.length} lines instead of one JSON line` };
  let a;
  try { a = JSON.parse(lines[0]); } catch (err) { return { ok: false, error: `the launcher output is not JSON: ${err.message}` }; }
  if (!a || typeof a.url !== 'string' || !/^https?:\/\//.test(a.url)) return { ok: false, error: `the launcher answered without a url: ${lines[0].slice(0, 200)}` };
  return { ok: true, url: a.url.replace(/\/+$/, ''), port: a.port, pid: a.pid, version: a.version || '', spawned: !!a.spawned };
}

/** `java -jar <jar> --install-launcher` (once). { ok:true, launcher } or { ok:false, error }. */
async function installLauncher({ jar, javaBin, env = process.env, platform = process.platform, timeoutMs = 60000, execImpl } = {}) {
  if (!jar || !jar.path) return { ok: false, error: 'no mcp-memory-server-X.Y.Z.jar to install the launcher from' };
  if (compareVersions(jar.version, MIN_LAUNCHER_VERSION) < 0) {
    return { ok: false, tooOld: true, error: `the installed memory server is ${jar.version}; the launcher needs ${MIN_LAUNCHER_VERSION} or newer` };
  }
  const java = bundledJava(env, platform) || javaBin;
  if (!java) return { ok: false, error: 'Java 21+ is needed to install the memory server launcher' };
  const r = await run(java, ['-jar', jar.path, '--install-launcher'], { env, timeoutMs, platform, execImpl });
  if (r.code !== 0) return { ok: false, error: fatalOf(r.stderr, `--install-launcher failed (exit ${r.code})`) };
  const file = launcherPath(env, platform);
  if (!fs.existsSync(file)) return { ok: false, error: `--install-launcher reported success but ${file} does not exist` };
  return { ok: true, launcher: file };
}

const RUN_HIDDEN_VBS = path.join(__dirname, 'run-hidden.vbs');

/**
 * How to start the launcher detached WITHOUT a window. On Windows it goes through wscript +
 * run-hidden.vbs: `spawn(cmd.exe, {detached:true, windowsHide:true})` opened a visible
 * Windows Terminal window (DETACHED_PROCESS makes Windows ignore the hide flag, and the
 * launcher's PowerShell got a console of its own) — measured; and without `detached` the
 * launcher died with the hook process. Pure.
 * @returns {[string, string[]]}
 */
function kickCommand(file, platform = process.platform) {
  if (platform === 'win32') return ['wscript.exe', ['//B', '//Nologo', RUN_HIDDEN_VBS, file]];
  return [file, []];
}

/**
 * Fire-and-forget launcher run: starts the daemon if it is down, without waiting. Only for a
 * daemon already known to be DOWN (callers health-check first — see mcp-client._ensureDaemon).
 * Returns false when the launcher is not installed (nothing is started then).
 */
function kickLauncher({ env = process.env, platform = process.platform, spawnImpl = null } = {}) {
  const file = launcherPath(env, platform);
  if (!fs.existsSync(file)) return false;
  const [cmd, argv] = kickCommand(file, platform);
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true, env };
    const child = spawnImpl ? spawnImpl(cmd, argv, opts) : spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', (err) => console.error(`[mcp-launcher] kick failed: ${err.message}`));
    child.unref();
    return true;
  } catch (err) {
    console.error(`[mcp-launcher] kick failed: ${err.message}`);
    return false;
  }
}

/**
 * kickLauncher, CONFIRMED on Windows: wscript exits right after Run(…, 0, False) starts the
 * launcher, so a non-zero exit (VBScript disabled — Microsoft is phasing it out — or blocked by
 * policy; `//B` hides its error) or a spawn error means nothing started. Then it says so loudly
 * and falls back to the plain detached launch: it may flash a window, but the server comes up
 * (pre-release audit 3.2.0: the hidden path failed silently, reporting "kicked" forever).
 * @returns {Promise<'kicked'|'fallback'|'missing'|'failed'>}
 */
function kickLauncherVerified({ env = process.env, platform = process.platform, spawnImpl = null, waitMs = 5000 } = {}) {
  const file = launcherPath(env, platform);
  if (!fs.existsSync(file)) return Promise.resolve('missing');
  if (platform !== 'win32') return Promise.resolve(kickLauncher({ env, platform, spawnImpl }) ? 'kicked' : 'failed');
  const [cmd, argv] = kickCommand(file, platform);
  return new Promise((resolve) => {
    let done = false;
    const fallback = (why) => {
      if (done) return; done = true;
      console.error(`[mcp-launcher] hidden launch failed (${why}) — starting the launcher the plain way (a window may flash)`);
      try {
        const c = spawnImpl ? spawnImpl('cmd.exe', ['/d', '/c', file], { detached: true, stdio: 'ignore', windowsHide: true, env }) : spawn('cmd.exe', ['/d', '/c', file], { detached: true, stdio: 'ignore', windowsHide: true, env });
        c.on('error', (err) => console.error(`[mcp-launcher] fallback launch failed: ${err.message}`));
        c.unref();
        resolve('fallback');
      } catch (err) { console.error(`[mcp-launcher] fallback launch failed: ${err.message}`); resolve('failed'); }
    };
    let child;
    try {
      child = spawnImpl ? spawnImpl(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, env }) : spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, env });
    } catch (err) { fallback(err.message); return; }
    // Kept REFERENCED while waiting (≤ waitMs; wscript returns in ms): an unref'd child and timer
    // let a short hook process exit before the verdict, dropping its own output.
    const t = setTimeout(() => { if (!done) { done = true; child.unref(); resolve('kicked'); } }, waitMs); // still running: it launched
    child.on('error', (err) => { clearTimeout(t); fallback(err.message); });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) { if (!done) { done = true; resolve('kicked'); } } else fallback(`wscript exit ${code}`);
    });
  });
}

module.exports = { runLauncher, installLauncher, kickLauncher, kickLauncherVerified, kickCommand, RUN_HIDDEN_VBS, newestInstalledJar, launcherPath, bundledJava, compareVersions, MIN_LAUNCHER_VERSION, JAR_RE };
