/**
 * lib/kb-worker.js — worker_thread entry point that owns the SQLite-backed KB.
 *
 * Root cause this exists to fix: node:sqlite/better-sqlite3 (see
 * scripts/lib/sqlite-compat.js) are FULLY SYNCHRONOUS — .run()/.get()/.all()
 * block the calling thread until they return. Before this file existed, those
 * calls ran directly on the daemon's main thread, which is the SAME thread
 * http-daemon.js uses to serve every session's HTTP traffic (including the
 * zero-I/O GET /health). Under concurrent multi-project load, one project's
 * slow brain_store/brain_search call froze /health for every OTHER session —
 * structurally impossible before ADR-001 (each session had its own process),
 * possible ever since (one shared process, one shared thread).
 *
 * This worker requires brain-store.js and metrics-store.js in ITS OWN thread,
 * so their synchronous SQLite work never touches the main thread. The handler is
 * async, so calls DO interleave at their `await`s — messages are NOT processed
 * strictly one at a time. Correctness does not rely on that: every caller sequence
 * that switches this worker's singleton project (init({project}) → ops) runs under
 * the per-slot kbLock in mcp-server.js (dispatchKbTool), and the one unlocked
 * caller (policy_shadow_report → metrics getEvaluationCountsIsolated) opens its own
 * read-only connection in a single synchronous call. A new unlocked caller that
 * touches the singleton would race — route it through dispatchKbTool.
 *
 * brain-index.js/brain-graph.js live here too: same failure mode, different
 * I/O (synchronous fs.readFileSync/writeFileAtomic instead of better-sqlite3),
 * same process-wide singleton state (_index/_graph) that must not be mutated
 * from two threads at once.
 *
 * This file lives under servers/brain-server/ (package.json "type":"module"),
 * so it's loaded as ESM — but brain-store.js/metrics-store.js/brain-index.js/
 * brain-graph.js (under claude-code-boss/scripts/) are CommonJS. createRequire()
 * bridges the two.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pluginRoot } = workerData;

const modules = {
  store: require(path.join(pluginRoot, 'scripts', 'brain-store.js')),
  metrics: require(path.join(pluginRoot, 'scripts', 'lib', 'metrics-store.js')),
  index: require(path.join(pluginRoot, 'scripts', 'brain-index.js')),
  graph: require(path.join(pluginRoot, 'scripts', 'brain-graph.js')),
};

parentPort.on('message', async (msg) => {
  const { id, mod, method, args } = msg;
  const target = modules[mod];
  if (!target || typeof target[method] !== 'function') {
    parentPort.postMessage({ id, ok: false, error: `kb-worker: unknown ${mod}.${method}` });
    return;
  }
  try {
    const result = await target[method](...args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
