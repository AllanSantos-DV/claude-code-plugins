#!/usr/bin/env node
'use strict';
/**
 * lesson-promote.js — copy lessons that proved useful in more than one place from a project to the user scope.
 *
 *   node scripts/lesson-promote.js scan                 plan only: candidates with their evidence, and what was rejected and why (read-only)
 *   node scripts/lesson-promote.js apply                promote the plan (at most kb.promotion.maxPerRun per run)
 *   node scripts/lesson-promote.js list                 every promotion in the registry
 *   node scripts/lesson-promote.js undo <id>... | --all delete the copy in `__user__` and mark the promotion reverted
 *   options: --json  --data-dir <dir>  --auto (weekly background run: honours kb.promotion.enabled/mode, writes the SessionStart notice)
 *
 * Rules and limits: scripts/lib/lesson-promotion.js. The originals are never touched; a promotion is a COPY whose text went
 * through prepareForUserScope (a secret rejects it). mcp-memory backend only: that is where lessons of several projects
 * can be read together. All I/O is injected into `run*` so tests use fakes and a temp data dir.
 */
const crypto = require('crypto');
const planner = require('./lib/lesson-promotion.js');
const registry = require('./lib/promotion-registry.js');
const { USER_SENTINEL } = require('../engine/lib/scope-sanitizer.js');
const { buildEmbedText } = require('../engine/lib/embed-text.js');

const newPromotionId = () => `prom-${crypto.randomBytes(4).toString('hex')}`;

/** Project-scope lessons of every project and what the user scope holds, each embedded locally (title + summary, as the capture dedup does). */
async function gather({ backend, embedder, cfg }) {
  await backend.init({ project: USER_SENTINEL, skipEmbedder: true });
  await embedder.init();
  if (!embedder.getStatus().ready) throw new Error(`embedder unavailable: ${embedder.getStatus().error || 'not ready'}`);
  const types = new Set(cfg.types);
  const embedAll = async (docs, project) => {
    const out = [];
    for (const d of docs) {
      // Only documents this plugin wrote (title+type metadata): never ones the server distilled itself.
      if (!d.bossWritten || !types.has(d.type)) continue;
      out.push({ id: d.id, project, type: d.type, title: d.title, summary: d.summary, recurrence: d.recurrence || 1, confidence: d.confidence, createdAt: d.created_at, tags: d.tags || [], vector: await embedder.embed(buildEmbedText({ title: d.title, summary: d.summary })) });
    }
    return out;
  };
  const projects = (await backend.listProjects()).filter((p) => p !== USER_SENTINEL);
  const entries = [];
  for (const p of projects) entries.push(...await embedAll(await backend.listDocuments({ projectId: p }), p));
  const userEntries = await embedAll(await backend.listDocuments({ projectId: USER_SENTINEL }), USER_SENTINEL);
  return { projects, entries, userEntries };
}

/** Plan + the sanitized user entry of each candidate to promote (nothing is written). */
async function buildPlan(deps) {
  const { backend, readCites, simFn, cfg, dataDir } = deps;
  const g = await gather(deps);
  const plan = planner.planPromotions({ entries: g.entries, userEntries: g.userEntries, cites: await readCites(), registry: registry.load(dataDir), cfg, simFn });
  const batch = await planner.prepareBatch(plan.candidates, {
    maxPerRun: cfg.maxPerRun, newId: newPromotionId,
    getFull: async (cand) => {
      const doc = await backend.get(cand.rep.id);
      if (!doc) throw new Error(`lesson ${cand.rep.id} (${cand.rep.project}) vanished between the listing and the read`);
      return { title: doc.title, summary: doc.summary, detail: (doc.content && doc.content.detail) || '' };
    },
  });
  return { ...plan, ...batch, projects: g.projects, userCount: g.userEntries.length };
}

function recordEvent(deps, name, payload) {
  try { deps.recordEvent(name, payload); } catch (err) { console.error(`[lesson-promote] metric ${name} not recorded: ${err.message}`); }
}

/** Promote what buildPlan accepted. Never throws for one lesson: a failure is reported and the next one still runs. */
async function applyPlan(deps, built) {
  const { backend, cfg, dataDir } = deps;
  const done = []; const failed = [];
  for (const { cand, entry } of built.accepted) {
    const id = entry.baseMetadata.promotionId;
    let userEntryId;
    try {
      userEntryId = await backend.save(entry);
      const rec = {
        id, ts: deps.now(), userEntryId, rule: cand.rule,
        sources: cand.sources.map((s) => ({ project: s.project, entryId: s.id, title: s.title })),
        evidence: cand.evidence,
        thresholds: { cosine: cfg.cosine, minProjects: cfg.minProjects, minCitedSessions: cfg.minCitedSessions, minCitedProjects: cfg.minCitedProjects, minConfidence: cfg.minConfidence, types: cfg.types },
        status: 'active',
        reason: cand.reason,
      };
      try { registry.addPromotion(dataDir, rec); } catch (err) {
        // A copy nobody can undo is worse than no copy: take it back.
        await backend.delete(userEntryId);
        throw new Error(`registry write failed, copy removed: ${err.message}`);
      }
      recordEvent(deps, 'lesson.promoted', { id, rule: cand.rule, projects: cand.sources.map((s) => s.project), sourceEntryIds: cand.sources.map((s) => s.id), userEntryId, recurrence: cand.recurrence, confidence: cand.confidence });
      done.push(rec);
    } catch (err) {
      console.error(`[lesson-promote] ${cand.rule} ${cand.rep.id}: ${err.message}`);
      failed.push({ entryId: cand.rep.id, project: cand.rep.project, title: cand.rep.title, error: err.message });
    }
  }
  for (const { cand, reason } of built.rejected) {
    registry.addRejection(dataDir, { ts: deps.now(), project: cand.rep.project, entryId: cand.rep.id, title: cand.rep.title, rule: cand.rule, reason });
  }
  return { done, failed };
}

/** Delete the copy in `__user__` and mark the promotion reverted; the originals are not touched. */
async function undoPromotions(deps, ids) {
  const { backend, dataDir } = deps;
  const reg = registry.load(dataDir);
  const targets = ids === 'all' ? reg.promotions.filter((p) => p.status === 'active').map((p) => p.id) : ids;
  const out = [];
  if (targets.length) await backend.init({ project: USER_SENTINEL, skipEmbedder: true });
  for (const id of targets) {
    const p = reg.promotions.find((x) => x.id === id);
    if (!p) { out.push({ id, ok: false, error: 'unknown promotion id' }); continue; }
    if (p.status === 'reverted') { out.push({ id, ok: true, note: 'already reverted' }); continue; }
    try {
      const present = await backend.get(p.userEntryId);
      if (present) await backend.delete(p.userEntryId);
      registry.markReverted(dataDir, id, deps.now());
      recordEvent(deps, 'lesson.promotion.reverted', { id, rule: p.rule, userEntryId: p.userEntryId });
      out.push({ id, ok: true, note: present ? 'copy deleted from the user scope' : 'the copy was already gone from the user scope' });
    } catch (err) { out.push({ id, ok: false, error: err.message }); }
  }
  return out;
}

// ── CLI ──
function defaultDeps({ dataDir, cfg }) {
  const metrics = require('../engine/lib/metrics-store.js');
  const brainStore = require('../engine/brain-store.js');
  return {
    dataDir, cfg, now: Date.now,
    backend: require('../engine/brain-backend.js'),
    embedder: require('../engine/brain-embedder.js'),
    simFn: brainStore.cosineSimilarity,
    // Events of every project; the key of a row is the project folder of its metrics db.
    readCites: async () => {
      const rows = [];
      for (const p of metrics.listProjects({ dataDir })) {
        for (const r of metrics.getEventLogIsolated(p, { eventName: 'retrieve.cited', sinceTs: 1, dataDir })) rows.push({ entryId: r.payload && r.payload.entryId, project: p, sessionId: r.sessionId });
      }
      return rows;
    },
    // Its own metrics key: a promotion belongs to no session or project of work (outcome-metrics keeps it out of those counts).
    recordEvent: (name, payload) => { if (metrics.init({ project: 'promotion', dataDir })) metrics.recordMetric(name, payload, null); else throw new Error('metrics store unavailable'); },
  };
}

function fmtCandidate(c) {
  const ev = c.rule === 'R1'
    ? c.evidence.cosines.map((x) => `${x.project} (cos ${x.cosine})`).join(' | ')
    : `cited in ${c.evidence.citedSessions.length} sessions of ${c.evidence.citingProjects.length} projects; lesson from ${c.rep.project}`;
  return `  [${c.rule}] ${c.type} "${c.rep.title}" — recurrence ${c.recurrence}, confidence ${c.confidence}\n      ${ev}`;
}

function renderScan(b, cfg) {
  const L = [`projects read: ${b.projects.length}; user scope holds ${b.userCount} lesson/pattern(s); thresholds: cosine ${cfg.cosine}, >= ${cfg.minProjects} projects, >= ${cfg.minCitedSessions} sessions of >= ${cfg.minCitedProjects} projects, confidence >= ${cfg.minConfidence}`];
  L.push(`pool ${b.stats.pool} lesson(s) (${b.stats.belowConfidence} below the confidence floor); matched R1 ${b.stats.r1}, R2 ${b.stats.r2}`);
  L.push(`WOULD PROMOTE (${b.accepted.length}, max ${cfg.maxPerRun} per run):`);
  for (const a of b.accepted) L.push(fmtCandidate(a.cand), `      -> user copy: "${a.entry.title}" tags [${a.entry.tags.join(', ')}]`);
  if (b.deferred.length) { L.push(`DEFERRED to a later run (${b.deferred.length}):`); for (const c of b.deferred) L.push(fmtCandidate(c)); }
  L.push(`REJECTED BY THE SANITIZER (${b.rejected.length}):`);
  for (const r of b.rejected) L.push(`  [${r.cand.rule}] "${r.cand.rep.title}" (${r.cand.rep.project}): ${r.reason}`);
  L.push(`SKIPPED (${b.skipped.length}):`);
  for (const s of b.skipped) L.push(`  [${s.rule}] "${s.title}" (${s.project}): ${s.reason}`);
  return L.join('\n');
}

function renderList(reg) {
  if (!reg.promotions.length) return 'no promotions yet';
  return reg.promotions.map((p) => `${p.id}  ${new Date(p.ts).toISOString().slice(0, 10)}  ${p.rule}  ${p.status}${p.revertedAt ? ` (${new Date(p.revertedAt).toISOString().slice(0, 10)})` : ''}  user entry ${p.userEntryId}\n    from ${p.sources.map((s) => `${s.project}: "${s.title}"`).join(' | ')}\n    why: ${p.reason}`).join('\n');
}

/** The command, with every dependency injectable. @returns {Promise<{code:number, out:string, data?:object}>} */
async function runCommand(cmd, args, deps) {
  const { cfg, dataDir } = deps;
  if (cmd === 'list') { const r = registry.load(dataDir); return { code: 0, out: renderList(r), data: r }; }
  if (cmd === 'undo') {
    const ids = args.all ? 'all' : args.ids;
    if (ids !== 'all' && !ids.length) return { code: 2, out: 'usage: undo <id>... | undo --all' };
    const res = await undoPromotions(deps, ids);
    return { code: res.every((r) => r.ok) ? 0 : 1, out: res.map((r) => `${r.id}: ${r.ok ? r.note : `FAILED ${r.error}`}`).join('\n') || 'nothing to undo', data: res };
  }
  if (cmd !== 'scan' && cmd !== 'apply') return { code: 2, out: 'usage: lesson-promote.js scan | apply | list | undo <id>...|--all  [--json] [--data-dir <dir>] [--auto]' };
  if (deps.backend.peekMode() !== 'mcp-memory') return { code: 0, out: 'skipped: lesson promotion reads the lessons of every project together, which only the mcp-memory backend allows', data: { ok: true, skipped: 'backend-not-mcp-memory' } };
  if (args.auto && !cfg.enabled) return { code: 0, out: 'skipped: kb.promotion.enabled is false', data: { ok: true, skipped: 'disabled' } };
  const mode = args.auto ? cfg.mode : (cmd === 'apply' ? 'apply' : 'dry-run');
  if (mode === 'dry-run') return planAndRun(deps, args, cmd, mode);
  const run = await registry.withRunLock(dataDir, () => planAndRun(deps, args, cmd, mode));
  return run.busy ? { code: 1, out: `another promotion run is in progress (${run.reason}) — nothing was copied`, data: { ok: false, busy: true } } : run;
}

async function planAndRun(deps, args, cmd, mode) {
  const { cfg, dataDir } = deps;
  const built = await buildPlan(deps);
  if (mode === 'dry-run') {
    const out = renderScan(built, cfg);
    if (args.auto) {
      const file = require('path').join(dataDir, 'promotions', 'last-scan.json');
      require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
      require('../engine/lib/atomic-write.js').writeJsonAtomic(file, { ts: deps.now(), mode: 'dry-run', text: out });
    }
    return { code: 0, out, data: { ok: true, mode, wouldPromote: built.accepted.length, rejected: built.rejected.length, skipped: built.skipped.length } };
  }
  const res = await applyPlan(deps, built);
  if (args.auto && res.done.length) registry.writeNotice(dataDir, res.done.map((p) => p.id));
  const lines = [renderScan(built, cfg), '', `PROMOTED ${res.done.length}: ${res.done.map((p) => p.id).join(', ') || '-'}  FAILED ${res.failed.length}`];
  for (const f of res.failed) lines.push(`  ${f.project} "${f.title}": ${f.error}`);
  return { code: res.failed.length ? 1 : 0, out: lines.join('\n'), data: { ok: !res.failed.length, ...res } };
}

function parseArgs(argv) {
  const a = { cmd: argv[0] || '', ids: [], all: false, json: false, auto: false, dataDir: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--all') a.all = true;
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--auto') a.auto = true;
    else if (argv[i] === '--data-dir') a.dataDir = argv[++i];
    else if (argv[i] === '--cwd') i++; // the weekly trigger passes it; the promotion reads every project, not one
    else a.ids.push(argv[i]);
  }
  return a;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = args.dataDir || require('../engine/lib/data-dir.js').dataDir();
    const cfg = require('../engine/lib/brain-config.js').getLessonPromotion();
    const deps = defaultDeps({ dataDir, cfg });
    let res;
    try { res = await runCommand(args.cmd, args, deps); } catch (err) {
      console.error(`[lesson-promote] ${err.message}`);
      // The weekly trigger stamped before spawning: a failed run (server or embedder down) gives the week back.
      if (args.auto) registry.unmarkPromotionRun(dataDir);
      res = { code: 1, out: `FAILED: ${err.message}`, data: { ok: false, error: err.message } };
    }
    try { await deps.backend.close(); } catch (e) { void e; }
    console.log(args.json && res.data ? JSON.stringify(res.data, null, 2) : res.out);
    process.exit(res.code);
  })().catch((err) => { console.error(`[lesson-promote] ${err.message}`); process.exit(1); });
}

module.exports = { gather, buildPlan, applyPlan, undoPromotions, runCommand, renderScan, parseArgs, newPromotionId };
