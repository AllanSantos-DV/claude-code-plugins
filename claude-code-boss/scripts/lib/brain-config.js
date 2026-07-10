/**
 * brain-config.js — cached loader for config/brain-config.json
 *
 * Avoids re-parsing on every hook invocation; exposes typed getters with sane
 * defaults so consumers never see undefined.
 *
 * The shipped config is merged with an optional per-user override living in
 * DATA_DIR/brain/user-config.json (never committed), mirroring the model-router
 * pattern (shipped ⊕ DATA_DIR/model-router/user-config.json). This lets a single
 * user tweak behavior (e.g. exclude a KB type from injection) without affecting
 * other contributors or surviving-across auto-update concerns.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

let _cache = null;

// Resolved at load() time (not frozen at module load) so tests can repoint
// CLAUDE_PLUGIN_DATA + _resetCache(), and so it tracks the canonical DATA_DIR.
function userConfigPath() {
  const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
  return path.join(DATA_DIR, 'brain', 'user-config.json');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `override` onto `base`: plain objects merge recursively; arrays and
// scalars from the override REPLACE the base value.
function deepMerge(base, override) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(override)) return out;
  for (const k of Object.keys(override)) {
    const ov = override[k];
    out[k] = (isPlainObject(ov) && isPlainObject(out[k])) ? deepMerge(out[k], ov) : ov;
  }
  return out;
}

// Inverse of deepMerge, for persistence: the subtree of `next` that differs from
// `base`, so a caller stores ONLY what changed from the factory defaults. Future
// shipped changes to untouched keys then still reach the user via deepMerge.
function deepDiff(base, next) {
  if (!isPlainObject(base) || !isPlainObject(next)) return next;
  const out = {};
  for (const k of Object.keys(next)) {
    if (isPlainObject(next[k]) && isPlainObject(base[k])) {
      const d = deepDiff(base[k], next[k]);
      if (isPlainObject(d) && Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) {
      out[k] = next[k];
    }
  }
  return out;
}

function load() {
  if (_cache) return _cache;
  let shipped = {};
  try {
    shipped = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[brain-config] load failed (${CONFIG_PATH}): ${err.message}`);
    shipped = {};
  }
  let override = null;
  try {
    const p = userConfigPath();
    if (fs.existsSync(p)) override = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) { void err; /* override ausente/ilegível → ignora, usa só o shipped */ }
  _cache = isPlainObject(override) ? deepMerge(shipped, override) : shipped;
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

/**
 * Types (lesson/pattern/reference/memory) excluded from the [BRAIN] block
 * injected on UserPromptSubmit. Normalized to trimmed lowercase; non-array or
 * missing → [] (default: inject all types). Set via the DATA_DIR user-override.
 * @returns {string[]}
 */
function getContextExcludeTypes() {
  const cfg = load();
  const r = (cfg.kb && cfg.kb.retrieval) || {};
  const raw = r.contextExcludeTypes;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
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

/**
 * Conversation ingestion setting (backend.ingestion). Opt-in: when enabled AND
 * the backend is the external mcp-memory server, the Stop hook ships each turn's
 * conversation to the daemon for server-side curation. Default OFF (privacy).
 * @returns {{enabled:boolean}}
 */
function getIngestion() {
  const cfg = load();
  const i = (cfg.backend && cfg.backend.ingestion) || {};
  return { enabled: i.enabled === true };
}

function _resetCache() { _cache = null; }

module.exports = {
  load,
  deepDiff,
  getRetrievalFast,
  getRetrievalDeep,
  getSubmission,
  getContextExcludeTypes,
  getCuration,
  getIngestion,
  _resetCache,
};
