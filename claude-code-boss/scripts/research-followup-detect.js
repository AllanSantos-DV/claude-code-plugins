#!/usr/bin/env node
/**
 * research-followup-detect.js — Stop hook (Plan #9 Loop 5).
 *
 * Closes the active-research write-through loop: if the agent received an
 * `active-research-detect` nudge in this session AND has not subsequently
 * called `capture_lesson({type:'research', ...})`, emit a Stop-time nudge
 * reminding it to persist the findings.
 *
 * Detection:
 *   - latest `research.auto.triggered` for this sid → ts_R
 *   - any `lesson.captured` with payload.type === 'research' AND ts >= ts_R → OK
 *   - else → emit nudge (once per fire — guarded by a per-sid stamp)
 *
 * Per-sid stamp avoids nagging on every Stop while the agent is still
 * working through the research in the same turn cluster. The stamp resets
 * when a fresh `research.auto.triggered` happens (newer ts).
 *
 * Cross-scope capture read: capture_lesson({type:'research', ...}) always
 * resolves to scope 'user' (inferDefaultScope maps type 'research' → 'user'
 * unconditionally — see scope-sanitizer.js), so the entry AND its
 * `lesson.captured` metric row land in the __user__ project's OWN brain.db,
 * a physically separate SQLite file from the current project's. Reading only
 * the current-project singleton's getEventLog() never observes that capture,
 * so we additionally read the __user__ DB in isolation (getEventLogIsolated —
 * same throwaway-connection pattern as brain-store.searchIsolated, no
 * close()/init() of the shared singleton) and merge both event streams before
 * deciding.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const { USER_SENTINEL } = require('./lib/scope-sanitizer.js');

function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env && !env.includes('${')) return env;
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

function stampPath(data, sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(data, '.runtime', `research-followup-${safe}.json`);
}

function readStamp(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* absent or corrupt: null */ return null; }
}

function writeStamp(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
  } catch { /* best effort */ }
}

/**
 * Decide whether to nudge given the event log + last-nudged stamp.
 * Pure function — testable in isolation.
 */
function decideNudge(events, stamp) {
  const triggers = events.filter(e => e.eventName === 'nudge.emitted' && e.payload && e.payload.kind === 'research');
  if (!triggers.length) return { nudge: false, reason: 'no-fire' };
  const latestTrigger = triggers[0]; // events list is newest-first

  const captures = events.filter(e =>
    e.eventName === 'lesson.captured' &&
    e.payload && e.payload.type === 'research' &&
    e.ts >= latestTrigger.ts);
  if (captures.length > 0) return { nudge: false, reason: 'captured', latestTrigger };

  if (stamp && stamp.firedAt === latestTrigger.ts) {
    return { nudge: false, reason: 'already-nudged', latestTrigger };
  }

  return { nudge: true, reason: 'pending-capture', latestTrigger };
}

function buildNudgeText(latestTrigger) {
  const q = (latestTrigger.payload && latestTrigger.payload.signals)
    ? latestTrigger.payload.signals.join(', ')
    : 'unknown';
  return [
    '## Research findings — capture before closing',
    `An active-research nudge fired earlier this session (signals: ${q}) but no `,
    '`capture_lesson({type:"research", ...})` followed. If you researched and have ',
    'usable findings, persist them so the next similar query reuses them:',
    '',
    '```',
    `capture_lesson({ type: 'research', title: <short>, summary: <one-line>, detail: <findings + sources>, tags: ['research', <area>] })`,
    '```',
    '',
    'If you skipped research (already knew the answer / not relevant), ignore this notice.',
  ].join('\n');
}

async function run(event) {
  const ev = event || {};
  const sid = ev.session_id || ev.sessionId || 'default';
  const project = ev.cwd ? path.basename(ev.cwd) : 'default';
  const data = dataDir();

  let store;
  try {
    store = require('./brain-store.js');
    await store.init({ project, skipEmbedder: true });
    if (store.getStorageType() !== 'sqlite') return {};
  } catch { /* store unavailable: no-op */ return {}; }

  let triggers, captures, userCaptures;
  try {
    triggers = store.getEventLog({ eventName: 'nudge.emitted', limit: 100 })
      .filter(e => e.payload && e.payload.kind === 'research' && e.sessionId === sid);
    captures = store.getEventLog({ eventName: 'lesson.captured', limit: 100 });
    // capture_lesson({type:'research'}) always resolves to scope 'user' (see
    // header) and lands in the __user__ project's own DB — read it in isolation
    // (no singleton mutation) so those captures aren't invisible to this project.
    userCaptures = project === USER_SENTINEL
      ? []
      : store.getEventLogIsolated(USER_SENTINEL, { eventName: 'lesson.captured', limit: 100 });
  } catch { /* event log read failed: no-op */ return {}; }

  const events = [...triggers, ...captures, ...userCaptures].sort((a, b) => b.ts - a.ts);

  const sp = stampPath(data, sid);
  const stamp = readStamp(sp);
  const decision = decideNudge(events, stamp);

  if (!decision.nudge) return {};

  writeStamp(sp, { firedAt: decision.latestTrigger.ts, nudgedAt: Date.now() });

  return { block: true, reason: buildNudgeText(decision.latestTrigger) };
}

if (require.main === module) {
  runStopDetectorCli(run, 'research-followup-detect');
}

module.exports = { run, decideNudge, buildNudgeText, stampPath };
