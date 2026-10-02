/**
 * lib/hook-worker.js — worker_thread that runs the daemon's HEAVY hook lane (G2).
 *
 * The Stop dispatcher and the PostToolUse side-effect hooks do synchronous SQLite
 * (brain-store/metrics-store, busy_timeout 5 s) and journal/transcript I/O. On the
 * daemon's main thread that work froze every session's HTTP — including the fast
 * PreToolUse guards that must answer in milliseconds. Here it only delays other
 * heavy hooks.
 *
 * ONE strict FIFO queue, one job at a time (awaited): the order hooks arrive in is
 * the order they run, so a PostToolUse journal write always lands before the Stop
 * that reads it — the same ordering the spawned hooks had.
 *
 * ESM (servers/brain-server is "type":"module"); hook-tools.js is CommonJS, bridged
 * with createRequire like kb-worker.js.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pluginRoot } = workerData;
const { runHookInline } = require(path.join(pluginRoot, 'scripts', 'lib', 'hook-tools.js'));

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { id, name, args } = queue.shift();
    try {
      const text = await runHookInline(pluginRoot, name, args);
      parentPort.postMessage({ id, ok: true, text });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
  busy = false;
}

parentPort.on('message', (msg) => {
  queue.push(msg);
  pump();
});
