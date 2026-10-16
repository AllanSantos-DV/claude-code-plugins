'use strict';
/**
 * economy-ledger.js — one cost record per Claude Code session, read from the transcript, and the
 * comparison of two groups of sessions. Pure (lines/records in, numbers out).
 *
 * WHY it exists: the Boss's savings are counted per cut (economy-metrics: tokens that never entered
 * the context). Nobody had the other side — what whole sessions cost, with and without a feature —
 * and "before/after" needs that. The transcript already holds it (usage per call), so a baseline
 * does not have to wait for new data: it is rebuilt from what Claude Code wrote.
 *
 * Cost unit: the plan-limit weights of economy-metrics (input 1, cache read 0.05, write 5m 1.25,
 * write 1h 2, output 5 — "input-equivalent tokens"), which need no price table and hold across
 * models; USD is added only for models economy-metrics prices.
 *
 * WHAT A COMPARISON PROVES, per method (the `claim` of compareGroups says it too):
 *   - randomized arms (the same population, a coin decides) — a causal effect of the feature;
 *   - observational split (with/without Boss, before/after an install date) — a difference that
 *     workload, model mix and session length also explain. Stratified by session size it removes
 *     the size confound, never the others. It cannot prove causality.
 */
const { limitUnits } = require('./economy-metrics.js');
const { turnCostUsd } = require('./compaction-episodes.js');

const BOSS_HOOK = /claude-code-boss/;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {Iterable<string|object>} lines transcript JSONL lines (or parsed objects)
 * @returns {null | {sessionId:string, version:string|null, cwd:string|null, entrypoint:string|null,
 *   firstTs:number, lastTs:number, calls:number, input:number, read:number, write5m:number, write1h:number,
 *   output:number, units:number, usd:number, unpricedModels:Object<string,number>, hitRatio:number|null,
 *   maxContext:number, compactions:number, bossActive:boolean, models:Object<string,number>}}
 *   null when the transcript has no billed call.
 */
function sessionRecord(lines) {
  const calls = new Map(); // message.id -> usage (a response written as several lines repeats the same usage)
  let sessionId = null; let version = null; let cwd = null; let entrypoint = null;
  let firstTs = Infinity; let lastTs = 0; let compactions = 0; let bossActive = false;
  for (const line of lines) {
    let o = line;
    if (typeof line === 'string') {
      if (!line) continue;
      try { o = JSON.parse(line); } catch (err) { void err; continue; } // a line being written
    }
    if (!o || typeof o !== 'object') continue;
    sessionId = sessionId || o.sessionId || null;
    version = version || o.version || null;
    cwd = cwd || o.cwd || null;
    entrypoint = entrypoint || o.entrypoint || null;
    const ts = Date.parse(o.timestamp);
    if (Number.isFinite(ts)) { firstTs = Math.min(firstTs, ts); lastTs = Math.max(lastTs, ts); }
    if (o.isCompactSummary) compactions++;
    const a = o.attachment;
    if (o.type === 'attachment' && a && /^hook_/.test(a.type || '') && BOSS_HOOK.test(`${a.command || ''} ${a.hookName || ''}`)) bossActive = true;
    const m = o.message;
    // Sub-agent calls (isSidechain) are billed to the session too.
    if (o.type === 'assistant' && m && m.usage) {
      calls.set(m.id || `${o.uuid}`, { model: m.model, usage: m.usage });
    }
  }
  if (!calls.size) return null;
  const rec = { sessionId, version, cwd, entrypoint, firstTs, lastTs, calls: calls.size, input: 0, read: 0, write5m: 0, write1h: 0, output: 0, units: 0, usd: 0, unpricedModels: {}, maxContext: 0, compactions, bossActive, models: {} };
  for (const { model, usage: u } of calls.values()) {
    const cc = u.cache_creation || {};
    const split = num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens);
    // A transcript without the 1h/5m split bills the whole write as 5m (economy-metrics' rule).
    const p = { model, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens),
      write5m: split ? num(cc.ephemeral_5m_input_tokens) : 0, write1h: split ? num(cc.ephemeral_1h_input_tokens) : 0, output: num(u.output_tokens) };
    rec.input += p.input; rec.read += p.read; rec.write5m += split ? p.write5m : p.write; rec.write1h += p.write1h; rec.output += p.output;
    rec.units += limitUnits(p);
    const usd = turnCostUsd(p);
    if (usd == null) rec.unpricedModels[model || 'unknown'] = (rec.unpricedModels[model || 'unknown'] || 0) + 1; else rec.usd += usd;
    rec.maxContext = Math.max(rec.maxContext, p.input + p.read + p.write);
    rec.models[model || 'unknown'] = (rec.models[model || 'unknown'] || 0) + 1;
  }
  const ctx = rec.input + rec.read + rec.write5m + rec.write1h;
  rec.hitRatio = ctx ? rec.read / ctx : null;
  if (!Number.isFinite(rec.firstTs)) rec.firstTs = rec.lastTs;
  return rec;
}

// ── comparison ──────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32): a report is reproducible from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Call-weighted cost per call of a group: Σunits / Σcalls (a long session weighs as many calls as it made). */
const groupRate = (rs) => rs.reduce((s, r) => s + r.units, 0) / rs.reduce((s, r) => s + r.calls, 0);

/** Session-size strata by peak context: what a session pays per call grows with how big its context got. */
const SIZE_EDGES = [50000, 150000, 400000];
const sizeBucket = (r) => SIZE_EDGES.filter((e) => r.maxContext > e).length;

/** Relative change of group B against group A, `(B−A)/A`, on a common weighting of the size strata. */
function stratifiedChange(a, b) {
  const strata = new Map();
  for (const r of a) (strata.get(sizeBucket(r)) || strata.set(sizeBucket(r), { a: [], b: [] }).get(sizeBucket(r))).a.push(r);
  for (const r of b) (strata.get(sizeBucket(r)) || strata.set(sizeBucket(r), { a: [], b: [] }).get(sizeBucket(r))).b.push(r);
  let wa = 0; let wb = 0; let w = 0;
  for (const s of strata.values()) {
    if (!s.a.length || !s.b.length) continue; // a stratum only one group reaches says nothing about the difference
    const weight = s.a.length + s.b.length;
    wa += groupRate(s.a) * weight; wb += groupRate(s.b) * weight; w += weight;
  }
  return w ? (wb - wa) / wa : null;
}

/**
 * Compare group A (reference) with group B (feature on / after).
 * @param {Array<object>} a  sessionRecord()s of the reference group
 * @param {Array<object>} b  sessionRecord()s of the group under test
 * @param {{randomized?:boolean, resamples?:number, seed?:number, minSessions?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, n:{a:number,b:number}, rate:{a:number,b:number}, change:number, stratified:(number|null),
 *   ci:[number,number], significant:boolean, claim:string, caveats:string[]}}
 *   change < 0 means B costs less per call. ci is the 95% bootstrap interval of the stratified change
 *   (of the raw one when no stratum holds both groups).
 */
function compareGroups(a, b, { randomized = false, resamples = 2000, seed = 1, minSessions = 8 } = {}) {
  if (a.length < minSessions || b.length < minSessions) {
    return { ok: false, reason: `needs at least ${minSessions} sessions per group (have ${a.length} and ${b.length}) — a smaller sample cannot separate an effect from the spread between sessions`, n: { a: a.length, b: b.length } };
  }
  const rate = { a: groupRate(a), b: groupRate(b) };
  const change = (rate.b - rate.a) / rate.a;
  const strat = stratifiedChange(a, b);
  const stat = (x, y) => { const s = stratifiedChange(x, y); return s == null ? (groupRate(y) - groupRate(x)) / groupRate(x) : s; };
  const rand = rng(seed);
  const pick = (xs) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  const draws = [];
  for (let i = 0; i < resamples; i++) draws.push(stat(pick(a), pick(b)));
  draws.sort((x, y) => x - y);
  const ci = [draws[Math.floor(0.025 * resamples)], draws[Math.ceil(0.975 * resamples) - 1]];
  const significant = ci[0] > 0 || ci[1] < 0;
  const caveats = ['the interval covers the spread between sessions, not the choice of which sessions were compared'];
  if (!randomized) caveats.push('observational: workload, model mix and session length also differ between the groups — a difference here is an association, not proof the feature caused it');
  if (strat == null) caveats.push('no session-size stratum holds both groups: the raw difference is reported, so size is NOT controlled');
  return {
    ok: true, n: { a: a.length, b: b.length }, rate, change, stratified: strat, ci, significant,
    claim: randomized
      ? 'randomized arms: the difference in cost per call is attributable to the feature (within the interval)'
      : 'observational split: the groups differ in cost per call by this much; it does not establish the cause',
    caveats,
  };
}

module.exports = { sessionRecord, compareGroups, groupRate, stratifiedChange, sizeBucket, rng, SIZE_EDGES };
