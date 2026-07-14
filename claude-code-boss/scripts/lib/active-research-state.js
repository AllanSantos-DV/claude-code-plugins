/**
 * active-research-state.js — per-session counters + per-query cooldown map.
 *
 * State file: `${CLAUDE_PLUGIN_DATA}/.runtime/active-research-state.json`
 *
 * Shape:
 *   {
 *     sessions: { [sid]: { count: number, lastTs: number } },
 *     cooldown: { [normalizedQuery]: number }   // ts of last fire
 *   }
 *
 * Best-effort: parse failures degrade to fresh state instead of throwing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DATA_DIR = dataDir();
const STATE = path.join(DATA_DIR, '.runtime', 'active-research-state.json');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_SWEEP_MS = 24 * 60 * 60 * 1000;

function _read() {
  try {
    const raw = fs.readFileSync(STATE, 'utf-8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') throw new Error('not object');
    o.sessions = o.sessions && typeof o.sessions === 'object' ? o.sessions : {};
    o.cooldown = o.cooldown && typeof o.cooldown === 'object' ? o.cooldown : {};
    return o;
  } catch { /* absent/corrupt: empty state */ return { sessions: {}, cooldown: {} }; }
}

// Best-effort, last-writer-wins (tear-free publish, no cross-process lock).
function _write(s) {
  try {
    writeJsonAtomic(STATE, s);
  } catch (err) {
    console.error(`[active-research-state] write failed: ${err.message}`);
  }
}

function _sweep(s, now) {
  for (const sid of Object.keys(s.sessions)) {
    if (now - (s.sessions[sid].lastTs || 0) > SESSION_TTL_MS) delete s.sessions[sid];
  }
  for (const q of Object.keys(s.cooldown)) {
    if (now - (s.cooldown[q] || 0) > COOLDOWN_SWEEP_MS) delete s.cooldown[q];
  }
}

function getSessionCount(sid) {
  const s = _read();
  return (s.sessions[sid] && s.sessions[sid].count) || 0;
}

function isCoolingDown(query, cooldownMs, now = Date.now()) {
  const s = _read();
  const last = s.cooldown[query];
  return typeof last === 'number' && (now - last) < cooldownMs;
}

function recordFire(sid, query, now = Date.now()) {
  const s = _read();
  _sweep(s, now);
  s.sessions[sid] = s.sessions[sid] || { count: 0, lastTs: 0 };
  s.sessions[sid].count += 1;
  s.sessions[sid].lastTs = now;
  s.cooldown[query] = now;
  _write(s);
}

function resetForTests() {
  try { if (fs.existsSync(STATE)) fs.unlinkSync(STATE); } catch { /* best effort */ }
}

module.exports = {
  getSessionCount,
  isCoolingDown,
  recordFire,
  resetForTests,
  STATE_PATH: STATE,
  SESSION_TTL_MS,
};
