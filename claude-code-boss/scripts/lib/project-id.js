'use strict';
/**
 * project-id.js — resolve the project identity the CLIENT stamps on every memory
 * operation (the handshake `projectId`, ingestion metadata, recall scope).
 *
 * v2.15.0 (F1): the resolver is now STRICT, aligning the client to the memory
 * server's project_id hard contract (native-java ADR-018). It returns a clean,
 * deterministic id OR THROWS (fail-loud) so ingestion can BLOCK — instead of the
 * old never-empty basename/'default' fallback that stamped folder-path scope-junk
 * (C:\, Temp, AppData) onto the shared memory.
 *
 * STRICT ladder (first non-empty wins):
 *   1. env CCB_PROJECT_ID          — force one id for the whole session/process.
 *   2. declared .memory/project.json (metadata.defaults.project_id) — found by
 *      walking up to the PROJECT ROOT (findProjectRoot); worktrees + subfolders of
 *      the same project converge on the SAME id. Case preserved.
 *   3. legacy .claude-boss-project  — the boss's OLD marker. Still READ (backward
 *      compat) but DEPRECATED and READ-ONLY: never auto-migrated. A declared
 *      .memory/project.json WINS over it; it WINS over git-remote (explicit choice).
 *   4. git remote origin normalized — host/owner/repo lowercase (unique per repo,
 *      portable across machines/clones).
 *   5. nothing → THROW with an actionable message (SCOPE_HELP). Nothing is written
 *      or injected without a stable id — by design.
 *
 * Pure + dependency-injected (env/fs/git) so it's deterministic to test. git calls
 * are timeout-guarded (windowsHide) so it stays cheap enough for hook use.
 *
 * CommonJS port note: the ESM reference (copilot-memory/lib/projectId.mjs) uses bare
 * `catch {}`; here every tolerant catch acknowledges the error (`void err;`) to
 * satisfy the boss lint rule `local/no-silent-return-catch`.
 */
const { execFileSync } = require('child_process');
const fsDefault = require('fs');
const path = require('path');
const { loadProjectConfig, declaredProjectId, projectConfigPath } = require('./project-config.js');

const MARKER_FILE = '.claude-boss-project'; // legacy boss marker (deprecated; read-only)
const MAX_WALK_UP = 8; // cap parent traversal so a stray cwd can't scan the whole disk
const MAX_LEN = 120;

// Single ACTIONABLE message, reused by the resolver throw + assertSafeProjectId + the
// ingestion guards. Surfaced to the user when a write is blocked for lack of scope.
const SCOPE_HELP =
  'Create a .memory/project.json at the project root (metadata.defaults.project_id, e.g. "owner/repo") ' +
  'OR work inside a git repository with a remote origin. Without a stable identifier the memory is NOT ' +
  'written or injected — this prevents spreading folder-path scope-junk (C:\\, Temp, AppData) across the memory.';

// ─── small pure helpers ──────────────────────────────────────────────────────

/** Trim to a non-empty string, else null. */
function _trim(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

/** Trim to a single clean line; drop control chars; cap length. Empty → ''. */
function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) || '';
  return firstLine.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LEN);
}

/**
 * Normalize a git remote URL to host/owner/repo, collapsing scheme, credentials,
 * `.git` suffix and case. https://github.com/Acme/Widgets.git and
 * git@github.com:Acme/Widgets.git both become github.com/acme/widgets.
 * (Mirrors normalizeGitRemote in ProjectIdResolver.java + projectId.mjs.)
 */
function normalizeGitRemote(remoteUrl) {
  if (remoteUrl == null) return null;
  let s = String(remoteUrl).trim();
  if (!s) return null;

  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);

  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(at + 1);

  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  if (colon >= 0 && (slash < 0 || colon < slash)) {
    s = s.slice(0, colon) + '/' + s.slice(colon + 1);
  }

  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith('.git')) s = s.slice(0, -4);
  while (s.endsWith('/')) s = s.slice(0, -1);

  s = s.toLowerCase();
  return s ? s : null;
}

/**
 * SAFETY FLOOR (defense in depth): refuse a project_id that LOOKS like a filesystem
 * path (drive root, UNC, unix-abs, or any backslash — covering Windows AppData/Temp).
 * No legitimate id — declared (owner/repo) or git-remote (host/owner/repo) — has that
 * shape; forward slashes are fine. Throws with an actionable message.
 */
function assertSafeProjectId(projectId) {
  const s = projectId == null ? '' : String(projectId).trim();
  if (!s) throw new Error('project_id is empty. ' + SCOPE_HELP);
  const looksLikePath =
    /^[A-Za-z]:[\\/]/.test(s) ||   // C:\ or C:/ (Windows drive)
    s.startsWith('\\\\') ||        // UNC \\server\share
    s.startsWith('/') ||           // unix absolute path
    s.includes('\\');              // any backslash — covers Windows AppData/Temp/...
  if (looksLikePath) {
    throw new Error('project_id looks like a filesystem path ("' + s + '") — refused to avoid ' +
      'scope-junk. ' + SCOPE_HELP);
  }
  return s;
}

// ─── git runner (injectable) ─────────────────────────────────────────────────

/** Run git in `cwd`; return trimmed stdout or null (never throws). */
function defaultGit(args, cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    });
    const s = String(out).trim();
    return s || null;
  } catch (err) {
    void err; // not a repo / git absent / timeout → the ladder falls through
    return null;
  }
}

/** `git remote get-url origin` — null when no remote / not a repo / git absent. */
function gitRemoteOriginUrl(cwd, git) {
  return git(['remote', 'get-url', 'origin'], cwd);
}

/**
 * The shared REPO BASE of all worktrees: `git rev-parse --git-common-dir` points at
 * the main repo's `.git`; its parent is the base (common to every worktree). Only
 * LOCATES the declared marker — never becomes the id. Absolute path, or null.
 */
function gitRepoBase(cwd, git) {
  const runGit = git || defaultGit;
  let common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) common = runGit(['rev-parse', '--git-common-dir'], cwd); // git < 2.31
  if (!common) return null;
  try {
    const abs = path.resolve(cwd, common); // resolve if relative
    const base = path.dirname(abs);        // .../repo/.git → .../repo
    return base && base.trim() ? base : null;
  } catch (err) {
    void err; // unresolvable path → no base
    return null;
  }
}

// ─── marker location (with the boss session-root ceiling) ────────────────────

/** Does this dir hold a `.memory/project.json`? (never throws) */
function hasMarker(dir, fs) {
  try { return fs.existsSync(projectConfigPath(dir)); } catch (err) { void err; return false; }
}
function safeResolve(p) {
  try { if (!p) return null; const abs = path.resolve(p); return abs && abs.trim() ? abs : null; }
  catch (err) { void err; return null; }
}
/** Case-insensitive on win32 path equality. */
function pathsEqual(a, b) {
  try {
    const ra = path.resolve(a); const rb = path.resolve(b);
    if (ra === rb) return true;
    return process.platform === 'win32' && ra.toLowerCase() === rb.toLowerCase();
  } catch (err) { void err; return false; }
}
/** Is `child` inside (a descendant of) `parent`? */
function isWithin(child, parent) {
  try {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (err) { void err; return false; }
}

/**
 * Locate the PROJECT ROOT holding `.memory/project.json`, without an unbounded
 * filesystem walk-up. Order:
 *   1. cwd itself has the marker.
 *   2. BOSS ADAPTATION (2a) — SESSION-ROOT CEILING: walk up from cwd toward the
 *      session root (env CLAUDE_PROJECT_DIR, set by Claude Code hooks) looking for
 *      the marker, and NEVER above it. When the env is unset we do NOT walk the
 *      filesystem (matches the reference) — only the git anchors below.
 *   3. git toplevel has the marker (tracked marker in a subfolder/worktree).
 *   4. repo-base (git-common-dir) has the marker (untracked marker only in the base).
 * So worktrees + subfolders of the same project converge on the SAME root → SAME id.
 * null when no marker is found at any anchor (outside git it does NOT climb the disk).
 */
function findProjectRoot({ cwd, env = process.env, fs = fsDefault, git = defaultGit } = {}) {
  const dir = _trim(cwd);
  if (!dir) return null;
  if (hasMarker(dir, fs)) return safeResolve(dir);

  const ceiling = _trim(env && env.CLAUDE_PROJECT_DIR);
  if (ceiling && (pathsEqual(dir, ceiling) || isWithin(dir, ceiling))) {
    let d = dir;
    for (let i = 0; i < MAX_WALK_UP; i++) {
      if (hasMarker(d, fs)) return safeResolve(d);
      if (pathsEqual(d, ceiling)) break;   // reached the session root (inclusive) — stop
      const parent = path.dirname(d);
      if (parent === d) break;             // filesystem root
      d = parent;
    }
  }

  const top = safeResolve(git(['rev-parse', '--show-toplevel'], dir));
  if (top && hasMarker(top, fs)) return top;
  const base = gitRepoBase(dir, git);
  if (base && hasMarker(base, fs)) return safeResolve(base);
  return null;
}

// ─── legacy marker (READ-ONLY back-compat + migration nudge, boss 2b) ─────────

/**
 * The nearest legacy `.claude-boss-project` walking up from `cwd`, as { id, path },
 * or null. READ-ONLY: this is the DEPRECATED boss marker — it is honored for
 * backward compatibility but NEVER auto-migrated to `.memory/project.json`.
 */
function legacyMarkerPresent(cwd, fs = fsDefault) {
  const dir = _trim(cwd);
  if (!dir) return null;
  let d = dir;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = path.join(d, MARKER_FILE);
    try {
      if (fs.existsSync(candidate)) {
        const id = sanitize(fs.readFileSync(candidate, 'utf-8'));
        if (id) return { id, path: candidate };
      }
    } catch (err) { void err; /* unreadable marker → keep walking */ }
    const parent = path.dirname(d);
    if (parent === d) break; // filesystem root
    d = parent;
  }
  return null;
}

/**
 * Read the nearest `.claude-boss-project`, walking up from `startDir`.
 * Preserved legacy export (project-identity-advisory + dashboard depend on it).
 * @returns {string} sanitized chosen id, or '' if none found/readable.
 */
function readMarker(startDir, fs = fsDefault) {
  const found = legacyMarkerPresent(startDir, fs);
  return found ? found.id : '';
}

// ─── the strict resolver (single source of truth for the ladder) ─────────────

/** Resolve id + which rung produced it, or THROW. Internal (DRY for the 3 facades). */
function _resolveWithStrength({ cwd, env = process.env, fs = fsDefault, git = defaultGit } = {}) {
  // Rung 1 — env override (explicit, wins over everything).
  const forced = sanitize(env && env.CCB_PROJECT_ID);
  if (forced) return { id: assertSafeProjectId(forced), strength: 'env' };

  const dir = _trim(cwd);
  if (dir) {
    // Rung 2 — DECLARED intent: .memory/project.json at the project root.
    const root = findProjectRoot({ cwd: dir, env, fs, git });
    if (root) {
      const declared = declaredProjectId(loadProjectConfig(root));
      if (declared) return { id: assertSafeProjectId(declared), strength: 'declared' };
    }
    // Rung 3 — LEGACY marker (read-only back-compat; beats git-remote as it was an
    // explicit user choice, but loses to a declared .memory/project.json above).
    const legacy = readMarker(dir, fs);
    if (legacy) return { id: assertSafeProjectId(legacy), strength: 'legacy' };
    // Rung 4 — git remote origin normalized (portable across machines).
    const norm = normalizeGitRemote(gitRemoteOriginUrl(dir, git));
    if (norm) return { id: assertSafeProjectId(norm), strength: 'git-remote' };
  }

  // Rung 5 — no stable identifier: FAIL LOUD.
  throw new Error('Could not resolve project_id' + (cwd ? ' for: ' + cwd : ' (empty workspace)') +
    '. ' + SCOPE_HELP);
}

/**
 * Resolve the logical project_id for a working directory. THROWS (fail-loud) when
 * impossible — the caller (ingestion boundary) must block. Best-effort/read callers
 * use tryResolveProjectId instead.
 * @param {object} [opts] { cwd, env=process.env, fs=fs, git=defaultGit }
 * @returns {string} the resolved id (never empty; throws instead)
 */
function resolveProjectId(opts) {
  return _resolveWithStrength(opts).id;
}

/** Try to resolve; null instead of throwing (best-effort hooks/reads). */
function tryResolveProjectId(opts) {
  try { return _resolveWithStrength(opts).id; }
  catch (err) { void err; return null; }
}

/**
 * Where the id WOULD come from — the scope "strength": env | declared | legacy |
 * git-remote | none. "none" is exactly when resolveProjectId throws (fail-loud) —
 * the signal a consumer uses to nudge the user to declare a .memory/project.json.
 */
function projectIdStrength(opts) {
  try { return _resolveWithStrength(opts).strength; }
  catch (err) { void err; return 'none'; }
}

/** true when the scope is fragile (resolveProjectId would throw). */
function isFragileScope(opts) {
  return projectIdStrength(opts) === 'none';
}

/**
 * FALLBACK id: the ladder IGNORING the declared marker AND the legacy marker — i.e.
 * the git-remote scope the project would have WITHOUT any declaration. Used to detect
 * memory stamped with the PRIOR id (git-remote) after the user later declared a
 * canonical id, so a consumer can propose migration. One-rung-below = git-remote
 * only; no remote → null (never derives from path/name — that was the scope-junk).
 */
function resolveFallbackProjectId({ cwd, git = defaultGit } = {}) {
  const dir = _trim(cwd);
  if (!dir) return null;
  return normalizeGitRemote(gitRemoteOriginUrl(dir, git)) || null;
}

/** Strength of the FALLBACK scope (never "declared"): git-remote | none. */
function fallbackStrength({ cwd, git = defaultGit } = {}) {
  const dir = _trim(cwd);
  if (!dir) return 'none';
  return normalizeGitRemote(gitRemoteOriginUrl(dir, git)) ? 'git-remote' : 'none';
}

/**
 * Assisted, NON-SILENT migration signal for the deprecated legacy marker. Returns
 * the data a consumer needs to WARN "you have a legacy .claude-boss-project — want to
 * migrate to .memory/project.json?", or null when there is nothing to migrate (no
 * legacy marker) OR a declared .memory/project.json already wins (migration done).
 * NEVER writes anything (the boss never auto-creates .memory/project.json — owner "c").
 */
function migrationHint({ cwd, env = process.env, fs = fsDefault, git = defaultGit } = {}) {
  const dir = _trim(cwd);
  if (!dir) return null;
  const legacy = legacyMarkerPresent(dir, fs);
  if (!legacy) return null; // nothing to migrate
  const root = findProjectRoot({ cwd: dir, env, fs, git });
  if (root && declaredProjectId(loadProjectConfig(root))) return null; // already declared → no nudge
  return {
    legacyId: legacy.id,
    legacyPath: legacy.path,
    marker: MARKER_FILE,
    suggestedDeclaredPath: projectConfigPath(dir),
    currentStrength: projectIdStrength({ cwd: dir, env, fs, git }),
    fallbackStrength: fallbackStrength({ cwd: dir, git }),
  };
}

/**
 * LOCAL-scope id for ancillary, per-machine stores (policies, shadow metrics,
 * adjudication) — DELIBERATELY not the memory contract. Never throws: prefers the
 * stable id (tryResolveProjectId) and, only when there is none, degrades to
 * basename(cwd) then 'default' — the historical local scoping. This is
 * non-contaminating (these stores are local, not the shared memory daemon), so the
 * basename fallback is acceptable here where it is NOT at the memory boundary.
 */
function resolveLocalScopeId({ cwd, env = process.env, fs = fsDefault, git = defaultGit } = {}) {
  const id = tryResolveProjectId({ cwd, env, fs, git });
  if (id) return id;
  if (cwd && typeof cwd === 'string') {
    const base = path.basename(cwd);
    if (base) return base;
  }
  return 'default';
}

/**
 * Sanitize a CALLER-SUPPLIED project id into a single safe path segment. Unlike the
 * resolver, an explicit `project` arg can carry `..`/separators straight into
 * `path.join(brainDir, <id>)`; this REJECTS (returns '') ids with a path separator,
 * drive-colon, or a pure parent-ref so the caller falls back to safe resolution.
 * (Distinct from assertSafeProjectId, which validates a RESOLVED logical id and DOES
 * allow forward slashes like owner/repo.)
 */
function sanitizeProjectId(raw) {
  const s = sanitize(raw);
  if (!s) return '';
  if (/[\\/:]/.test(s)) return '';
  if (s === '.' || s === '..') return '';
  return s;
}

module.exports = {
  // ── Preserved legacy exports (contract unchanged for existing call-sites) ──
  resolveProjectId, readMarker, sanitize, sanitizeProjectId, MARKER_FILE,
  // ── Strict resolver API (F1) ──
  tryResolveProjectId, projectIdStrength, isFragileScope,
  resolveFallbackProjectId, fallbackStrength,
  resolveLocalScopeId,
  normalizeGitRemote, findProjectRoot, gitRepoBase, assertSafeProjectId, SCOPE_HELP,
  legacyMarkerPresent, migrationHint,
};
