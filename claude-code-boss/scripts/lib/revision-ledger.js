'use strict';
/**
 * revision-ledger.js — per-project APPEND-ONLY audit trail of APPLIED policy
 * self-updates (Fase 3 micro-C).
 *
 * Every time a user EXPLICITLY applies a self-update (today: the reversible
 * demote-to-advisory in policy_apply_candidate), one entry is appended here so
 * there is a durable, auditable record of what changed, when, and how the
 * policy's identity moved (sourceHash + activationId, before → after).
 *
 * Honesty / safety contract (mirrors the other JSON stores):
 *   - Append-only from the caller's view: appendRevision only ever ADDS.
 *   - NO code, snippets, globs, or free-form policy text are stored — only the
 *     transition metadata below. A malformed caller can never smuggle snippets
 *     in: normalizeEntry keeps ONLY the known keys.
 *   - Never throws: load returns an empty shape on any error; appendRevision
 *     returns a boolean; both console.error on failure.
 *
 * Storage: one JSON file per project under
 *   <dataDir>/policy-revisions/<project>/ledger.json
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');
const { sanitizeProjectId } = require('./project-id.js');

/** Cap of retained revisions per project (newest kept) — bounds file growth. */
const MAX_REVISIONS = 500;
/** Hard cap on the free-text note so a caller cannot bloat the ledger. */
const MAX_NOTE_CHARS = 500;

/** Project id → a single safe path segment (never empty, never a traversal). */
function safeProject(projectId) {
  return sanitizeProjectId(projectId) || 'default';
}

/** The per-project policy-revisions directory. */
function revisionsDir(dataDir, projectId) {
  return path.join(dataDir, 'policy-revisions', safeProject(projectId));
}

/** @returns {string} the ledger file for a project. */
function ledgerPath(dataDir, projectId) {
  return path.join(revisionsDir(dataDir, projectId), 'ledger.json');
}

/**
 * Load the ledger for a project. On a missing/corrupt/unreadable file returns
 * the empty shape `{ revisions: [] }` (never throws).
 * @returns {{revisions: Array<object>}}
 */
function load(dataDir, projectId) {
  const p = ledgerPath(dataDir, projectId);
  try {
    if (!fs.existsSync(p)) return { revisions: [] };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && Array.isArray(obj.revisions) ? obj : { revisions: [] };
  } catch (err) {
    console.error(`[revision-ledger] load failed (${p}): ${err.message}`);
    return { revisions: [] };
  }
}

/** A nullable string field → String or null (never an object/array). */
function strOrNull(v) {
  return v == null ? null : String(v);
}

/**
 * Normalize an incoming entry to the stored shape — defensively, so a malformed
 * caller can never write snippets or unexpected keys into the ledger. ONLY the
 * transition-metadata fields survive.
 * @returns {object}
 */
function normalizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const note = e.note == null ? '' : String(e.note).slice(0, MAX_NOTE_CHARS);
  return {
    ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
    policyId: strOrNull(e.policyId),
    action: strOrNull(e.action),
    beforeSourceHash: strOrNull(e.beforeSourceHash),
    afterSourceHash: strOrNull(e.afterSourceHash),
    beforeActivationId: strOrNull(e.beforeActivationId),
    afterActivationId: strOrNull(e.afterActivationId),
    note,
  };
}

/**
 * Append one revision entry for a project (newest-capped). Best-effort,
 * last-writer-wins (like the other JSON stores). Returns false + console.error
 * on failure; never throws.
 * @returns {boolean}
 */
function appendRevision(dataDir, projectId, entry) {
  try {
    const store = load(dataDir, projectId);
    store.revisions.push(normalizeEntry(entry));
    if (store.revisions.length > MAX_REVISIONS) {
      store.revisions = store.revisions.slice(store.revisions.length - MAX_REVISIONS);
    }
    writeJsonAtomic(ledgerPath(dataDir, projectId), store);
    return true;
  } catch (err) {
    console.error(`[revision-ledger] appendRevision failed: ${err.message}`);
    return false;
  }
}

/**
 * List stored revisions for a project, newest first. `policyId` (optional)
 * filters to one policy. Never throws.
 * @returns {Array<object>}
 */
function listRevisions(dataDir, projectId, { policyId } = {}) {
  const store = load(dataDir, projectId);
  let out = store.revisions.slice();
  if (policyId != null && policyId !== '') {
    const want = String(policyId);
    out = out.filter((r) => r && String(r.policyId) === want);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

module.exports = {
  revisionsDir,
  ledgerPath,
  load,
  appendRevision,
  listRevisions,
  MAX_REVISIONS,
  MAX_NOTE_CHARS,
};
