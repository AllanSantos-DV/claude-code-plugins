'use strict';
/**
 * compaction-cache-cross.js — the compactions crossed with the cache expiries: per period, how many ran over a warm cache
 * and how many over a cold one, and the list of the warm ones. Pure (rows in, report out) → unit-tested;
 * `scripts/compaction-report.js --cache` prints it.
 *
 * A compaction's cache state is its run event's own `cache` (warm | cold | unknown, with the real idle age and TTL). An
 * older run carries only `cacheWarm`, the rules' view, which also calls a mid-turn or an unknown age warm: those are
 * marked `legacy` and have no age. The expiries (`compaction.cold`) count once per session and answer — a reopened
 * process may say again an expiry its previous run already said, timed from the transcript instead of the turn's end.
 * A run said warm although an expiry of that same answer was recorded before it is listed apart (`disagreements`).
 */

const SAME_ANSWER_MS = 2 * 60000; // turn end (timer) vs the transcript's last call (reopen): the same answer, seconds apart

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function parsePayload(r) {
  let p = r.payload || {};
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
  return p;
}

/** The period key of a timestamp, in this machine's local time: 'YYYY-MM-DD', or the Monday of its week. */
function periodOf(ts, period) {
  const d = new Date(ts);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** The cache state a run event says, and whether it is the old field (no age). */
function stateOf(p) {
  if (p.cache === 'warm' || p.cache === 'cold' || p.cache === 'unknown') return { cache: p.cache, legacy: false };
  return { cache: p.cacheWarm === true ? 'warm' : p.cacheWarm === false ? 'cold' : 'unknown', legacy: true };
}

/**
 * @param {Array<object>} rows metrics rows (compaction.run and compaction.cold are read, the rest ignored)
 * @param {{period?: 'day'|'week'}} [opts]
 */
function crossCacheState(rows, { period = 'day' } = {}) {
  if (period !== 'day' && period !== 'week') throw new Error(`compaction-cache-cross: period must be day or week, got ${period}`);
  const runs = [];
  const coldBySession = new Map();
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    const sid = r.sessionId || r.session_id || null;
    const ts = Number(r.ts) || 0;
    if (name === 'compaction.run') runs.push({ ts, sid, p: parsePayload(r) });
    else if (name === 'compaction.cold') {
      const p = parsePayload(r);
      const list = coldBySession.get(sid) || (coldBySession.set(sid, []), coldBySession.get(sid));
      list.push({ ts, answerAt: num(p.answerAt), p });
    }
  }

  const colds = [];
  for (const [sid, list] of coldBySession) {
    list.sort((a, b) => (a.answerAt ?? a.ts) - (b.answerAt ?? b.ts));
    for (const c of list) {
      const prev = colds.length && colds[colds.length - 1].sid === sid ? colds[colds.length - 1] : null;
      if (prev && c.answerAt != null && prev.answerAt != null && Math.abs(c.answerAt - prev.answerAt) <= SAME_ANSWER_MS) { prev.seen.push(c.p.detectedBy || '?'); continue; }
      colds.push({ sid, ts: c.ts, answerAt: c.answerAt, idleMs: num(c.p.idleMs), ttlMs: num(c.p.ttlMs), tokens: num(c.p.tokens), detectedBy: c.p.detectedBy || '?', seen: [c.p.detectedBy || '?'] });
    }
  }

  const periods = new Map();
  const at = (key) => periods.get(key) || (periods.set(key, {
    period: key, compactions: 0, warm: 0, cold: 0, unknown: 0, legacy: 0, byRanBy: {}, refused: 0, expiries: 0, expiriesByDetector: {},
  }), periods.get(key));
  const warm = [];
  const disagreements = [];
  for (const run of runs.sort((a, b) => a.ts - b.ts)) {
    const { cache, legacy } = stateOf(run.p);
    const g = at(periodOf(run.ts, period));
    g.compactions++;
    g[cache]++;
    if (legacy) g.legacy++;
    const ranBy = run.p.ranBy || (run.p.outcome === 'pruned' || run.p.outcome === 'brief' ? 'boss' : 'engine');
    g.byRanBy[ranBy] = (g.byRanBy[ranBy] || 0) + 1;
    if (run.p.engineAccepted === false) g.refused++;
    const item = {
      ts: run.ts, sessionId: run.sid, trigger: run.p.trigger || null, reason: run.p.reason || null, outcome: run.p.outcome || null, ranBy,
      cache, legacy, warmBy: run.p.warmBy || null, idleMs: num(run.p.idleMs), ttlMs: num(run.p.ttlMs),
      tokensBefore: num(run.p.tokensBefore), tokensAfter: num(run.p.tokensAfter), engineAccepted: run.p.engineAccepted ?? null,
    };
    if (cache === 'warm') warm.push(item);
    const answerAt = num(run.p.lastAnswerAt);
    if (cache === 'warm' && item.warmBy !== 'mid-turn' && answerAt != null) {
      const expired = colds.find((c) => c.sid === run.sid && c.answerAt != null && Math.abs(c.answerAt - answerAt) <= SAME_ANSWER_MS && c.ts <= run.ts);
      if (expired) disagreements.push({ ...item, expiryRecordedAt: expired.ts, expiryDetectedBy: expired.detectedBy });
    }
  }
  for (const c of colds) {
    const g = at(periodOf(c.answerAt ?? c.ts, period));
    g.expiries++;
    g.expiriesByDetector[c.detectedBy] = (g.expiriesByDetector[c.detectedBy] || 0) + 1;
  }

  const list = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));
  const totals = list.reduce((t, g) => {
    for (const k of ['compactions', 'warm', 'cold', 'unknown', 'legacy', 'refused', 'expiries']) t[k] += g[k];
    return t;
  }, { compactions: 0, warm: 0, cold: 0, unknown: 0, legacy: 0, refused: 0, expiries: 0 });
  return { period, periods: list, totals, warm: warm.reverse(), disagreements };
}

const k = (n) => (n == null ? '?' : `${Math.round(n / 1000)}k`);
const dur = (ms) => (ms == null ? '?' : ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}min`);
const stamp = (ts) => {
  const d = new Date(ts); const p2 = (n) => String(n).padStart(2, '0');
  return `${periodOf(ts, 'day')} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** Plain-text report of crossCacheState(). */
function formatCross(x, { days } = {}) {
  const t = x.totals;
  const L = [`Compactions vs cache${days ? ` in the last ${days} day(s)` : ''}: ${t.compactions} — warm ${t.warm}, cold ${t.cold}, unknown ${t.unknown}`
    + `${t.legacy ? ` (${t.legacy} from before the cache state was recorded: rules' view, no age)` : ''}; cache expiries recorded: ${t.expiries}.`];
  if (t.refused) L.push(`Cuts of ours the engine refused (its summary ran instead): ${t.refused}.`);
  L.push('', `${x.period === 'week' ? 'Week of' : 'Day'}        compactions  warm  cold  unknown  boss  engine  expiries`);
  for (const g of x.periods) {
    L.push(`${g.period}  ${String(g.compactions).padStart(11)}  ${String(g.warm).padStart(4)}  ${String(g.cold).padStart(4)}  ${String(g.unknown).padStart(7)}`
      + `  ${String(g.byRanBy.boss || 0).padStart(4)}  ${String(g.byRanBy.engine || 0).padStart(6)}  ${String(g.expiries).padStart(8)}`);
  }
  L.push('', x.warm.length ? 'Compactions over a warm cache (newest first):' : 'No compaction ran over a warm cache.');
  for (const w of x.warm) {
    L.push(`  ${stamp(w.ts)}  ${String(w.sessionId || '?').slice(0, 8)}  ${w.trigger || '?'}/${w.reason || '?'} → ${w.outcome || '?'} by ${w.ranBy}`
      + `  ${w.legacy ? 'age not recorded' : `idle ${dur(w.idleMs)} of TTL ${dur(w.ttlMs)}${w.warmBy === 'mid-turn' ? ' (mid-turn)' : ''}`}  ${k(w.tokensBefore)} → ${k(w.tokensAfter)}`);
  }
  if (x.disagreements.length) {
    L.push('', 'Said warm although the expiry of the same answer was recorded before it:');
    for (const d of x.disagreements) L.push(`  ${stamp(d.ts)}  ${String(d.sessionId || '?').slice(0, 8)}  expiry seen by ${d.expiryDetectedBy} at ${stamp(d.expiryRecordedAt)}`);
  }
  return L.join('\n');
}

module.exports = { crossCacheState, formatCross, periodOf, SAME_ANSWER_MS };
