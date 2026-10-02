'use strict';
/**
 * session-counter.js — per-session "every N stops" cadence counters.
 *
 * The daemon (Phase G) serves every session from one process and one data dir:
 * a single global counter let one session's Stops fire another session's
 * reminder. State: { sessions: { [sid]: { n, ts } } }, pruned by TTL and size.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;

/** Increment and return the counter of `sid` in the JSON state file `file`. */
function tick(file, sid, now = Date.now()) {
  const key = String(sid || 'default');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) { void err; /* absent/corrupt → fresh */ }
  const sessions = state && typeof state.sessions === 'object' && state.sessions ? state.sessions : {};
  for (const k of Object.keys(sessions)) {
    if (!sessions[k] || now - (sessions[k].ts || 0) > TTL_MS) delete sessions[k];
  }
  const cur = sessions[key] || { n: 0, ts: now };
  cur.n += 1;
  cur.ts = now;
  sessions[key] = cur;
  const keys = Object.keys(sessions);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => sessions[a].ts - sessions[b].ts).slice(0, keys.length - MAX_SESSIONS).forEach((k) => { delete sessions[k]; });
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { sessions });
  } catch (err) {
    console.error(`[session-counter] could not persist ${file}: ${err.message}`);
  }
  return cur.n;
}

module.exports = { tick, TTL_MS, MAX_SESSIONS };
