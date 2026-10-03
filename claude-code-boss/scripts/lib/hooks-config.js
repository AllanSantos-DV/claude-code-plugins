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
const { isPlainObject, deepMerge, filesStamp, loadLayered } = require('./config-merge.js');

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
    // graph-guard stays in dev+standard (it protects MACHINE resources, not a
    // learning nag) but free's contract is "no blocking, ever" — so off here.
    graphGuard:       { enabled: false },
  },
};

let _cache = null;          // raw (shipped ⊕ user) file contents
let _resolvedCache = null;  // profile-resolved contents


function load() {
  if (_cache) return _cache;
  // Layered (shipped + global user-config, legacy backfilled) — lib/config-merge.
  _cache = loadLayered({ label: 'hooks-config', shippedPath: CONFIG_PATH, userPath: userConfigPath, legacyPath: legacyUserConfigPath }).config;
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

// Profile-resolved (free disables it). Backs the graph-guard: on the mcp-memory
// backend with a READY Session Graph, a BROAD symbol-ish Grep/Glob/Bash-grep is
// denied ONCE with a redirect to graph_search/graph_symbols (cheap, structural,
// no embeddings) so the agent re-runs the text search SCOPED to the paths the
// graph surfaced. Retrying the identical call always passes (deny-once).
function getGraphGuard() {
  const gg = _resolved().graphGuard || {};
  return {
    enabled: gg.enabled !== false,
    // Readiness probes are cached per project root so a fresh hook process
    // (spawned per tool call) never pays a network round-trip on every search.
    cacheTtlMs: Number.isInteger(gg.cacheTtlMs) && gg.cacheTtlMs > 0 ? gg.cacheTtlMs : 5 * 60 * 1000,
    probeTimeoutMs: Number.isInteger(gg.probeTimeoutMs) && gg.probeTimeoutMs > 0 ? gg.probeTimeoutMs : 1200,
    // Proactive warm: at SessionStart, fire an (incremental) graph ingest so the
    // graph is ready-and-fresh before the first search — the server does the
    // delta (SHA-256 per-file manifest → no-op ~5s if nothing changed, rebuild
    // if it did), so the client just triggers it. Cooldown avoids re-hashing the
    // repo on every session open. warm follows enabled (dev/standard on, free
    // off) but can be turned off independently.
    warm: gg.warm !== false,
    warmCooldownMs: Number.isInteger(gg.warmCooldownMs) && gg.warmCooldownMs > 0 ? gg.warmCooldownMs : 4 * 60 * 60 * 1000,
  };
}

// Not profile-controlled — read straight from the raw file (like getCurationGuard).
// Backs the deterministic error-guard (DENY-on-recurring-Bash-failure). Defaults ON.
function getErrorGuard() {
  const eg = load().errorGuard || {};
  return {
    enabled: eg.enabled !== false,
    // Failures counted within the CURRENT session only (lib/session-failures.js) —
    // the old 90-day `windowDays` is gone with the project-wide store.
    threshold: Number.isInteger(eg.threshold) && eg.threshold > 0 ? eg.threshold : 2,
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

/**
 * Cheap identity of every file load() reads (mtime+size; 'none' when absent).
 * The daemon resets the cache only when this changes, instead of re-reading and
 * re-parsing on every hook call — same "an edit is seen on the next call" as a
 * fresh process, for the price of three stat() calls.
 */
function sourceStamp() {
  // The legacy path is left out on purpose: it only matters for the one-time
  // legacy→global backfill, and resolving it calls dataDir() (~1 ms here) — the
  // very cost this stamp exists to avoid.
  return filesStamp(CONFIG_PATH, userConfigPath());
}

module.exports = {
  load,
  getProfile,
  profileNames,
  saveProfile,
  userConfigPath,
  resolveProfileConfig,
  getCurationStop,
  getCurationGuard,
  getGraphGuard,
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
  sourceStamp,
};
