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
const os = require('os');

const { sanitizeSessionId } = require('./session-id.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
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

function _save(sessionId, obj) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(_path(sessionId), JSON.stringify(obj));
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
