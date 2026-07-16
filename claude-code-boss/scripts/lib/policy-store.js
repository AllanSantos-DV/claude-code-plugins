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
 *   { id, entryId, mode:'always', scope:'user'|'project', projectId,
 *     text, sourceHash, activatedAt }
 *   - id         stable key (entryId if given, else hash(text+scope+projectId));
 *   - text       REDACTED + capped (MAX_POLICY_CHARS);
 *   - sourceHash sha256 of the RAW approved text, so a later KB edit (different
 *                raw text → different hash) can require re-approval.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const MAX_POLICY_CHARS = 2000;   // per-policy stored/injected text cap
const DEFAULT_MAX_POLICIES = 10; // budget: max active policies per injected set
const DEFAULT_MAX_CHARS = 4000;  // budget: max total text chars per injected set

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
 * Activate (upsert) a standing always-apply policy. The text is REDACTED + capped
 * before storage. Budget is enforced against the active set for the target
 * (scope, projectId): if adding this policy would push the injected set past
 * `maxPolicies` OR its total text past `maxChars`, activation is REFUSED
 * (`{activated:false, reason:'budget'}`) — an 'always' policy is never silently
 * truncated. Empty text is refused (`reason:'empty'`).
 * @returns {{activated:boolean, id?:string, sig?:string, reason?:string}}
 */
function activate(dataDir, { entryId, text, scope = 'project', projectId, now = Date.now() } = {},
  { maxPolicies = DEFAULT_MAX_POLICIES, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { activated: false, reason: 'empty' };

  const sc = scope === 'user' ? 'user' : 'project';
  const pid = String(projectId != null ? projectId : '');
  const safeText = redact(raw).text.slice(0, MAX_POLICY_CHARS);
  const sourceHash = sha256(raw);
  const id = entryId ? sanitizeId(entryId) : sha256(`${safeText}|${sc}|${pid}`).slice(0, 16);

  const { records } = loadResult(dataDir);
  // Bound the set that would be INJECTED together (excluding this same-id record,
  // since an upsert replaces it rather than adding a new one).
  const active = activeFor(records, pid, id);
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
 * Active records for `projectId`'s injection context (user-scope always +
 * project-scope matching this projectId), in a DETERMINISTIC order (activatedAt,
 * then id) so the injected block is stable across runs.
 * @returns {Array<object>}
 */
function list(dataDir, { projectId, now = Date.now() } = {}) {
  void now; // accepted for signature symmetry / future TTL; 'always' policies don't expire.
  const { records } = loadResult(dataDir);
  return activeFor(records, projectId, null).sort((a, b) =>
    (a.activatedAt || 0) - (b.activatedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

module.exports = {
  storePath, loadResult, save,
  activate, deactivate, list, activeFor,
  MAX_POLICY_CHARS, DEFAULT_MAX_POLICIES, DEFAULT_MAX_CHARS,
};
