'use strict';
/**
 * host-env.js — the environment the engine reads for the CURRENT call.
 *
 * Outside a host adapter this is process.env. A host that serves several sessions from one
 * process (the Claude Code adapter: hook-context.js, hooks running inside the shared daemon)
 * plugs in a per-call view with setHostEnv(), so project-id and metrics resolve each call
 * against its own session root instead of the first session's. The engine never requires
 * the adapter: the adapter registers itself here.
 */

let _provider = null;

/** @returns {Record<string,string|undefined>} the current call's env (process.env when no host provider is set) */
function hostEnv() {
  return _provider ? _provider() : process.env;
}

/** @param {(() => object)|null} fn per-call env provider, or null to go back to process.env */
function setHostEnv(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

module.exports = { hostEnv, setHostEnv };
