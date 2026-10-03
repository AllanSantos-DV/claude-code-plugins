/**
 * embed-worker-client.js — main-thread side of embed-worker.js (G12).
 *
 * Returns an object with brain-embedder's API (init/embed/embedBatch/getStatus/
 * getDimensions) that `brain-embedder.setDelegate()` installs in the daemon, so every
 * in-process consumer (brain_search, brain_store, capture_lesson, retrieve-core) is
 * routed to the worker without touching its call site. Failures follow the
 * embedder's own contract: a failed/timed-out embed resolves null (callers fall back
 * to keyword search), with the cause logged. A dead worker is replaced on next call.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// terminate() while the worker is inside the embedder's NATIVE init (onnxruntime loading
// the model) fast-fails the WHOLE process — 0xC0000409, reproduced 1 in 10 shutdowns that
// raced an in-flight init; it was the intermittent unit-suite death and a daemon restart
// could die the same way. shutdown() lets the op in flight finish (bounded) first.
const SHUTDOWN_DRAIN_MS = 30000;

export function createEmbedWorker({ pluginRoot, initTimeoutMs = 120000, callTimeoutMs = 30000, workerPath, shutdownDrainMs = SHUTDOWN_DRAIN_MS } = {}) {
  let worker = null;
  let inWorker = 0;          // messages posted to the CURRENT worker and not yet answered
  let drained = null;        // resolves when inWorker drops to 0 (shutdown waits on it)
  let nextId = 1;
  const pending = new Map();
  let status = { provider: null, model: null, dimensions: null, ready: false, error: null };
  let closed = false;

  function failAll(err) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: err.message }); }
    pending.clear();
  }

  function spawn() {
    const w = new Worker(workerPath || path.join(__dirname, 'embed-worker.js'), { workerData: { pluginRoot } });
    w.on('message', (msg) => {
      if (worker === w && inWorker > 0 && --inWorker === 0 && drained) drained();
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.status) status = msg.status;
      if (pending.size === 0) w.unref();
      p.resolve(msg);
    });
    const onDeath = (err) => {
      if (worker !== w) return;
      worker = null;
      inWorker = 0; if (drained) drained();
      status = { ...status, ready: false, error: err.message };
      failAll(err);
    };
    w.on('error', (err) => { console.error(`[embed-worker] error: ${err.message}`); onDeath(err); });
    w.on('exit', (code) => onDeath(new Error(`embed-worker exited unexpectedly (code ${code})`)));
    w.unref();
    worker = w;
    return w;
  }

  function call(op, arg, timeoutMs) {
    if (closed) return Promise.resolve({ ok: false, error: 'embed-worker shut down' });
    const w = worker || spawn();
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: `embed-worker ${op} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      w.ref();
      inWorker++;
      w.postMessage({ id, op, arg });
    });
  }

  async function run(op, arg, timeoutMs, failValue) {
    const r = await call(op, arg, timeoutMs);
    if (!r.ok) {
      console.error(`[embed-worker] ${op} failed: ${r.error}`);
      return failValue;
    }
    return r.result;
  }

  return {
    init: () => run('init', null, initTimeoutMs, false),
    embed: (text) => run('embed', text, callTimeoutMs, null),
    embedBatch: (texts) => run('embedBatch', texts, callTimeoutMs, null),
    getStatus: () => ({ ...status }),
    getDimensions: () => status.dimensions,
    async shutdown() {
      closed = true;
      failAll(new Error('embed-worker shut down')); // callers are released now; the op itself drains
      const w = worker;
      if (!w) return;
      if (inWorker > 0) {
        const done = new Promise((r) => { drained = r; });
        let timer;
        const capped = await Promise.race([done.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), shutdownDrainMs); })]);
        clearTimeout(timer);
        if (capped) console.error(`[embed-worker] shutdown: op still running after ${shutdownDrainMs}ms — terminating anyway`);
      }
      worker = null;
      await w.terminate();
    },
  };
}
