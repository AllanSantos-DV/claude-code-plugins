'use strict';
/**
 * compaction-metrics.js — turn the controlled-compaction trail into numbers the owner
 * can judge it by. Pure (rows in, summary out) → unit-tested; /api/metrics/compaction
 * feeds it (same shape as lib/curation-metrics.js).
 *
 * Every number says what it is:
 *   - WHEN: gate decisions by action/reason (held vs waited for a warm cache vs below
 *     the threshold) and resume checks (history re-expanded by the engine);
 *   - HOW MUCH: chars cut (exact, from our pruning), tokens cut (measured: the context
 *     the turn AFTER the compaction answered over vs the reading before), by trigger;
 *   - THE CACHE: per host|auth, the contracted window actually observed in writes
 *     (ephemeral_5m vs ephemeral_1h — subscription and API can differ), hit rate, and
 *     what the first turn after a compaction paid (cache read vs write) — the price of
 *     rewriting history, which the timing exists to keep at "would have paid anyway".
 */
const path = require('path');

const COMPACTION_EVENTS = [
  'compaction.session', 'compaction.gate', 'compaction.run', 'compaction.resume',
  'compaction.settled', 'compaction.error', 'cache.turn',
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bump = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

function ttlVerdict(acc) {
  return require(path.join(__dirname, '..', '..', 'servers', 'model-router', 'cache-cycle.js')).deriveTtlVerdict(acc);
}

/**
 * @param {Array<{ts?:number,eventName?:string,event_name?:string,payload?:object|string,sessionId?:string}>} rows
 * @param {{timeline?:number}} [opts]
 */
function summarizeCompaction(rows, { timeline = 20 } = {}) {
  const s = {
    sessions: 0,
    gate: { total: 0, byAction: {}, byReason: {}, held: 0, attachmentsPassed: 0 },
    runs: { total: 0, pruned: 0, nativeSummary: 0, byTrigger: {}, byReason: {}, prunedByKind: {} },
    // duplicatesDropped: the engine's copies removed from a resumed history (hook-compaction resume defect).
    cut: { charsBefore: 0, charsAfter: 0, charsCut: 0, avgRatio: null, prunedResults: 0, duplicatesDropped: 0, verbatimBroken: 0 },
    // firstTurn*: the first API call after each compaction (cache.turn afterCompaction).
    settled: { count: 0, tokensBefore: 0, tokensAfter: 0, tokensCut: 0, firstTurns: 0, firstTurnRead: 0, firstTurnWrite: 0 },
    resume: { checks: 0, reexpanded: 0, reloadedTokens: 0 },
    errors: { total: 0, byWhere: {} },
    cache: { byHost: {} },
    timeline: [],
  };
  let ratioSum = 0;
  const hosts = {};
  const runsList = [];
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
    switch (name) {
      case 'compaction.session': s.sessions++; break;
      case 'compaction.gate':
        s.gate.total++;
        bump(s.gate.byAction, p.action || '?');
        bump(s.gate.byReason, p.reason || '?');
        if (p.action === 'compact') s.gate.held++;
        if (p.reason === 'attachments-would-be-lost') s.gate.attachmentsPassed++;
        break;
      case 'compaction.run':
        s.runs.total++;
        if (p.outcome === 'pruned') {
          s.runs.pruned++;
          s.cut.charsBefore += num(p.charsBefore);
          s.cut.charsAfter += num(p.charsAfter);
          s.cut.charsCut += num(p.charsCut);
          s.cut.prunedResults += num(p.prunedResults);
          s.cut.duplicatesDropped += num(p.duplicatesDropped);
          ratioSum += num(p.ratio);
          for (const [k, v] of Object.entries(p.byReason || {})) bump(s.runs.prunedByKind, k, num(v));
        } else {
          s.runs.nativeSummary++;
        }
        if (p.verbatimTextIntact === false) s.cut.verbatimBroken++;
        bump(s.runs.byTrigger, p.trigger || '?');
        bump(s.runs.byReason, p.reason || '?');
        runsList.push({ ts: r.ts || null, trigger: p.trigger, reason: p.reason, outcome: p.outcome, charsCut: num(p.charsCut), ratio: num(p.ratio), tokensBefore: p.tokensBefore ?? null });
        break;
      case 'compaction.settled':
        s.settled.count++;
        s.settled.tokensBefore += num(p.tokensBefore);
        s.settled.tokensAfter += num(p.tokensAfter);
        s.settled.tokensCut += Math.max(0, num(p.tokensCut));
        break;
      case 'compaction.resume':
        s.resume.checks++;
        if (p.reexpanded) s.resume.reexpanded++;
        s.resume.reloadedTokens += num(p.reloadedTokens);
        break;
      case 'compaction.error':
        s.errors.total++;
        bump(s.errors.byWhere, p.where || '?');
        break;
      case 'cache.turn': {
        const key = `${p.host || 'unknown'}|${p.auth || 'unknown'}`;
        const h = hosts[key] || (hosts[key] = { host: p.host || 'unknown', auth: p.auth || 'unknown', turns: 0, read: 0, write: 0, input: 0, write5m: 0, write1h: 0, models: {}, afterCompaction: { turns: 0, read: 0, write: 0 } });
        h.turns++;
        h.read += num(p.read); h.write += num(p.write); h.input += num(p.input);
        h.write5m += num(p.write5m); h.write1h += num(p.write1h);
        if (p.model) bump(h.models, p.model);
        if (p.afterCompaction) {
          h.afterCompaction.turns++; h.afterCompaction.read += num(p.read); h.afterCompaction.write += num(p.write);
          s.settled.firstTurnRead += num(p.read); s.settled.firstTurnWrite += num(p.write); s.settled.firstTurns++;
        }
        break;
      }
      default: break;
    }
  }
  s.cut.avgRatio = s.runs.pruned ? +(ratioSum / s.runs.pruned).toFixed(3) : null;
  for (const [key, h] of Object.entries(hosts)) {
    const prompt = h.read + h.write + h.input;
    s.cache.byHost[key] = {
      ...h,
      hitPct: prompt > 0 ? Math.round((h.read / prompt) * 1000) / 10 : null,
      ttl: ttlVerdict({ write5m: h.write5m, write1h: h.write1h }),
    };
  }
  s.timeline = runsList.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, timeline);
  return s;
}

module.exports = { summarizeCompaction, COMPACTION_EVENTS };
