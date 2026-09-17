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
 * so their synchronous SQLite work never touches the main thread. Messages are
 * processed one at a time (a worker has a single event loop too), which keeps
 * kb-worker-client.js's call ordering intact.
 *
 * This file lives under servers/brain-server/ (package.json "type":"module"),
 * so it's loaded as ESM — but brain-store.js/metrics-store.js (under
 * claude-code-boss/scripts/) are CommonJS. createRequire() bridges the two.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pluginRoot } = workerData;

const modules = {
  store: require(path.join(pluginRoot, 'scripts', 'brain-store.js')),
  metrics: require(path.join(pluginRoot, 'scripts', 'lib', 'metrics-store.js')),
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
