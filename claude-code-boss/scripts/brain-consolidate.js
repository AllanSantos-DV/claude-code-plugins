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
  // Only documents THIS plugin wrote (title+type metadata): never ones the server distilled itself
  // or a sister client wrote (pre-release audit 3.1.1).
  const all = (await backend.listDocuments({ projectId: project })).filter((d) => d.bossWritten);
  // Deletes a previous run left undone (its survivor recorded them in absorbedIds): delete them,
  // never sum their recurrence again (that inflated the count every week — audit 3.1.1).
  const pending = new Set();
  for (const d of all) for (const id of ((d.metadata && d.metadata.absorbedIds) || [])) pending.add(id);
  const leftovers = all.filter((d) => pending.has(d.id));
  const docs = all.filter((d) => !pending.has(d.id));
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
    for (const d of leftovers) {
      try { await backend.delete(d.id); deleted += 1; } catch (err) { console.error(`[brain-consolidate] pending delete ${d.id}: ${err.message}`); }
    }
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const p of plans) {
      const s = byId.get(p.survivorId);
      try {
        // METADATA-ONLY patch (get_document + same content): the listing only carries a ~200-char
        // preview and add_document replaces metadata, so rewriting the survivor from it truncated
        // its content and dropped keys (audit 3.1.1, measured on the server).
        const absorbedIds = [...(((s.metadata && s.metadata.absorbedIds) || [])), ...p.absorbedIds].slice(-200);
        await backend.patchMetadata(s.id, { recurrence: p.newRecurrence, absorbedIds });
        merged += 1;
        for (const id of p.absorbedIds) {
          try { await backend.delete(id); deleted += 1; } catch (err) { console.error(`[brain-consolidate] delete ${id} (retried on the next run): ${err.message}`); }
        }
      } catch (err) { console.error(`[brain-consolidate] apply ${p.survivorId}: ${err.message}`); }
    }
  }
  return { ok: true, project, apply, groups: plans.length, merged, deleted, pendingDeletes: leftovers.length, plans, source: 'mcp-memory' };
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
    let res;
    try { res = await consolidate({ project, apply, minSim, maxSim }); } catch (err) {
      // e.g. the memory server is down — reported, and the week is given back below.
      res = { ok: false, project, apply, groups: 0, merged: 0, deleted: 0, plans: [], reason: err.message };
    }
    if (!res.ok && apply) {
      // The weekly trigger stamped this project before spawning us — a failed run gives the week back.
      const stamp = require('path').join(require('./lib/data-dir.js').dataDir(), '.runtime', 'brain-consolidate-last.json');
      require('./curation-session.js').unmarkConsolidated(stamp, project);
    }
    try { await store.close(); } catch (e) { void e; }
    try { await require('./brain-backend.js').close(); } catch (e) { void e; }
    console.log(JSON.stringify({
      ...res,
      note: apply
        ? `Merged ${res.merged} group(s), deleted ${res.deleted} duplicate(s).`
        : `Dry run — ${res.groups} mergeable group(s). Re-run with --apply to consolidate.`,
    }, null, 2));
    process.exit(res.ok ? 0 : 1);
  })().catch(err => { console.error(`[brain-consolidate] ${err.message}`); process.exit(1); });
}

module.exports = { consolidate };
