/**
 * hooks-config.js — cached loader + PROFILE resolver for config/hooks-config.json.
 *
 * Replaces 6+ duplicated `fs.readFileSync(...hooks-config.json...)` blocks.
 * Exposes typed getters with documented defaults so consumers never see undefined.
 *
 * PROFILES (U1): `hooks-config.json` may carry a top-level `profile` field
 * ("dev" | "standard" | "free", default "dev"). A profile is a DEFAULTS overlay,
 * not a lock:
 *   effective = deepMerge(PROFILE_PRESETS[profile], rawFileConfig)
 * so any value explicitly present in the file WINS over the preset (override
 * beats preset). The `dev` preset is intentionally empty — every getter's
 * hardcoded fallback already reproduces today's dev behavior — so `standard`
 * (quiet/advisory) and `free` (passthrough) carry the deltas.
 *
 * UPDATE-SAFE SWITCH: the active profile (and any override) is read from
 * `config/hooks-config.json` (shipped) merged with an optional user override
 * (never committed) at a STABLE GLOBAL path — globalDir()/hooks/user-config.json
 * — mirroring brain-config. It lives GLOBALLY (not under the volatile per-folder
 * data dir) so switching the plugin's data folder can never orphan the user's
 * profile choice. A one-time backfill in load() migrates a legacy
 * DATA_DIR/hooks/user-config.json up to the global path. This lets `/boss profile
 * <name>` or the dashboard switch the profile without editing a versioned file —
 * so a plugin auto-update never reverts the user's choice.
 */
const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write.js');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'hooks-config.json');

// Resolved at call time (not frozen at module load) so tests can repoint HOME/
// CLAUDE_PLUGIN_DATA + _resetCache(). GLOBAL (not data-dir-scoped) so switching
// the data folder never orphans the user's profile choice.
function userConfigPath() {
  const { globalDir } = require('./data-dir.js');
  return path.join(globalDir(), 'hooks', 'user-config.json');
}

// Pre-Phase-1.5 location of the override (under the resolved active data dir).
// Retained only so load() can backfill it up to the global path exactly once.
function legacyUserConfigPath() {
  const { dataDir } = require('./data-dir.js');
  return path.join(dataDir(), 'hooks', 'user-config.json');
}

const DEFAULT_PROFILE = 'dev';

// Per-profile DEFAULTS overlay. Single source of profile deltas; profile-aware
// getters read the resolved config, never the raw file.
const PROFILE_PRESETS = {
  // dev = current behavior; getters' hardcoded defaults already produce it.
  dev: {},
  // standard = open the plugin to non-maintainers: inform once, never nag. TWO Stop
  // blocks are kept BY DESIGN: curation-stop (once, soft) and capture-dispatch — the
  // block-until-ack that DRIVES lesson capture best-effort (on Stop the agent is asked to
  // call capture_lesson or capture_ack; the guard re-prompts until it does). This is
  // best-effort, NOT a hard guarantee: the host can still end the turn on user interrupt,
  // API failure, or after its Stop-continuation cap. Every OTHER block-capable detector is
  // silenced. A silent trigger alone (correction-detect) does NOT drive a write — the Stop
  // block does (best-effort). session-summary stays (1x/session, positive). capture opt-out
  // lives in kb.capture.
  standard: {
    curationStop:     { maxAttempts: 1 },   // block once then relent (advisory)
    patternDetect:    { enabled: false },   // dev-only capture nudge (Stop-block)
    decisionScan:     { enabled: false },   // stays off until F1b (decision-promote would block); re-enabled with deferred surface
    verifyNudge:      { enabled: false },   // dev tool
    selfReview:       { enabled: false },   // dev self-review nudge
    refineResearch:   { enabled: false },   // every-4th-Stop nag → off
    failureRetro:     { enabled: false },   // retro prompt on repeated failures → off
    researchFollowup: { enabled: false },   // research-capture nag → off
    autoContinue:     { enabled: false },   // forces continuation → drift → off
    // correction-detect INTENTIONALLY absent → stays ON: it's a SILENT
    // UserPromptSubmit context injection (invisible to the user) and the #1
    // learning trigger. `standard` must stay quiet WITHOUT killing auto-learning.
  },
  // free = passthrough: the Stop dispatcher short-circuits entirely (retrieval on
  // UserPromptSubmit stays — pure value, no block). These flags mirror "all off"
  // as defense-in-depth if the short-circuit is ever bypassed.
  free: {
    curationStop:     { enabled: false },
    patternDetect:    { enabled: false },
    correctionDetect: { enabled: false },
    decisionScan:     { enabled: false },
    verifyNudge:      { enabled: false },
    selfReview:       { enabled: false },
    refineResearch:   { enabled: false },
    failureRetro:     { enabled: false },
    researchFollowup: { enabled: false },
    sessionSummary:   { enabled: false },
    autoContinue:     { enabled: false },
  },
};

let _cache = null;          // raw (shipped ⊕ user) file contents
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
  let shipped = {};
  try {
    shipped = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[hooks-config] load failed (${CONFIG_PATH}): ${err.message}`);
    shipped = {};
  }
  // One-time backfill: if the global override doesn't exist yet but a legacy
  // per-data-dir one does, copy it up so the user's profile choice survives the
  // Phase-1.5 move to the global path. Guarded by !exists so an existing global
  // is never overwritten; only the resolved active data dir is consulted (no
  // sibling scan). Fail-open — a failed backfill just means load() uses shipped.
  try {
    const globalPath = userConfigPath();
    if (!fs.existsSync(globalPath)) {
      const legacyPath = legacyUserConfigPath();
      if (fs.existsSync(legacyPath)) {
        writeFileAtomic(globalPath, fs.readFileSync(legacyPath));
      }
    }
  } catch (err) {
    console.error(`[hooks-config] user-config backfill skipped: ${err.message}`);
  }
  let override = null;
  try {
    const p = userConfigPath();
    if (fs.existsSync(p)) override = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) { void err; /* override ausente/ilegível → ignora, usa só o shipped */ }
  _cache = isPlainObject(override) ? deepMerge(shipped, override) : shipped;
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

// Not profile-controlled — read straight from the raw file (like getCurationGuard).
// Backs the deterministic error-guard (DENY-on-recurring-Bash-failure). Defaults ON.
function getErrorGuard() {
  const eg = load().errorGuard || {};
  return {
    enabled: eg.enabled !== false,
    threshold: Number.isInteger(eg.threshold) && eg.threshold > 0 ? eg.threshold : 2,
    windowDays: Number.isInteger(eg.windowDays) && eg.windowDays > 0 ? eg.windowDays : 90,
  };
}

// Not profile-controlled — read straight from the raw file (like getErrorGuard).
// Backs the deterministic always-apply POLICY injection (SessionStart +
// SubagentStart). Defaults ON; budgets bound how much standing-policy text may be
// injected per session/subagent start.
function getPolicyInject() {
  const pi = load().policyInject || {};
  return {
    enabled: pi.enabled !== false,
    maxPolicies: Number.isInteger(pi.maxPolicies) && pi.maxPolicies > 0 ? pi.maxPolicies : 10,
    maxChars: Number.isInteger(pi.maxChars) && pi.maxChars > 0 ? pi.maxChars : 4000,
  };
}

// Not profile-controlled — read straight from the raw file (like getPolicyInject).
// Backs the OPT-IN, prospective trigger-evidence capture (Fase 3 micro-B1). When
// enabled, the shadow hook stores a bounded, REDACTED, TTL-limited record of the
// ADDED text that triggered a shadow policy so the judge can adjudicate the actual
// TRIGGER proposals. DEFAULT OFF for privacy: `enabled` is true ONLY when the file
// explicitly sets it to true (an absent/invalid value stays off — the opt-in gate).
function getCaptureTriggerEvidence() {
  const ct = load().captureTriggerEvidence || {};
  return {
    enabled: ct.enabled === true,
    ttlDays: Number.isInteger(ct.ttlDays) && ct.ttlDays > 0 ? ct.ttlDays : 7,
    maxPerProject: Number.isInteger(ct.maxPerProject) && ct.maxPerProject > 0 ? ct.maxPerProject : 500,
    maxSnippetChars: Number.isInteger(ct.maxSnippetChars) && ct.maxSnippetChars > 0 ? ct.maxSnippetChars : 2000,
  };
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

function getRefineResearch() {
  const rr = _resolved().refineResearch || {};
  return { enabled: rr.enabled !== false };
}

function getResearchFollowup() {
  const rf = _resolved().researchFollowup || {};
  return { enabled: rf.enabled !== false };
}

function getFailureRetro() {
  const fr = _resolved().failureRetro || {};
  return {
    enabled: fr.enabled !== false,
    minFailures: Number.isFinite(fr.minFailures) ? fr.minFailures : 2,
    timeWindowMin: Number.isFinite(fr.timeWindowMin) ? fr.timeWindowMin : 10,
    consecutiveThreshold: Number.isFinite(fr.consecutiveThreshold) ? fr.consecutiveThreshold : 3,
  };
}

function getAutoContinue() {
  const ac = _resolved().autoContinue || {};
  return {
    enabled: ac.enabled !== false,
    maxBlocks: Number.isInteger(ac.maxBlocks) && ac.maxBlocks > 0 ? ac.maxBlocks : 1,
  };
}

function getSessionSummary() {
  const ss = _resolved().sessionSummary || {};
  return { enabled: ss.enabled !== false };
}

/** Valid profile names (the presets we ship). */
function profileNames() {
  return Object.keys(PROFILE_PRESETS);
}

/**
 * Persist the active profile to globalDir()/hooks/user-config.json (update-safe,
 * never committed, stable across data-folder switches). Merges with any existing
 * user-config so unrelated overrides survive. Returns the path written. Throws on
 * invalid name or write failure.
 * @param {string} name  one of PROFILE_PRESETS
 * @returns {string} the user-config path written
 */
function saveProfile(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, name)) {
    throw new Error(`invalid profile '${name}'. Valid: ${profileNames().join(', ')}`);
  }
  const p = userConfigPath();
  let current = {};
  try {
    if (fs.existsSync(p)) current = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch (err) { void err; /* corrupt/absent → start fresh */ }
  if (!isPlainObject(current)) current = {};
  current.profile = name;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, `${JSON.stringify(current, null, 2)}\n`);
  _resetCache();
  return p;
}

function _resetCache() { _cache = null; _resolvedCache = null; }

module.exports = {
  load,
  getProfile,
  profileNames,
  saveProfile,
  userConfigPath,
  resolveProfileConfig,
  getCurationStop,
  getCurationGuard,
  getErrorGuard,
  getPolicyInject,
  getCaptureTriggerEvidence,
  getCuration,
  getVerifyNudge,
  getPatternDetect,
  getCorrectionDetect,
  getDecisionScan,
  getSelfReview,
  getRefineResearch,
  getResearchFollowup,
  getFailureRetro,
  getAutoContinue,
  getSessionSummary,
  PROFILE_PRESETS,
  _resetCache,
};
