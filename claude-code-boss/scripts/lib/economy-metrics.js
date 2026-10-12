'use strict';
/**
 * economy-metrics.js — what a cut is REALLY worth: tokens, dollars and plan limit.
 *
 * Pure (rows in, numbers out). Method and measurements: codex-boss
 * docs/research/economia-tokens-e-limite.md §3–§4 (approved by the owner 2026-10-12).
 *
 *   R  = (raw − shown) / K              tokens that never entered the context (K = 3.43, T6)
 *   E  = w·W + Σ r_j                    permanence in "input-equivalent": the item is written to the
 *                                       cache (w = 1.25 for 5 min, 2 for 1 h; W = 1 + cold rewrites) and
 *                                       re-read by every later request until a compaction (r_j = the
 *                                       model's read/input ratio)
 *   T  = R · E · (1 − RECAPTURE)        input-equivalent tokens saved (base of the dollar figure)
 *   TL = R · (w·W + 0.05·N)             the same in the Claude plan's limit unit (fixed weights)
 *   η  = ΣT / (C + ΣT)                  share of the spend the Boss avoided (C = measured consumption)
 *
 * MEASURED: the item's session has cache.turn rows after the cut and a compaction.run followed (the item
 * left the context, so N is known). ESTIMATED: otherwise — E from the T8 table by session size
 * (or the global median when the cut carries no session). Every number is labelled which it is.
 */

const CHARS_PER_TOKEN = 3.43; // provider tokenizer, 200 random results (T6); the old /4 under-counted ~14%
const RECAPTURE = 0.005;      // an agent re-reading the saved full output: 7 of 1,335 cuts (T3)
// Permanence multiplier E by the session's number of calls (T8: 30,600 results in 353 sessions).
const PERMANENCE_BY_CALLS = [[50, 2.05], [200, 4.75], [1000, 16.75], [Infinity, 22]];
const PERMANENCE_MEDIAN = 12.4;
// Claude Pro, 5 h window: limit-unit per 1% (T7b, 9 windows, CV 0.075). Recalibrated by calibrateLimit().
const LIMIT_UNITS_PER_PERCENT = 71400;
const LIMIT_WEIGHTS = Object.freeze({ input: 1, read: 0.05, write5m: 1.25, write1h: 2, output: 5 });

// USD per MTok input and read/input ratio — official pricing page (accessed 2026-10-12, per the research §2).
const MODELS = Object.freeze({
  'claude-opus-5-5': { inputUsd: 4, readRatio: 0.05 },
  'claude-sonnet-5-5': { inputUsd: 2, readRatio: 0.05 },
  'claude-sonnet-5': { inputUsd: 2, readRatio: 0.1 },
  'claude-opus-5': { inputUsd: 5, readRatio: 0.1 },
  'claude-opus-4-8': { inputUsd: 5, readRatio: 0.1 },
});
const DEFAULT_READ_RATIO = 0.1; // a model not in the table: the conservative (higher) ratio, unpriced in USD

/** `msg_0…` = Claude subscription; `msg_vrtx…`/`msg_bdrk…` = cloud (USD) — the owner's existing rule. */
function routeOf(messageId) {
  const id = String(messageId || '');
  if (/^msg_(vrtx|bdrk)/.test(id)) return 'api';
  if (/^msg_0/.test(id)) return 'subscription';
  return 'unknown';
}

const permanenceFor = (calls) => (Number.isFinite(calls) && calls > 0 ? PERMANENCE_BY_CALLS.find(([max]) => calls <= max)[1] : PERMANENCE_MEDIAN);
const readRatio = (model) => (MODELS[model] ? MODELS[model].readRatio : DEFAULT_READ_RATIO);
const writeWeight = (t) => (Number(t.write1h) > Number(t.write5m) ? 2 : 1.25);

/** Index cache.turn / compaction.run rows by session (ascending ts). */
function indexSessions(rows) {
  const by = new Map();
  const get = (sid) => by.get(sid) || (by.set(sid, { turns: [], compactions: [] }), by.get(sid));
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    const sid = r.session_id || r.sessionId;
    if (!sid || (name !== 'cache.turn' && name !== 'compaction.run')) continue;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
    const ts = Number(r.ts);
    if (name === 'cache.turn') get(sid).turns.push({ ts, ...p });
    else get(sid).compactions.push(ts);
  }
  for (const s of by.values()) { s.turns.sort((a, b) => a.ts - b.ts); s.compactions.sort((a, b) => a - b); }
  return by;
}

/**
 * Permanence of one cut. Returns {E, EL, measured, route, model, readRatio}.
 * @param {{ts?:number, session_id?:string}} item
 */
function permanence(item, sessions) {
  const s = item.session_id && sessions.get(item.session_id);
  if (!s || !s.turns.length || !Number.isFinite(item.ts)) {
    return { E: PERMANENCE_MEDIAN, EL: PERMANENCE_MEDIAN, measured: false, route: 'unknown', model: null };
  }
  const first = s.turns.find((t) => t.ts >= item.ts) || null;
  const ref = first || s.turns[s.turns.length - 1];
  const route = routeOf(ref.messageId);
  const model = ref.model || null;
  const endsAt = s.compactions.find((c) => c > item.ts); // the item left the context here
  const after = s.turns.filter((t) => t.ts >= item.ts && (endsAt === undefined || t.ts <= endsAt));
  if (endsAt === undefined || !after.length) {
    // Still in the context (or no later call seen): the call count so far is only a floor — estimate.
    const E = permanenceFor(s.turns.length);
    return { E, EL: E, measured: false, route, model };
  }
  // W = 1 + cold rewrites; the first call writes the item once.
  const w = writeWeight(after[0]);
  const rewrites = after.filter((t) => t.cacheState === 'miss').length;
  const W = 1 + rewrites;
  let E = w * W;
  let EL = w * W;
  for (const t of after) { E += readRatio(t.model); EL += LIMIT_WEIGHTS.read; }
  return { E, EL, measured: true, route, model };
}

/** Consumption of the session rows in input-equivalent (C) and in the limit unit, by route. */
function consumption(rows) {
  const out = { eq: 0, limit: 0, byRoute: {} };
  for (const r of rows || []) {
    if ((r.eventName || r.event_name) !== 'cache.turn') continue;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; continue; } }
    const w = writeWeight(p);
    const eq = (Number(p.input) || 0) + readRatio(p.model) * (Number(p.read) || 0) + w * (Number(p.write) || 0) + 5 * (Number(p.output) || 0);
    const lim = limitUnits(p);
    out.eq += eq; out.limit += lim;
    const route = routeOf(p.messageId);
    out.byRoute[route] = (out.byRoute[route] || 0) + eq;
  }
  return out;
}

/** One request in the plan's limit unit (fixed weights, same for every model — T7b). */
function limitUnits(u) {
  const w5 = Number(u.write5m) || 0; const w1 = Number(u.write1h) || 0;
  const write = (w5 || w1) ? w5 * LIMIT_WEIGHTS.write5m + w1 * LIMIT_WEIGHTS.write1h : (Number(u.write) || 0) * LIMIT_WEIGHTS.write5m;
  return (Number(u.input) || 0) * LIMIT_WEIGHTS.input + (Number(u.read) || 0) * LIMIT_WEIGHTS.read + write + (Number(u.output) || 0) * LIMIT_WEIGHTS.output;
}

/**
 * @param {Array<{chars:number, ts?:number, session_id?:string}>} items  cuts: `chars` = raw − shown
 * @param {Array} rows  the metric rows (cache.turn / compaction.run are read from them)
 * @param {{limitUnitsPerPercent?:number}} [opts]
 */
function summarizeEconomy(items, rows, opts = {}) {
  const l1 = Number(opts.limitUnitsPerPercent) > 0 ? Number(opts.limitUnitsPerPercent) : LIMIT_UNITS_PER_PERCENT;
  const sessions = indexSessions(rows);
  const mk = () => ({ cuts: 0, rawTokens: 0, tokens: 0, usd: 0, usdUnpricedTokens: 0, limitUnits: 0 });
  const e = { k: CHARS_PER_TOKEN, limitUnitsPerPercent: l1, measured: mk(), estimated: mk(), total: mk(), byRoute: {} };
  for (const it of items) {
    const R = Math.max(0, Number(it.chars) || 0) / CHARS_PER_TOKEN;
    if (!R) continue;
    const pm = permanence(it, sessions);
    const T = R * pm.E * (1 - RECAPTURE);
    const TL = R * pm.EL * (1 - RECAPTURE);
    const price = pm.model && MODELS[pm.model] ? MODELS[pm.model].inputUsd : null;
    const bucket = pm.measured ? e.measured : e.estimated;
    const route = e.byRoute[pm.route] || (e.byRoute[pm.route] = mk());
    for (const b of [bucket, e.total, route]) {
      b.cuts++; b.rawTokens += R; b.tokens += T; b.limitUnits += TL;
      if (pm.route !== 'subscription') { if (price != null) b.usd += (T * price) / 1e6; else b.usdUnpricedTokens += T; }
    }
  }
  const c = consumption(rows);
  e.consumptionTokens = Math.round(c.eq);
  // No measured consumption (no cache.turn rows) → no η: 100% would be a made-up number.
  e.eta = c.eq > 0 ? e.total.tokens / (e.total.tokens + c.eq) : null;
  e.limitPercent = e.total.limitUnits / l1;
  // The limit reading only means something for the subscription route.
  e.subscriptionLimitPercent = (e.byRoute.subscription ? e.byRoute.subscription.limitUnits : 0) / l1;
  return e;
}

/**
 * Recalibrate "limit units per 1%" from blocks (rate_limit rejected = the 100% point of a window).
 * @param {Array<number>} windowUnits  limit units used from window start to each block
 * @returns {number} units per 1% (median over windows ÷ 100), or the default when there is none
 */
function calibrateLimit(windowUnits) {
  const xs = (windowUnits || []).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!xs.length) return LIMIT_UNITS_PER_PERCENT;
  const mid = xs.length >> 1;
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return median / 100;
}

module.exports = {
  CHARS_PER_TOKEN, RECAPTURE, PERMANENCE_MEDIAN, LIMIT_UNITS_PER_PERCENT, LIMIT_WEIGHTS, MODELS,
  routeOf, permanenceFor, indexSessions, permanence, consumption, limitUnits, summarizeEconomy, calibrateLimit,
};
