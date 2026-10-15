'use strict';
/**
 * compaction-report.js — the compaction history read from the metrics store, and its text report.
 * Shared by `scripts/compaction-report.js` (CLI) and the doctor check; the dashboard has its own
 * loader (it already cycles the store per project) and feeds the same summarizeCompaction().
 */
const { summarizeCompaction, COMPACTION_EVENTS } = require('./compaction-metrics.js');

/** Every compaction-related row of the last `days` days across the metrics projects (or one). */
function loadCompactionRows({ days = 30, project = null, store = require('./metrics-store.js') } = {}) {
  const sinceTs = Date.now() - days * 86400_000;
  const projects = project ? [project] : store.listProjects();
  const rows = [];
  for (const p of projects) {
    store.close(); // single-instance module: one project at a time
    if (!store.init({ project: p })) continue;
    for (const ev of COMPACTION_EVENTS) for (const r of store.getEventLog({ eventName: ev, sinceTs })) if (r.ts >= sinceTs) rows.push(r);
  }
  store.close();
  return rows;
}

const k = (n) => (n == null ? '?' : `${Math.round(n / 1000)}k`);
const usd = (n) => (n == null ? '?' : `US$ ${n.toFixed(2)}`);

function describeSuggestion(s) {
  if (!s) return '';
  return s.ok
    ? `suggested ceiling ~${k(s.tokens)} (${s.percent}% of the window) — model estimate from ${s.basis.episodes} cuts, not applied`
    : `no suggestion — missing: ${s.missing.join('; ')}`;
}

/** Plain-text report: per model|window group (counts, cost, indicator, suggestion) and the worst sessions. */
function formatReport(summary, { days = 30 } = {}) {
  const e = summary.episodes;
  const L = [`Compactions in the last ${days} day(s): ${e.total} (boss: ${e.groups.reduce((a, g) => a + g.boss, 0)}, engine: ${e.groups.reduce((a, g) => a + g.engine, 0)}).`];
  if (!e.total) L.push('No compaction recorded yet: nothing to calibrate the threshold from.');
  for (const g of e.groups) {
    L.push('', `${g.model || '?'} · window ${k(g.windowTokens)}: ${g.compactions} cut(s) in ${g.sessions} session(s), ${g.turns} calls`
      + ` (${g.per100Turns ?? '?'} per 100 calls; boss ${g.boss}, engine ${g.engine})`);
    L.push(`  cut at a median ${g.medianPctAtTrigger ?? '?'}% of the window · context after ${k(g.medianTokensAfter)} · cost of the rewrite turns ${usd(g.totalCostUsd)} (avg ${usd(g.avgCostUsd)})`);
    L.push(`  compacts too much: ${g.compactsTooMuch}`);
    L.push(`  ${describeSuggestion(g.suggestion)}`);
  }
  const worst = e.sessions.filter((s) => s.compactions).slice(0, 5);
  if (worst.length) {
    L.push('', 'Sessions with the most compactions:');
    for (const s of worst) L.push(`  ${s.sessionId.slice(0, 8)}  ${s.compactions} cut(s) (boss ${s.boss}, engine ${s.engine}) over ${s.turns} calls / ${s.spanHours}h — too much: ${s.compactsTooMuch} — ${usd(s.costUsd)}`);
  }
  L.push('', 'The default threshold is unchanged: this report only collects.');
  return L.join('\n');
}

module.exports = { loadCompactionRows, formatReport, describeSuggestion, summarizeCompaction };
