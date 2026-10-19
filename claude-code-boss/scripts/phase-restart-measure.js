#!/usr/bin/env node
/**
 * phase-restart-measure.js — would the phase-restart notice save money on this machine? Reads the Claude Code
 * transcripts (read-only) and replays them (lib/phase-restart-measure.js).
 *
 *   node scripts/phase-restart-measure.js [--days 30] [--threshold 400000] [--json] [--save]
 *
 *   --save   keep the result in <data dir>/.runtime/phase-restart-measure.json (the dashboard shows it)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { measure } = require('./lib/phase-restart-measure.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function resultPath() {
  return path.join(require('../engine/lib/data-dir.js').dataDir(), '.runtime', 'phase-restart-measure.json');
}

function main() {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const days = Number(arg('--days', 30));
  const thresholdTokens = Number(arg('--threshold', 400000));
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number (got ${arg('--days')})`);
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) throw new Error(`--threshold must be a positive number (got ${arg('--threshold')})`);
  const r = measure({ root, days, thresholdTokens });
  if (process.argv.includes('--save')) {
    const file = resultPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r)}\n`); return; }
  console.log(`Phase restart at ${Math.round(r.thresholdTokens / 1000)}k — ${r.sessions} sessions, ${r.activeDays} active days (last ${days}), sessions/day median ${r.sessionsPerDay.median} · p90 ${r.sessionsPerDay.p90} · max ${r.sessionsPerDay.max}`);
  console.log(`Crossings: ${r.crossings} (${r.crossingsPerSessionDay} per session-day that crossed); notices that would fire: ${r.notices}`);
  console.log(`Saving: US$ ${r.savingUsd} of US$ ${r.baseUsd} (${r.savingPct}%) = US$ ${r.savingUsdPerDay}/active day, US$ ${r.savingPerNoticeUsd}/notice — ${r.verdict}`);
  if (r.unpricedCalls) console.log(`${r.unpricedCalls} calls of models without a price were billed as Opus 5.5`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`phase-restart-measure: ${err.message}`); process.exit(1); }
}

module.exports = { resultPath };
