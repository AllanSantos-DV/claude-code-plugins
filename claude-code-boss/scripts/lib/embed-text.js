'use strict';
/**
 * embed-text.js — Canonical text representation used to EMBED a KB entry.
 *
 * Title + summary ONLY. Including the (often long, term-dense) `detail` dilutes
 * the embedding: measured cos(query, title+summary)=0.51 vs title+summary+detail=0.13
 * for the same entry, pushing entries below the retrieval gate. The detail is still
 * stored and shown on retrieval — it just must not steer the vector.
 *
 * Used by every write path (brain_store, capture_lesson, native index, reembed) so
 * the stored vector is consistent and reproducible across all of them.
 */
function buildEmbedText(entry = {}) {
  const title = String(entry.title || '').trim();
  const summary = String(entry.summary || '').trim();
  if (title && summary) return `${title}. ${summary}`;
  return title || summary;
}

module.exports = { buildEmbedText };
