'use strict';
/**
 * lib/brain-port.js — the brain daemon's port as its clients must read it: the same rule as the
 * daemon's resolvePort (servers/brain-server/lib/daemon-common.js), so an out-of-range override
 * never sends a client to a port the daemon does not listen on.
 */

const DEFAULT_PORT = 38217;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} BRAIN_HTTP_PORT when it is 1..65535, else 38217
 */
function brainPort(env = process.env) {
  const e = env.BRAIN_HTTP_PORT && Number(env.BRAIN_HTTP_PORT);
  return e && e > 0 && e <= 65535 ? e : DEFAULT_PORT;
}

module.exports = { brainPort, DEFAULT_PORT };
