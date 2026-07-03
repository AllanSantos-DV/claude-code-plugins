#!/usr/bin/env node
/**
 * brain-consolidate.js — KB hygiene job (F3 #5).
 *
 * Finds near-duplicate lessons (cosine similarity in [minSim, maxSim], same type)
 * using the STORED embedding vectors (no model load), merges each group into one
 * survivor summing recurrence, deletes the absorbed entries, and logs what merged.
 *
 * Safe by default: DRY-RUN unless `--apply` is passed. Triggered manually (CLI /
 * dashboard button) or by a weekly SessionStart cooldown (curation-session.js).
 *
 *   node scripts/brain-consolidate.js [--project <k>] [--apply] [--min-sim 0.7] [--max-sim 0.9]
 */
'use strict';

const path = require('path');
const store = require('./brain-store.js');
const { planMerges } = require('./lib/consolidate-plan.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

/**
 * Run consolidation for a project. Injectable store/simFn for tests.
 * @returns {Promise<{ok, project, apply, groups, merged, deleted, plans, reason?}>}
 */
async function consolidate({ project, apply = false, minSim = 0.7, maxSim = 0.9, _store } = {}) {
  const s = _store || store;
  await s.init({ project, skipEmbedder: true });
  if (s.getStorageType() !== 'sqlite') {
    return { ok: true, project, apply, groups: 0, merged: 0, deleted: 0, plans: [], reason: 'not-sqlite' };
  }
  const entries = s.listWithVectors(project);
  const plans = planMerges(entries, s.cosineSimilarity, { minSim, maxSim });

  let merged = 0, deleted = 0;
  if (apply) {
    for (const p of plans) {
      try {
        const r = s.applyConsolidation(p.survivorId, p.newRecurrence, p.absorbedIds);
        if (r && r.ok) { merged += 1; deleted += r.deleted; }
      } catch (err) { console.error(`[brain-consolidate] apply ${p.survivorId}: ${err.message}`); }
    }
  }

  return { ok: true, project, apply, groups: plans.length, merged, deleted, plans };
}

if (require.main === module) {
  (async () => {
    const project = arg('project', path.basename(process.cwd()));
    const apply = hasFlag('apply');
    const minSim = parseFloat(arg('min-sim', '0.7'));
    const maxSim = parseFloat(arg('max-sim', '0.9'));
    const res = await consolidate({ project, apply, minSim, maxSim });
    try { await store.close(); } catch (e) { void e; }
    console.log(JSON.stringify({
      ...res,
      note: apply
        ? `Merged ${res.merged} group(s), deleted ${res.deleted} duplicate(s).`
        : `Dry run — ${res.groups} mergeable group(s). Re-run with --apply to consolidate.`,
    }, null, 2));
    process.exit(0);
  })().catch(err => { console.error(`[brain-consolidate] ${err.message}`); process.exit(1); });
}

module.exports = { consolidate };
