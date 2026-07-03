/**
 * consolidate-plan.js — pure merge planner for KB hygiene (F3 #5).
 *
 * Given entries (each with an embedding vector + type + recurrence + confidence +
 * createdAt) and a similarity function, group NEAR-duplicates (cosine in
 * [minSim, maxSim], same type) and decide, per group, which entry survives and
 * which are absorbed. The absorbed entries' recurrence is summed into the
 * survivor so the signal isn't lost.
 *
 * Pure + deterministic → unit-tested with a synthetic similarity function. The
 * runner (brain-consolidate.js) supplies real vectors + cosineSimilarity and
 * applies the plan.
 */
'use strict';

// Union-find for grouping transitively-similar entries.
function _find(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}
function _union(parent, a, b) {
  const ra = _find(parent, a), rb = _find(parent, b);
  if (ra !== rb) parent[ra] = rb;
}

/**
 * Pick the survivor of a group: highest recurrence, then highest confidence,
 * then oldest (smallest createdAt), then smallest id — fully deterministic.
 */
function _pickSurvivor(group) {
  return group.slice().sort((a, b) =>
    (b.recurrence || 1) - (a.recurrence || 1)
    || (b.confidence || 0) - (a.confidence || 0)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    || String(a.id).localeCompare(String(b.id)),
  )[0];
}

/**
 * @param {Array<{id,type,recurrence,confidence,createdAt,vector:number[]|null}>} entries
 * @param {(a,b)=>number} simFn  cosine similarity of two vectors
 * @param {{minSim?:number, maxSim?:number}} [opts]
 * @returns {Array<{survivorId:string, absorbedIds:string[], newRecurrence:number, size:number, type:string}>}
 */
function planMerges(entries, simFn, opts = {}) {
  const minSim = typeof opts.minSim === 'number' ? opts.minSim : 0.7;
  const maxSim = typeof opts.maxSim === 'number' ? opts.maxSim : 0.9;
  const items = (entries || []).filter(e => e && e.vector && e.vector.length);
  const n = items.length;
  if (n < 2) return [];

  const parent = items.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (items[i].type !== items[j].type) continue;
      let s;
      try { s = simFn(items[i].vector, items[j].vector); }
      catch { continue; }
      if (typeof s === 'number' && s >= minSim && s <= maxSim) _union(parent, i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = _find(parent, i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  const plans = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const survivor = _pickSurvivor(group);
    // Survivor-anchored (complete-linkage on the survivor): only absorb members
    // that are themselves near the SURVIVOR in-band. Union-find is single-linkage,
    // so a transitive chain could otherwise pull in an entry with sim(survivor, e)
    // < minSim — deleting something that isn't a near-duplicate of what it merges
    // into. Chained-but-dissimilar entries are left untouched.
    const absorbed = [];
    for (const e of group) {
      if (e.id === survivor.id) continue;
      let s;
      try { s = simFn(survivor.vector, e.vector); }
      catch { continue; }
      if (typeof s === 'number' && s >= minSim && s <= maxSim) absorbed.push(e);
    }
    if (absorbed.length === 0) continue;
    const newRecurrence = (survivor.recurrence || 1)
      + absorbed.reduce((sum, e) => sum + (e.recurrence || 1), 0);
    plans.push({
      survivorId: survivor.id,
      absorbedIds: absorbed.map(e => e.id),
      newRecurrence,
      size: absorbed.length + 1,
      type: survivor.type,
    });
  }
  // Deterministic order: biggest groups first, then by survivor id.
  plans.sort((a, b) => b.size - a.size || String(a.survivorId).localeCompare(String(b.survivorId)));
  return plans;
}

module.exports = { planMerges, _pickSurvivor };
