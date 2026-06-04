/**
 * hooks-config.js — cached loader for config/hooks-config.json.
 *
 * Replaces 6+ duplicated `fs.readFileSync(...hooks-config.json...)` blocks.
 * Exposes typed getters with documented defaults so consumers never see undefined.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'hooks-config.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[hooks-config] load failed (${CONFIG_PATH}): ${err.message}`);
    _cache = {};
  }
  return _cache;
}

function getCurationStop() {
  const cfg = load();
  const cs = cfg.curationStop || {};
  return {
    enabled: cs.enabled !== false,
    maxAttempts: Number.isInteger(cs.maxAttempts) && cs.maxAttempts > 0 ? cs.maxAttempts : 3,
  };
}

function getCurationGuard() {
  const cfg = load();
  return cfg.curationGuard || {};
}

function getCuration() {
  const cfg = load();
  return cfg.curation || {};
}

function _resetCache() { _cache = null; }

module.exports = {
  load,
  getCurationStop,
  getCurationGuard,
  getCuration,
  _resetCache,
};
