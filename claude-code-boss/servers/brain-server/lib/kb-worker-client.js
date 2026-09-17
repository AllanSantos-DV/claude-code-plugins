/**
 * lib/kb-worker-client.js — main-thread proxy for kb-worker.js.
 *
 * Created ONCE per daemon process (see http-daemon.js), never per session/call.
 * Exposes storeClient/metricsClient objects that mirror brain-store.js's and
 * metrics-store.js's public method names, so mcp-server.js's getKB() swaps in
 * this client with no other call-site changes. Each method is a message
 * round-trip to kb-worker.js, correlated by an incrementing id — the ordering
 * guarantee mcp-server.js's withLock relies on (getKB(project)→ops atomic) is
 * preserved because messages are sent in call order and the worker processes
 * its mailbox one message at a time.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_METHODS = [
  'init', 'save', 'get', 'getRaw', 'merge', 'prune', 'search', 'searchByKeywords',
  'searchIsolated', 'delete', 'list', 'count', 'close', 'listWithVectors',
  'setRecurrence', 'applyConsolidation', 'getVector', 'deleteVector',
  'getStorageType', 'getStatus', 'cosineSimilarity', 'recordCitation', 'citationMultiplier',
];

const METRICS_METHODS = [
  'init', 'isReady', 'close', 'recordMetric', 'getEventLog', 'getEventLogIsolated',
  'getEvaluationCounts', 'getEvaluationCountsIsolated', 'getMetricsSummary',
  'cleanupMetrics', 'listProjects',
];

export function createKbWorkerClient({ pluginRoot, callTimeoutMs = 30000 }) {
  const worker = new Worker(path.join(__dirname, 'kb-worker.js'), { workerData: { pluginRoot } });
  const pending = new Map();
  let nextId = 1;
  let dead = null; // Error once the worker has exited — new calls fail loud instead of hanging.

  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  worker.on('message', (msg) => {
    settle(msg.id, (p) => { if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error)); });
  });
  worker.on('error', (err) => {
    dead = err;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  });
  worker.on('exit', (code) => {
    if (!dead) dead = new Error(`kb-worker exited unexpectedly (code ${code})`);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(dead); }
    pending.clear();
  });
  worker.unref(); // don't keep the daemon process alive solely for this worker

  // Without this, a framing bug (worker replies with a wrong/missing id, or never
  // replies) leaves the promise in `pending` forever — the caller (withLock) hangs
  // that one HTTP session indefinitely instead of failing loud. Timer is unref'd so
  // it never keeps the process alive on its own, same rationale as worker.unref().
  function call(mod, method, args) {
    if (dead) return Promise.reject(dead);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, () => reject(new Error(`kb-worker call timed out after ${callTimeoutMs}ms (${mod}.${method})`)));
      }, callTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, mod, method, args });
    });
  }

  function makeClient(mod, methods) {
    const client = {};
    for (const method of methods) client[method] = (...args) => call(mod, method, args);
    return client;
  }

  async function shutdown() {
    dead = dead || new Error('kb-worker shutting down');
    for (const [, p] of pending) p.reject(dead);
    pending.clear();
    await worker.terminate();
  }

  return {
    storeClient: makeClient('store', STORE_METHODS),
    metricsClient: makeClient('metrics', METRICS_METHODS),
    shutdown,
  };
}
