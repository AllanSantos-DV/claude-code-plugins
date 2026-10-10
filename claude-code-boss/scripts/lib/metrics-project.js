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

/**
 * The metrics project key every curation/value reader and writer uses: the strict project id
 * made a single readable segment (`owner/repo` → `owner__repo`), else the folder name. It was
 * `basename(cwd)` everywhere — two repos with the same folder name shared one metrics.db, and
 * each reader re-derived it its own way (session root vs event cwd).
 *
 * The first time a key is used, an existing db under the OLD basename key is COPIED in (not
 * moved: another same-named project may still read it), so no history is lost.
 * @param {string} [cwd]
 * @returns {string}
 */
function metricsKeyFor(cwd) {
  const path = require('path');
  const dir = cwd ? path.resolve(cwd) : process.cwd();
  const pid = require('./project-id.js');
  const id = pid.sanitizeLogicalProjectId(pid.tryResolveProjectId({ cwd: dir }) || '');
  const legacy = path.basename(dir) || 'default';
  const key = id ? id.replace(/\//g, '__') : legacy;
  if (key !== legacy && !_adopted.has(key)) {
    _adopted.add(key);
    adoptLegacyDb(key, legacy);
  }
  return key;
}

const _adopted = new Set();

/** Copy the metrics db (and its WAL, which may hold the newest rows) from `legacy` to `key` once. */
function adoptLegacyDb(key, legacy) {
  const fs = require('fs');
  const path = require('path');
  const base = path.join(require('./data-dir.js').dataDir(), 'metrics');
  const to = path.join(base, key, 'metrics.db');
  const from = path.join(base, legacy, 'metrics.db');
  try {
    if (fs.existsSync(to) || !fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(`${from}-wal`)) fs.copyFileSync(`${from}-wal`, `${to}-wal`);
    fs.copyFileSync(from, to);
  } catch (err) {
    console.error(`[metrics] could not carry the metrics of "${legacy}" over to "${key}": ${err.message}`);
  }
}

/**
 * The same key from an already-resolved project id (the KB scope a capture was stored under):
 * `lesson.captured` was written under the raw id (`owner/repo` → a NESTED metrics dir) while the
 * session summary read basename(cwd) — they never met, so it never counted project lessons.
 * @param {string} id
 * @returns {string}
 */
function metricsKeyForId(id) {
  const pid = require('./project-id.js');
  const s = pid.sanitizeLogicalProjectId(String(id || ''));
  return s ? s.replace(/\//g, '__') : 'default';
}

/**
 * The metrics key of the CALLING SESSION: its root (CLAUDE_PROJECT_DIR) wins over the event
 * cwd, which drifts with `cd` — the same rule the writer (metrics.js) follows.
 * @param {string} [eventCwd]
 * @returns {string}
 */
function sessionMetricsKey(eventCwd) {
  const root = require('./hook-context.js').hookEnv().CLAUDE_PROJECT_DIR || eventCwd;
  return root ? metricsKeyFor(root) : 'default';
}

module.exports = { metricsProjectKey, metricsKeyFor, metricsKeyForId, sessionMetricsKey, _resetAdopted: () => _adopted.clear() };
