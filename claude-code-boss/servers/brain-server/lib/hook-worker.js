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

// Background (fire-and-forget, G4) jobs beyond this many waiting are dropped,
// oldest first, so a stalled worker cannot grow the queue without bound.
const MAX_BACKGROUND = 1000;
const DEGRADED_RE = /degradado no daemon/;

const queue = [];
let busy = false;
let backgroundQueued = 0;
// session_id → names of background hooks that degraded since that session's last
// Stop. Nobody waits on a background hook, so its fail-open message rides on the
// session's next Stop reply instead of vanishing (fail-open stays VISIBLE, ADR-015 P2).
const degradedBySession = new Map();

function noteDegraded(args, name) {
  const sid = (args && args.session_id) || '';
  if (!degradedBySession.has(sid)) degradedBySession.set(sid, new Set());
  degradedBySession.get(sid).add(name);
}

function withBackgroundDegradation(args, text) {
  const sid = (args && args.session_id) || '';
  const names = degradedBySession.get(sid);
  if (!names) return text;
  degradedBySession.delete(sid);
  const note = `[claude-code-boss] hooks em segundo plano degradados no daemon desde o último Stop (fail-open): ${[...names].join(', ')} — detalhes no log do daemon.`;
  let out = {};
  try { out = JSON.parse(text) || {}; } catch (err) { console.error(`[hook-worker] Stop reply is not JSON: ${err.message}`); return text; }
  out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${note}` : note;
  return JSON.stringify(out);
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { id, name, args, background } = queue.shift();
    if (background) backgroundQueued--;
    try {
      let text = await runHookInline(pluginRoot, name, args);
      if (background) {
        if (DEGRADED_RE.test(text)) noteDegraded(args, name);
        continue;
      }
      if (name === 'hook_stop_dispatcher') text = withBackgroundDegradation(args, text);
      parentPort.postMessage({ id, ok: true, text });
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      if (background) { console.error(`[hook-worker] ${name}: ${error}`); noteDegraded(args, name); continue; }
      parentPort.postMessage({ id, ok: false, error });
    }
  }
  busy = false;
}

parentPort.on('message', (msg) => {
  if (msg.background) {
    if (backgroundQueued >= MAX_BACKGROUND) {
      const i = queue.findIndex(j => j.background);
      const dropped = queue.splice(i, 1)[0];
      backgroundQueued--;
      console.error(`[hook-worker] background queue full (${MAX_BACKGROUND}); dropped ${dropped.name}`);
      noteDegraded(dropped.args, dropped.name);
    }
    backgroundQueued++;
  }
  queue.push(msg);
  pump();
});
