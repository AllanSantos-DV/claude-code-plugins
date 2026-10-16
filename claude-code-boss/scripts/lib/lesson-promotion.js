'use strict';
/**
 * lesson-promotion.js — pure planner: which project-scope lessons have shown they are useful in more than one place
 * and should be COPIED to the user scope (`__user__`). Entries, vectors, events and the registry come in injected;
 * nothing here touches a backend, an embedder or the disk (scripts/lesson-promote.js does the I/O).
 *
 * Two rules, either one is enough:
 *   R1 — the SAME lesson (same type, cosine of title+summary >= cosine) exists in >= minProjects distinct projects.
 *   R2 — one lesson was CITED (retrieve.cited) in >= minCitedSessions sessions of >= minCitedProjects distinct projects.
 *
 * Evidence is counted per entry, never per capture: R1 keeps the best entry of each project as a source (a project that
 * captured the same lesson twice is still one project), and R2 only counts events that carry a session id.
 */
const { _pickSurvivor } = require('./consolidate-plan.js');
const { USER_SENTINEL, USER_TAG_HINTS, prepareForUserScope, sanitizeForUserScope } = require('../../engine/lib/scope-sanitizer.js');

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'apply',
  cosine: 0.9,
  minProjects: 2,
  minCitedSessions: 2,
  minCitedProjects: 2,
  maxPerRun: 5,
  intervalDays: 7,
  types: Object.freeze(['lesson', 'pattern']),
  minConfidence: 0.7,
});
const MAX_TAGS = 5;
const MIN_NAME_LEN = 5; // a repo name shorter than this would mangle ordinary words when scrubbed out of the text

/** The metrics key of a KB project id (`owner/repo` → `owner__repo`), as metrics-project.metricsKeyFor derives it. */
const metricsKeyOfProject = (id) => String(id || '').replace(/\//g, '__');

/**
 * What "a distinct project" means: the last segment of the id (`owner/repo`, a metrics key `owner__repo` or a bare folder
 * name all name the same repo). Older KBs are keyed by folder name, newer ones by `owner/repo`; counting those as two
 * projects would promote a lesson on evidence from one repo. Two repos of one name under different owners count as one — the
 * conservative side.
 */
const projectIdentity = (id) => String(id || '').split(/\/|__/).filter(Boolean).pop()?.toLowerCase() || '';

const rankCompare = (a, b) => (_pickSurvivor([a, b]) === a ? -1 : 1);
const round = (v) => +Number(v).toFixed(3);

/** Citing sessions and projects of each entry id, from retrieve.cited rows ({entryId, project, sessionId}). */
function citationIndex(cites) {
  const idx = new Map();
  for (const c of cites || []) {
    if (!c || !c.entryId) continue;
    if (!idx.has(c.entryId)) idx.set(c.entryId, { sessions: new Set(), projects: new Set() });
    const e = idx.get(c.entryId);
    e.projects.add(projectIdentity(c.project));
    if (c.sessionId) e.sessions.add(`${c.project || ''}|${c.sessionId}`);
  }
  return idx;
}

/** Entry ids the registry already decided about: promoted (active), reverted by the owner, rejected by the sanitizer. */
function registryBlocks(registry) {
  const active = new Set(); const reverted = new Set(); const rejected = new Set();
  for (const p of (registry && registry.promotions) || []) {
    const set = p.status === 'reverted' ? reverted : active;
    for (const s of p.sources || []) set.add(s.entryId);
  }
  for (const r of (registry && registry.rejected) || []) rejected.add(r.entryId);
  return { active, reverted, rejected };
}

/**
 * @param {object} input
 * @param {Array<{id,project,type,title,summary,recurrence,confidence,createdAt,tags,vector}>} input.entries  project-scope lessons of every project
 * @param {Array<{id,type,title,vector}>} input.userEntries  what `__user__` already holds
 * @param {Array<{entryId,project,sessionId}>} input.cites  retrieve.cited events (project = metrics key)
 * @param {{promotions?:object[], rejected?:object[]}} input.registry
 * @param {object} input.cfg  kb.promotion
 * @param {(a:number[],b:number[])=>number} input.simFn
 * @returns {{candidates:object[], skipped:object[], stats:object}}
 *   candidates are ordered by strength; each is {rule, type, rep, sources, recurrence, confidence, evidence, reason}
 */
function planPromotions({ entries, userEntries, cites, registry, cfg, simFn }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const types = new Set(c.types);
  const stats = { entries: (entries || []).length, pool: 0, belowConfidence: 0, r1: 0, r2: 0 };
  const pool = [];
  for (const e of entries || []) {
    if (!e || !e.vector || !e.vector.length || !types.has(e.type) || e.project === USER_SENTINEL) continue;
    if ((Number(e.confidence) || 0) < c.minConfidence) { stats.belowConfidence++; continue; }
    pool.push(e);
  }
  pool.sort(rankCompare);
  stats.pool = pool.length;

  const raw = [];
  const assigned = new Set();
  // R1 — seed-anchored (like planMerges): a member must be near the SEED itself, so a transitive chain never glues
  // two lessons that are not the same one. Seeds go in survivor order, so the seed is the strongest member.
  for (const seed of pool) {
    if (assigned.has(seed.id)) continue;
    const members = [];
    for (const e of pool) {
      if (assigned.has(e.id) || e.type !== seed.type) continue;
      const s = e === seed ? 1 : simFn(seed.vector, e.vector);
      if (typeof s === 'number' && s >= c.cosine) members.push({ e, cos: s });
    }
    const byProject = new Map();
    for (const m of members) { const k = projectIdentity(m.e.project); if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(m); }
    if (byProject.size < c.minProjects) continue;
    const sources = [...byProject.values()].map((ms) => _pickSurvivor(ms.map((m) => m.e)));
    for (const m of members) assigned.add(m.e.id);
    const cosOf = new Map(members.map((m) => [m.e.id, m.cos]));
    raw.push({
      rule: 'R1', type: seed.type, rep: seed, sources,
      evidence: { cosines: sources.map((s) => ({ project: s.project, entryId: s.id, cosine: round(cosOf.get(s.id)) })), projects: sources.map((s) => s.project) },
      reason: `the same ${seed.type} exists in ${byProject.size} projects (cosine >= ${c.cosine}): ${sources.map((s) => s.project).join(', ')}`,
    });
    stats.r1++;
  }
  // R2 — cited across sessions and projects (entries already grouped by R1 are left to R1).
  const cited = citationIndex(cites);
  for (const e of pool) {
    if (assigned.has(e.id)) continue;
    const ci = cited.get(e.id);
    if (!ci || ci.sessions.size < c.minCitedSessions || ci.projects.size < c.minCitedProjects) continue;
    raw.push({
      rule: 'R2', type: e.type, rep: e, sources: [e],
      evidence: { citedSessions: [...ci.sessions].sort(), citingProjects: [...ci.projects].sort(), projects: [e.project] },
      reason: `cited in ${ci.sessions.size} sessions of ${ci.projects.size} projects (>= ${c.minCitedSessions} sessions, >= ${c.minCitedProjects} projects)`,
    });
    stats.r2++;
  }

  const strength = (x) => (x.rule === 'R1' ? x.sources.length : x.evidence.citingProjects.length);
  for (const x of raw) { x.recurrence = x.sources.reduce((s, e) => s + (e.recurrence || 1), 0); x.confidence = Math.max(...x.sources.map((s) => Number(s.confidence) || 0)); }
  raw.sort((a, b) => strength(b) - strength(a) || b.recurrence - a.recurrence || b.confidence - a.confidence || String(a.rep.id).localeCompare(String(b.rep.id)));

  const blocks = registryBlocks(registry);
  const candidates = []; const skipped = [];
  const skip = (x, reason, extra) => skipped.push({ rule: x.rule, project: x.rep.project, entryId: x.rep.id, title: x.rep.title, reason, ...(extra || {}) });
  for (const x of raw) {
    const ids = x.sources.map((s) => s.id);
    if (ids.some((id) => blocks.active.has(id))) { skip(x, 'already promoted (an active promotion has this lesson as a source)'); continue; }
    if (ids.some((id) => blocks.reverted.has(id))) { skip(x, 'promotion reverted by the owner earlier — not promoted again'); continue; }
    if (ids.some((id) => blocks.rejected.has(id))) { skip(x, 'rejected earlier (the sanitizer refused its text)'); continue; }
    let best = null;
    for (const u of userEntries || []) {
      if (!u || !u.vector || u.type !== x.type) continue;
      const s = simFn(x.rep.vector, u.vector);
      if (typeof s === 'number' && s >= c.cosine && (!best || s > best.cos)) best = { cos: s, u };
    }
    if (best) { skip(x, `already in the user scope (cosine ${round(best.cos)} with "${best.u.title}")`, { userEntryId: best.u.id }); continue; }
    candidates.push(x);
  }
  return { candidates, skipped, stats };
}

/** Tags worth carrying to the user scope: a user-level hint, or one that several source projects share; never one naming a project. */
function safeTags(sources, projectIds) {
  const names = projectIds.flatMap((p) => [p, String(p).split('/').pop()]).filter((n) => n && n.length >= MIN_NAME_LEN).map((n) => n.toLowerCase());
  const count = new Map();
  for (const s of sources) for (const t of new Set((s.tags || []).map((x) => String(x).trim().toLowerCase()))) if (t) count.set(t, (count.get(t) || 0) + 1);
  const keep = [];
  for (const [t, n] of count) {
    if (t.length > 32 || /[\\/@:]/.test(t)) continue;
    if (names.some((nm) => t.includes(nm))) continue;
    if (USER_TAG_HINTS.has(t) || (sources.length > 1 && n > 1)) keep.push(t);
  }
  return keep.sort().slice(0, MAX_TAGS);
}

/** Title/summary/detail scrubbed of every source project's id and (long enough) repo name, after prepareForUserScope. */
function scrub(prep, projectIds) {
  const out = { ...prep };
  for (const p of projectIds) {
    for (const name of [p, String(p).split('/').pop()]) {
      if (!name || (name !== p && name.length < MIN_NAME_LEN)) continue;
      for (const k of Object.keys(out)) out[k] = sanitizeForUserScope(out[k], name);
    }
  }
  return out;
}

/**
 * The entry to write in the user scope from a candidate and the representative's FULL text (the listing only carries a
 * preview). Copies title/summary/detail only: never `content.files`, `source` or the sources' own ids.
 * @param {object} cand  a planPromotions candidate
 * @param {{title?:string, summary?:string, detail?:string}} full
 * @param {string} promotionId
 * @returns {{entry:object}|{rejected:true, reason:string}}
 */
function buildUserEntry(cand, full, promotionId) {
  const prep = prepareForUserScope({ title: full.title, summary: full.summary, detail: full.detail }, cand.rep.project);
  if (prep.rejected) return { rejected: true, reason: prep.reason };
  const projectIds = [...new Set(cand.sources.map((s) => s.project))];
  const safe = scrub(prep.safe, projectIds);
  return {
    entry: {
      title: safe.title,
      summary: safe.summary,
      content: { detail: safe.detail || safe.summary },
      type: cand.type,
      tags: safeTags(cand.sources, projectIds),
      confidence: cand.confidence,
      recurrence: cand.recurrence,
      scope: 'user',
      projectId: USER_SENTINEL,
      source: {},
      baseMetadata: { promotionId },
    },
  };
}

/**
 * Walk the ordered candidates, build each user entry and stop at maxPerRun accepted ones; a candidate the sanitizer
 * refuses does not take a slot. `getFull(candidate)` returns the representative's full text.
 * @returns {Promise<{accepted:Array<{cand,entry}>, rejected:Array<{cand,reason}>, deferred:object[]}>}
 */
async function prepareBatch(candidates, { maxPerRun, getFull, newId }) {
  const accepted = []; const rejected = []; const deferred = [];
  for (const cand of candidates) {
    if (accepted.length >= maxPerRun) { deferred.push(cand); continue; }
    const built = buildUserEntry(cand, await getFull(cand), newId());
    if (built.rejected) rejected.push({ cand, reason: built.reason }); else accepted.push({ cand, entry: built.entry });
  }
  return { accepted, rejected, deferred };
}

module.exports = { DEFAULTS, projectIdentity, planPromotions, buildUserEntry, prepareBatch, safeTags, citationIndex, registryBlocks, metricsKeyOfProject };
