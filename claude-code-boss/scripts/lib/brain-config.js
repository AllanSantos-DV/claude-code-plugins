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
const { isPlainObject, filesStamp, loadLayered } = require('./config-merge.js');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

let _cache = null;
let _cacheVersion = 0;
let _cacheStamp = null;

// On-disk version stamp for the user-override file (globalDir()/user-config.json).
// Stored as `_v` alongside the diffed config fields inside the SAME JSON file (no
// extra file to keep in sync). Absent/non-integer `_v` (legacy file written before
// this existed, or a test writing the override directly with fs) reads as 0, which
// only matters for CAS purposes if a caller compares against a stale baseline of
// 0 too — see save()'s expectedVersion.
function _onDiskVersion(p) {
  try {
    if (!fs.existsSync(p)) return 0;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return isPlainObject(raw) && Number.isInteger(raw._v) ? raw._v : 0;
  } catch (err) {
    console.error(`[brain-config] failed to read version from ${p}: ${err.message}`);
    return 0;
  }
}

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

/** mtime+size of the user override (null when absent): another process saving it changes it. */
function userConfigStamp() {
  try { const st = fs.statSync(userConfigPath()); return `${st.mtimeMs}:${st.size}`; }
  catch (err) { if (err.code !== 'ENOENT') console.error(`[brain-config] stat user config: ${err.message}`); return null; }
}

function load() {
  // Long-lived processes (the brain daemon) must see a save made by ANOTHER process
  // (the dashboard): the cache is valid only while the user override is unchanged.
  const stamp = userConfigStamp();
  if (_cache && stamp === _cacheStamp) return _cache;
  _cacheStamp = stamp;
  // Layered (shipped + global user-config, legacy backfilled); `_v` is the
  // persistence-only version stamp the CAS save checks — stripped, never config.
  const { config, version } = loadLayered({ label: 'brain-config', shippedPath: CONFIG_PATH, userPath: userConfigPath, legacyPath: legacyUserConfigPath, versioned: true });
  _cache = config;
  _cacheVersion = version;
  return _cache;
}

/**
 * Same as load(), plus the on-disk version of the user-override at the moment
 * it was read. Callers that intend to save() back MUST capture this version as
 * their baseline (`save(config, { expectedVersion: version })`) — otherwise a
 * concurrent saver's change is silently lost (see save()'s CAS check below).
 * @returns {{config: object, version: number}}
 */
function loadWithVersion() {
  const config = load();
  return { config, version: _cacheVersion };
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
    // C2b: bound of an EXPLORATION command's output when Token Guard isn't installed
    // (looser than the curation-nag thresholds above — a real git log legitimately exceeds 30 lines).
    shapeMaxLines: Number.isInteger(c.shapeMaxLines) && c.shapeMaxLines > 0 ? c.shapeMaxLines : 80,
    shapeMaxChars: Number.isInteger(c.shapeMaxChars) && c.shapeMaxChars > 0 ? c.shapeMaxChars : 8000,
  };
}

/**
 * Skill promotion thresholds (brain-promote scan + the dashboard panel).
 * Config: kb.skillPromotion, read through load() — shipped ⊕ the user override
 * (both readers used to read only the shipped file, so a user tweak was ignored —
 * BACKLOG Q44).
 * @returns {{enabled:boolean, minRecurrence:number, minConfidence:number, types:string[]}}
 */
function getSkillPromotion() {
  const sp = (load().kb && load().kb.skillPromotion) || {};
  return { enabled: true, minRecurrence: 3, minConfidence: 0.8, types: ['lesson', 'pattern'], ...sp };
}

/**
 * Limits for `capture_lesson` `type:"skill"` (mechanical validation in
 * scripts/lib/skill-capture.js). Config: kb.skillCapture. Same shape as the
 * module's own defaults — this getter exists so an operator can tune the
 * budget without a code change; validateSkillFields() stays pure (limits
 * passed in, never reads config itself).
 * @returns {{descriptionMin:number, descriptionMax:number, useForMax:number, doNotUseForMax:number}}
 */
function getSkillCapture() {
  const cfg = load();
  const s = (cfg.kb && cfg.kb.skillCapture) || {};
  return {
    descriptionMin: Number.isInteger(s.descriptionMin) && s.descriptionMin > 0 ? s.descriptionMin : 40,
    descriptionMax: Number.isInteger(s.descriptionMax) && s.descriptionMax > 0 ? s.descriptionMax : 280,
    useForMax: Number.isInteger(s.useForMax) && s.useForMax > 0 ? s.useForMax : 400,
    doNotUseForMax: Number.isInteger(s.doNotUseForMax) && s.doNotUseForMax > 0 ? s.doNotUseForMax : 400,
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
 *   maxQueryChars    (int,  default 800)  — recall query cap; 0 = send the whole prompt.
 *   projectArmMinScore (num, default 0.65) — floor for the project-arm search_memory hits.
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
    // 2.29.1: the daemon's embed + FTS cost grows with query length (4.7k chars → 14 s
    // in compose; capped at 800 → 1.1 s, same top hit). 0 disables the cap.
    maxQueryChars: Number.isInteger(c.maxQueryChars) && c.maxQueryChars >= 0 ? c.maxQueryChars : 800,
    // 2.29.1: hybrid scores of unrelated prompts sit at ~0.5–0.63, relevant ones at
    // ~0.65–0.77 — below the floor the project arm injects noise, not memory.
    projectArmMinScore: typeof c.projectArmMinScore === 'number' ? c.projectArmMinScore : 0.65,
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
 * cwd resolution (strict ladder, see project-id.js) decides.
 * @returns {string}
 */
function getMcpProjectId() {
  const cfg = load();
  const m = (cfg.backend && cfg.backend.mcpMemory) || {};
  return typeof m.projectId === 'string' ? m.projectId : '';
}

/**
 * Onboarding nudges (config: `onboarding`).
 *   projectIdentity (bool, default true) — SessionStart notice + the project-id-stop
 *     Stop detector when the cwd has no project id (strict ladder: memory is off
 *     there). Set false to silence both (memory stays off in that folder).
 * @returns {{projectIdentity:boolean}}
 */
function getOnboarding() {
  const cfg = load();
  const o = cfg.onboarding || {};
  return { projectIdentity: o.projectIdentity !== false };
}

function _resetCache() { _cache = null; _cacheVersion = 0; _cacheStamp = null; }

/** Cheap identity of every file load() reads — see hooks-config.sourceStamp(). */
function sourceStamp() {
  // The legacy path is left out on purpose: it only matters for the one-time
  // legacy→global backfill, and resolving it calls dataDir() (~1 ms here) — the
  // very cost this stamp exists to avoid.
  return filesStamp(CONFIG_PATH, userConfigPath());
}

// `config` recebido aqui é sempre um snapshot COMPLETO do caller (não um
// delta) — tanto mcp-wizard.js's start() quanto dashboard.js's PUT
// /api/brain/backend-config montam o objeto inteiro antes de chamar save().
// Isso impede qualquer merge honesto contra o override atual em disco: uma
// tentativa anterior fazia `deepMerge(deepMerge(shipped, currentOverride),
// config)` para tentar preservar mudanças concorrentes de outro caller, mas
// como TODO campo do config do caller está presente (inclusive os que ele
// nunca tocou, com valores só desatualizados de quando carregou), o merge
// não consegue distinguir "o caller mudou isto de propósito" de "a visão do
// caller disto está apenas stale" — e acaba sobrescrevendo de volta campos
// que outro caller alterou depois. Provado quebrado por teste + reprodução
// isolada (2026-09-16): o merge perdeu silenciosamente `curation.
// maxOutputChars` de um caller B ao salvar uma mudança não relacionada de um
// caller A.
//
// Fechado de verdade em 2026-09-17 via CAS/versionamento otimista: um `_v`
// inteiro é gravado junto do diff dentro do PRÓPRIO user-config.json (ver
// _onDiskVersion). Um caller que passa `opts.expectedVersion` (capturado via
// loadWithVersion() no momento em que leu o config que está prestes a
// editar) só tem o save aceito se o `_v` em disco AINDA for esse mesmo
// número — se outro caller salvou no meio, o `_v` já avançou e este save é
// REJEITADO (throw, fail-loud) em vez de sobrescrever a mudança alheia às
// cegas. Callers que não passam expectedVersion mantêm o comportamento
// antigo (last-write-wins, sem checagem) — é o caso de testes que escrevem
// o override diretamente. Os dois call-sites de produção (mcp-wizard.js's
// start(), dashboard.js's PUT /api/brain/backend-config) foram atualizados
// pra sempre passar expectedVersion.
function save(config, opts) {
  const expectedVersion = (opts && Number.isInteger(opts.expectedVersion)) ? opts.expectedVersion : undefined;
  const p = userConfigPath();
  try {
    const { writeJsonAtomic } = require('./atomic-write.js');
    const shipped = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const currentVersion = _onDiskVersion(p);
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      const err = new Error(
        `brain-config save rejected: override on disk changed since it was loaded ` +
        `(expected version ${expectedVersion}, found ${currentVersion}) — reload and retry`
      );
      err.code = 'BRAIN_CONFIG_CONFLICT';
      throw err;
    }
    const diff = deepDiff(shipped, config);
    const nextVersion = currentVersion + 1;
    writeJsonAtomic(p, { _v: nextVersion, ...diff });
    _cache = null;
    return nextVersion;
  } catch (err) {
    if (err.code !== 'BRAIN_CONFIG_CONFLICT') console.error(`[brain-config] save failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  load,
  userConfigPath,
  loadWithVersion,
  save,
  deepDiff,
  getRetrievalFast,
  getRetrievalDeep,
  getSubmission,
  getContextExcludeTypes,
  getCuration,
  getSkillCapture,
  getSkillPromotion,
  getIngestion,
  getRecallCompose,
  getBackendType,
  getMcpProjectId,
  getOnboarding,
  _resetCache,
  sourceStamp,
};
