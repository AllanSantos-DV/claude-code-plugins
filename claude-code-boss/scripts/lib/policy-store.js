'use strict';
/**
 * policy-store.js — registry of USER-ACTIVATED standing policies ("always-apply"
 * constraints). Backs the deterministic policy injection (Phase 2 micro-2):
 *
 *   - policy_activate (MCP tool, EXPLICIT user action) UPSERTS a record here;
 *   - policy-inject.js (SessionStart + SubagentStart) LISTS the active records
 *     for the current project and injects them as `additionalContext`, so a
 *     standing constraint (e.g. "never let pre-existing code errors pass") is
 *     surfaced every session/subagent start — deterministically, NOT via a
 *     semantic-recall gamble that can miss;
 *   - policy_deactivate REMOVES a record so an invalidated policy stops being
 *     injected immediately.
 *
 * Deterministic + explicit: a policy only exists here because the user asked for
 * it (never auto-promoted from captured lessons — that would silently govern
 * every project). "Surfacing ≠ compliance": this store guarantees the policy is
 * PRESENT in context; enforcement is a later micro.
 *
 * Storage: ONE JSON file `<dataDir>/policies/registry.json` shaped
 * `{ records: { <id>: {...} } }` — dynamic runtime state, NOT versioned. Mirrors
 * error-store.js (atomic writes via atomic-write.js, capped text, best-effort
 * load with console.error — never an empty catch). Policy text is REDACTED
 * (lib/redact.js) before storage so a secret pasted into a policy never lands in
 * the registry NOR the injected context.
 *
 * Record shape:
 *   { id, entryId, mode:'always'|'glob', scope:'user'|'project', projectId,
 *     text, globs?, sourceHash, activatedAt }
 *   - id         stable key (entryId if given, else hash(text+scope+projectId),
 *                or hash(text+'glob'+projectId+globs) for a glob policy);
 *   - mode       'always' → injected every session/subagent start (micro-2);
 *                'glob'   → project-scoped, surfaced ONLY as a post-edit advisory
 *                           when an edited path matches `globs` (micro-3);
 *   - globs      canonical (sorted+deduped) glob patterns, glob-mode only;
 *   - text       REDACTED + capped (MAX_POLICY_CHARS);
 *   - sourceHash sha256 of the RAW approved text (+ mode/globs for glob policies),
 *                so a later KB edit (different hash) can require re-approval.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact.js');
const { writeJsonAtomic } = require('./atomic-write.js');
const { anyGlobMatches } = require('./glob-match.js');

const MAX_POLICY_CHARS = 2000;   // per-policy stored/injected text cap
const DEFAULT_MAX_POLICIES = 10; // budget: max active policies per injected set
const DEFAULT_MAX_CHARS = 4000;  // budget: max total text chars per injected set

// ── Glob-scoped policies (Phase 2 micro-3) ──────────────────────────────────
// A glob policy is surfaced ONLY as a PostToolUse advisory when an edited file's
// project-relative path matches one of its globs (never at session start). These
// bounds live in the store (not config) to keep the tuning surface small.
const MAX_GLOBS_PER_POLICY = 20;         // max glob patterns a single policy may carry
const MAX_GLOB_LEN = 200;                // max chars per glob pattern
const MAX_GLOB_POLICIES_PER_PROJECT = 50; // max active glob policies per project

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

// The id is only a JSON object key (the registry is a single fixed file, so no
// user string reaches a path). Still normalize a caller-supplied entryId to a
// clean, stable key so re-activating the same policy upserts rather than forks.
function sanitizeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// Single fixed file — the path carries no user-controlled segment.
function storePath(dataDir) {
  return path.join(dataDir, 'policies', 'registry.json');
}

/**
 * Best-effort load that DISTINGUISHES a corrupt registry from an empty one, so a
 * caller can WARN (the injector surfaces a "registry unreadable" note instead of
 * silently dropping the user's standing constraints). A parse/read failure →
 * `{ records:{}, corrupt:true }` + console.error; missing file → not corrupt.
 * @returns {{records:object, corrupt:boolean}}
 */
function loadResult(dataDir) {
  const p = storePath(dataDir);
  try {
    if (!fs.existsSync(p)) return { records: {}, corrupt: false };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.records && typeof obj.records === 'object') {
      return { records: obj.records, corrupt: false };
    }
    // Parsed but not the expected shape — treat as empty (not corrupt), matching
    // error-store's lenient handling of an unrecognized top-level object.
    return { records: {}, corrupt: false };
  } catch (err) {
    console.error(`[policy-store] load failed (${p}): ${err.message}`);
    return { records: {}, corrupt: true };
  }
}

// Best-effort, last-writer-wins: writeJsonAtomic publishes tear-free, but two
// concurrent load->mutate->save cycles can still lose an update (see atomic-write.js).
function save(dataDir, store) {
  const p = storePath(dataDir);
  try {
    writeJsonAtomic(p, store);
    return true;
  } catch (err) {
    console.error(`[policy-store] save failed (${p}): ${err.message}`);
    return false;
  }
}

/**
 * Records that are ACTIVE in the injection context of `projectId`: every
 * user-scope policy (always) PLUS the project-scope policies stamped with this
 * exact projectId. This is the set that co-injects at a session/subagent start,
 * and therefore the set the budget must bound. `excludeId` drops a same-id record
 * so re-activating an existing policy doesn't count itself.
 */
function activeFor(records, projectId, excludeId) {
  const pid = String(projectId != null ? projectId : '');
  return Object.values(records).filter((r) =>
    r && r.id !== excludeId &&
    (r.scope === 'user' || (r.scope === 'project' && String(r.projectId) === pid)));
}

/**
 * The ALWAYS-apply subset of `activeFor`: policies injected UNCONDITIONALLY at
 * SessionStart/SubagentStart. A legacy record with NO `mode` is treated as
 * 'always' (backward compat); glob (and any future/unknown) modes are EXCLUDED so
 * a conditional policy can never leak into the always set.
 */
function activeAlways(records, projectId, excludeId) {
  return activeFor(records, projectId, excludeId).filter((r) => r.mode === 'always' || r.mode == null);
}

/**
 * The GLOB-mode subset for `projectId` (glob policies are project-scoped, so the
 * user-scope branch of activeFor never contributes here). These surface ONLY as a
 * post-edit advisory when an edited path matches — never at session start.
 */
function activeGlob(records, projectId) {
  return activeFor(records, projectId, null).filter((r) => r.mode === 'glob');
}

// Deterministic injection order: oldest-activated first, id as a stable tiebreak.
function byActivatedThenId(a, b) {
  return (a.activatedAt || 0) - (b.activatedAt || 0) || String(a.id).localeCompare(String(b.id));
}

/**
 * Canonicalize a caller-supplied glob array into a sorted+deduped set, or REJECT
 * it (return null) — the design choice is REJECT, never coerce, so a malformed
 * glob set can't silently degrade into an unconditional (always) policy nor a
 * truncated pattern list. Per entry: coerce→string, strip control chars, `\`→`/`,
 * trim, cap to MAX_GLOB_LEN. Empties (after trim) are dropped ONLY to compute
 * validity (an empty string is not a pattern). Returns null when: input is not an
 * array; the resulting set is EMPTY; any normalized entry exceeds MAX_GLOB_LEN
 * (over-length → reject, don't truncate); or the set exceeds MAX_GLOBS_PER_POLICY.
 * @param {*} globs
 * @returns {string[]|null}
 */
function canonicalizeGlobs(globs) {
  if (!Array.isArray(globs)) return null;
  const out = [];
  for (const raw of globs) {
    const norm = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '') // strip control chars
      .replace(/\\/g, '/')                   // Windows separators → POSIX
      .trim();
    // Over-length is a HARD reject — never silently truncate to force validity.
    if (norm.length > MAX_GLOB_LEN) return null;
    if (!norm) continue; // empty after trim → not a real pattern; drop for validity
    out.push(norm.slice(0, MAX_GLOB_LEN)); // defensive cap (norm already ≤ MAX_GLOB_LEN)
  }
  const uniq = Array.from(new Set(out)).sort();
  if (uniq.length === 0) return null;                  // no usable pattern → invalid
  if (uniq.length > MAX_GLOBS_PER_POLICY) return null; // too many → invalid (don't drop)
  return uniq;
}

/**
 * Resolve `filePath` to a PROJECT-RELATIVE, POSIX-normalized path, or null when it
 * can't be located inside the project (absolute path on another drive, or one that
 * escapes `cwd`). An absolute path is made relative to `cwd`; a relative path is
 * used as-is. NEVER returns an absolute path (so a glob can't be matched against a
 * machine-specific prefix). `\`→`/` and a single leading `./` are stripped.
 * @param {string} filePath  the edited file path (absolute or relative)
 * @param {string} [cwd]     the session working directory
 * @returns {string|null}
 */
function toRelPath(filePath, cwd) {
  const fp = typeof filePath === 'string' ? filePath : '';
  if (!fp) return null;
  let rel;
  if (path.isAbsolute(fp)) {
    const base = typeof cwd === 'string' && cwd ? cwd : '';
    if (!base) return null; // can't anchor an absolute path without a cwd
    rel = path.relative(base, fp);
    // Escapes the project (../…) or resolves to another drive (absolute) → outside.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  } else {
    rel = fp;
  }
  let norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('./')) norm = norm.slice(2);
  return norm || null;
}

/**
 * Activate (upsert) a standing policy in one of TWO modes:
 *
 *   - ALWAYS (default, micro-2): injected UNCONDITIONALLY at every session/subagent
 *     start. Budget is enforced against the ALWAYS set only (glob policies don't
 *     count): if adding it would push the injected set past `maxPolicies` OR its
 *     total text past `maxChars`, activation is REFUSED (`reason:'budget'`) — an
 *     always policy is never silently truncated. id/sourceHash are unchanged from
 *     micro-2 so existing records resolve identically.
 *
 *   - GLOB (micro-3): triggered when `globs` is provided. Project-scoped ONLY
 *     (scope is forced to 'project'), surfaced ONLY as a post-edit advisory when an
 *     edited path matches one of the (canonicalized) globs. `canonicalizeGlobs`
 *     REJECTS a malformed set (`reason:'invalid-globs'`, nothing stored — atomic).
 *     A SEPARATE budget bounds glob policies per project
 *     (`MAX_GLOB_POLICIES_PER_PROJECT`, `reason:'budget'`). The glob set is folded
 *     into the id AND sourceHash so distinct globs (or a matcher/mode change) yield
 *     a distinct record/definition hash.
 *
 * Text is REDACTED + capped in BOTH modes. Empty text is refused (`reason:'empty'`).
 * @returns {{activated:boolean, id?:string, sig?:string, mode?:string, reason?:string}}
 */
function activate(dataDir, { entryId, text, scope = 'project', projectId, globs, now = Date.now() } = {},
  { maxPolicies = DEFAULT_MAX_POLICIES, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { activated: false, reason: 'empty' };

  const safeText = redact(raw).text.slice(0, MAX_POLICY_CHARS);
  const pid = String(projectId != null ? projectId : '');

  // ── GLOB branch ───────────────────────────────────────────────────────────
  // Presence of `globs` selects glob mode. Glob policies are project-scoped only
  // this micro — force it even if the caller passed scope:'user'.
  if (globs !== undefined && globs !== null) {
    const canon = canonicalizeGlobs(globs);
    if (canon === null) return { activated: false, reason: 'invalid-globs' };

    const { records } = loadResult(dataDir);
    const id = entryId
      ? sanitizeId(entryId)
      : sha256(`${safeText}|glob|${pid}|${canon.join(',')}`).slice(0, 16);
    // Separate glob budget (this same-id record excluded so an upsert doesn't
    // count itself). Glob policies do NOT consume the always maxPolicies/maxChars.
    const existing = activeGlob(records, pid).filter((r) => r.id !== id);
    if (existing.length + 1 > MAX_GLOB_POLICIES_PER_PROJECT) {
      return { activated: false, reason: 'budget' };
    }
    // Fold mode + globs into the definition hash so a later glob/matcher change
    // (different globs → different hash) can require re-approval, and distinct
    // glob sets on the same text never collide.
    const sourceHash = sha256(`${raw}\nglob\n${canon.join(',')}`);
    records[id] = {
      id,
      entryId: entryId ? String(entryId) : null,
      mode: 'glob',
      scope: 'project',
      projectId: pid,
      text: safeText,
      globs: canon,
      sourceHash,
      activatedAt: now,
    };
    save(dataDir, { records });
    return { activated: true, id, sig: sourceHash, mode: 'glob' };
  }

  // ── ALWAYS branch (micro-2 id/hash preserved) ─────────────────────────────
  const sc = scope === 'user' ? 'user' : 'project';
  const sourceHash = sha256(raw);
  const id = entryId ? sanitizeId(entryId) : sha256(`${safeText}|${sc}|${pid}`).slice(0, 16);

  const { records } = loadResult(dataDir);
  // Bound the ALWAYS set that would be INJECTED together (excluding this same-id
  // record, since an upsert replaces it). Glob policies are NOT counted here.
  const active = activeAlways(records, pid, id);
  const wouldCount = active.length + 1;
  const wouldChars = active.reduce((n, r) => n + (typeof r.text === 'string' ? r.text.length : 0), 0) + safeText.length;
  if (wouldCount > maxPolicies || wouldChars > maxChars) {
    return { activated: false, reason: 'budget' };
  }

  records[id] = {
    id,
    entryId: entryId ? String(entryId) : null,
    mode: 'always',
    scope: sc,
    projectId: pid,
    text: safeText,
    sourceHash,
    activatedAt: now,
  };
  save(dataDir, { records });
  return { activated: true, id, sig: sourceHash };
}

/**
 * Deactivate a policy by id (as returned by `list`/`activate`). Matches the exact
 * stored key, falling back to the sanitized form so a raw entryId still resolves.
 * @returns {{deactivated:boolean, id:string}}
 */
function deactivate(dataDir, id) {
  const raw = id != null ? String(id) : '';
  const { records } = loadResult(dataDir);
  const key = records[raw] ? raw : (records[sanitizeId(raw)] ? sanitizeId(raw) : '');
  if (!key) return { deactivated: false, id: raw };
  delete records[key];
  save(dataDir, { records });
  return { deactivated: true, id: key };
}

/**
 * The SessionStart/SubagentStart set: ALWAYS-mode records for `projectId`'s
 * injection context (user-scope always + project-scope matching this projectId),
 * in a DETERMINISTIC order (activatedAt, then id). Glob policies are EXCLUDED — a
 * conditional (per-file) policy must never be injected unconditionally.
 * @returns {Array<object>}
 */
function listAlways(dataDir, { projectId } = {}) {
  const { records } = loadResult(dataDir);
  return activeAlways(records, projectId, null).sort(byActivatedThenId);
}

/**
 * The MCP-listing set: ALL active records for `projectId` (both always and glob
 * modes), deterministically ordered — so `policy_list` shows everything the user
 * has activated, with `mode`/`globs` to distinguish them.
 * @returns {Array<object>}
 */
function listVisible(dataDir, { projectId } = {}) {
  const { records } = loadResult(dataDir);
  return activeFor(records, projectId, null).sort(byActivatedThenId);
}

/**
 * The post-edit advisory set: GLOB-mode records for `projectId` whose globs match
 * the edited file's project-relative path, deterministically ordered. If the path
 * can't be resolved inside the project (other drive / escapes cwd) → `[]`.
 * @returns {Array<object>}
 */
function listGlobMatching(dataDir, { projectId, filePath, cwd } = {}) {
  const rel = toRelPath(filePath, cwd);
  if (rel == null) return [];
  const { records } = loadResult(dataDir);
  return activeGlob(records, projectId)
    .filter((r) => anyGlobMatches(r.globs, rel))
    .sort(byActivatedThenId);
}

/**
 * Back-compat alias of `listVisible` (mode-blind). Retained for any legacy caller;
 * the always-injection path uses `listAlways` and MCP listing uses `listVisible`.
 * @returns {Array<object>}
 */
function list(dataDir, opts) {
  return listVisible(dataDir, opts || {});
}

module.exports = {
  storePath, loadResult, save,
  activate, deactivate,
  list, listAlways, listVisible, listGlobMatching,
  activeFor, activeAlways, activeGlob,
  canonicalizeGlobs, toRelPath,
  MAX_POLICY_CHARS, DEFAULT_MAX_POLICIES, DEFAULT_MAX_CHARS,
  MAX_GLOBS_PER_POLICY, MAX_GLOB_LEN, MAX_GLOB_POLICIES_PER_PROJECT,
};
