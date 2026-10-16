#!/usr/bin/env node
/**
 * outcome-report.js — what the Boss delivers in results that grow with use, from the events it recorded in every
 * project (lib/outcome-metrics.js).
 *
 *   node scripts/outcome-report.js [--since 2026-10-01] [--maturity-since 2026-10-02] [--data-dir <dir>] [--json]
 *
 * Reads the metrics store read-only. A machine's first days show little here by design; the same command a month
 * later shows the curve.
 */
const { summarizeOutcomes } = require('./lib/outcome-metrics.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

/** Every project's events (the store is one database per project). */
function loadRows(since, explicitDir) {
  const store = require('../engine/lib/metrics-store.js');
  const dataDir = explicitDir || require('../engine/lib/data-dir.js').dataDir();
  const rows = [];
  for (const p of store.listProjects({ dataDir })) rows.push(...store.getEventLogIsolated(p, { limit: 500000, sinceTs: since || 1, dataDir }));
  return rows;
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);

function render(s) {
  const L = [];
  const l = s.learning; const c = s.curation; const m = s.mechanical;
  L.push(`events from ${s.window.from} to ${s.window.to}: ${s.window.projects} projects, ${s.window.sessions} sessions`);
  L.push('');
  L.push('LEARNING LOOP');
  L.push(`  lessons captured ${l.captured} (+${l.imported} backfilled in bulk weeks, counted apart): ${l.admitted} new, ${l.merged} a known lesson recurring (${pct(l.recurrenceShare)}); user-scope (promoted to every project) ${l.userScope} (${pct(l.userScopeShare)})`);
  L.push(`  recalled ${l.injected} lesson(s) into prompts, ${l.cited} cited in the reply (citation rate ${pct(l.citationRate)})`);
  L.push(`  recall origin: ${Object.keys(l.origins).length ? Object.entries(l.origins).map(([k, v]) => `${k} ${v}`).join(', ') + ` (another project: ${pct(l.crossProjectShare)})` : 'not recorded yet (starts with this build)'}`);
  L.push(`  reuse: ${l.reuse.citedEntries} distinct lessons cited; ${l.reuse.inSeveralSessions} in more than one session, ${l.reuse.inSeveralProjects} in more than one project`);
  L.push('');
  L.push('CURATION LOOP');
  L.push(`  ${c.scripts} curated scripts in use; ${c.redirected} commands handled by a script vs ${c.flagged} whose raw output entered the context → ${pct(c.share)} handled mechanically; ${c.uncovered} noisy commands without a script yet`);
  L.push('');
  L.push('DECISIONS TAKEN BY A RULE');
  L.push(`  ${m.mechanical} by rule (${Object.entries(m.byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  L.push(`  ${m.handedBack} handed back to the model (${Object.entries(m.handedBackByKind).map(([k, v]) => `${k} ${v}`).join(', ')}) → mechanical share ${pct(m.share)}`);
  L.push('');
  L.push('BY WEEK (captured/recurring | recalled/cited | by rule/handed back = share | curated share)');
  for (const w of s.byWeek) L.push(`  ${w.week}  ${String(w.captured).padStart(4)}/${String(w.merged).padStart(3)} | ${String(w.injected).padStart(4)}/${String(w.cited).padStart(3)} | ${String(w.mechanical).padStart(5)}/${String(w.handedBack).padStart(5)} = ${pct(w.mechanicalShare).padStart(4)} | ${pct(w.curationShare).padStart(4)}`);
  L.push('');
  L.push(`BY HOW MANY SESSIONS THE PROJECT HAS HAD (rate per session; sessions started since ${s.window.maturitySince})`);
  for (const b of s.maturity) L.push(`  ${b.label.padEnd(15)} ${String(b.sessions).padStart(5)} sessions  by rule ${String(b.mechanicalPerSession).padStart(6)}  recalled ${String(b.recalledPerSession).padStart(5)}  mechanical share ${pct(b.mechanicalShare)}  curated share ${pct(b.curationShare)}`);
  L.push('');
  for (const [k, v] of Object.entries(s.labels)) L.push(`${k}: ${v}`);
  return L.join('\n');
}

function main() {
  const since = arg('--since') ? Date.parse(arg('--since')) : 0;
  if (arg('--since') && !Number.isFinite(since)) throw new Error(`--since "${arg('--since')}" is not a date`);
  // The last 14 days: the window every rule event is still retained for, so every maturity bucket is measured the same way.
  const maturitySince = arg('--maturity-since') ? Date.parse(arg('--maturity-since')) : Date.now() - 14 * 86400e3;
  const s = summarizeOutcomes(loadRows(since, arg('--data-dir')), { since, maturitySince });
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : render(s));
}

if (require.main === module) main();
module.exports = { loadRows, render };
