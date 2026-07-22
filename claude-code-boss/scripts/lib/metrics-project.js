'use strict';
/**
 * metrics-project.js — the ONE canonical, path-safe metrics project key.
 *
 * The problem it fixes: `metrics.fire` derives its project from `basename(cwd)` when
 * no `project` is supplied (see metrics.js `_resolveProject`), which is INCONSISTENT
 * with how policies scope themselves (`resolveProjectId({cwd})` — env marker →
 * .claude-boss-project → basename → 'default'). If a hook wrote shadow-evaluation
 * events under basename while the report resolved the project via the stable id,
 * they'd read different metrics dbs and the report would show nothing.
 *
 * `metricsProjectKey(cwd)` closes that gap: it hashes the SAME stable id policies
 * use into a short, path-safe hex segment. BOTH the shadow hook and the report call
 * this and pass the result as the metrics `project`, so they always agree on the
 * metrics db — regardless of marker/env/basename. Hashing (rather than passing the
 * raw id) also guarantees a safe `metricsDir` segment: a chosen id like `orgA/api`
 * (which the resolver can return verbatim from a marker) never reaches a path.
 *
 * Scope note: this is a LOCAL, per-machine metrics store (not the shared memory
 * contract), so it uses `resolveLocalScopeId` — the never-throwing resolver that
 * degrades to basename(cwd)/'default' when there is no stable id — NOT the strict
 * `resolveProjectId` (which blocks ingestion). A local basename key is acceptable
 * here; contaminating the shared memory with one is not.
 */
const crypto = require('crypto');
const { resolveLocalScopeId } = require('./project-id.js');

/**
 * Stable, path-safe metrics project key for `cwd`: sha256 of the resolved (stable)
 * project id, truncated to 16 hex chars. No `/ \ :` — safe as a single path segment.
 * @param {string} [cwd] the session working directory
 * @returns {string} 16-char lowercase hex key
 */
function metricsProjectKey(cwd) {
  const pid = resolveLocalScopeId({ cwd });
  return crypto.createHash('sha256').update(String(pid)).digest('hex').slice(0, 16);
}

module.exports = { metricsProjectKey };
