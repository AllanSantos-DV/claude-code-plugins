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

const fs = require('fs');
const { writeJsonAtomic } = require('./lib/atomic-write.js');
const path = require('path');

const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const hooksConfig = require('./lib/hooks-config.js');
const { analyze } = require('./lib/tuning-advisor.js');
const { aggregateProfileImpact } = require('./lib/profile-impact.js');
const { aggregateCaptureRate } = require('./lib/capture-rate.js');

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most once per 6h

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function stampPath() { return path.join(dataDir(), '.runtime', 'tuning-advisory-last.json'); }

function onCooldown(p) {
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf8')).ts;
    return Number.isFinite(t) && (Date.now() - t) < COOLDOWN_MS;
  } catch { /* absent → not on cooldown */ return false; }
}

function stamp(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); writeJsonAtomic(p, { ts: Date.now() }); }
  catch (e) { void e; }
}

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

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { /* defaults */ }
  const eventName = event.hook_event_name || 'SessionStart';

  const sp = stampPath();
  if (onCooldown(sp)) return emitEmpty();

  const project = event.cwd ? path.basename(event.cwd) : 'default';
  let input = null;
  try { input = await gather(project); }
  catch (err) { console.error(`[tuning-advisory] ${err && err.message ? err.message : err}`); return emitEmpty(); }
  if (!input) return emitEmpty();

  const { recommendations } = analyze(input);
  const top = recommendations.find(r => r.level === 'warn' || r.level === 'suggest');
  if (!top) return emitEmpty();

  stamp(sp);
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `[TUNING] ${top.title} — ${top.detail} (${top.evidence}). Detalhes no card "Recomendações de tuning" do /dashboard.`,
    },
  });
}

if (require.main === module) {
  main().catch((err) => { console.error(`[tuning-advisory] ${err && err.message ? err.message : err}`); emitEmpty(); });
}

module.exports = { onCooldown, stampPath, gather, COOLDOWN_MS };
