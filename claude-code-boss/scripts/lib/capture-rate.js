'use strict';
/**
 * capture-rate.js — nudge→capture conversion rate for the curated learning loop.
 *
 * Pure. Like skill-roi, it aggregates a metrics event log in JS (getMetricsSummary
 * only counts by event_name, not by payload). The keystone metric the loop lacked:
 * of the nudges each detector emits, how many actually became a captured lesson?
 *
 * Correlation: grouped by PROJECT (not session) — `lesson.captured` is written with
 * a null session_id (the LLM calling capture_lesson doesn't pass one), so project is
 * the only key both nudge and capture share; this mirrors research-followup, which
 * already correlates the capture by time, not session. Within a project, each
 * `nudge.emitted{kind}` is matched to the FIRST not-yet-consumed
 * `lesson.captured{type=map(kind)}` with ts >= the nudge. A capture with no
 * preceding nudge is "spontaneous" (the LLM capturing unprompted — a healthy loop),
 * counted separately so it neither inflates nor deflates the nudge rate.
 *
 * Limits: correction and failure both map to type 'lesson' (shared pool within a
 * project, attributed by time order); user-scope captures land under '__user__' so a
 * project-scope nudge that led to one won't get credited (conservative — never
 * inflates). The per-kind split is a proxy; the aggregate rate is the real signal.
 */

const KIND_TO_TYPE = {
  correction: 'lesson',
  pattern: 'pattern',
  decision: 'decision',
  research: 'research',
  failure: 'lesson',
};
const KINDS = Object.keys(KIND_TO_TYPE);

/**
 * @param {Array<{eventName:string, payload:object, project?:string, sessionId?:string, ts:number}>} events
 * @returns {{ byKind: Record<string,{kind,nudges,captures,rate}>, spontaneous: Record<string,number> }}
 */
function aggregateCaptureRate(events) {
  const byProject = new Map();
  for (const e of events || []) {
    const key = e.project || e.sessionId || 'default';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(e);
  }

  const byKind = {};
  for (const k of KINDS) byKind[k] = { kind: k, nudges: 0, captures: 0, rate: null };
  const spontaneous = {};

  for (const [, evs] of byProject) {
    const sorted = evs.slice().sort((a, b) => a.ts - b.ts);
    const nudges = sorted.filter(e => e.eventName === 'nudge.emitted' && e.payload && KINDS.includes(e.payload.kind));
    const captures = sorted.filter(e => e.eventName === 'lesson.captured' && e.payload && e.payload.type);
    const consumed = new Set();

    for (const n of nudges) {
      const kind = n.payload.kind;
      byKind[kind].nudges += 1;
      const wantType = KIND_TO_TYPE[kind];
      const idx = captures.findIndex((c, i) => !consumed.has(i) && c.payload.type === wantType && c.ts >= n.ts);
      if (idx >= 0) { consumed.add(idx); byKind[kind].captures += 1; }
    }

    captures.forEach((c, i) => {
      if (!consumed.has(i)) spontaneous[c.payload.type] = (spontaneous[c.payload.type] || 0) + 1;
    });
  }

  for (const k of KINDS) {
    const row = byKind[k];
    row.rate = row.nudges > 0 ? row.captures / row.nudges : null;
  }
  return { byKind, spontaneous };
}

module.exports = { aggregateCaptureRate, KIND_TO_TYPE, KINDS };
