/**
 * lib/kb-worker-client.js — main-thread proxy for kb-worker.js, backed by a POOL of
 * N worker_threads with sticky per-project routing (ADR-014).
 *
 * Created ONCE per daemon process (see http-daemon.js), never per session/call.
 * Exposes clientsFor(project) → {storeClient, metricsClient, indexClient, graphClient}
 * bundles that mirror brain-store.js's, metrics-store.js's, brain-index.js's and
 * brain-graph.js's public method names, so mcp-server.js's getKB() swaps this client
 * in with no method-signature changes at the individual call sites. clientsFor(project)
 * picks ONE worker slot via workerIndexFor(project) — the SAME project always lands on
 * the SAME slot (sticky) — and every method on that bundle talks to that slot, so a
 * call sequence like init({project}) → search(...) → get(...) (the same pattern
 * getKB()/retrieve-core.js already used against the single worker) stays on one
 * worker throughout, preserving each worker's brain-store.js/brain-index.js/
 * brain-graph.js/metrics-store.js singleton (_db/_project) correctness exactly like
 * the single-worker predecessor did. Different projects that land on different slots
 * run on distinct OS threads — real parallelism, not just the appearance of it.
 *
 * Message ordering per slot is still call order (each worker processes its mailbox
 * one message at a time) — the guarantee mcp-server.js's per-worker lock relies on
 * (getKB(project)→ops atomic on that worker) is preserved per-slot exactly as it was
 * process-wide before.
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
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

const INDEX_METHODS = ['init', 'index', 'deindex', 'lookup', 'search', 'clear', 'getStatus'];

const GRAPH_METHODS = [
  'init', 'registerNode', 'unregisterNode', 'addEdge', 'removeEdge',
  'getRelated', 'getCites', 'getCitedBy', 'clear', 'getStatus',
];

// Estimated-safe ceiling pending real RSS measurement per worker (ADR-014 Q1).
const DEFAULT_POOL_SIZE_CAP = 8;

/**
 * Final normalization layer applied to EVERY project string right before hashing,
 * regardless of which resolution path produced it (resolveProject(args) or
 * resolveProjectChain's focusId — see ADR-014 §Decisão item 1 and PLAN-kb-worker-pool.md
 * Fase 0 item 3). This does NOT decide which of those two sources wins for a given
 * KB tool — each call-site in mcp-server.js still uses whichever expression it already
 * used before the pool existed (resolveProject(args) for most tools, focusId || project
 * for brain_retrieve_context specifically) — it only guarantees that two different
 * STRING representations of the same already-resolved logical project (case, incidental
 * whitespace) hash to the same worker.
 */
export function canonicalProject(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

/** Deterministic string hash (djb2). No persisted state — pure function of the string. */
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

export function defaultPoolSize() {
  const envRaw = process.env.CCB_KB_WORKER_POOL_SIZE;
  if (envRaw) {
    const n = parseInt(envRaw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return Math.max(1, Math.min(os.availableParallelism(), DEFAULT_POOL_SIZE_CAP));
}

export function createKbWorkerPool({ pluginRoot, callTimeoutMs = 30000, poolSize } = {}) {
  const size = poolSize || defaultPoolSize();

  /** workerIndexFor: hash(canonicalProject) % N — same project, same slot, always. */
  function workerIndexFor(project) {
    return djb2(canonicalProject(project)) % size;
  }

  const slots = [];
  for (let i = 0; i < size; i++) {
    slots.push(createSlot(i));
  }

  function createSlot(slotIndex) {
    const worker = new Worker(path.join(__dirname, 'kb-worker.js'), { workerData: { pluginRoot } });
    const pending = new Map();
    let nextId = 1;
    let dead = null; // Error once the worker has exited — new calls fail loud instead of hanging.

    function settle(id, fn) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (pending.size === 0) worker.unref();
      fn(p);
    }

    worker.on('message', (msg) => {
      settle(msg.id, (p) => { if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error)); });
    });
    worker.on('error', (err) => {
      dead = err;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      worker.unref();
    });
    worker.on('exit', (code) => {
      if (!dead) dead = new Error(`kb-worker exited unexpectedly (code ${code}, pool slot ${slotIndex})`);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(dead); }
      pending.clear();
      worker.unref();
    });
    worker.unref();

    function call(mod, method, args, project) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      const callId = `${slotIndex}-${id}`;
      const startedAt = Date.now();
      console.error(JSON.stringify({
        tag: 'kb-worker-pool', callId, project: canonicalProject(project), workerIndex: slotIndex, mod, method, startedAt,
      }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, () => reject(new Error(`kb-worker call timed out after ${callTimeoutMs}ms (${mod}.${method}, pool slot ${slotIndex})`)));
        }, callTimeoutMs);
        timer.unref();
        pending.set(id, {
          resolve: (result) => {
            console.error(JSON.stringify({ tag: 'kb-worker-pool', callId, finishedAt: Date.now() }));
            resolve(result);
          },
          reject: (err) => {
            console.error(JSON.stringify({ tag: 'kb-worker-pool', callId, finishedAt: Date.now() }));
            reject(err);
          },
          timer,
        });
        worker.ref();
        worker.postMessage({ id, mod, method, args });
      });
    }

    async function shutdown() {
      dead = dead || new Error('kb-worker shutting down');
      for (const [, p] of pending) p.reject(dead);
      pending.clear();
      await worker.terminate();
    }

    return { call, shutdown };
  }

  // Callers (mcp-server.js's getKB(project), and the brain_retrieve_context /
  // metrics call-sites) resolve `project` ONCE, pick a slot via workerIndexFor(project),
  // and use THAT slot's client bundle for the whole sequence of calls that follows
  // (init(...) then get/search/save/... on the SAME worker) — mirroring exactly how
  // the single-worker predecessor let init({project}) switch the worker's singleton
  // _db/_project and relied on withLock to keep that sequence atomic. A pool client
  // bundle has no mutable "current project" state of its own — the caller's choice
  // of slot IS that state, which is what makes concurrent different-project sequences
  // (different slots) safe to run in parallel instead of serializing through one lock.
  function makeClient(mod, methods, slot, project) {
    const client = {};
    for (const method of methods) {
      client[method] = (...args) => slot.call(mod, method, args, project);
    }
    return client;
  }

  /**
   * Client bundle for a project's sticky worker. `project` is threaded through purely
   * for the routing log (ADR-014's {callId, project, workerIndex, ...} pair) — the
   * actual routing decision was already made by workerIndexFor(project) below.
   */
  function clientsFor(project) {
    const slot = slots[workerIndexFor(project)];
    return {
      storeClient: makeClient('store', STORE_METHODS, slot, project),
      metricsClient: makeClient('metrics', METRICS_METHODS, slot, project),
      indexClient: makeClient('index', INDEX_METHODS, slot, project),
      graphClient: makeClient('graph', GRAPH_METHODS, slot, project),
    };
  }

  async function shutdown() {
    await Promise.all(slots.map((s) => s.shutdown()));
  }

  return {
    workerIndexFor,
    clientsFor,
    poolSize: size,
    shutdown,
  };
}
