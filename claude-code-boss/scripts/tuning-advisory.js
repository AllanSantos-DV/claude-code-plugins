#!/usr/bin/env node
/**
 * tuning-advisory.js — SessionStart hook (mechanical, zero model).
 *
 * Reads the current project's telemetry, runs the DETERMINISTIC tuning-advisor,
 * and injects the single highest-priority recommendation (warn/suggest) as a
 * one-line advisory. Cooldown-guarded (once/6h), silent when nothing is
 * actionable. Mirrors doctor-advisory: cheap, no network, never an extra agent
 * turn — the analysis is mechanical, only the short conclusion reaches the agent.
 */
'use strict';

const path = require('path');

const { runTextCli } = require('./lib/hook-io.js');
const hooksConfig = require('./lib/hooks-config.js');
const { analyze } = require('./lib/tuning-advisor.js');
const { aggregateProfileImpact } = require('./lib/profile-impact.js');
const { aggregateCaptureRate } = require('./lib/capture-rate.js');

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most once per 6h
const { onCooldown: cooldownActive, stamp } = require('./lib/cooldown-stamp.js');
const onCooldown = (p) => cooldownActive(p, COOLDOWN_MS);

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function stampPath() { return path.join(dataDir(), '.runtime', 'tuning-advisory-last.json'); }

/** Read one project's telemetry into the shape tuning-advisor.analyze() expects. */
async function gather(project) {
  const metricsStore = require('./lib/metrics-store.js');
  if (!metricsStore.init({ project })) return null;
  const dispatch = metricsStore.getEventLog({ eventName: 'stop.dispatch', limit: 2000 });
  const nudges = metricsStore.getEventLog({ eventName: 'nudge.emitted', limit: 1000 })
    .map(e => ({ eventName: 'nudge.emitted', payload: e.payload, project, ts: e.ts }));
  const caps = metricsStore.getEventLog({ eventName: 'lesson.captured', limit: 1000 })
    .map(e => ({ eventName: 'lesson.captured', payload: e.payload, project, ts: e.ts }));
  const fired = metricsStore.getEventLog({ eventName: 'retrieve.fired', limit: 2000 }).length;
  const cited = metricsStore.getEventLog({ eventName: 'retrieve.cited', limit: 2000 }).length;
  return {
    activeProfile: hooksConfig.getProfile(),
    impact: aggregateProfileImpact(dispatch),
    captureRate: aggregateCaptureRate([...nudges, ...caps]),
    retrieval: { fired, cited },
  };
}

async function run(event) {
  const sp = stampPath();
  if (onCooldown(sp)) return null;

  const project = require('./lib/metrics-project.js').sessionMetricsKey(event && event.cwd);
  let input = null;
  try { input = await gather(project); }
  catch (err) { console.error(`[tuning-advisory] ${err && err.message ? err.message : err}`); return null; }
  if (!input) return null;

  const { recommendations } = analyze(input);
  const top = recommendations.find(r => r.level === 'warn' || r.level === 'suggest');
  if (!top) return null;

  stamp(sp);
  return `[TUNING] ${top.title} — ${top.detail} (${top.evidence}). Detalhes no card "Recomendações de tuning" do /dashboard.`;
}

function main() { return runTextCli(run, 'TUNING-ADVISORY', 'SessionStart'); }

if (require.main === module) {
  main(); // runTextCli never rejects: it logs and emits {} itself
}

module.exports = { onCooldown, stampPath, gather, COOLDOWN_MS, run };
