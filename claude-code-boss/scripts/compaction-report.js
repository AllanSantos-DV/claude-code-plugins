#!/usr/bin/env node
'use strict';
/**
 * compaction-report.js — compactions per session / model / window crossed with their cost, and the
 * threshold the data suggests (stating what is missing). Usage: node compaction-report.js [days] [--json] [--project <id>]
 */
const { loadCompactionRows, formatReport, summarizeCompaction } = require('./lib/compaction-report.js');

function main(argv) {
  const json = argv.includes('--json');
  const pi = argv.indexOf('--project');
  const project = pi >= 0 ? argv[pi + 1] : null;
  if (pi >= 0 && !project) throw new Error('--project needs a value');
  const days = Number(argv.find((a, i) => /^\d+$/.test(a) && argv[i - 1] !== '--project')) || 30;
  const summary = summarizeCompaction(loadCompactionRows({ days, project }));
  process.stdout.write(`${json ? JSON.stringify(summary.episodes, null, 2) : formatReport(summary, { days })}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`compaction-report: ${err.message}`); process.exit(1); }
}

module.exports = { main };
