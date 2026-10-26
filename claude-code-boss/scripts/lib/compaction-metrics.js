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
    phaseRestartNotices: 0, // the opt-in phase-restart notice (a second gate event on a prompt already counted)
    runs: { total: 0, pruned: 0, nativeSummary: 0, byTrigger: {}, byReason: {}, prunedByKind: {} },
    // duplicatesDropped: the engine's copies removed from a resumed history (hook-compaction resume defect).
    cut: { charsBefore: 0, charsAfter: 0, charsCut: 0, avgRatio: null, prunedResults: 0, duplicatesDropped: 0, verbatimBroken: 0 },
    // firstTurn*: the first API call after each compaction (cache.turn afterCompaction).
    settled: { count: 0, prevented: 0, tokensBefore: 0, tokensAfter: 0, tokensCut: 0, firstTurns: 0, firstTurnRead: 0, firstTurnWrite: 0 },
    resume: { checks: 0, reexpanded: 0, copies: 0 }, // copies: the engine copies found in resumed histories
    errors: { total: 0, byWhere: {} },
    cache: { byHost: {} },
    // windows the gate measured against (model limit or compaction window), newest first:
    // what the % threshold means in tokens for each, and whether it sits past the engine's point.
    windows: [],
    timeline: [],
  };
  let ratioSum = 0;
  const hosts = {};
  const windowsSeen = new Map();
  const runsList = [];
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
    switch (name) {
      case 'compaction.session': s.sessions++; break;
      case 'compaction.gate':
        if (p.action === 'phase-restart-notice') { s.phaseRestartNotices++; break; }
        if (Number(p.windowTokens) > 0) {
          const wk = `${p.windowTokens}|${p.windowSource || '?'}`;
          const prev = windowsSeen.get(wk);
          if (!prev || (r.ts || 0) >= prev.lastTs) windowsSeen.set(wk, { windowTokens: Number(p.windowTokens), source: p.windowSource || null, engineAutoCompactAt: p.engineAutoCompactAt ?? null, thresholdPercent: p.thresholdPercent ?? null, thresholdTokens: p.thresholdTokens ?? null, aboveEngine: p.thresholdAboveEngine === true, lastTs: r.ts || 0, gates: (prev ? prev.gates : 0) + 1 });
          else prev.gates++;
        }
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
        if (p.prevented || p.tokensBefore == null) { s.settled.prevented++; break; } // no measured 'before'
        s.settled.count++;
        s.settled.tokensBefore += num(p.tokensBefore);
        s.settled.tokensAfter += num(p.tokensAfter);
        s.settled.tokensCut += Math.max(0, num(p.tokensCut));
        break;
      case 'compaction.resume':
        s.resume.checks++;
        if (p.reexpanded) s.resume.reexpanded++;
        s.resume.copies += num(p.copies);
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
  s.windows = [...windowsSeen.values()].sort((a, b) => b.lastTs - a.lastTs);
  s.timeline = runsList.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, timeline);
  // Per-compaction history, per session and per model|window, with the "compacts too much" indicator (compaction-episodes.js).
  const ep = require('./compaction-episodes.js').buildEpisodes(rows);
  s.episodes = { total: ep.episodes.length, recent: ep.episodes.slice(0, timeline), sessions: ep.sessions.slice(0, 50), groups: ep.groups };
  return s;
}

/**
 * The one-tile summary of controlled compaction for the Home (the full panel is summarizeCompaction): on or off, whether
 * the cut at a cold cache builds the brief itself (`mechanicalCut`), and what the cuts saved as measured on the next turn.
 * @param {{enabled?:boolean, mechanicalCut?:boolean}} cfg  hooks-config getCompaction()
 * @param {Array} rows  any events; only the compaction runs and their measured outcome are read
 * @returns {{enabled:boolean, mechanicalCut:boolean, runs:number, measured:number, tokensCut:number}}
 */
function compactionTile(cfg, rows) {
  const only = (rows || []).filter((r) => { const n = r.eventName || r.event_name; return n === 'compaction.run' || n === 'compaction.settled'; });
  const s = summarizeCompaction(only, { timeline: 0 });
  const enabled = !cfg || cfg.enabled !== false;
  return { enabled, mechanicalCut: enabled && (!cfg || cfg.mechanicalCut !== false), runs: s.runs.total, measured: s.settled.count, tokensCut: s.settled.tokensCut };
}

module.exports = { summarizeCompaction, compactionTile, COMPACTION_EVENTS };
