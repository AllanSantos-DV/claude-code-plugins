#!/usr/bin/env node
/**
 * session-summary.js — Stop detector (U2, "value made visible").
 *
 * Once per session (counter cap, like auto-continue-stop), when the session has
 * captured at least one lesson, inject a single positive one-liner:
 *   "[SESSION] Captured N lesson(s) this session — the Brain is learning."
 *
 * Agent-facing (EN); the agent relays it to the user in their language. Cheap and
 * standard-friendly (fires in both profiles) — it's encouragement, not a gate.
 *
 * "This session" is bounded by the session-start stamp written at SessionStart
 * (curation-session.js). lesson.captured metrics carry no session_id, so we count
 * project-matched events with ts >= that stamp.
 */
'use strict';

const fs = require('fs');
const { writeFileAtomic } = require('./lib/atomic-write.js');
const path = require('path');

const hooksCfg = require('./lib/hooks-config.js');
const { countLessonsSince } = require('./lib/value-summary.js');

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function safeSid(sid) {
  return String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function startStampPath(dir, sid) {
  return path.join(dir, '.runtime', `session-start-${safeSid(sid)}.json`);
}

function counterPath(dir, sid) {
  return path.join(dir, '.runtime', `session-summary-${safeSid(sid)}.json`);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* absent */ return null; }
}

function buildReason(n) {
  const s = n === 1 ? '' : 's';
  return `[SESSION] Captured ${n} lesson${s} this session — the Brain is learning. `
    + `If more durable lessons emerged, capture them before you finish.`;
}

/** Read this project's lesson.captured rows. Fail-open to []. */
function readLessons(metricsStore, project) {
  try {
    if (!metricsStore.init({ project })) return [];
    return metricsStore.getEventLog({ eventName: 'lesson.captured', limit: 500 });
  } catch (err) { console.error(`[session-summary] read(${project}): ${err.message}`); return []; }
}

async function run(event, deps = {}) {
  const ev = event || {};
  const cfg = hooksCfg.getSessionSummary();
  if (!cfg.enabled) return {};
  if (ev.stop_hook_active) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const dir = deps.dataDir || dataDir();

  // Fire at most once per session.
  const cFile = counterPath(dir, sid);
  if (readJson(cFile)) return {};

  const start = readJson(startStampPath(dir, sid));
  // Missing stamp → count nothing this session (avoid reporting the all-time
  // total once). A present stamp bounds the count to the session lifetime.
  const sinceTs = start && Number.isFinite(start.ts) ? start.ts : Date.now();
  const project = ev.cwd ? path.basename(ev.cwd) : (start && start.project) || 'default';

  const metricsStore = deps.metricsStore || require('./lib/metrics-store.js');
  // Count lessons captured this session across BOTH the project DB and the global
  // __user__ DB — user-scoped captures (type reference/research or user-tagged)
  // land in __user__, so a project-only read would miss/undercount them.
  const projRows = readLessons(metricsStore, project);
  const userRows = project === '__user__' ? [] : readLessons(metricsStore, '__user__');
  const n = countLessonsSince(projRows, { sinceTs, project })
    + countLessonsSince(userRows, { sinceTs });
  if (n <= 0) return {};

  try {
    fs.mkdirSync(path.dirname(cFile), { recursive: true });
    writeFileAtomic(cFile, JSON.stringify({ firedAt: Date.now(), count: n }));
  } catch (err) { console.error(`[session-summary] counter write failed: ${err.message}`); }

  return { block: true, reason: buildReason(n) };
}

if (require.main === module) {
  const { runStopDetectorCli } = require('./lib/hook-io.js');
  runStopDetectorCli(run, 'session-summary');
}

module.exports = { run, buildReason, counterPath, startStampPath };
