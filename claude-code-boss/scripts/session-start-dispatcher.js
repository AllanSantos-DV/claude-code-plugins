#!/usr/bin/env node
/**
 * session-start-dispatcher.js — the single SessionStart Node-hook entry
 * (excludes `model-router-ensure.js`, which stays a separate spawn — same
 * reason as in `user-prompt-submit-dispatcher.js`: it calls `process.exit()`
 * in its normal flow and does real multi-second waits).
 *
 * Consolidates 12 per-session Node spawns (brain-daemon-ensure.js,
 * memory-rotate.js, session-whitelist.js, brain-health.js,
 * project-snapshot.js, curation-session.js, doctor-advisory.js,
 * review-checklist-advisory.js, tuning-advisory.js,
 * project-identity-advisory.js, graph-warm.js, policy-inject.js) into ONE
 * in-process pass — same pattern as the other dispatchers here.
 * `policy-inject.js` ALSO stays wired standalone on `SubagentStart` (a
 * separate matcher with a single hook, not consolidated) — its `run(event)`
 * is shared, not duplicated logic.
 *
 * CONCURRENT with per-detector timeouts, exactly like
 * `user-prompt-submit-dispatcher.js` — see that file's header for the full
 * rationale (a plain sequential loop turns the old parallel processes'
 * `max()` latency into a `sum()`, and `brain-daemon-ensure` alone can
 * legitimately take several seconds). Ceilings mirror each detector's OLD
 * standalone `hooks.json` timeout; `brain-daemon-ensure` gets 25000 (not the
 * dispatcher's own 30000 external timeout) for the same margin reason.
 *
 * Two detector shapes coexist here (unlike the other dispatchers, which are
 * uniform):
 *   - TEXT detectors (`run(event) → string|null`): brain-daemon-ensure,
 *     brain-health, project-snapshot, curation-session, doctor-advisory,
 *     review-checklist-advisory, tuning-advisory, project-identity-advisory,
 *     policy-inject — contribute `additionalContext`.
 *   - SIDE-EFFECT-only detectors (`run(event) → anything non-string`):
 *     memory-rotate, session-whitelist, graph-warm — their return value is
 *     discarded; only the side effect (file rotation, whitelist file,
 *     graph-ingest poke) matters. `dispatch()` tells the two apart with a
 *     single `typeof result === 'string'` check — no separate detector list
 *     needed, and a detector can't accidentally "leak" a non-text return
 *     into the merged `additionalContext`.
 *
 * Each detector runs in its own try/catch(+timeout) so a crash or hang in
 * one never blocks the others — same fail-open guarantee as separate
 * processes.
 */
'use strict';

const { readStdin, parsePayload, emitJson, emitEmpty } = require('./lib/hook-io.js');
const brainDaemonEnsure = require('./brain-daemon-ensure.js');
const memoryRotate = require('./memory-rotate.js');
const sessionWhitelist = require('./session-whitelist.js');
const brainHealth = require('./brain-health.js');
const projectSnapshot = require('./project-snapshot.js');
const curationSession = require('./curation-session.js');
const doctorAdvisory = require('./doctor-advisory.js');
const reviewChecklistAdvisory = require('./review-checklist-advisory.js');
const tuningAdvisory = require('./tuning-advisory.js');
const projectIdentityAdvisory = require('./project-identity-advisory.js');
const graphWarm = require('./graph-warm.js');
const policyInject = require('./policy-inject.js');

const SEP = '\n\n';

// Ceilings mirror each detector's OLD standalone `hooks.json` timeout (ms).
const DETECTORS = [
  { name: 'brain-daemon-ensure', mod: brainDaemonEnsure, timeoutMs: 25000 },
  { name: 'memory-rotate', mod: memoryRotate, timeoutMs: 10000 },
  { name: 'session-whitelist', mod: sessionWhitelist, timeoutMs: 10000 },
  { name: 'brain-health', mod: brainHealth, timeoutMs: 5000 },
  { name: 'project-snapshot', mod: projectSnapshot, timeoutMs: 5000 },
  { name: 'curation-session', mod: curationSession, timeoutMs: 5000 },
  { name: 'doctor-advisory', mod: doctorAdvisory, timeoutMs: 5000 },
  { name: 'review-checklist-advisory', mod: reviewChecklistAdvisory, timeoutMs: 5000 },
  { name: 'tuning-advisory', mod: tuningAdvisory, timeoutMs: 8000 },
  { name: 'project-identity-advisory', mod: projectIdentityAdvisory, timeoutMs: 5000 },
  { name: 'graph-warm', mod: graphWarm, timeoutMs: 5000 },
  { name: 'policy-inject', mod: policyInject, timeoutMs: 10000 },
];

/**
 * Race a detector's `run(event)` against its own ceiling. Resolves to a
 * tagged outcome (never rejects) so the caller can log an accurate message
 * for each of the three distinct cases — see `user-prompt-submit-dispatcher.js`
 * for the identical helper and full rationale.
 * @returns {Promise<{status:'ok', value:*}|{status:'timeout'}|{status:'error', err:Error}>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ status: 'timeout' }), ms);
    promise.then(
      (value) => { clearTimeout(t); resolve({ status: 'ok', value }); },
      (err) => { clearTimeout(t); resolve({ status: 'error', err }); },
    );
  });
}

/**
 * Run every detector against the same event CONCURRENTLY, and concatenate
 * whatever STRING each one returns (side-effect-only detectors return
 * non-strings and are silently excluded — see header). Concatenation order
 * follows the `DETECTORS` array, not completion order (deterministic).
 * Pure (no stdio) so it can be exercised directly in unit tests.
 * `opts.detectors` overrides the real detector list (test-only — mirrors the
 * other dispatchers here).
 * @param {object} event  SessionStart payload
 * @param {{detectors?: Array<{name:string, mod:{run:Function}, timeoutMs?:number}>}} [opts]
 * @returns {Promise<string|null>}
 */
async function dispatch(event, opts = {}) {
  const list = Array.isArray(opts.detectors) ? opts.detectors : DETECTORS;
  const results = await Promise.all(list.map(async ({ name, mod, timeoutMs }) => {
    const outcome = await withTimeout(Promise.resolve().then(() => mod.run(event)), timeoutMs || 5000);
    if (outcome.status === 'timeout') {
      console.error(`[claude-code-boss:session-start-dispatcher] ${name}: timed out after ${timeoutMs || 5000}ms`);
      return null;
    }
    if (outcome.status === 'error') {
      const err = outcome.err;
      console.error(`[claude-code-boss:session-start-dispatcher] ${name}: ${err && err.message ? err.message : err}`);
      return null;
    }
    return outcome.value;
  }));
  const texts = results.filter((r) => typeof r === 'string' && r);
  return texts.length ? texts.join(SEP) : null;
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const eventName = event.hook_event_name || 'SessionStart';
  const text = await dispatch(event);
  if (text) {
    emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
    return;
  }
  emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[claude-code-boss:session-start-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

module.exports = { dispatch, DETECTORS, SEP, withTimeout };
