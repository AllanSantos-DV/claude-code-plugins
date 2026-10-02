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
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/**
 * @param {{ CLAUDE_PROJECT_DIR?: string }} overrides  values for THIS call; an
 *   empty/missing CLAUDE_PROJECT_DIR is REMOVED (never inherited from the daemon).
 * @param {() => any} fn
 */
function runWithHookEnv(overrides, fn) {
  const env = { ...process.env, ...overrides };
  if (!overrides || !overrides.CLAUDE_PROJECT_DIR) delete env.CLAUDE_PROJECT_DIR;
  return als.run({ env }, fn);
}

function hookEnv() {
  const s = als.getStore();
  return s ? s.env : process.env;
}

module.exports = { runWithHookEnv, hookEnv };
