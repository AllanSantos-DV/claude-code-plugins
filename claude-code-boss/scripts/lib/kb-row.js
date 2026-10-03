'use strict';
/**
 * kb-row.js — decode a KB `entries` row (SQLite) into an entry object. Shared by
 * brain-store.js and consolidate-datadirs.js so the two readers can never drift.
 */

/** Tolerant JSON decode for the TEXT columns (content/source/tags). */
function safeJson(str, fallback) {
  if (str == null) return fallback;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); }
  catch (err) { console.error(`[kb-row] JSON parse failed: ${err.message}`); return fallback; }
}

/**
 * Float32 BLOB → number[]. better-sqlite3 returns a Node Buffer; node:sqlite a
 * Uint8Array whose byteOffset may be non-zero — slice() yields a fresh, offset-0
 * ArrayBuffer of the exact length (vectors are written as Float32Array).
 */
function blobToVector(blob) {
  const u8 = blob instanceof Uint8Array ? blob : Uint8Array.from(blob);
  const copy = u8.slice();
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength >> 2));
}

function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    session_id: row.session_id,
    title: row.title,
    summary: row.summary,
    content: safeJson(row.content, {}),
    source: safeJson(row.source, {}),
    tags: safeJson(row.tags, []),
    confidence: row.confidence,
    access_count: row.access_count,
    recurrence: row.recurrence != null ? row.recurrence : 1,
    scope: row.scope || 'project',
    last_accessed: row.last_accessed,
    created_at: row.created_at,
  };
}

module.exports = { safeJson, blobToVector, rowToEntry };
