'use strict';
/**
 * memory-server-kick.js — when the memory server's launcher was last started, shared by every process.
 *
 * Hook processes are short-lived and the brain daemon builds a client per caller, so a cooldown kept in
 * memory let each of them start another launcher while the server was still booting: 30 launcher
 * processes (about 90 MB each) piled up behind one server that had not announced itself yet. The marker
 * on disk makes it one launcher start per cooldown for the whole machine.
 */
const fs = require('fs');
const path = require('path');

const COOLDOWN_MS = 120000;

/** @param {string} [dir] plugin data dir (default: the resolved one) */
function markerPath(dir) {
  return path.join(dir || require('./data-dir.js').dataDir(), '.runtime', 'memory-server-kick.json');
}

/** @returns {number} ms timestamp of the last recorded launcher start, 0 when none */
function lastKickAt(dir) {
  try {
    return Number(JSON.parse(fs.readFileSync(markerPath(dir), 'utf8')).at) || 0;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[memory-server-kick] marker unreadable: ${err.message}`);
    return 0;
  }
}

/** True while a launcher started by any process is still inside the cooldown. */
function inCooldown(dir, now = Date.now()) {
  const last = lastKickAt(dir);
  return last > 0 && now - last < COOLDOWN_MS;
}

function recordKick(dir, now = Date.now()) {
  try {
    const file = markerPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now }));
  } catch (err) {
    console.error(`[memory-server-kick] marker not written: ${err.message}`);
  }
}

/** The server answers again: the next failure may start the launcher at once. */
function clearKick(dir) {
  try { fs.unlinkSync(markerPath(dir)); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[memory-server-kick] marker not removed: ${err.message}`);
  }
}

module.exports = { COOLDOWN_MS, markerPath, lastKickAt, inCooldown, recordKick, clearKick };
