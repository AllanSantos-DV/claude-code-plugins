'use strict';
/**
 * hook-context.js — per-call environment for hooks that run INSIDE the shared
 * brain daemon (Phase G, ADR-015) instead of in their own `node` process.
 *
 * A spawned hook inherits Claude Code's env (CLAUDE_PROJECT_DIR = the session
 * root). The daemon is spawned once and serves every session, so its
 * process.env carries the FIRST session's CLAUDE_PROJECT_DIR. Reading
 * process.env there would resolve every other session against the wrong
 * session-root ceiling. The hook tool runs each call inside runWithHookEnv()
 * with that call's own values; code that needs the session env reads hookEnv(),
 * which falls back to process.env outside a hook call (CLI / spawned hooks —
 * unchanged behaviour).
 *
 * The per-call env is a read-through VIEW over process.env, not a copy: copying
 * process.env (OS-backed on Windows) on every hook call was ~15% of a fast
 * guard's CPU in the daemon.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function makeView(overrides, dropped) {
  const own = (k) => Object.prototype.hasOwnProperty.call(overrides, k);
  const hidden = (k) => dropped.has(k);
  return new Proxy({}, {
    get: (_, k) => (typeof k !== 'string' ? undefined : own(k) ? overrides[k] : hidden(k) ? undefined : process.env[k]),
    has: (_, k) => own(k) || (!hidden(k) && k in process.env),
    ownKeys: () => [...new Set([...Object.keys(process.env).filter(k => !hidden(k)), ...Object.keys(overrides)])],
    getOwnPropertyDescriptor: (t, k) => {
      const v = own(k) ? overrides[k] : hidden(k) ? undefined : process.env[k];
      return v === undefined ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
    },
  });
}

/**
 * @param {{ CLAUDE_PROJECT_DIR?: string, CCB_PROJECT_ID?: string }} overrides  values for
 *   THIS call; an empty/missing one is REMOVED (never inherited from the daemon).
 * @param {() => any} fn
 */
function runWithHookEnv(overrides, fn) {
  const o = { ...(overrides || {}) };
  const dropped = new Set();
  for (const k of ['CLAUDE_PROJECT_DIR', 'CCB_PROJECT_ID']) {
    if (!o[k]) { delete o[k]; dropped.add(k); }
  }
  return als.run({ overrides: o, dropped, view: null }, fn);
}

function hookEnv() {
  const s = als.getStore();
  if (!s) return process.env;
  if (!s.view) s.view = makeView(s.overrides, s.dropped);
  return s.view;
}

module.exports = { runWithHookEnv, hookEnv };
