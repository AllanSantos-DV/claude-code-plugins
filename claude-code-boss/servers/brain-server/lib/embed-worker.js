/**
 * embed-worker.js — runs the embedder (scripts/brain-embedder.js) OFF the daemon's
 * main thread (G12).
 *
 * Measured 2026-10-02: one embed blocked the event loop 18–33 ms on a fast machine
 * (tokenization + pre/post run on the JS thread; ollama even uses execFileSync) —
 * every session's PreToolUse guards waited behind each prompt's recall. The model
 * now lives here; the main thread only exchanges messages. Same single copy of the
 * model as before, so memory is unchanged.
 *
 * Protocol: { id, op: 'init'|'embed'|'embedBatch', arg } → { id, ok, result, status, error }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const embedder = require(path.join(workerData.pluginRoot, 'scripts', 'brain-embedder.js'));

parentPort.on('message', async ({ id, op, arg }) => {
  try {
    let result;
    if (op === 'init') result = await embedder.init();
    else if (op === 'embed') result = await embedder.embed(arg);
    else if (op === 'embedBatch') result = await embedder.embedBatch(arg);
    else throw new Error(`unknown op ${op}`);
    parentPort.postMessage({ id, ok: true, result, status: embedder.getStatus() });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err && err.message, status: embedder.getStatus() });
  }
});
