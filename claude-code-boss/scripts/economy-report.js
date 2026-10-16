#!/usr/bin/env node
/**
 * economy-report.js — what whole sessions cost, split into two groups, from the transcripts Claude Code
 * already wrote (lib/economy-ledger.js). The baseline exists from the first transcript on disk.
 *
 *   node scripts/economy-report.js [--days 30] [--split boss | --split before:2026-10-15T22:00:00Z]
 *                                  [--save] [--json] [--min-sessions 8]
 *
 *   --split boss            sessions where a claude-code-boss hook answered (B) vs none (A)
 *   --split before:<ISO>    sessions that started before the date (A) vs after (B) — e.g. a build's install time
 *   --save                  keep one record per session in <data dir>/.runtime/economy-ledger.jsonl
 *                           (a baseline that outlives Claude Code's own transcript cleanup)
 *
 * Observational: read the `claim` and `caveats` printed with every comparison.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionRecord, compareGroups } = require('./lib/economy-ledger.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Top-level session transcripts (sub-agent files live in nested folders) modified inside the window. */
function transcripts(days) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const since = Date.now() - days * 86400e3;
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs >= since) out.push(p);
    }
  }
  return out;
}

function ledgerPath() {
  return path.join(require('../engine/lib/data-dir.js').dataDir(), '.runtime', 'economy-ledger.jsonl');
}

/** Keep the newest record of each session (a live session grows between runs). */
function saveLedger(records) {
  const file = ledgerPath();
  const bySession = new Map();
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l); // our own file: a bad line is a bug to see, not to skip
      bySession.set(r.sessionId, r);
    }
  }
  for (const r of records) if (!bySession.has(r.sessionId) || bySession.get(r.sessionId).lastTs <= r.lastTs) bySession.set(r.sessionId, r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...bySession.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { file, sessions: bySession.size };
}

const usd = (n) => `US$ ${n.toFixed(2)}`;
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function main() {
  const days = Number(arg('--days', 30));
  const minSessions = Number(arg('--min-sessions', 8));
  const split = arg('--split', 'boss');
  const records = [];
  for (const f of transcripts(days)) {
    const r = sessionRecord(fs.readFileSync(f, 'utf8').split('\n'));
    if (r && r.sessionId) records.push(r);
  }
  const unpriced = {};
  for (const r of records) for (const [m, n] of Object.entries(r.unpricedModels)) unpriced[m] = (unpriced[m] || 0) + n;
  const total = {
    sessions: records.length, calls: records.reduce((s, r) => s + r.calls, 0), units: records.reduce((s, r) => s + r.units, 0),
    usd: records.reduce((s, r) => s + r.usd, 0), unpricedCalls: Object.values(unpriced).reduce((s, n) => s + n, 0),
    hitRatio: records.reduce((s, r) => s + r.read, 0) / records.reduce((s, r) => s + r.input + r.read + r.write5m + r.write1h, 0),
  };
  let a; let b; let labels;
  if (split === 'boss') { a = records.filter((r) => !r.bossActive); b = records.filter((r) => r.bossActive); labels = ['without Boss hooks', 'with Boss hooks']; } else if (split.startsWith('before:')) {
    const cut = Date.parse(split.slice(7));
    if (!Number.isFinite(cut)) throw new Error(`--split before:<ISO date> — "${split.slice(7)}" is not a date`);
    a = records.filter((r) => r.firstTs < cut); b = records.filter((r) => r.firstTs >= cut); labels = [`started before ${split.slice(7)}`, 'started after'];
  } else throw new Error(`unknown --split "${split}" (boss | before:<ISO date>)`);
  const cmp = compareGroups(a, b, { minSessions });
  const saved = process.argv.includes('--save') ? saveLedger(records) : null;
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ days, total, unpriced, split, labels, cmp, saved }, null, 2)); return; }
  console.log(`sessions in the last ${days} days: ${total.sessions}, ${total.calls} billed calls, cache hit ${(total.hitRatio * 100).toFixed(1)}%`);
  console.log(`cost: ${total.units.toExponential(3)} input-equivalent tokens; ${usd(total.usd)} on priced models${total.unpricedCalls ? ` (+${total.unpricedCalls} calls on models without a price: ${Object.entries(unpriced).map(([m, n]) => `${m} ${n}`).join(', ')})` : ''}`);
  console.log(`split "${split}": A = ${labels[0]} (${a.length}), B = ${labels[1]} (${b.length})`);
  if (!cmp.ok) { console.log(`no comparison: ${cmp.reason}`); } else {
    console.log(`cost per call: A ${cmp.rate.a.toFixed(0)}  B ${cmp.rate.b.toFixed(0)} units  → B vs A ${pct(cmp.change)} raw, ${cmp.stratified == null ? 'n/a' : pct(cmp.stratified)} by session size; 95% interval ${pct(cmp.ci[0])} … ${pct(cmp.ci[1])}${cmp.significant ? '' : ' (includes 0: no detectable difference)'}`);
    console.log(`claim: ${cmp.claim}`);
    for (const c of cmp.caveats) console.log(`caveat: ${c}`);
  }
  if (saved) console.log(`ledger: ${saved.sessions} sessions kept in ${saved.file}`);
}

if (require.main === module) main();
module.exports = { transcripts, saveLedger, ledgerPath };
