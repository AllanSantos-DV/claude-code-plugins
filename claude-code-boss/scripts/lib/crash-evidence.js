'use strict';
/**
 * crash-evidence.js — leave a readable trace when the brain daemon dies (no admin needed).
 *
 * The daemon runs detached with no parent waiting on it, so its exit code went
 * unrecorded, and every new spawn truncated the stderr log of the one that died. A native
 * abort (0xC0000409, the CRT's __fastfail) killed it on a machine nobody was watching,
 * and nothing was left to read.
 *
 * Detection needs no resident watcher. A graceful shutdown deletes the lock file
 * (http-daemon.js). So when the port is free and the lock still names a dead pid that
 * started after the last Windows boot, the daemon did not exit by itself or with the
 * reboot. The next ensureDaemon records it, before the new spawn overwrites the log:
 *   - the final stderr;
 *   - the versions of Node and the native modules, plus the VC++/onnxruntime DLLs;
 *   - CPU and RAM;
 *   - the installed plugins and MCP servers (names only).
 * A hidden collector then appends the Windows "Application Error" event, which carries
 * the faulting module and the exception code, plus the AVX flags. Both are readable by
 * a normal user. Records go to <dataDir>/brain-crash.log (JSON lines, newest last).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const v8 = require('v8');
const { spawn, spawnSync } = require('child_process');

const LOG_NAME = 'brain-crash.log';
const REPORT_DIR = 'crash-reports';
const MAX_RECORDS = 20;
const MAX_REPORTS = 10;
const STDERR_TAIL_LINES = 60;
const NATIVE_PACKAGES = ['onnxruntime-node', 'onnxruntime-common', '@huggingface/transformers', 'sharp', '@img/sharp-win32-x64', 'better-sqlite3'];
const SYSTEM_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'onnxruntime.dll'];

function crashLogFile(dataDir) { return path.join(dataDir, LOG_NAME); }
function reportDir(dataDir) { return path.join(dataDir, REPORT_DIR); }
function lockPath(dataDir) { return path.join(dataDir, 'brain-http.lock.json'); }
function spawnLogPath(dataDir) { return path.join(dataDir, 'brain-http.spawn.log'); }

/** Node flags for the daemon: a V8 fatal error or an uncaught exception writes a report. */
function reportFlags(dataDir) {
  return ['--report-on-fatalerror', '--report-uncaught-exception', `--report-directory=${reportDir(dataDir)}`];
}

/** kill(pid, 0) probes without signalling; EPERM means the pid exists under another user. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const readJson = (file) => require('./json-file.js').readJsonLoud(file, 'crash-evidence');

/**
 * The lock of a daemon that died without shutting down, or null.
 * A pid reused by another process reads as alive: that crash is missed, never invented.
 * A lock for another port belongs to a pre-fixed-port daemon, which the supervisor may
 * have stopped with a hard kill (exileLegacyDaemon): not a crash either.
 * @param {{dataDir:string, port?:number, now?:number, bootTimeMs?:number, alive?:(pid:number)=>boolean}} o
 */
function detectUncleanExit({ dataDir, port, now = Date.now(), bootTimeMs, alive = pidAlive }) {
  const lock = readJson(lockPath(dataDir));
  if (!lock || !Number.isInteger(lock.pid)) return null;
  if (port != null && lock.port != null && Number(lock.port) !== Number(port)) return null;
  if (alive(lock.pid)) return null;
  const boot = bootTimeMs == null ? now - os.uptime() * 1000 : bootTimeMs;
  // Started before this boot → it went down with the machine, not on its own.
  if (Number.isFinite(lock.startedAt) && lock.startedAt < boot) return null;
  return lock;
}

/**
 * A daemon WE killed (hard-kill fallback, installer) leaves its lock behind exactly like
 * a crash: drop that lock so detectUncleanExit does not report our own kill. Only the
 * lock of the killed pid — a newer daemon's lock is never touched.
 * @returns {boolean} whether a lock was removed
 */
function forgetStoppedDaemon(dataDir, pid) {
  const lock = readJson(lockPath(dataDir));
  if (!lock || lock.pid !== pid) return false;
  fs.rmSync(lockPath(dataDir), { force: true });
  return true;
}

/**
 * FileVersion of a PE file (VS_FIXEDFILEINFO, signature 0xFEEF04BD), or null.
 * Read in-process so the doctor and the record need no PowerShell for it.
 */
function peFileVersion(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[crash-evidence] ${file}: ${err.message}`);
    return null;
  }
  const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const at = buf.lastIndexOf(sig);
  if (at < 0 || at + 16 > buf.length) return null;
  const ms = buf.readUInt32LE(at + 8);
  const ls = buf.readUInt32LE(at + 12);
  return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
}

/** -1/0/1 comparing dotted numeric versions. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function system32() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'); }

/** Versions of the DLLs the onnxruntime binding resolves from System32 (Windows only). */
function systemDlls() {
  if (process.platform !== 'win32') return null;
  const out = {};
  for (const name of SYSTEM_DLLS) out[name] = peFileVersion(path.join(system32(), name));
  return out;
}

function nativePackages(pluginRoot) {
  const out = {};
  if (!pluginRoot) return out;
  const roots = [path.join(pluginRoot, 'node_modules'), path.join(pluginRoot, 'servers', 'brain-server', 'node_modules')];
  for (const name of NATIVE_PACKAGES) {
    for (const nm of roots) {
      const pkg = readJson(path.join(nm, name, 'package.json'));
      if (pkg && pkg.version) { out[name] = pkg.version; break; }
    }
  }
  const ortDll = path.join(pluginRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll');
  if (process.platform === 'win32' && fs.existsSync(ortDll)) out['onnxruntime.dll (bundled)'] = peFileVersion(ortDll);
  return out;
}

function embedderProvider() {
  try { return (require('./brain-config.js').load().embedder || {}).provider || 'transformers'; } catch (err) {
    return `unknown (${err.message})`;
  }
}

/** Plugin keys and MCP server names: what else shares the machine, without any secret. */
function neighbours(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const installed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = Object.entries((installed && installed.plugins) || {})
    .map(([key, list]) => `${key}@${(Array.isArray(list) && list[0] && list[0].version) || '?'}`);
  const cfg = readJson(path.join(os.homedir(), '.claude.json'));
  const mcpServers = Object.keys((cfg && cfg.mcpServers) || {});
  return { plugins, mcpServers };
}

/** Everything about this machine that a native abort could depend on. Cheap, synchronous. */
function snapshot({ pluginRoot } = {}) {
  const cpus = os.cpus();
  return {
    node: { version: process.version, v8: process.versions.v8, modules: process.versions.modules, sqlite: process.versions.sqlite || null, execPath: process.execPath, arch: process.arch },
    os: { platform: process.platform, release: os.release(), totalMemMB: Math.round(os.totalmem() / 2 ** 20), freeMemMB: Math.round(os.freemem() / 2 ** 20), heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 2 ** 20) },
    cpu: { model: cpus[0] ? cpus[0].model.trim() : null, count: cpus.length },
    embedderProvider: embedderProvider(),
    nativePackages: nativePackages(pluginRoot),
    systemDlls: systemDlls(),
    ...neighbours(),
  };
}

function readRecords(dataDir) {
  let text;
  try { text = fs.readFileSync(crashLogFile(dataDir), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[crash-evidence] ${crashLogFile(dataDir)}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (err) { console.error(`[crash-evidence] corrupt record skipped: ${err.message}`); }
  }
  return out;
}

function writeRecords(dataDir, records) {
  require('./atomic-write.js').writeFileAtomic(crashLogFile(dataDir), records.slice(-MAX_RECORDS).map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function stderrTail(dataDir) {
  let text;
  try { text = fs.readFileSync(spawnLogPath(dataDir), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[crash-evidence] spawn log: ${err.message}`);
    return [];
  }
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-STDERR_TAIL_LINES);
}

/** Node reports written since the dead daemon started; keeps the newest MAX_REPORTS on disk. */
function reportsSince(dataDir, sinceMs) {
  let names;
  try { names = fs.readdirSync(reportDir(dataDir)).filter((n) => n.endsWith('.json')); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[crash-evidence] ${reportDir(dataDir)}: ${err.message}`);
    return [];
  }
  const files = names.map((n) => {
    const p = path.join(reportDir(dataDir), n);
    return { p, m: fs.statSync(p).mtimeMs };
  }).sort((a, b) => b.m - a.m);
  for (const old of files.slice(MAX_REPORTS)) fs.rmSync(old.p, { force: true });
  return files.slice(0, MAX_REPORTS).filter((f) => !Number.isFinite(sinceMs) || f.m >= sinceMs).map((f) => f.p);
}

/**
 * Write the record of a dead daemon, then drop its stale lock (it would be re-reported).
 * @returns {object} the record
 */
function recordCrash({ dataDir, lock, pluginRoot, now = Date.now() }) {
  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    detectedAt: new Date(now).toISOString(),
    pid: lock.pid,
    version: lock.version || null,
    pluginRoot: lock.pluginRoot || pluginRoot || null,
    startedAt: Number.isFinite(lock.startedAt) ? new Date(lock.startedAt).toISOString() : null,
    // Upper bound: the death happened somewhere between startedAt and now.
    aliveAtMostMs: Number.isFinite(lock.startedAt) ? now - lock.startedAt : null,
    stderrTail: stderrTail(dataDir),
    nodeReports: reportsSince(dataDir, lock.startedAt),
    machine: snapshot({ pluginRoot: lock.pluginRoot || pluginRoot }),
    windows: null,
  };
  writeRecords(dataDir, [...readRecords(dataDir), record]);
  fs.rmSync(lockPath(dataDir), { force: true });
  return record;
}

// Event 1000 "Application Error" fields: 0 app, 3 faulting module, 4 its version,
// 6 exception code, 7 offset, 8 pid, 10 app path, 11 module path. Readable without admin.
const FAULT_PS = `
$ErrorActionPreference = 'Stop'
$since = [DateTime]::Parse($env:CCB_CRASH_SINCE).ToLocalTime()
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $since } -MaxEvents 100 -ErrorAction SilentlyContinue |
  Where-Object { $_.Properties[0].Value -eq 'node.exe' } |
  ForEach-Object { $p = $_.Properties; [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); module = $p[3].Value; moduleVersion = $p[4].Value; exception = $p[6].Value; offset = $p[7].Value; pid = "$($p[8].Value)"; appPath = $p[10].Value; modulePath = $p[11].Value } })
Add-Type -Namespace CcbCrash -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);'
$cpu = [pscustomobject]@{ avx = [CcbCrash.K]::IsProcessorFeaturePresent(39); avx2 = [CcbCrash.K]::IsProcessorFeaturePresent(40); avx512f = [CcbCrash.K]::IsProcessorFeaturePresent(41) }
[pscustomobject]@{ events = $ev; cpu = $cpu } | ConvertTo-Json -Depth 4 -Compress
`;

/** The event's pid field is decimal or hex depending on the Windows build. */
function samePid(field, pid) {
  const s = String(field || '').trim().toLowerCase();
  return s === String(pid) || (s.startsWith('0x') && parseInt(s, 16) === pid);
}

/** Ask Windows for the fault events since `sinceIso` and the CPU's AVX flags. */
// Tests inject `run`; the real one is always hidden.
function hiddenSpawnSync(cmd, args, opts) { return spawnSync(cmd, args, { ...opts, windowsHide: true }); }

function queryWindows(sinceIso, run = hiddenSpawnSync) {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(FAULT_PS, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, CCB_CRASH_SINCE: sinceIso },
  });
  if (r.error) throw new Error(`powershell failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`powershell exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  const j = JSON.parse(String(r.stdout).trim());
  const events = j.events == null ? [] : Array.isArray(j.events) ? j.events : [j.events];
  return { events, cpu: j.cpu || null };
}

/** Fill `windows` on record `id`: its own fault event (matched by pid) and the CPU flags. */
function enrich(dataDir, id, { query = queryWindows } = {}) {
  const rec = readRecords(dataDir).find((r) => r.id === id);
  if (!rec) throw new Error(`crash record ${id} not found in ${crashLogFile(dataDir)}`);
  const since = rec.startedAt || new Date(Date.parse(rec.detectedAt) - 7 * 86400000).toISOString();
  let windows;
  try {
    const { events, cpu } = query(since);
    const fault = events.find((e) => samePid(e.pid, rec.pid)) || null;
    windows = { fault, cpu, note: fault ? null : `no Application Error event for node.exe pid ${rec.pid} since ${since} — a Node abort (out of memory, exit 134) leaves none: see the stderr tail; otherwise it was killed from outside or Windows Error Reporting is off` };
  } catch (err) {
    windows = { fault: null, cpu: null, note: `Windows query failed: ${err.message}` };
  }
  // Re-read: another record may have landed while PowerShell ran.
  const records = readRecords(dataDir);
  const target = records.find((r) => r.id === id);
  if (target) { target.windows = windows; writeRecords(dataDir, records); }
  return windows;
}

/** Run enrich() in a hidden detached process, so session start does not wait on PowerShell. */
function startEnrich(dataDir, id) {
  if (process.platform !== 'win32') return false;
  const child = spawn(process.execPath, [__filename, 'enrich', dataDir, id], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => console.error(`[crash-evidence] enrich spawn failed: ${err.message}`));
  child.unref();
  return true;
}

/** One-line description of a record, for the session notice and the doctor. */
function describe(rec) {
  const parts = [];
  const mins = rec.aliveAtMostMs == null ? null : Math.round(rec.aliveAtMostMs / 60000);
  parts.push(`daemon v${rec.version || '?'} pid ${rec.pid} died unexpectedly (detected ${rec.detectedAt}${mins == null ? '' : `, up to ${mins} min after start`})`);
  const f = rec.windows && rec.windows.fault;
  if (f) parts.push(`Windows fault: exception 0x${String(f.exception).replace(/^0x/i, '')} in ${f.module} ${f.moduleVersion || ''}`.trim());
  else if (rec.windows && rec.windows.note) parts.push(rec.windows.note);
  const last = (rec.stderrTail || []).slice(-1)[0];
  if (last) parts.push(`last stderr: ${last.slice(0, 200)}`);
  return parts.join('; ');
}

/** What to do about a record, read from the faulting module. */
function adviceFor(rec) {
  const f = rec.windows && rec.windows.fault;
  const mod = f ? String(f.module).toLowerCase() : '';
  if (mod.startsWith('onnxruntime') || mod.startsWith('msvcp140') || mod.startsWith('vcruntime')) {
    return 'the embedder\'s ONNX runtime aborted: install the latest Visual C++ x64 redistributable (https://aka.ms/vc14/vc_redist.x64.exe) and run `node scripts/doctor.js`; if it keeps dying, switch the embedder provider in the dashboard (Embedder panel)';
  }
  // Node's own aborts (V8 out-of-memory, process.abort) exit 134 without a Windows fault event,
  // so a fault inside node.exe is a fail-fast in its C++ (often an addon misusing N-API).
  if (mod === 'node.exe') return 'a fail-fast inside node.exe (not a V8 out-of-memory, which exits 134 without a Windows fault event): read the Node report and the stderr tail in the record';
  if (mod) return `the fault is in ${f.module} (${f.modulePath || 'path unknown'}): check what installed that DLL`;
  return 'no Windows fault event yet — the collector may still be running; run `node scripts/doctor.js` again in a minute';
}

if (require.main === module && process.argv[2] === 'enrich') {
  try { enrich(process.argv[3], process.argv[4]); } catch (err) {
    console.error(`[crash-evidence] enrich failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  LOG_NAME, MAX_RECORDS, crashLogFile, reportDir, reportFlags, pidAlive, detectUncleanExit, forgetStoppedDaemon, peFileVersion, compareVersions,
  systemDlls, embedderProvider, snapshot, readRecords, recordCrash, queryWindows, enrich, startEnrich, describe, adviceFor, samePid,
};
