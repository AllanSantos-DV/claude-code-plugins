#!/usr/bin/env node
'use strict';
/**
 * compaction-report.js — compactions per session / model / window crossed with their cost, and the
 * threshold the data suggests (stating what is missing). With --cache: each compaction crossed with the
 * cache state it ran over (warm vs cold per day or week, and the warm ones listed).
 * Usage: node compaction-report.js [days] [--json] [--project <id>] [--cache [--period day|week]]
 */
const { loadCompactionRows, formatReport, summarizeCompaction } = require('./lib/compaction-report.js');
const { crossCacheState, formatCross } = require('./lib/compaction-cache-cross.js');

function main(argv) {
  const json = argv.includes('--json');
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const project = valueOf('--project');
  const period = valueOf('--period') || 'day';
  const days = Number(argv.find((a, i) => /^\d+$/.test(a) && argv[i - 1] !== '--project')) || 30;
  const rows = loadCompactionRows({ days, project });
  if (argv.includes('--cache')) {
    const x = crossCacheState(rows, { period });
    process.stdout.write(`${json ? JSON.stringify(x, null, 2) : formatCross(x, { days })}\n`);
    return;
  }
  const summary = summarizeCompaction(rows);
  process.stdout.write(`${json ? JSON.stringify(summary.episodes, null, 2) : formatReport(summary, { days })}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`compaction-report: ${err.message}`); process.exit(1); }
}

module.exports = { main };
