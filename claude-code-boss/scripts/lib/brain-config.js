/**
 * brain-config.js — cached loader for config/brain-config.json
 *
 * Avoids re-parsing on every hook invocation; exposes typed getters with sane
 * defaults so consumers never see undefined.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[brain-config] load failed (${CONFIG_PATH}): ${err.message}`);
    _cache = {};
  }
  return _cache;
}

function getRetrievalFast() {
  const cfg = load();
  const r = (cfg.kb && cfg.kb.retrieval) || {};
  return {
    topK: Number.isInteger(r.fastTopK) && r.fastTopK > 0 ? r.fastTopK : 5,
    minScore: typeof r.minScoreFast === 'number' ? r.minScoreFast : 0.5,
  };
}

function getRetrievalDeep() {
  const cfg = load();
  const r = (cfg.kb && cfg.kb.retrieval) || {};
  return {
    topK: Number.isInteger(r.deepTopK) && r.deepTopK > 0 ? r.deepTopK : 3,
    minScore: typeof r.minScoreDeep === 'number' ? r.minScoreDeep : 0.6,
  };
}

function getSubmission() {
  const cfg = load();
  const s = (cfg.kb && cfg.kb.submission) || {};
  return {
    minBashLines: Number.isInteger(s.minBashLines) && s.minBashLines > 0 ? s.minBashLines : 3,
    minOutputChars: Number.isInteger(s.minOutputChars) && s.minOutputChars > 0 ? s.minOutputChars : 1500,
  };
}

function getCuration() {
  const cfg = load();
  const c = cfg.curation || {};
  return {
    maxOutputChars: Number.isInteger(c.maxOutputChars) && c.maxOutputChars > 0 ? c.maxOutputChars : 1500,
    maxOutputLines: Number.isInteger(c.maxOutputLines) && c.maxOutputLines > 0 ? c.maxOutputLines : 30,
    oneHitMaxRecurrence: Number.isInteger(c.oneHitMaxRecurrence) && c.oneHitMaxRecurrence > 0 ? c.oneHitMaxRecurrence : 3,
    oneHitWindowDays: Number.isInteger(c.oneHitWindowDays) && c.oneHitWindowDays > 0 ? c.oneHitWindowDays : 90,
  };
}

function _resetCache() { _cache = null; }

module.exports = {
  load,
  getRetrievalFast,
  getRetrievalDeep,
  getSubmission,
  getCuration,
  _resetCache,
};
