'use strict';
/**
 * project-config.js — reader for `.memory/project.json`, the ecosystem's DECLARED
 * scope convention (mirrors ProjectConfig.java of native-java and the copilot-memory
 * extension's projectConfig.mjs). The boss now HONORS a declared `project_id` and the
 * `metadata.defaults` / branch-glob metadata instead of only deriving from git/path.
 * Missing/corrupt file → null (the resolver ladder falls through to the next rung).
 *
 * Schema (fields used; forward-compat ignores the rest):
 *   { "version", "project": {name,client,team}, "server": {url,workspace},
 *     "metadata": { "defaults": {project_id, ...}, "branches": { "<glob>": {..} } },
 *     "user": { "identifyBy": "os-username|git-email|manual", "name" } }
 *
 * CommonJS port note: the reference uses bare `catch {}` (ESM); here every tolerant
 * catch acknowledges the error (`void err;`) to satisfy the boss lint rule
 * `local/no-silent-return-catch` — these are intentional never-throw readers.
 */
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

/** Absolute path of the declared-scope marker for a workspace. */
function projectConfigPath(workspacePath) {
  return join(String(workspacePath || '.'), '.memory', 'project.json');
}

/** Load + TOLERANT parse. Missing/empty/corrupt → null (never throws). */
function loadProjectConfig(workspacePath) {
  try {
    const p = projectConfigPath(workspacePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (err) {
    void err; // absent/corrupt/unreadable marker → fall through to the next rung
    return null;
  }
}

/**
 * Extract the DECLARED project_id (`metadata.defaults.project_id`). Trimmed, but
 * case is PRESERVED (an explicit human choice — e.g. `AllanSantos-DV/copilot-memory`).
 * null when absent/blank.
 */
function declaredProjectId(cfg) {
  const v = cfg && cfg.metadata && cfg.metadata.defaults && cfg.metadata.defaults.project_id;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Current git branch, or null (detached HEAD / not a repo / git absent). */
function gitBranch(workspacePath) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true,
    });
    const s = String(out).trim();
    return s && s !== 'HEAD' ? s : null;
  } catch (err) {
    void err; // no branch / not a git repo / git missing → no branch metadata
    return null;
  }
}

/**
 * Match the current branch against `metadata.branches` glob patterns (exact first,
 * then simple glob). Mirrors matchBranchMetadata of ProjectConfig.java.
 */
function matchBranchMeta(cfg, workspacePath) {
  const branches = cfg && cfg.metadata && cfg.metadata.branches;
  if (!branches || typeof branches !== 'object') return null;
  const branch = gitBranch(workspacePath);
  if (!branch) return null;
  if (branches[branch] && typeof branches[branch] === 'object') return branches[branch];
  for (const [pattern, meta] of Object.entries(branches)) {
    if (meta && typeof meta === 'object' && globMatch(pattern, branch)) return meta;
  }
  return null;
}

/** Simple glob: `*` → any suffix, `?` → one char, anchored. Enough for `feat/*` etc. */
function globMatch(pattern, value) {
  try {
    const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(value);
  } catch (err) {
    void err; // a malformed pattern never matches (tolerant)
    return false;
  }
}

/**
 * Metadata to stamp on every write/search from the project.json (parity with the
 * server's mergeMetadata: defaults ⊕ branch; the CALLER's metadata wins and is
 * applied by the caller afterwards). {} when no config. Never throws.
 */
function configMetadata(workspacePath) {
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) return {};
  const out = {};
  const defaults = cfg.metadata && cfg.metadata.defaults;
  if (defaults && typeof defaults === 'object') Object.assign(out, defaults);
  const branchMeta = matchBranchMeta(cfg, workspacePath);
  if (branchMeta) Object.assign(out, branchMeta);
  return out;
}

module.exports = {
  projectConfigPath,
  loadProjectConfig,
  declaredProjectId,
  configMetadata,
  matchBranchMeta,
  globMatch,
};
