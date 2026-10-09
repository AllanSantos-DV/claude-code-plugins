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

const store = require('./brain-store.js');
const { planMerges } = require('./lib/consolidate-plan.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

/**
 * Consolidation on the mcp-memory backend (BACKLOG Q54): the lessons live on the SERVER, which
 * exposes no vectors — so each entry is embedded locally (title + summary, the same text the
 * capture dedup uses), the same planner groups them, and applying a group first upserts the
 * survivor with the summed recurrence, then deletes the absorbed documents (a failed delete never
 * loses the count). The owner chose real deletes (months of dry-runs, no loss).
 * @returns {Promise<{ok, project, apply, groups, merged, deleted, plans, source, reason?}>}
 */
async function consolidateRemote({ project, apply, minSim, maxSim, backend, embedder }) {
  await backend.init({ project, skipEmbedder: true });
  const docs = await backend.listDocuments({ projectId: project });
  const emb = embedder || require('./brain-embedder.js');
  await emb.init();
  if (!emb.getStatus().ready) {
    return { ok: false, project, apply, groups: 0, merged: 0, deleted: 0, plans: [], source: 'mcp-memory', reason: `embedder unavailable: ${emb.getStatus().error || 'not ready'}` };
  }
  const { buildEmbedText } = require('./lib/embed-text.js');
  const entries = [];
  for (const d of docs) {
    entries.push({ id: d.id, type: d.type, recurrence: d.recurrence || 1, confidence: d.confidence, createdAt: d.created_at, vector: await emb.embed(buildEmbedText({ title: d.title, summary: d.summary })) });
  }
  const plans = planMerges(entries, store.cosineSimilarity, { minSim, maxSim });
  let merged = 0, deleted = 0;
  if (apply) {
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const p of plans) {
      const s = byId.get(p.survivorId);
      try {
        await backend.save({ id: s.id, title: s.title, summary: s.summary, content: { detail: (s.content && s.content.detail) || s.summary }, type: s.type, tags: s.tags || [], confidence: s.confidence, scope: s.scope || 'project', projectId: project, recurrence: p.newRecurrence });
        merged += 1;
        for (const id of p.absorbedIds) {
          try { await backend.delete(id); deleted += 1; } catch (err) { console.error(`[brain-consolidate] delete ${id}: ${err.message}`); }
        }
      } catch (err) { console.error(`[brain-consolidate] apply ${p.survivorId}: ${err.message}`); }
    }
  }
  return { ok: true, project, apply, groups: plans.length, merged, deleted, plans, source: 'mcp-memory' };
}

/**
 * Run consolidation for a project. Injectable store/backend/embedder for tests.
 * @returns {Promise<{ok, project, apply, groups, merged, deleted, plans, reason?}>}
 */
async function consolidate({ project, apply = false, minSim = 0.7, maxSim = 0.9, _store, _backend, _embedder } = {}) {
  const backend = _backend || (_store ? null : require('./brain-backend.js'));
  if (backend && backend.peekMode() === 'mcp-memory') {
    return consolidateRemote({ project, apply, minSim, maxSim, backend, embedder: _embedder });
  }
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
    // The STRICT project id of --cwd (the KB has been keyed by it since 2.29.1) — not the folder
    // name; an explicit --project is still sanitized (BACKLOG Q54).
    const { sanitizeProjectId, tryResolveProjectId } = require('./lib/project-id.js');
    const cwd = arg('cwd', process.cwd());
    const project = arg('project', '') ? sanitizeProjectId(arg('project', '')) : tryResolveProjectId({ cwd });
    if (!project) {
      console.log(JSON.stringify({ ok: true, skipped: 'no-project-id', cwd, note: 'This folder has no project id — memory is off here, nothing to consolidate.' }));
      process.exit(0);
    }
    const apply = hasFlag('apply');
    const minSim = parseFloat(arg('min-sim', '0.7'));
    const maxSim = parseFloat(arg('max-sim', '0.9'));
    const res = await consolidate({ project, apply, minSim, maxSim });
    try { await store.close(); } catch (e) { void e; }
    try { await require('./brain-backend.js').close(); } catch (e) { void e; }
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
