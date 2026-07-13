/**
 * metrics.js — Plan #5 metrics writer (fire-and-forget).
 *
 * Hooks call `record(eventName, payload, ctx)` to drop a row in the dedicated
 * metrics store (lib/metrics-store.js — its own SQLite file, independent of
 * the KB backend/brain-store). Never throws — instrumentation MUST NOT break
 * a hook.
 */
'use strict';

const path = require('path');
const metricsStore = require('./metrics-store.js');

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
    if (!metricsStore.init({ project })) return 0;
    return metricsStore.recordMetric(eventName, payload, ctx.sessionId || ctx.session_id || null);
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
  metricsStore.close();
}

module.exports = { record, fire, _resetForTests };
