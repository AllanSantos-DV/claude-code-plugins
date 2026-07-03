/**
 * value-summary.js — pure aggregation of metric rows into the dashboard's
 * "value made visible" numbers (U2) and the learning-loop signal (D4).
 *
 * Input is the raw event rows from brain-store.getEventLog (newest-first is fine;
 * order doesn't matter). All functions are pure so they're trivially testable and
 * the dashboard endpoint stays a thin adapter.
 *
 * Cards:
 *   - Context saved by curation: sum of `curation.flagged.chars` (raw output that
 *     tripped the curation thresholds) → tokens ≈ chars/4.
 *   - Learned: count of `lesson.captured` (any decision).
 *   - Memory in action: count of `retrieve.cited` (KB entries the reply used).
 *   - Learning loop (D4): captured vs merged per week from `lesson.captured`
 *     `decision` ('admit' = new, 'merge' = a prior lesson recurred).
 */
'use strict';

const CHARS_PER_TOKEN = 4;

function _num(v) { return Number.isFinite(v) ? v : 0; }

/** ISO week-ish bucket key: YYYY-Www is overkill; use the UTC date of the week's Monday. */
function weekKey(ts) {
  const d = new Date(_num(ts));
  if (!Number.isFinite(d.getTime())) return 'unknown';
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/**
 * @param {Array<{eventName:string, ts:number, payload:object, project?:string}>} rows
 * @param {{project?:string}} [opts]  when set, only rows for that project are counted
 * @returns {{
 *   contextSaved: {chars:number, tokens:number, events:number},
 *   learned: {total:number, byType:Object<string,number>},
 *   memoryCited: number,
 *   learningLoop: {captured:number, merged:number, admitted:number, mergeRate:number, byWeek:Array<{week:string, captured:number, merged:number}>}
 * }}
 */
function summarize(rows, opts = {}) {
  const project = opts.project || null;
  const out = {
    contextSaved: { chars: 0, tokens: 0, events: 0 },
    learned: { total: 0, byType: {} },
    memoryCited: 0,
    learningLoop: { captured: 0, merged: 0, admitted: 0, mergeRate: 0, byWeek: [] },
  };
  const weekMap = new Map(); // week → {captured, merged}

  for (const r of rows || []) {
    if (!r || !r.eventName) continue;
    if (project && r.project && r.project !== project) continue;
    const p = r.payload || {};
    switch (r.eventName) {
      case 'curation.flagged': {
        out.contextSaved.chars += _num(p.chars);
        out.contextSaved.events += 1;
        break;
      }
      case 'lesson.captured': {
        out.learned.total += 1;
        const t = String(p.type || 'lesson');
        out.learned.byType[t] = (out.learned.byType[t] || 0) + 1;
        out.learningLoop.captured += 1;
        if (p.decision === 'merge') out.learningLoop.merged += 1;
        else out.learningLoop.admitted += 1;
        const wk = weekKey(r.ts);
        const w = weekMap.get(wk) || { captured: 0, merged: 0 };
        w.captured += 1;
        if (p.decision === 'merge') w.merged += 1;
        weekMap.set(wk, w);
        break;
      }
      case 'retrieve.cited': {
        out.memoryCited += 1;
        break;
      }
      default: break;
    }
  }

  out.contextSaved.tokens = Math.round(out.contextSaved.chars / CHARS_PER_TOKEN);
  out.learningLoop.mergeRate = out.learningLoop.captured > 0
    ? Math.round((out.learningLoop.merged / out.learningLoop.captured) * 100) / 100
    : 0;
  out.learningLoop.byWeek = [...weekMap.entries()]
    .map(([week, v]) => ({ week, captured: v.captured, merged: v.merged }))
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));

  return out;
}

/**
 * Count `lesson.captured` events for a session window: rows with ts >= sinceTs
 * (and matching project when given). Used by the session-summary Stop detector.
 * @param {Array} rows
 * @param {{sinceTs:number, project?:string}} opts
 * @returns {number}
 */
function countLessonsSince(rows, { sinceTs = 0, project = null } = {}) {
  let n = 0;
  for (const r of rows || []) {
    if (!r || r.eventName !== 'lesson.captured') continue;
    if (project && r.project && r.project !== project) continue;
    if (_num(r.ts) >= sinceTs) n += 1;
  }
  return n;
}

module.exports = { summarize, countLessonsSince, weekKey, CHARS_PER_TOKEN };
