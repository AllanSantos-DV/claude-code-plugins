'use strict';
/**
 * outcome-metrics.js — what the Boss delivers in RESULTS that grow with use, from the metric events it already
 * records (pure: rows in, numbers out). Cost per session cannot show this (lib/economy-ledger.js says why): the
 * value is memory, curated commands and decisions made by a rule instead of by the model, and none of it exists
 * on a machine's first day.
 *
 * Four views of the same rows:
 *   learning   — lessons captured (new vs a known one recurring, user-scope share = promotion), recalled, cited;
 *                where recalled lessons came from (own project / ancestor / another project) and which cited
 *                lessons served several sessions or projects (reuse).
 *   curation   — commands handled by a curated script vs commands whose raw output still reached the context.
 *   mechanical — decisions taken by a rule (rewrite, redirect, guard, cut, recall) against the ones handed back to
 *                the model (a nudge, a capture offer, a curation block, a raw output): the mechanical share.
 *   maturity   — the same rates by how many sessions a project has had (1–3, 4–10, 11–30, 31+).
 *
 * Two honesty rules. (1) A project that captures more than BACKFILL_PER_WEEK lessons in one week is backfilling (a bulk
 * extraction from old transcripts, an import): those lessons are counted apart — the agent did not learn them from work
 * that week. (2) Shares of "by rule vs handed back" start at the week the rule events
 * started being recorded; earlier weeks show no share, not 0% — the rules ran, nothing counted them. Maturity compares
 * sessions of one window only (the one every event kind is retained for), ordered by the project's whole history.
 *
 * Every number is a count of recorded events. "Avoided" things are NOT inferred: a recall is an opportunity to avoid a
 * repeat, a cited lesson is evidence the answer used it — the report says which is which.
 */

const MECHANICAL = Object.freeze({
  'curation.redirected': 'curated-script redirect',
  'curation.shaped': 'output shaped',
  'shell-escape.rewritten': 'command rewritten (Windows escape)',
  'powershell.rewritten': 'command rewritten (PowerShell)',
  'fileformat.restored': 'file format restored',
  'error-guard.denied': 'blind re-run denied',
  'graph-guard.fired': 'Grep redirected to the graph',
  'compaction.run': 'context cut at the right time',
});
const HANDED_BACK = Object.freeze({
  'nudge.emitted': 'agent asked to capture a lesson/decision',
  'capture.offered': 'capture review offered',
  'curation.stop.blocked': 'turn blocked to curate a command',
  'curation.flagged': 'raw output of a recurring command entered the context',
});
// Measured on this machine's history: organic weeks hold 1–25 captures per project; the bulk weeks 54, 62, 74, 85, 97, 248.
const BACKFILL_PER_WEEK = 40;
const MATURITY_BUCKETS = Object.freeze([[3, '1–3 sessions'], [10, '4–10 sessions'], [30, '11–30 sessions'], [Infinity, '31+ sessions']]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const share = (a, b) => (a + b > 0 ? a / (a + b) : null);
const round = (v, d = 3) => (v == null ? null : +Number(v).toFixed(d));

/** UTC date of the Monday of the event's week. */
function weekOf(ts) {
  const d = new Date(num(ts));
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

/**
 * @param {Array<{eventName:string, ts:number, payload?:object, sessionId?:string, project?:string}>} rows  every project's events
 * @param {{since?:number, maturitySince?:number}} [opts]  since: only events at or after this time (ms); maturitySince: only sessions that started
 * at or after it feed the maturity rates (default `since`)
 */
function summarizeOutcomes(rows, { since = 0, maturitySince = since, backfillPerWeek = BACKFILL_PER_WEEK } = {}) {
  const perProjectWeek = new Map();
  for (const r of rows || []) {
    if (r && r.eventName === 'lesson.captured' && num(r.ts) >= since) { const k = `${r.project}|${weekOf(r.ts)}`; perProjectWeek.set(k, (perProjectWeek.get(k) || 0) + 1); }
  }
  const weeks = new Map();
  const wk = (ts) => { const k = weekOf(ts); if (!weeks.has(k)) weeks.set(k, { week: k, captured: 0, admitted: 0, merged: 0, userScope: 0, injected: 0, cited: 0, redirected: 0, flagged: 0, mechanical: 0, handedBack: 0 }); return weeks.get(k); };
  const learning = { captured: 0, imported: 0, admitted: 0, merged: 0, byScope: {}, injected: 0, cited: 0, origins: {}, citedByOrigin: {}, citedEntries: new Map() };
  const mechByKind = {}; const backByKind = {};
  let firstRedirect = null; // when the dominant rule event started being recorded
  const curation = { redirected: 0, flagged: 0, used: 0, uncovered: 0, bypass: 0, scripts: new Map() };
  const proj = new Map(); // project -> { sessions: Map(sid -> {first, mech, back, lessons, injected, redirected, flagged}) }
  const projects = new Set(); const sessions = new Set();
  // An event with no session id (a lesson capture does not carry one) belongs to no session: it feeds the totals, not the per-session rates.
  const cell = (r) => {
    if (!r.sessionId) return { first: 0, mech: 0, back: 0, lessons: 0, injected: 0, redirected: 0, flagged: 0 };
    const p = r.project || '(none)'; const sid = r.sessionId;
    if (!proj.has(p)) proj.set(p, new Map());
    const m = proj.get(p);
    if (!m.has(sid)) m.set(sid, { first: num(r.ts), mech: 0, back: 0, lessons: 0, injected: 0, redirected: 0, flagged: 0 });
    const c = m.get(sid); c.first = Math.min(c.first, num(r.ts));
    return c;
  };

  for (const r of rows || []) {
    if (!r || !r.eventName || num(r.ts) < since) continue;
    const p = r.payload || {}; const n = r.eventName; const w = wk(r.ts);
    projects.add(r.project || '(none)'); if (r.sessionId) sessions.add(`${r.project}|${r.sessionId}`);
    const c = cell(r);
    if (n === 'lesson.captured' && perProjectWeek.get(`${r.project}|${w.week}`) > backfillPerWeek) {
      learning.imported++; // a bulk week of one project: backfill, not learning from that week's work
    } else if (n === 'lesson.captured') {
      learning.captured++; w.captured++; c.lessons++;
      if (p.decision === 'merge') { learning.merged++; w.merged++; } else { learning.admitted++; w.admitted++; }
      const sc = String(p.scope || 'auto'); learning.byScope[sc] = (learning.byScope[sc] || 0) + 1;
      if (sc === 'user') w.userScope++;
    } else if (n === 'retrieve.injected') {
      const k = p.chars === 0 ? 0 : num(p.count); learning.injected += k; w.injected += k; c.injected += k;
      for (const [o, v] of Object.entries(p.origins || {})) learning.origins[o] = (learning.origins[o] || 0) + num(v);
    } else if (n === 'retrieve.cited') {
      learning.cited++; w.cited++;
      const o = p.origin || 'unrecorded'; learning.citedByOrigin[o] = (learning.citedByOrigin[o] || 0) + 1;
      if (p.entryId) {
        if (!learning.citedEntries.has(p.entryId)) learning.citedEntries.set(p.entryId, { sessions: new Set(), projects: new Set() });
        const e = learning.citedEntries.get(p.entryId); e.sessions.add(r.sessionId || ''); e.projects.add(r.project || '');
      }
    }
    if (MECHANICAL[n]) { mechByKind[n] = (mechByKind[n] || 0) + 1; w.mechanical++; c.mech++; }
    if (HANDED_BACK[n]) { backByKind[n] = (backByKind[n] || 0) + 1; w.handedBack++; c.back++; }
    if (n === 'curation.redirected') { firstRedirect = firstRedirect == null ? num(r.ts) : Math.min(firstRedirect, num(r.ts)); curation.redirected++; w.redirected++; c.redirected++; const id = `${r.project}|${p.shellId}`; if (!curation.scripts.has(id)) curation.scripts.set(id, num(r.ts)); }
    else if (n === 'curation.flagged') { curation.flagged++; w.flagged++; c.flagged++; }
    else if (n === 'curation.used') curation.used++;
    else if (n === 'curation.uncovered') curation.uncovered++;
    else if (n === 'curation.bypass') curation.bypass++;
  }

  const entries = [...learning.citedEntries.values()];
  const instrumentedFrom = firstRedirect == null ? null : weekOf(firstRedirect);
  const byWeek = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map((w) => {
    const on = instrumentedFrom != null && w.week >= instrumentedFrom;
    return { ...w, mechanicalShare: on ? round(share(w.mechanical, w.handedBack)) : null, curationShare: on ? round(share(w.redirected, w.flagged)) : null };
  });

  // Maturity: sessions of one project ordered by when they started; the rate of each bucket pools every project.
  const buckets = MATURITY_BUCKETS.map(([max, label]) => ({ label, max, sessions: 0, mech: 0, back: 0, lessons: 0, injected: 0, redirected: 0, flagged: 0 }));
  for (const m of proj.values()) {
    [...m.values()].sort((a, b) => a.first - b.first).forEach((s, i) => {
      if (s.first < maturitySince) return;
      const b = buckets.find((x) => i + 1 <= x.max);
      b.sessions++; for (const k of ['mech', 'back', 'lessons', 'injected', 'redirected', 'flagged']) b[k] += s[k];
    });
  }
  const mechTotal = Object.values(mechByKind).reduce((s, x) => s + x, 0); const backTotal = Object.values(backByKind).reduce((s, x) => s + x, 0);
  const originTotal = Object.values(learning.origins).reduce((s, x) => s + x, 0);
  return {
    window: { projects: projects.size, sessions: sessions.size, from: byWeek.length ? byWeek[0].week : null, to: byWeek.length ? byWeek[byWeek.length - 1].week : null, ruleEventsFrom: instrumentedFrom, maturitySince: maturitySince ? new Date(maturitySince).toISOString().slice(0, 10) : null },
    learning: {
      captured: learning.captured, imported: learning.imported, admitted: learning.admitted, merged: learning.merged, recurrenceShare: round(learning.captured ? learning.merged / learning.captured : null),
      userScope: learning.byScope.user || 0, userScopeShare: round(learning.captured ? (learning.byScope.user || 0) / learning.captured : null), byScope: learning.byScope,
      injected: learning.injected, cited: learning.cited, citationRate: round(learning.injected ? learning.cited / learning.injected : null),
      origins: learning.origins, crossProjectShare: round(originTotal ? ((learning.origins.other || 0) / originTotal) : null), citedByOrigin: learning.citedByOrigin,
      reuse: { citedEntries: entries.length, inSeveralSessions: entries.filter((e) => e.sessions.size > 1).length, inSeveralProjects: entries.filter((e) => e.projects.size > 1).length },
    },
    curation: {
      redirected: curation.redirected, flagged: curation.flagged, share: round(share(curation.redirected, curation.flagged)), used: curation.used, uncovered: curation.uncovered, bypass: curation.bypass,
      scripts: curation.scripts.size,
    },
    mechanical: { byKind: mechByKind, handedBackByKind: backByKind, mechanical: mechTotal, handedBack: backTotal, share: round(share(mechTotal, backTotal)) },
    byWeek,
    maturity: buckets.filter((b) => b.sessions).map((b) => ({
      label: b.label, sessions: b.sessions, mechanicalPerSession: round(b.mech / b.sessions, 2), recalledPerSession: round(b.injected / b.sessions, 2),
      curationShare: round(share(b.redirected, b.flagged)), mechanicalShare: round(share(b.mech, b.back)),
    })),
    labels: {
      measured: 'counts of recorded events',
      notInferred: 'a recall is an opportunity to avoid a repeat; a citation is evidence the answer used the lesson; neither proves a correction was avoided',
      maturity: 'cross-sectional: projects with more sessions also differ in size and kind of work',
      shares: 'weeks before the rule events were recorded show no share (n/a), not 0%',
      imported: `lessons of a project-week above ${BACKFILL_PER_WEEK} captures are backfill, counted apart`,
    },
  };
}

module.exports = { summarizeOutcomes, weekOf, BACKFILL_PER_WEEK, MECHANICAL, HANDED_BACK, MATURITY_BUCKETS };
