/**
 * hooks-config.js — cached loader + PROFILE resolver for config/hooks-config.json.
 *
 * Replaces 6+ duplicated `fs.readFileSync(...hooks-config.json...)` blocks.
 * Exposes typed getters with documented defaults so consumers never see undefined.
 *
 * PROFILES (U1): `hooks-config.json` may carry a top-level `profile` field
 * ("dev" | "standard", default "dev"). A profile is a DEFAULTS overlay, not a
 * lock:
 *   effective = deepMerge(PROFILE_PRESETS[profile], rawFileConfig)
 * so any value explicitly present in the file WINS over the preset (override
 * beats preset). The `dev` preset is intentionally empty — every getter's
 * hardcoded fallback already reproduces today's dev behavior — so only
 * `standard` carries a delta (quieter, non-maintainer-friendly).
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'hooks-config.json');

const DEFAULT_PROFILE = 'dev';

// Per-profile DEFAULTS overlay. Single source of profile deltas; profile-aware
// getters read the resolved config, never the raw file.
const PROFILE_PRESETS = {
  // dev = current behavior; getters' hardcoded defaults already produce it.
  dev: {},
  // standard = open the plugin to non-maintainers: inform once, never nag.
  standard: {
    curationStop:     { maxAttempts: 1 },   // block once then relent (advisory)
    patternDetect:    { enabled: false },   // dev-only capture nudge
    correctionDetect: { enabled: false },   // dev-only capture nudge
    decisionScan:     { enabled: false },   // dev-only capture nudge
    verifyNudge:      { enabled: false },   // dev tool
    selfReview:       { enabled: false },   // dev self-review nudge
  },
};

let _cache = null;          // raw file contents
let _resolvedCache = null;  // profile-resolved contents

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

/**
 * Active profile name — validated against PROFILE_PRESETS, else DEFAULT_PROFILE.
 * @returns {string}
 */
function getProfile() {
  const p = load().profile;
  return (typeof p === 'string' && Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, p))
    ? p : DEFAULT_PROFILE;
}

/**
 * Pure profile resolution: preset defaults with the raw file merged on top
 * (explicit file values win). Exported for tests. The result is deep-cloned so
 * it never aliases the module-level PROFILE_PRESETS or the raw-file cache — a
 * caller may freely mutate it without poisoning shared state.
 * @param {object} raw  raw hooks-config.json contents
 * @returns {object}
 */
function resolveProfileConfig(raw) {
  const safeRaw = isPlainObject(raw) ? raw : {};
  const profile = (typeof safeRaw.profile === 'string'
    && Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, safeRaw.profile))
    ? safeRaw.profile : DEFAULT_PROFILE;
  return structuredClone(deepMerge(PROFILE_PRESETS[profile], safeRaw));
}

/** Cached profile-resolved config. */
function _resolved() {
  if (_resolvedCache) return _resolvedCache;
  _resolvedCache = resolveProfileConfig(load());
  return _resolvedCache;
}

function getCurationStop() {
  const cs = _resolved().curationStop || {};
  return {
    enabled: cs.enabled !== false,
    maxAttempts: Number.isInteger(cs.maxAttempts) && cs.maxAttempts > 0 ? cs.maxAttempts : 3,
  };
}

// Not profile-controlled — read straight from the raw file.
function getCurationGuard() {
  const cfg = load();
  return cfg.curationGuard || {};
}

function getCuration() {
  const cfg = load();
  return cfg.curation || {};
}

function getVerifyNudge() {
  const vn = _resolved().verifyNudge || {};
  return {
    enabled: vn.enabled !== false,
    maxBlocks: Number.isInteger(vn.maxBlocks) && vn.maxBlocks > 0 ? vn.maxBlocks : 1,
    testPatterns: Array.isArray(vn.testPatterns)
      ? vn.testPatterns.filter(s => typeof s === 'string' && s.trim())
      : [],
  };
}

function getPatternDetect() {
  const pd = _resolved().patternDetect || {};
  return { enabled: pd.enabled !== false };
}

function getCorrectionDetect() {
  const cd = _resolved().correctionDetect || {};
  return { enabled: cd.enabled !== false };
}

function getDecisionScan() {
  const ds = _resolved().decisionScan || {};
  return { enabled: ds.enabled !== false };
}

function getSelfReview() {
  const sr = _resolved().selfReview || {};
  return {
    enabled: sr.enabled !== false,
    topK: Number.isInteger(sr.topK) && sr.topK > 0 ? sr.topK : 2,
    minScore: typeof sr.minScore === 'number' ? sr.minScore : 0.2,
    types: Array.isArray(sr.types) && sr.types.length
      ? sr.types.filter(s => typeof s === 'string' && s.trim())
      : ['lesson', 'failure'],
  };
}

function getSessionSummary() {
  const ss = _resolved().sessionSummary || {};
  return { enabled: ss.enabled !== false };
}

function _resetCache() { _cache = null; _resolvedCache = null; }

module.exports = {
  load,
  getProfile,
  resolveProfileConfig,
  getCurationStop,
  getCurationGuard,
  getCuration,
  getVerifyNudge,
  getPatternDetect,
  getCorrectionDetect,
  getDecisionScan,
  getSelfReview,
  getSessionSummary,
  PROFILE_PRESETS,
  _resetCache,
};
