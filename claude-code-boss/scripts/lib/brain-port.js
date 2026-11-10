'use strict';
/**
 * lib/brain-port.js — the brain daemon's port as its clients must read it: from the run file the
 * running daemon writes (`<data dir>/brain-http.lock.json`), read on every call. No client carries
 * a port of its own, so a daemon moved to another port (a port override, a second install) is found
 * where it really listens, and a stopped daemon reads as "no port" instead of a guessed one.
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {string} [data]  the boss data dir (defaults to the canonical resolver's answer)
 * @returns {number|null} the port in the daemon's run file, or null when there is no running daemon to read
 */
function brainPort(data = require('../../engine/lib/data-dir.js').dataDir()) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(data, 'brain-http.lock.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[claude-code-boss] brain daemon run file unreadable in ${data}: ${err.message}`);
    return null;
  }
  const p = Number(lock && lock.port);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

module.exports = { brainPort };
