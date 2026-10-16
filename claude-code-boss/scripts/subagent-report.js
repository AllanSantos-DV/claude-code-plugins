#!/usr/bin/env node
/**
 * subagent-report.js — how big sub-agent contexts get per agent type and whether a smaller compaction window is worth
 * setting for any of them (lib/subagent-usage.js). Read-only: it never edits an agent file.
 *
 *   node scripts/subagent-report.js [--days 30] [--json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionRecord } = require('./lib/economy-ledger.js');
const { summarizeSubagents } = require('./lib/subagent-usage.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Sub-agent transcripts (`<project>/<session>/subagents/agent-*.jsonl`) touched inside the window, with their agent type. */
function subagentRuns(days) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const since = Date.now() - days * 86400e3;
  const runs = [];
  for (const proj of fs.readdirSync(root)) {
    const pd = path.join(root, proj);
    for (const d of fs.readdirSync(pd, { withFileTypes: true })) {
      const sd = path.join(pd, d.name, 'subagents');
      if (!d.isDirectory() || !fs.existsSync(sd)) continue;
      for (const f of fs.readdirSync(sd)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(sd, f);
        if (fs.statSync(p).mtimeMs < since) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        const rec = sessionRecord(lines);
        if (!rec) continue;
        const metaFile = p.replace(/\.jsonl$/, '.meta.json');
        const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
        runs.push({ ...rec, agentType: meta.agentType || 'unknown', compactions: lines.filter((l) => l.includes('compact_boundary')).length });
      }
    }
  }
  return runs;
}

function main() {
  const days = Number(arg('--days', 30));
  const s = summarizeSubagents(subagentRuns(days));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`sub-agent runs in the last ${days} days: ${s.total.runs}, ${s.total.calls} calls`);
  for (const t of s.types) {
    console.log(`${t.agentType.padEnd(24)} runs ${String(t.runs).padStart(4)}  peak context p50 ${String(t.peak.p50).padStart(7)} p90 ${String(t.peak.p90).padStart(7)} max ${String(t.peak.max).padStart(7)}  engine cuts ${t.engineCompactions}  → ${t.advice.action === 'none' ? 'nothing to set' : `SET autoCompactWindow: ${t.advice.window}`} (${t.advice.why})`);
  }
}

if (require.main === module) main();
module.exports = { subagentRuns };
