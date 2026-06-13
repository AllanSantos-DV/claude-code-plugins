/**
 * metrics.js — Plan #5 metrics writer (fire-and-forget).
 *
 * Hooks call `record(eventName, payload, ctx)` to drop a row in the metrics_event
 * table via brain-store. Never throws — instrumentation MUST NOT break a hook.
 *
 * Init is lazy and cached by project to keep hot-path latency minimal. Async by
 * design so callers can `await` if they want to (but most won't).
 */
'use strict';

const path = require('path');

const _ready = new Map(); // project → Promise<store|null>

function _getStore(project) {
  if (_ready.has(project)) return _ready.get(project);
  const p = (async () => {
    try {
      const store = require('../brain-store.js');
      await store.init({ project, skipEmbedder: true });
      if (store.getStorageType() !== 'sqlite') return null;
      return store;
    } catch (err) {
      console.error(`[metrics] init failed (${project}): ${err.message}`);
      return null;
    }
  })();
  _ready.set(project, p);
  return p;
}

function _resolveProject(ctx) {
  if (ctx && ctx.project) return ctx.project;
  const cwd = (ctx && ctx.cwd) || process.cwd();
  try { return path.basename(cwd); } catch { /* basename failed: default */ return 'default'; }
}

/**
 * Append a metric event. Always returns Promise<number> (inserted id or 0).
 * Errors are swallowed and logged.
 *
 * @param {string} eventName  snake.case event id (e.g. `retrieve.fired`)
 * @param {object} [payload]  arbitrary JSON-serializable object
 * @param {object} [ctx]      { sessionId, project, cwd } — project derived from cwd if omitted
 */
async function record(eventName, payload = {}, ctx = {}) {
  try {
    const project = _resolveProject(ctx);
    const store = await _getStore(project);
    if (!store) return 0;
    return store.recordMetric(eventName, payload, ctx.sessionId || ctx.session_id || null);
  } catch (err) {
    console.error(`[metrics] record(${eventName}) failed: ${err.message}`);
    return 0;
  }
}

/** Synchronous-fire helper for hooks that don't await. Drops the promise. */
function fire(eventName, payload, ctx) {
  record(eventName, payload, ctx).catch(() => { /* swallowed */ });
}

function _resetForTests() {
  _ready.clear();
}

module.exports = { record, fire, _resetForTests };
