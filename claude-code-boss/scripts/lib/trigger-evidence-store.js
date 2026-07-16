'use strict';
/**
 * trigger-evidence-store.js — per-project, OPT-IN, TTL-limited queue of PROSPECTIVE
 * trigger evidence (Fase 3 micro-B1).
 *
 * micro-A records shadow `trigger`/`pass` OUTCOMES but drops the code (privacy), so
 * the actual triggering edits can't be adjudicated. This store closes that gap: when
 * (and ONLY when) the user opts in (`captureTriggerEvidence.enabled` — DEFAULT OFF),
 * the shadow hook appends a bounded, REDACTED record of the ADDED text that would have
 * triggered a shadow policy. The judge (`policy_adjudication_prepare source:'triggers'`)
 * then reads these back to adjudicate the REAL trigger proposals — not just current code.
 *
 * Privacy contract (mirrors the honesty framing of the adjudication tools):
 *   - OPT-IN: nothing is captured unless the user turns capture on.
 *   - BOUNDED: only the 6 fields below survive normalization — never a raw/absolute
 *     path, never an un-redacted snippet, never the tool name.
 *   - REDACTED + CAPPED: the added snippet is redacted (lib/redact.js) AND capped to
 *     MAX_SNIPPET_CHARS, defensively AGAIN here even though the caller already redacts.
 *   - TTL + CAPPED: expired records (older than ttlDays) are purged on every write, and
 *     the queue is capped to the newest maxPerProject — so it never grows without bound.
 *   - LOCAL + PURGEABLE: it lives on this machine and `purgeEvidence` (and the
 *     `policy_trigger_evidence_purge` MCP tool) let the user delete it any time.
 *
 * Record shape (ONLY these fields are ever persisted):
 *   { eventId, activationId, sourceHash, file, addedSnippet, ts }
 *   - eventId      random hex id for one captured triggering Edit proposal;
 *   - activationId the shadow policy's telemetry key (so the judge can find its evidence);
 *   - sourceHash   the policy definition hash at capture time;
 *   - file         PROJECT-RELATIVE path only (absolute/traversal is reduced to a basename);
 *   - addedSnippet REDACTED + capped ADDED text (the evidence of what triggered);
 *   - ts           capture time (ms).
 *
 * Storage: one JSON file per project under
 *   <dataDir>/trigger-evidence/<sanitizedProject>/queue.json
 * keyed by `sanitizeProjectId(projectId)` — the SAME sanitization adjudication-store
 * uses, so the hook-write and the prepare-read agree on the project segment.
 *
 * Never throws: load returns an empty shape on any error, append returns a boolean,
 * purge returns a count — all console.error on failure (per the house store convention).
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');
const { sanitizeProjectId } = require('./project-id.js');
const { redact } = require('./redact.js');

/** Cap of retained evidence per project (newest kept) — bounds file growth. */
const MAX_EVIDENCE_PER_PROJECT = 500;
/** Default retention window: records older than this are purged on write. */
const DEFAULT_TTL_DAYS = 7;
/** Hard ceiling on a stored snippet (chars) — bounds each record + the queue. */
const MAX_SNIPPET_CHARS = 2000;

const MS_PER_DAY = 86_400_000;

/** Project id → a single safe path segment (never empty, never a traversal). */
function safeProject(projectId) {
  return sanitizeProjectId(projectId) || 'default';
}

/**
 * The per-project trigger-evidence directory. Exported so callers can locate the queue.
 * @returns {string}
 */
function evidenceDir(dataDir, projectId) {
  return path.join(dataDir, 'trigger-evidence', safeProject(projectId));
}

/** @returns {string} the evidence queue file for a project. */
function queuePath(dataDir, projectId) {
  return path.join(evidenceDir(dataDir, projectId), 'queue.json');
}

/**
 * Load the evidence queue for a project. On a missing/corrupt/unreadable file
 * returns the empty shape `{ evidence: [] }` (never throws).
 * @returns {{evidence: Array<object>}}
 */
function load(dataDir, projectId) {
  const p = queuePath(dataDir, projectId);
  try {
    if (!fs.existsSync(p)) return { evidence: [] };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && Array.isArray(obj.evidence) ? obj : { evidence: [] };
  } catch (err) {
    console.error(`[trigger-evidence-store] load failed (${p}): ${err.message}`);
    return { evidence: [] };
  }
}

/** Coerce a value to a finite non-negative integer (defaults to 0). */
function num(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Reduce a path to a PROJECT-RELATIVE, POSIX-normalized form. An absolute path,
 * a drive-qualified path, or one with a `..` segment is collapsed to its basename
 * so the store NEVER persists an absolute path or a traversal — only a relative file.
 * @param {*} file
 * @returns {string}
 */
function safeRelFile(file) {
  const s = typeof file === 'string' ? file : '';
  if (!s) return '';
  let norm = s.replace(/\\/g, '/');
  while (norm.startsWith('./')) norm = norm.slice(2);
  const escapes = path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm)
    || norm.split('/').some((seg) => seg === '..');
  return escapes ? path.posix.basename(norm) : norm;
}

/**
 * Normalize an incoming record to the stored shape — defensively, so a malformed
 * caller can never write an absolute path, an un-redacted snippet, or unexpected
 * keys into the queue. ONLY the 6 honest fields survive; the snippet is redacted
 * AND capped to MAX_SNIPPET_CHARS even though the caller is expected to redact.
 * @returns {object}
 */
function normalizeRecord(record) {
  const r = record && typeof record === 'object' ? record : {};
  const snippet = redact(String(r.addedSnippet != null ? r.addedSnippet : '')).text.slice(0, MAX_SNIPPET_CHARS);
  return {
    eventId: r.eventId != null ? String(r.eventId) : '',
    activationId: r.activationId != null ? String(r.activationId) : null,
    sourceHash: r.sourceHash != null ? String(r.sourceHash) : null,
    file: safeRelFile(r.file),
    addedSnippet: snippet,
    ts: Number.isFinite(r.ts) ? r.ts : Date.now(),
  };
}

/**
 * Append one trigger-evidence record for a project. Normalizes defensively, PURGES
 * expired records (older than `ttlDays` relative to now) on write, then caps the
 * queue to the newest `maxPerProject` by ts, and publishes atomically. Best-effort,
 * last-writer-wins (like the other JSON stores). Returns false + console.error on
 * failure; never throws.
 * @param {string} dataDir
 * @param {string} projectId
 * @param {object} record
 * @param {{ttlDays?:number, maxPerProject?:number}} [opts]
 * @returns {boolean}
 */
function appendEvidence(dataDir, projectId, record, { ttlDays = DEFAULT_TTL_DAYS, maxPerProject = MAX_EVIDENCE_PER_PROJECT } = {}) {
  try {
    const store = load(dataDir, projectId);
    const rec = normalizeRecord(record);
    // PURGE expired (ts < now - ttlDays) on write. ttlDays<=0 → no TTL (keep all).
    const ttlMs = num(ttlDays) * MS_PER_DAY;
    const cutoff = ttlMs > 0 ? Date.now() - ttlMs : -Infinity;
    let list = store.evidence.filter((e) => e && Number.isFinite(e.ts) && e.ts >= cutoff);
    list.push(rec);
    // Cap to the NEWEST maxPerProject by ts.
    const cap = num(maxPerProject) > 0 ? num(maxPerProject) : MAX_EVIDENCE_PER_PROJECT;
    if (list.length > cap) {
      list = list.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(list.length - cap);
    }
    writeJsonAtomic(queuePath(dataDir, projectId), { evidence: list });
    return true;
  } catch (err) {
    console.error(`[trigger-evidence-store] appendEvidence failed: ${err.message}`);
    return false;
  }
}

/**
 * List stored evidence for a project, newest first. Optional filters: `activationId`
 * (one policy's evidence) and `sinceTs` (records at/after a timestamp). Never throws.
 * @returns {Array<object>}
 */
function listEvidence(dataDir, projectId, { activationId, sinceTs } = {}) {
  const store = load(dataDir, projectId);
  let out = store.evidence.slice();
  if (activationId != null && activationId !== '') {
    const want = String(activationId);
    out = out.filter((e) => e && String(e.activationId) === want);
  }
  if (Number.isFinite(sinceTs)) {
    out = out.filter((e) => e && Number.isFinite(e.ts) && e.ts >= sinceTs);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // newest first
  return out;
}

/**
 * Purge stored evidence for a project. With NO filter, deletes ALL of the project's
 * evidence. `activationId` narrows to one policy; `olderThanTs` narrows to records
 * strictly older than a timestamp; both together delete records matching BOTH. Returns
 * the number of records removed. Never throws (console.error + returns 0 on failure).
 * @returns {number}
 */
function purgeEvidence(dataDir, projectId, { activationId, olderThanTs } = {}) {
  try {
    const store = load(dataDir, projectId);
    const before = store.evidence.length;
    const hasAct = activationId != null && activationId !== '';
    const hasTs = Number.isFinite(olderThanTs);
    const want = hasAct ? String(activationId) : null;
    // Keep a record UNLESS it matches ALL provided filters (delete matching). With no
    // filter both predicates default true → shouldDelete true → the whole queue clears.
    const kept = store.evidence.filter((e) => {
      if (!e) return false;
      const matchesAct = hasAct ? String(e.activationId) === want : true;
      const matchesTs = hasTs ? (Number.isFinite(e.ts) && e.ts < olderThanTs) : true;
      return !(matchesAct && matchesTs);
    });
    const removed = before - kept.length;
    if (removed > 0) writeJsonAtomic(queuePath(dataDir, projectId), { evidence: kept });
    return removed;
  } catch (err) {
    console.error(`[trigger-evidence-store] purgeEvidence failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  evidenceDir,
  queuePath,
  load,
  normalizeRecord,
  appendEvidence,
  listEvidence,
  purgeEvidence,
  safeRelFile,
  MAX_EVIDENCE_PER_PROJECT,
  DEFAULT_TTL_DAYS,
  MAX_SNIPPET_CHARS,
};
