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

// ── Shadow-assertion glob policies (Phase 3 micro-A) ────────────────────────
// A shadow-assertion glob policy carries a DETERMINISTIC content assert that a
// FUTURE guard WOULD test (kind:'forbid-added-literal'). This micro only MEASURES
// how often that assert WOULD trigger (enforcement:'shadow') — it never blocks and
// is silent. The literal is stored UNREDACTED (a redacted literal can't match), so
// a secret-bearing literal is REJECTED at activation rather than stored.
const MAX_LITERAL_CHARS = 256;               // max chars for an assert literal (reject, don't truncate)
const MAX_SHADOW_POLICIES_PER_PROJECT = 10;  // SEPARATE budget: max shadow-assertion policies per project

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
// policy-store is in the SAME known best-effort last-writer-wins class as the other
// manual-action snapshot stores (oneoff/cooldown/recall-health). `mutate()` below
// NARROWS that window by re-reading immediately before the write; it deliberately
// does NOT add cross-process locking — activate/deactivate are low-frequency, EXPLICIT
// user actions, so a proportionate mitigation (not a lock) is the honest fit here.
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
 * Read-modify-write against the FRESHEST on-disk registry — the single seam both
 * `activate()` and `deactivate()` use so the load happens as LATE as possible (right
 * before the write) instead of from a snapshot captured earlier in the call. This
 * NARROWS the lost-update window: a concurrent writer whose record landed between
 * "call start" and this read is present in `records`, so the subsequent write merges
 * it forward rather than clobbering it with a stale in-memory copy.
 *
 * `fn(loaded)` receives the fresh `loadResult` (`{records, corrupt}`), MUTATES
 * `records` IN PLACE for the single-record change it wants to commit, and returns
 * `{ commit, result }`:
 *   - commit:true  → the mutated records are persisted; returns
 *                    `{ saved:<boolean from save()>, result }` so the caller can
 *                    surface a persist failure (e.g. as reason:'persist');
 *   - commit:false → nothing is written; returns `{ saved:null, result }`.
 * The corrupt-registry decision is left to `fn` (via `loaded.corrupt`) so each caller
 * chooses its own refusal shape WITHOUT overwriting the unreadable file.
 *
 * HONEST GUARANTEE: this NARROWS — it does NOT eliminate — the race. Two truly
 * simultaneous cross-process writers can still interleave (the later rename wins);
 * policy-store stays a best-effort, last-writer-wins store (no cross-process lock).
 * `io` is an optional `{ loadResult, save }` seam so a test can simulate a concurrent
 * writer landing right before the read; production uses the module functions.
 * @param {string} dataDir
 * @param {(loaded:{records:object,corrupt:boolean}) => {commit:boolean, result:*}} fn
 * @param {{loadResult?:Function, save?:Function}} [io]
 * @returns {{saved:(boolean|null), result:*}}
 */
function mutate(dataDir, fn, io) {
  const readFresh = (io && io.loadResult) || loadResult;
  const writeStore = (io && io.save) || save;
  const loaded = readFresh(dataDir);          // the LATE read — freshest on-disk state
  const { commit, result } = fn(loaded);
  if (commit) return { saved: writeStore(dataDir, { records: loaded.records }), result };
  return { saved: null, result };
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

/**
 * True iff `r` is a SHADOW-ASSERTION glob policy: a glob-mode record carrying a
 * `forbid-added-literal` assert AND `enforcement:'shadow'`. A legacy/hand-edited
 * glob record with a different (or missing) enforcement is NOT one of these — it
 * is excluded from both the shadow budget and the shadow-matching set.
 */
function isShadowAssertion(r) {
  return !!(r && r.mode === 'glob' && r.enforcement === 'shadow'
    && r.assert && r.assert.kind === 'forbid-added-literal');
}

/**
 * The SHADOW-ASSERTION subset of `activeGlob` for `projectId` — the set the
 * SEPARATE shadow budget (`MAX_SHADOW_POLICIES_PER_PROJECT`) bounds.
 */
function activeShadow(records, projectId) {
  return activeGlob(records, projectId).filter(isShadowAssertion);
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
 * escapes `cwd` via `..`). NEVER returns an absolute path nor a `../…` traversal.
 *
 * With a `cwd`, BOTH relative and absolute inputs are anchored against it
 * (`path.relative(cwd, path.resolve(cwd, fp))`) and rejected when the result climbs
 * out (leading `..`) or lands on another drive (absolute). Without a `cwd`, an
 * absolute input can't be anchored → null; a relative input is kept as-is but still
 * rejected if it contains a `..` SEGMENT (a bare relative `../outside.js` must NOT
 * pass through unchanged — the pre-fix escape). `\`→`/` and a leading `./` stripped.
 *
 * The escape check is SEGMENT-AWARE: a filename that merely starts with `..`
 * (e.g. `..config`) is a distinct segment and is allowed; only a `..` path segment
 * is an escape.
 * @param {string} filePath  the edited file path (absolute or relative)
 * @param {string} [cwd]     the session working directory
 * @returns {string|null}
 */
function toRelPath(filePath, cwd) {
  const fp = typeof filePath === 'string' ? filePath : '';
  if (!fp) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : '';
  let rel;
  if (base) {
    // Anchor BOTH relative and absolute inputs against cwd; reject other-drive
    // (absolute residual) escapes. `path.relative` collapses interior `..` that
    // stays inside, so only a genuine escape surfaces as a leading `..`.
    rel = path.relative(base, path.resolve(base, fp));
    if (!rel || path.isAbsolute(rel)) return null;
  } else if (path.isAbsolute(fp)) {
    return null; // can't anchor an absolute path without a cwd
  } else {
    rel = fp; // no cwd: keep the relative path as-is (escape-checked below)
  }
  let norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('./')) norm = norm.slice(2);
  // Segment-aware escape guard: a `..` SEGMENT (leading or interior) climbs out of
  // the project — reject rather than return a traversing path. This closes the
  // pre-fix hole where a bare relative `../outside.js` was returned unchanged.
  if (norm.split('/').some((s) => s === '..')) return null;
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
 *   - GLOB + SHADOW-ASSERTION (micro-A): a GLOB policy that ALSO carries an `assert`
 *     ({kind:'forbid-added-literal', literal, caseSensitive?}) with
 *     `enforcement:'shadow'`. It only MEASURES how often the assert WOULD trigger a
 *     future guard — never blocks, silent. The literal is stored UNREDACTED (a
 *     redacted literal can't match), so a secret-bearing literal is REJECTED
 *     (`reason:'sensitive-literal'`, nothing stored). Other refusals:
 *     `bad-assert-kind`, `bad-literal`, `literal-too-long`, `unsupported-enforcement`,
 *     and a SEPARATE `MAX_SHADOW_POLICIES_PER_PROJECT` budget (`reason:'budget'`).
 *     A per-definition opaque `activationId` (the telemetry key) is minted on the
 *     first definition and REUSED across upserts while the definition (sourceHash)
 *     is unchanged; any change to globs/kind/literal/caseSensitive/enforcement mints
 *     a fresh one.
 *
 * Text is REDACTED + capped in BOTH modes. Empty text is refused (`reason:'empty'`).
 * A CORRUPT registry refuses activation up-front (`reason:'corrupt'`) rather than
 * overwriting it, and a failed persist surfaces (`reason:'persist'`) instead of a
 * false success.
 * @returns {{activated:boolean, id?:string, sig?:string, mode?:string, activationId?:string, enforcement?:string, reason?:string}}
 */
function activate(dataDir, { entryId, text, scope = 'project', projectId, globs, assert, enforcement, now = Date.now() } = {},
  { maxPolicies = DEFAULT_MAX_POLICIES, maxChars = DEFAULT_MAX_CHARS } = {}, io) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { activated: false, reason: 'empty' };

  // Pure input → derived once (functions of the args only, independent of the
  // registry), so their position relative to the on-disk read is immaterial.
  const safeText = redact(raw).text.slice(0, MAX_POLICY_CHARS);
  const pid = String(projectId != null ? projectId : '');

  // Apply the single-record change to the FRESHEST on-disk registry via mutate():
  // the store is (re)read INSIDE this closure, immediately before the write, so a
  // concurrent activation that already landed isn't clobbered by a stale snapshot
  // (narrows the last-writer-wins window; see mutate()). The corrupt check AND every
  // records-dependent decision (budget, activationId reuse, the upsert) run against
  // that fresh `records`.
  const { saved, result } = mutate(dataDir, ({ records, corrupt }) => {
    // Refuse up-front on corruption so a parse failure can't be clobbered by an
    // overwrite (the load-bearing state is the user's standing constraints).
    if (corrupt) return { commit: false, result: { activated: false, reason: 'corrupt' } };

    // ── GLOB branch ───────────────────────────────────────────────────────────
    // Presence of `globs` selects glob mode. Glob policies are project-scoped only
    // this micro — force it even if the caller passed scope:'user'.
    if (globs !== undefined && globs !== null) {
      const canon = canonicalizeGlobs(globs);
      if (canon === null) return { commit: false, result: { activated: false, reason: 'invalid-globs' } };

      const id = entryId
        ? sanitizeId(entryId)
        : sha256(`${safeText}|glob|${pid}|${canon.join(',')}`).slice(0, 16);

      // ── SHADOW-ASSERTION sub-branch ─────────────────────────────────────────
      // A glob policy carrying an `assert` is a shadow-assertion policy (micro-A).
      if (assert !== undefined && assert !== null) {
        if (typeof assert !== 'object' || Array.isArray(assert) || assert.kind !== 'forbid-added-literal') {
          return { commit: false, result: { activated: false, reason: 'bad-assert-kind' } };
        }
        const literal = assert.literal;
        if (typeof literal !== 'string' || literal.length === 0) {
          return { commit: false, result: { activated: false, reason: 'bad-literal' } };
        }
        // Reject (don't truncate) an oversized literal — a truncated literal would
        // silently measure a DIFFERENT assertion than the user approved.
        if (literal.length > MAX_LITERAL_CHARS) {
          return { commit: false, result: { activated: false, reason: 'literal-too-long' } };
        }
        // Secret gate: the literal is stored UNREDACTED (redaction would break exact
        // matching). If the redactor WOULD change it, it carries a secret → refuse.
        if (redact(literal).text !== literal) {
          return { commit: false, result: { activated: false, reason: 'sensitive-literal' } };
        }
        // Only 'shadow' (measure) is supported this micro — 'enforce' (block) is a
        // LATER micro and must be refused, not silently downgraded.
        if (enforcement !== 'shadow') {
          return { commit: false, result: { activated: false, reason: 'unsupported-enforcement' } };
        }
        const caseSensitive = assert.caseSensitive !== false; // DEFAULT true

        // SEPARATE shadow budget (this same-id record excluded so an upsert doesn't
        // count itself). Independent of the plain-glob budget.
        const existingShadow = activeShadow(records, pid).filter((r) => r.id !== id);
        if (existingShadow.length + 1 > MAX_SHADOW_POLICIES_PER_PROJECT) {
          return { commit: false, result: { activated: false, reason: 'budget' } };
        }

        // Definition hash folds globs + the FULL assert (kind/literal/caseSensitive)
        // + enforcement so ANY definition change yields a new hash → new activationId.
        const sourceHash = sha256(
          `${raw}\nglob\n${canon.join(',')}\nshadow\n${assert.kind}\n${literal}\n${caseSensitive}\n${enforcement}`);
        // activationId is the IMMUTABLE-per-definition telemetry key: reuse the prior
        // one when the definition is unchanged, else mint a fresh opaque id.
        const prior = records[id];
        const activationId = (prior && prior.sourceHash === sourceHash && prior.activationId)
          ? prior.activationId
          : crypto.randomBytes(12).toString('hex');

        records[id] = {
          id,
          entryId: entryId ? String(entryId) : null,
          mode: 'glob',
          scope: 'project',
          projectId: pid,
          text: safeText,
          globs: canon,
          assert: { kind: 'forbid-added-literal', literal, caseSensitive },
          enforcement: 'shadow',
          activationId,
          sourceHash,
          activatedAt: now,
        };
        return { commit: true, result: { activated: true, id, activationId, mode: 'glob', enforcement: 'shadow' } };
      }

      // Separate glob budget (this same-id record excluded so an upsert doesn't
      // count itself). Glob policies do NOT consume the always maxPolicies/maxChars.
      const existing = activeGlob(records, pid).filter((r) => r.id !== id);
      if (existing.length + 1 > MAX_GLOB_POLICIES_PER_PROJECT) {
        return { commit: false, result: { activated: false, reason: 'budget' } };
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
      return { commit: true, result: { activated: true, id, sig: sourceHash, mode: 'glob' } };
    }

    // ── ALWAYS branch (micro-2 id/hash preserved) ─────────────────────────────
    const sc = scope === 'user' ? 'user' : 'project';
    const sourceHash = sha256(raw);
    const id = entryId ? sanitizeId(entryId) : sha256(`${safeText}|${sc}|${pid}`).slice(0, 16);

    // Bound the ALWAYS set that would be INJECTED together (excluding this same-id
    // record, since an upsert replaces it). Glob policies are NOT counted here.
    const active = activeAlways(records, pid, id);
    const wouldCount = active.length + 1;
    const wouldChars = active.reduce((n, r) => n + (typeof r.text === 'string' ? r.text.length : 0), 0) + safeText.length;
    if (wouldCount > maxPolicies || wouldChars > maxChars) {
      return { commit: false, result: { activated: false, reason: 'budget' } };
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
    return { commit: true, result: { activated: true, id, sig: sourceHash } };
  }, io);

  // A COMMITTED change whose persist failed surfaces as reason:'persist' (never a
  // false success); refusals and the corrupt gate return the closure result verbatim.
  if (saved === false) return { activated: false, reason: 'persist' };
  return result;
}

/**
 * Deactivate a policy by id (as returned by `list`/`activate`). Matches the exact
 * stored key, falling back to the sanitized form so a raw entryId still resolves.
 * Uses mutate() so the delete is applied to the FRESHEST on-disk registry (narrows
 * the lost-update window; a concurrent activation isn't clobbered by a stale read).
 * A corrupt registry loads as empty records → no key match → no write (unchanged).
 * @param {{loadResult?:Function, save?:Function}} [io] optional test seam
 * @returns {{deactivated:boolean, id:string}}
 */
function deactivate(dataDir, id, io) {
  const raw = id != null ? String(id) : '';
  const { result } = mutate(dataDir, ({ records }) => {
    const key = records[raw] ? raw : (records[sanitizeId(raw)] ? sanitizeId(raw) : '');
    if (!key) return { commit: false, result: { deactivated: false, id: raw } };
    delete records[key];
    return { commit: true, result: { deactivated: true, id: key } };
  }, io);
  // Mirrors the prior behavior of ignoring save()'s return here (a persist failure
  // leaves the record active, surfaced on the next list rather than as an error).
  return result;
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
 * The SHADOW-MEASUREMENT set: SHADOW-ASSERTION glob records for `projectId` whose
 * globs match the edited file's project-relative path, deterministically ordered.
 * Legacy/hand-edited glob records WITHOUT `enforcement:'shadow'` (or without a
 * `forbid-added-literal` assert) are EXCLUDED — only records that went through the
 * shadow-activation gate are measured. Path outside the project (other drive /
 * escapes cwd via the FIXED `toRelPath`) → `[]`.
 * @returns {Array<object>}
 */
function listShadowMatching(dataDir, { projectId, filePath, cwd } = {}) {
  const rel = toRelPath(filePath, cwd);
  if (rel == null) return [];
  const { records } = loadResult(dataDir);
  return activeGlob(records, projectId)
    .filter((r) => r.enforcement === 'shadow'
      && r.assert && r.assert.kind === 'forbid-added-literal'
      && anyGlobMatches(r.globs, rel))
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
  storePath, loadResult, save, mutate,
  activate, deactivate,
  list, listAlways, listVisible, listGlobMatching, listShadowMatching,
  activeFor, activeAlways, activeGlob, activeShadow, isShadowAssertion,
  canonicalizeGlobs, toRelPath,
  MAX_POLICY_CHARS, DEFAULT_MAX_POLICIES, DEFAULT_MAX_CHARS,
  MAX_GLOBS_PER_POLICY, MAX_GLOB_LEN, MAX_GLOB_POLICIES_PER_PROJECT,
  MAX_LITERAL_CHARS, MAX_SHADOW_POLICIES_PER_PROJECT,
};
