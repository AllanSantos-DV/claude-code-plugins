/**
 * cooldown-store.js — per-session set of "already-acted-on" keys with TTL.
 *
 * Used by failure-retro.js to avoid nudging the agent twice for the same
 * failure signature in a single session. File-backed JSON, trivially small.
 *
 * Schema: { keys: { [key]: ts } }
 * TTL: 24h sliding window. cleanup() called on every load.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { sanitizeSessionId } = require('./session-id.js');
const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DATA_DIR = dataDir();
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
const TTL_MS = 24 * 60 * 60 * 1000;

function _path(sessionId) {
  return path.join(RUNTIME_DIR, `cooldown-${sanitizeSessionId(sessionId)}.json`);
}

function _load(sessionId) {
  try {
    const p = _path(sessionId);
    if (!fs.existsSync(p)) return { keys: {} };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!obj || typeof obj !== 'object' || typeof obj.keys !== 'object') return { keys: {} };
    const now = Date.now();
    for (const k of Object.keys(obj.keys)) {
      if (typeof obj.keys[k] !== 'number' || (now - obj.keys[k]) > TTL_MS) delete obj.keys[k];
    }
    return obj;
  } catch { /* absent/corrupt: empty */ return { keys: {} }; }
}

// Best-effort, last-writer-wins (tear-free publish, no cross-process lock).
function _save(sessionId, obj) {
  try {
    writeJsonAtomic(_path(sessionId), obj);
  } catch (err) {
    console.error(`[cooldown-store] save failed: ${err.message}`);
  }
}

function has(sessionId, key) {
  const obj = _load(sessionId);
  return Object.prototype.hasOwnProperty.call(obj.keys, key);
}

function add(sessionId, key) {
  const obj = _load(sessionId);
  obj.keys[key] = Date.now();
  _save(sessionId, obj);
}

function clear(sessionId) {
  try {
    const p = _path(sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best effort */ }
}

module.exports = { has, add, clear, TTL_MS };
