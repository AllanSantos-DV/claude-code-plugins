'use strict';
/**
 * compaction-episodes.js — one record per compaction, per session, and what they say about the
 * threshold. Pure (rows in, numbers out) → unit-tested; summarizeCompaction() embeds it and
 * scripts/compaction-report.js prints it.
 *
 * An episode is the first API call after a compaction (`cache.turn` with afterCompaction), so it
 * counts the boss's cuts AND the engine's own (auto at its window, or the user's /compact). Who
 * made it: a `compaction.run` of the same session at or before that call → the boss (trigger
 * auto|manual); none → the engine.
 *
 * Per episode: when, model, window, context before/after, % of the window at the trigger, who, and
 * the cost of the compaction turn (the rewrite) priced with economy-metrics' table. Window and
 * threshold % come from the session's latest `compaction.gate` — unknown (null) for sessions the
 * gate never saw.
 *
 * suggestLimit() is a MODEL, not a measurement: with A = context right after a compaction,
 * g = tokens the context grows per turn, w/r = write/read price ratio, a cycle that compacts at T
 * costs  w·A·g/(T−A) + r·(A+T)/2  per turn, minimised at  T = A + sqrt(2·w·A·g/r).
 * It ignores that the boss only cuts with a cold cache (where the rewrite is paid anyway), so read
 * it as the cost-optimal ceiling, and it is withheld until the group has MIN_EPISODES measured cuts.
 */
const { priceOf, LIMIT_WEIGHTS } = require('./economy-metrics.js');

const MIN_EPISODES = 5;          // measured cuts a model|window group needs before it gets a suggestion
const TOO_MUCH_PER_100_TURNS = 5; // heuristic: more than one cut every 20 calls
const TOO_MUCH_PER_HOUR = 2;
const MIN_FOR_INDICATOR = 2;     // one cut alone says nothing about frequency
const RUN_MATCH_MS = 30 * 60000; // the first call after a boss cut follows it within minutes; an older run is not this cut's

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ms = (t) => (Number(t) < 1e12 ? Number(t) * 1000 : Number(t)); // store rows: ms; tolerate seconds
const round = (v, d = 2) => (v == null ? null : +Number(v).toFixed(d));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const ctxOf = (p) => num(p.read) + num(p.write) + num(p.input);

/** USD of one call from economy-metrics' per-model price and the plan's fixed weights; null for a model it does not price. */
function turnCostUsd(p) {
  const m = priceOf(p.model);
  if (!m) return null;
  const w5 = num(p.write5m); const w1 = num(p.write1h);
  const write = (w5 || w1) ? w5 * LIMIT_WEIGHTS.write5m + w1 * LIMIT_WEIGHTS.write1h : num(p.write) * LIMIT_WEIGHTS.write5m;
  const eq = num(p.input) + num(p.read) * m.readRatio + write + num(p.output) * LIMIT_WEIGHTS.output;
  return (eq * m.inputUsd) / 1e6;
}

/** A row's payload as an object: rows from the store may carry it as a JSON string; unparseable → {}. */
function parsePayload(r) {
  let p = r.payload || {};
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
  return p;
}

/**
 * @param {Array<object>} rows compaction.gate / compaction.run / cache.turn rows (any order)
 * @returns {{episodes:Array<object>, sessions:Array<object>, groups:Array<object>}}
 */
function buildEpisodes(rows) {
  const bySession = new Map();
  const get = (sid) => bySession.get(sid) || (bySession.set(sid, { turns: [], runs: [], gates: [] }), bySession.get(sid));
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    const sid = r.sessionId || r.session_id;
    if (!sid || (name !== 'cache.turn' && name !== 'compaction.run' && name !== 'compaction.gate')) continue;
    const e = { ts: ms(r.ts || 0), p: parsePayload(r) };
    const s = get(sid);
    if (name === 'cache.turn') s.turns.push(e); else if (name === 'compaction.run') s.runs.push(e); else s.gates.push(e);
  }

  const episodes = [];
  const sessions = [];
  const turnsByGroup = new Map();
  const growth = new Map(); // group key → tokens-per-turn samples

  for (const [sid, s] of bySession) {
    s.turns.sort((a, b) => a.ts - b.ts); s.runs.sort((a, b) => a.ts - b.ts); s.gates.sort((a, b) => a.ts - b.ts);
    const lastGate = [...s.gates].reverse().find((g) => num(g.p.windowTokens) > 0);
    const sessionWindow = lastGate ? num(lastGate.p.windowTokens) : null;
    const usedRuns = new Set();
    const mine = [];
    let prev = null;
    for (const t of s.turns) {
      const key = `${t.p.model || '?'}|${sessionWindow || '?'}`;
      turnsByGroup.set(key, (turnsByGroup.get(key) || 0) + 1);
      if (t.p.afterCompaction) {
        const runIdx = s.runs.findLastIndex((r, i) => r.ts <= t.ts && t.ts - r.ts <= RUN_MATCH_MS && !usedRuns.has(i));
        const run = runIdx >= 0 ? s.runs[runIdx] : null;
        if (run) usedRuns.add(runIdx);
        const gate = [...s.gates].reverse().find((g) => g.ts <= t.ts && num(g.p.windowTokens) > 0) || lastGate;
        const windowTokens = gate ? num(gate.p.windowTokens) : null;
        const before = run && run.p.tokensBefore != null ? num(run.p.tokensBefore) : prev ? ctxOf(prev.p) : null;
        const after = ctxOf(t.p);
        const ep = {
          sessionId: sid, ts: t.ts, model: t.p.model || null, windowTokens,
          thresholdPercent: gate && gate.p.thresholdPercent != null ? num(gate.p.thresholdPercent) : null,
          origin: run ? (run.p.trigger === 'manual' ? 'boss-manual' : 'boss-auto') : 'engine',
          outcome: run ? run.p.outcome || null : null,
          tokensBefore: before, tokensAfter: after,
          pctOfWindowAtTrigger: before != null && windowTokens ? round((before / windowTokens) * 100, 1) : null,
          costUsd: round(turnCostUsd(t.p), 4),
        };
        episodes.push(ep); mine.push(ep);
      } else if (prev && !prev.p.afterCompaction) {
        const d = ctxOf(t.p) - ctxOf(prev.p);
        if (d > 0) { const a = growth.get(key) || []; a.push(d); growth.set(key, a); }
      }
      prev = t;
    }
    const spanH = s.turns.length > 1 ? (s.turns[s.turns.length - 1].ts - s.turns[0].ts) / 3600000 : 0;
    sessions.push({
      sessionId: sid, turns: s.turns.length, spanHours: round(spanH, 2), compactions: mine.length,
      boss: mine.filter((e) => e.origin !== 'engine').length, engine: mine.filter((e) => e.origin === 'engine').length,
      per100Turns: s.turns.length ? round((mine.length / s.turns.length) * 100, 1) : null,
      perHour: spanH >= 0.25 ? round(mine.length / spanH, 2) : null, // < 15 min is too short to be a rate
      costUsd: round(mine.reduce((a, e) => a + (e.costUsd || 0), 0), 4),
      windowTokens: sessionWindow,
      compactsTooMuch: tooMuch(mine.length, s.turns.length, spanH),
    });
  }

  const groupMap = new Map();
  for (const e of episodes) {
    const key = `${e.model || '?'}|${e.windowTokens || '?'}`;
    const g = groupMap.get(key) || { key, model: e.model, windowTokens: e.windowTokens, episodes: [], sessions: new Set() };
    g.episodes.push(e); g.sessions.add(e.sessionId); groupMap.set(key, g);
  }
  const groups = [...groupMap.values()].map((g) => {
    const turns = turnsByGroup.get(g.key) || 0;
    const pcts = g.episodes.map((e) => e.pctOfWindowAtTrigger).filter((v) => v != null);
    const costs = g.episodes.map((e) => e.costUsd).filter((v) => v != null);
    return {
      key: g.key, model: g.model, windowTokens: g.windowTokens, compactions: g.episodes.length, sessions: g.sessions.size, turns,
      boss: g.episodes.filter((e) => e.origin !== 'engine').length, engine: g.episodes.filter((e) => e.origin === 'engine').length,
      per100Turns: turns ? round((g.episodes.length / turns) * 100, 1) : null,
      medianPctAtTrigger: round(median(pcts), 1),
      medianTokensAfter: median(g.episodes.map((e) => e.tokensAfter)),
      totalCostUsd: round(costs.reduce((a, v) => a + v, 0), 4),
      avgCostUsd: costs.length ? round(costs.reduce((a, v) => a + v, 0) / costs.length, 4) : null,
      medianGrowthPerTurn: median(growth.get(g.key) || []),
      compactsTooMuch: tooMuch(g.episodes.length, turns, null),
      suggestion: suggestLimit({ model: g.model, windowTokens: g.windowTokens, episodes: g.episodes.length, afterTokens: median(g.episodes.map((e) => e.tokensAfter)), growthPerTurn: median(growth.get(g.key) || []) }),
    };
  }).sort((a, b) => b.compactions - a.compactions);

  episodes.sort((a, b) => b.ts - a.ts);
  sessions.sort((a, b) => b.compactions - a.compactions);
  return { episodes, sessions, groups };
}

/** 'yes' | 'no' | 'insufficient' (fewer than MIN_FOR_INDICATOR cuts, or no turns to rate them against). */
function tooMuch(count, turns, spanHours) {
  if (count < MIN_FOR_INDICATOR || !turns) return 'insufficient';
  const per100 = (count / turns) * 100;
  const perHour = spanHours && spanHours >= 0.25 ? count / spanHours : 0;
  return per100 > TOO_MUCH_PER_100_TURNS || perHour > TOO_MUCH_PER_HOUR ? 'yes' : 'no';
}

/**
 * Cost-optimal compaction ceiling for one model|window group (see the header for the model).
 * Always says what is missing instead of guessing.
 */
function suggestLimit({ model, windowTokens, episodes, afterTokens, growthPerTurn }) {
  const missing = [];
  if (!priceOf(model)) missing.push(`price of model ${model || '?'} (not in economy-metrics MODELS)`);
  if (!windowTokens) missing.push('window size (no compaction.gate seen for these sessions)');
  if (episodes < MIN_EPISODES) missing.push(`samples: ${episodes} of ${MIN_EPISODES} measured compactions`);
  if (!afterTokens) missing.push('context after compaction');
  if (!growthPerTurn) missing.push('context growth per turn (no consecutive calls measured)');
  if (missing.length) return { ok: false, missing };
  const wOverR = LIMIT_WEIGHTS.write5m / priceOf(model).readRatio; // the 1h write (2×) would raise it; the 5m figure is the conservative lower bound
  const tokens = Math.round(afterTokens + Math.sqrt(2 * wOverR * afterTokens * growthPerTurn));
  return { ok: true, tokens, percent: round((tokens / windowTokens) * 100, 1), basis: { afterTokens, growthPerTurn, writeOverRead: wOverR, episodes } };
}

module.exports = { buildEpisodes, suggestLimit, turnCostUsd, tooMuch, MIN_EPISODES, TOO_MUCH_PER_100_TURNS, TOO_MUCH_PER_HOUR };
