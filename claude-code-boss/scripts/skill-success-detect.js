#!/usr/bin/env node
/**
 * skill-success-detect.js — Stop hook (Plan #9 Loop 4).
 *
 * Pairs each `skill.invoked` event in this session with a heuristic
 * success/failure verdict, recorded as `skill.outcome`. Heuristic:
 *   - For each unsettled `skill.invoked` in this sid:
 *     - if any `failure.retro.fired` event in this sid has ts > skill ts → outcome=0
 *     - else → outcome=1
 *   - Record `skill.outcome` metric { skillName, success: 0|1 }
 *   - Track settled skill-event ids in `.runtime/skill-outcome-settled-<sid>.json`
 *     so we don't double-count across Stop ticks.
 *
 * Heuristic is rough by design (per Plan #9 D2 — auto-disable disabled, banner
 * is just a hint). Refinement comes from instrumentation feedback.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

function settledPath(sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(DATA_DIR, '.runtime', `skill-outcome-settled-${safe}.json`);
}

function readSettled(p) {
  try { const a = JSON.parse(fs.readFileSync(p, 'utf-8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

function writeSettled(p, ids) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const capped = ids.slice(-200);
    fs.writeFileSync(p, JSON.stringify(capped));
  } catch { /* best effort */ }
}

/**
 * Pure: given invocations + failures + already-settled ids, return outcomes
 * to record. Each output: { eventId, skillName, success: 0|1 }.
 */
function computeOutcomes(invocations, failures, settledIds) {
  const settled = new Set(settledIds);
  const failuresAsc = (failures || []).slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const inv of invocations || []) {
    if (settled.has(inv.id)) continue;
    const skillName = inv.payload && inv.payload.skillName;
    if (!skillName) continue;
    const failed = failuresAsc.some(f => f.ts > inv.ts);
    out.push({ eventId: inv.id, skillName, success: failed ? 0 : 1 });
  }
  return out;
}

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  if (ev.stop_hook_active) return emitEmpty();

  const sid = ev.session_id || ev.sessionId || 'default';
  const project = ev.cwd ? path.basename(ev.cwd) : 'default';

  let store;
  try {
    store = require('./brain-store.js');
    await store.init({ project, skipEmbedder: true });
    if (store.getStorageType() !== 'sqlite') return emitEmpty();
  } catch { return emitEmpty(); }

  let invocations, failures;
  try {
    invocations = store.getEventLog({ eventName: 'skill.invoked', limit: 500 })
      .filter(e => e.sessionId === sid);
    failures = store.getEventLog({ eventName: 'failure.retro.fired', limit: 200 })
      .filter(e => e.sessionId === sid);
  } catch { return emitEmpty(); }

  if (!invocations.length) return emitEmpty();

  const sp = settledPath(sid);
  const settledIds = readSettled(sp);
  const outcomes = computeOutcomes(invocations, failures, settledIds);
  if (!outcomes.length) return emitEmpty();

  for (const o of outcomes) {
    try { store.recordMetric('skill.outcome', { skillName: o.skillName, success: o.success }, sid); }
    catch { /* best effort */ }
  }

  writeSettled(sp, [...settledIds, ...outcomes.map(o => o.eventId)]);
  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[skill-success-detect] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { computeOutcomes, settledPath };
