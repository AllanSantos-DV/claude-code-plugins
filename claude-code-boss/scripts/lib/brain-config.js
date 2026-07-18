/**
 * brain-config.js — cached loader for config/brain-config.json
 *
 * Avoids re-parsing on every hook invocation; exposes typed getters with sane
 * defaults so consumers never see undefined.
 *
 * The shipped config is merged with an optional per-user override (never
 * committed). That override lives at a STABLE GLOBAL path — globalDir()/
 * user-config.json — rather than under the per-folder data dir, so the backend
 * choice (local vs mcp-memory) is visible to EVERY writer regardless of which
 * data dir it resolved. Otherwise a writer that resolved a different folder than
 * where the dashboard saved the override would never see `mcp-memory` and would
 * silently fall back to `local` (the split-brain KB bug). A one-time backfill in
 * load() migrates a legacy DATA_DIR/brain/user-config.json up to the global path,
 * so an existing user's backend choice is preserved across the move.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

let _cache = null;

// Resolved at load() time (not frozen at module load) so tests can repoint HOME/
// CLAUDE_PLUGIN_DATA + _resetCache(). GLOBAL (not data-dir-scoped) so every writer
// sees the same backend choice no matter which folder it resolved.
function userConfigPath() {
  const { globalDir } = require('./data-dir.js');
  return path.join(globalDir(), 'user-config.json');
}

// Pre-Phase-1 location of the override (under the resolved active data dir).
// Retained only so load() can backfill it up to the global path exactly once.
function legacyUserConfigPath() {
  const { dataDir } = require('./data-dir.js');
  return path.join(dataDir(), 'brain', 'user-config.json');
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
  // One-time backfill: if the global override doesn't exist yet but a legacy
  // per-data-dir one does, copy it up so the user's backend choice survives the
  // Phase-1 move to the global path. Guarded by !exists so an existing global is
  // never overwritten; only the resolved active data dir is consulted (no sibling
  // scan). Fail-open — a failed backfill just means load() uses shipped defaults.
  try {
    const globalPath = userConfigPath();
    if (!fs.existsSync(globalPath)) {
      const legacyPath = legacyUserConfigPath();
      if (fs.existsSync(legacyPath)) {
        const { writeFileAtomic } = require('./atomic-write.js');
        writeFileAtomic(globalPath, fs.readFileSync(legacyPath));
      }
    }
  } catch (err) {
    console.error(`[brain-config] user-config backfill skipped: ${err.message}`);
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
 * missing → [] (default: inject all types). Set via the global user-override.
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

/**
 * compose_recall knobs (mcp-memory recall path). Config: kb.retrieval.compose.
 *   includeHomeSpine (bool, default true) — inject the never-filtered global spine.
 *   maxInjectChars   (int,  default 6000) — hard cap on total injected fact text.
 *   timeoutMs        (int,  default 8000) — abort a slow compose → degraded (empty).
 *   overlay          (obj  | null)        — generic metadata overlay for active blocks.
 */
function getRecallCompose() {
  const cfg = load();
  const c = (cfg.kb && cfg.kb.retrieval && cfg.kb.retrieval.compose) || {};
  const overlay = (c.overlay && typeof c.overlay === 'object' && !Array.isArray(c.overlay)) ? c.overlay : null;
  return {
    includeHomeSpine: c.includeHomeSpine !== false,
    maxInjectChars: Number.isInteger(c.maxInjectChars) && c.maxInjectChars > 0 ? c.maxInjectChars : 6000,
    timeoutMs: Number.isInteger(c.timeoutMs) && c.timeoutMs > 0 ? c.timeoutMs : 8000,
    overlay,
    // Pool-warming (ADR-017): fire a home-federated search alongside compose so
    // ingested HOME docs accumulate recall signal and graduate (async Dreaming).
    // Non-injected; default ON. Set false to disable the extra background search.
    poolWarming: c.poolWarming !== false,
  };
}

/**
 * Configured backend type WITHOUT connecting. `local` (SQLite, keys by basename
 * BY DESIGN) or `mcp-memory` (shared daemon, scopes by the handshake projectId).
 * @returns {'local'|'mcp-memory'|string}
 */
function getBackendType() {
  const cfg = load();
  return (cfg.backend && cfg.backend.type) || 'local';
}

/**
 * The mcp-memory handshake projectId pinned in config (`backend.mcpMemory.projectId`).
 * When non-empty it WINS over the cwd-resolved id (`brain-backend`: `mcpCfg.projectId
 * || _project`), so recall is stable regardless of marker/env/basename. Empty → the
 * cwd resolution (env → marker → basename) decides. Used by the onboarding advisory
 * so its "is identity stable?" test is a true superset of the handshake's sources.
 * @returns {string}
 */
function getMcpProjectId() {
  const cfg = load();
  const m = (cfg.backend && cfg.backend.mcpMemory) || {};
  return typeof m.projectId === 'string' ? m.projectId : '';
}

/**
 * Onboarding nudges (config: `onboarding`).
 *   projectIdentity (bool, default true) — SessionStart advisory when a
 *     mcp-memory session has no stable project identity (no `.claude-boss-project`
 *     marker and no `CCB_PROJECT_ID`), so recall is silently riding the fragile
 *     `basename(cwd)` fallback. Set false to opt out (keep basename silently).
 * @returns {{projectIdentity:boolean}}
 */
function getOnboarding() {
  const cfg = load();
  const o = cfg.onboarding || {};
  return { projectIdentity: o.projectIdentity !== false };
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
  getRecallCompose,
  getBackendType,
  getMcpProjectId,
  getOnboarding,
  _resetCache,
};
