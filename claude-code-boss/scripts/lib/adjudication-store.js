'use strict';
/**
 * adjudication-store.js — per-project store of policy-adjudication DISPOSITIONS
 * (Fase 3 micro-B0, the "judge" loop).
 *
 * A disposition is the HONEST, best-effort record of a `policy-auditor` sub-agent's
 * judgment over a SAMPLED set of the CURRENT code occurrences that a glob/shadow
 * policy matches — persisted so `policy_adjudication_report` can read it back.
 *
 * Honesty contract (mirrors the MCP tools):
 *   - This is a "current-snapshot occurrence disposition", NOT a false-positive rate.
 *   - Only tallies + coverage + provenance are stored. NO code snippets are persisted
 *     here (the redacted context lives only in the ephemeral bundle the auditor reads).
 *
 * Storage: one JSON file per project under
 *   <dataDir>/adjudications/<project>/dispositions.json
 * (the SAME `<dataDir>/adjudications/<project>/` dir the trusted prepare tool drops
 * its ephemeral `bundle-<hash>.json` files into, so paths agree on sanitization).
 *
 * Never throws: load returns an empty shape on any error, save returns a boolean —
 * both console.error on failure (per the house store convention).
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');
const { sanitizeProjectId } = require('./project-id.js');

/** Cap of retained dispositions per project (newest kept) — bounds file growth. */
const MAX_DISPOSITIONS = 200;

/** Project id → a single safe path segment (never empty, never a traversal). */
function safeProject(projectId) {
  return sanitizeProjectId(projectId) || 'default';
}

/**
 * The per-project adjudication directory (bundles + dispositions live here).
 * Exported so the prepare tool writes bundles under the exact same sanitized key.
 * @returns {string}
 */
function adjudicationDir(dataDir, projectId) {
  return path.join(dataDir, 'adjudications', safeProject(projectId));
}

/** @returns {string} the dispositions registry file for a project. */
function dispositionsPath(dataDir, projectId) {
  return path.join(adjudicationDir(dataDir, projectId), 'dispositions.json');
}

/**
 * Load the dispositions registry for a project. On a missing/corrupt/unreadable
 * file returns the empty shape `{ dispositions: [] }` (never throws).
 * @returns {{dispositions: Array<object>}}
 */
function load(dataDir, projectId) {
  const p = dispositionsPath(dataDir, projectId);
  try {
    if (!fs.existsSync(p)) return { dispositions: [] };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && Array.isArray(obj.dispositions) ? obj : { dispositions: [] };
  } catch (err) {
    console.error(`[adjudication-store] load failed (${p}): ${err.message}`);
    return { dispositions: [] };
  }
}

/** Coerce a value to a finite non-negative integer count (defaults to 0). */
function num(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Normalize an incoming record to the stored shape — defensively, so a malformed
 * caller can never write snippets or unexpected keys into the registry. ONLY the
 * honest tally/coverage/provenance fields survive; NO code context is persisted.
 * @returns {object}
 */
function normalizeRecord(record) {
  const r = record && typeof record === 'object' ? record : {};
  const c = r.counts && typeof r.counts === 'object' ? r.counts : {};
  const cov = r.coverage && typeof r.coverage === 'object' ? r.coverage : {};
  const prov = r.provenance && typeof r.provenance === 'object' ? r.provenance : {};
  const out = {
    policyId: r.policyId != null ? String(r.policyId) : null,
    manifestHash: r.manifestHash != null ? String(r.manifestHash) : null,
    ts: Number.isFinite(r.ts) ? r.ts : Date.now(),
    counts: {
      legit: num(c.legit),
      problem: num(c.problem),
      uncertain: num(c.uncertain),
      injectionSuspected: num(c.injectionSuspected),
      total: num(c.total),
    },
    coverage: { sampled: num(cov.sampled), eligible: num(cov.eligible) },
    provenance: {
      scannerVersion: prov.scannerVersion != null ? String(prov.scannerVersion) : null,
      promptVersion: prov.promptVersion != null ? String(prov.promptVersion) : null,
    },
  };
  if (r.activationId != null) out.activationId = String(r.activationId);
  return out;
}

/**
 * Persist one disposition for a project (append, newest-capped). Best-effort,
 * last-writer-wins (like the other JSON stores). Returns false + console.error on
 * failure; never throws.
 * @returns {boolean}
 */
function saveDisposition(dataDir, projectId, record) {
  try {
    const store = load(dataDir, projectId);
    store.dispositions.push(normalizeRecord(record));
    if (store.dispositions.length > MAX_DISPOSITIONS) {
      store.dispositions = store.dispositions.slice(store.dispositions.length - MAX_DISPOSITIONS);
    }
    writeJsonAtomic(dispositionsPath(dataDir, projectId), store);
    return true;
  } catch (err) {
    console.error(`[adjudication-store] saveDisposition failed: ${err.message}`);
    return false;
  }
}

/**
 * List stored dispositions for a project, newest first. `policyId` (optional)
 * filters to one policy. Never throws.
 * @returns {Array<object>}
 */
function listDispositions(dataDir, projectId, { policyId } = {}) {
  const store = load(dataDir, projectId);
  let out = store.dispositions.slice();
  if (policyId != null && policyId !== '') {
    const want = String(policyId);
    out = out.filter((d) => d && String(d.policyId) === want);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

module.exports = {
  adjudicationDir,
  dispositionsPath,
  load,
  saveDisposition,
  listDispositions,
  MAX_DISPOSITIONS,
};
