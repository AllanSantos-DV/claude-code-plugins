'use strict';
/**
 * embedder-guard.js — load the local embedder (onnxruntime) once in a throwaway process
 * before the daemon does, so a machine where that load ABORTS the process natively stops
 * killing the Brain daemon.
 *
 * A native abort (0xC0000409 fast-fail from a DLL, or Node's 134) cannot be caught: inside
 * the daemon it takes the whole process down, and the next prompt respawns it into the same
 * crash. Here it only kills the test process; the outcome is recorded in
 * `<data>/embedder-guard.json` under a key of {plugin version, Node version, arch, model},
 * and an abort writes a `none` override: brain-embedder then runs keyword-only search and
 * says why in its status (and the doctor). A JS error or a timeout is NOT an abort — nothing
 * is forced and the next boot tries again. A new plugin, Node or model re-runs the test;
 * so does a doctor load test, which also lifts the override when it passes.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const GUARD_FILE = 'embedder-guard.json';
// 0xC0000409 as a child exit status: a native DLL called abort()/__fastfail. Node's own
// aborts (V8 out-of-memory, process.abort) exit 134 instead — measured on Windows 11.
const FAST_FAIL_STATUSES = new Set([0xC0000409, 0xC0000409 - 0x100000000]);
const NODE_ABORT_STATUS = 134;
const PROBE_TIMEOUT_MS = 180000;
// The test process must load the real model even while an override is in place.
const GUARD_OFF_ENV = 'CCB_EMBEDDER_GUARD';

function isNativeAbort(status) { return FAST_FAIL_STATUSES.has(status) || status === NODE_ABORT_STATUS; }

function exitHex(status) { return Number.isInteger(status) ? `0x${(status >>> 0).toString(16).toUpperCase()}` : null; }

function pluginVersion() { return require('../../package.json').version; }

/** Provider and model as brain-embedder reads them (same defaults). */
function configured(load = () => require('./brain-config.js').load()) {
  const e = load().embedder || {};
  return { provider: e.provider || 'transformers', model: e.model || 'Xenova/all-MiniLM-L6-v2' };
}

function guardKey({ model, node = process.version, arch = `${process.platform}-${process.arch}`, plugin = pluginVersion() }) {
  return `${plugin}|${String(node).replace(/^v?/, 'v')}|${arch}|${model}`;
}

function guardFile(data) { return path.join(data, GUARD_FILE); }

function readGuard(data) {
  try {
    return JSON.parse(fs.readFileSync(guardFile(data), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[embedder-guard] ${guardFile(data)} unreadable: ${err.message}`);
    return null;
  }
}

/** The override for this process, or null: only a record whose key is the current one counts. */
function forcedNone(data, model, env = process.env) {
  if (env[GUARD_OFF_ENV] === 'off') return null;
  const g = readGuard(data);
  return g && g.forced === 'none' && g.key === guardKey({ model }) ? g : null;
}

/** Any .onnx weight under the cache = model materialized. */
function modelPresent(cacheDir) {
  try {
    if (!cacheDir || !fs.existsSync(cacheDir)) return false;
    const stack = [cacheDir];
    let n = 0;
    while (stack.length && n++ < 5000) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/\.onnx$/i.test(e.name)) return true;
      }
    }
    return false;
  } catch (err) {
    console.error(`[embedder-guard] model cache ${cacheDir} unreadable: ${err.message}`);
    return false;
  }
}

function probeArgs(data) {
  const ce = require('./crash-report-flags.js');
  const embedder = path.join(__dirname, '..', 'brain-embedder.js');
  const code = `const e=require(${JSON.stringify(embedder)});const t=Date.now();` +
    `e.init().then(ok=>{if(!ok)throw new Error(e.getStatus().error||'init failed');return e.embed('doctor probe')})` +
    `.then(v=>{console.log(JSON.stringify({ok:true,dims:v.length,ms:Date.now()-t}))})` +
    `.catch(err=>{console.log(JSON.stringify({ok:false,error:err.message}));process.exitCode=2})`;
  fs.mkdirSync(ce.reportDir(data), { recursive: true });
  return [...ce.reportFlags(data), '-e', code];
}

function probeEnv(env = process.env) { return { ...env, [GUARD_OFF_ENV]: 'off' }; }

/** Turn a finished test process into {ok, dims, ms} or {ok:false, status, error, lastLine, reportDir}. */
function interpret({ status, stdout, stderr, error }, data) {
  const reportDir = require('./crash-report-flags.js').reportDir(data);
  const lines = `${stdout || ''}\n${stderr || ''}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result = lines.map(l => { try { return JSON.parse(l); } catch (err) { void err; return null; } }).filter(x => x && typeof x.ok === 'boolean').pop();
  const lastLine = lines.filter(l => !l.startsWith('{')).pop() || '';
  if (error) return { ok: false, error: error.code === 'ETIMEDOUT' ? `no answer in ${(error.timeoutMs || PROBE_TIMEOUT_MS) / 1000}s` : error.message, lastLine, reportDir };
  if (result && result.ok && status === 0) return result;
  return { ok: false, status, error: result && result.error, lastLine, reportDir };
}

/** Doctor's load test: blocking, hidden. `run` is injectable for tests. */
function probeSync({ data, execPath = process.execPath, run = null }) {
  const opts = { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: probeEnv() };
  const r = run ? run(execPath, probeArgs(data), opts) : spawnSync(execPath, probeArgs(data), { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: probeEnv() });
  return interpret(r, data);
}

/** Daemon's load test: same process, without blocking the daemon's event loop. */
function probeAsync({ data, execPath = process.execPath, spawnFn = null, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error = null;
    const child = spawnFn
      ? spawnFn(execPath, probeArgs(data), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: probeEnv() })
      : spawn(execPath, probeArgs(data), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: probeEnv() });
    const timer = setTimeout(() => { error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', timeoutMs }); child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { error = error || err; });
    child.on('close', (status) => { clearTimeout(timer); resolve(interpret({ status, stdout, stderr, error }, data)); });
  });
}

/**
 * Record a load test: a pass clears any override, a native abort forces `none`, anything
 * else (JS error, timeout) leaves the file as it was. Returns the record written, or null.
 */
function recordOutcome(data, { model, node }, result, now = new Date()) {
  const key = guardKey({ model, node });
  let rec = null;
  if (result.ok) rec = { key, ok: true, at: now.toISOString() };
  else if (isNativeAbort(result.status)) {
    const what = FAST_FAIL_STATUSES.has(result.status) ? 'a native DLL failed' : 'V8 fatal error';
    rec = {
      key, forced: 'none', status: result.status, at: now.toISOString(),
      reason: `loading the local embedder aborted a test process (exit ${exitHex(result.status)}, ${what})${result.lastLine ? `; last output: ${result.lastLine}` : ''}`,
    };
  }
  if (!rec) return null;
  fs.mkdirSync(data, { recursive: true });
  // Unique temp + retried rename: a FIXED `.tmp` name let two daemons booting at once
  // write the same temp file and publish each other's half.
  require('./atomic-write.js').writeFileAtomic(guardFile(data), JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * The daemon's boot step: test the configured local embedder once per key, before the
 * embed worker loads it. Never throws.
 * @returns {Promise<{skipped?:string, cached?:object, result?:object, record?:object|null}>}
 */
async function ensureGuard({ data, cfg, cacheDir = path.join(data, 'models'), probe = probeAsync }) {
  try {
    cfg = cfg || configured();
    if (cfg.provider !== 'transformers') return { skipped: `provider "${cfg.provider}" loads no local model` };
    // Not downloaded yet: the worker downloads it; the next boot tests the cached model.
    if (!modelPresent(cacheDir)) return { skipped: 'the embedding model is not downloaded yet' };
    const g = readGuard(data);
    if (g && g.key === guardKey({ model: cfg.model })) return { cached: g };
    const result = await probe({ data });
    const record = recordOutcome(data, { model: cfg.model }, result);
    if (record && record.forced) console.error(`[embedder-guard] ${record.reason} — semantic search off, keyword fallback only`);
    else if (!record) console.error(`[embedder-guard] load test inconclusive (${result.error || `exit ${exitHex(result.status)}`}) — not forcing keyword-only; retried next boot`);
    return { result, record };
  } catch (err) {
    console.error(`[embedder-guard] ${err.message}`);
    return { skipped: `guard failed: ${err.message}` };
  }
}

module.exports = {
  GUARD_FILE, GUARD_OFF_ENV, FAST_FAIL_STATUSES, NODE_ABORT_STATUS, PROBE_TIMEOUT_MS,
  isNativeAbort, exitHex, configured, guardKey, guardFile, readGuard, forcedNone, modelPresent,
  interpret, probeSync, probeAsync, recordOutcome, ensureGuard,
};
