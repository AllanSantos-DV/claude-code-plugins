/**
 * lib/hook-worker-client.js — the daemon's handle on lib/hook-worker.js (G2).
 *
 * ONE worker per daemon process (not per session), created by http-daemon.js and
 * handed to every session's createBrainServer → createHookTools. Unlike a
 * kb-worker slot, a dead hook worker is replaced on the next call: in-flight calls
 * fail loud (the hook tool turns that into its visible fail-open message) and the
 * following hook gets a fresh worker instead of failing until a daemon restart.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createHookWorker({ pluginRoot, callTimeoutMs = 60000 } = {}) {
  if (!pluginRoot) throw new Error('createHookWorker: pluginRoot is required');
  let worker = null;
  let nextId = 1;
  let spawned = 0;
  let closed = false;
  const pending = new Map();

  function failAll(err) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  }

  function ensure() {
    if (worker) return worker;
    const w = new Worker(path.join(__dirname, 'hook-worker.js'), { workerData: { pluginRoot } });
    spawned++;
    w.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (pending.size === 0) w.unref();
      if (msg.ok) p.resolve(msg.text); else p.reject(new Error(msg.error));
    });
    const onDeath = (err) => {
      if (worker === w) worker = null;
      failAll(err);
    };
    w.on('error', (err) => { console.error(`[hook-worker] error: ${err.message}`); onDeath(err); });
    w.on('exit', (code) => { if (worker === w) onDeath(new Error(`hook-worker exited (code ${code})`)); });
    w.unref();
    worker = w;
    return w;
  }

  /** Run a heavy hook in the worker; resolves the hook's stdout text. */
  function run(name, args) {
    if (closed) return Promise.reject(new Error('hook-worker shut down'));
    const w = ensure();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        if (pending.size === 0) w.unref();
        reject(new Error(`hook-worker call timed out after ${callTimeoutMs}ms (${name})`));
      }, callTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      w.ref();
      w.postMessage({ id, name, args });
    });
  }

  function stats() {
    return { alive: !!worker, spawned, inFlight: pending.size };
  }

  async function shutdown() {
    closed = true;
    failAll(new Error('hook-worker shutting down'));
    const w = worker;
    worker = null;
    if (w) await w.terminate();
  }

  /** Test seam: kill the current worker as a crash would (the client stays open). */
  async function _kill() {
    const w = worker;
    if (w) await w.terminate();
  }

  return { run, stats, shutdown, _kill };
}
