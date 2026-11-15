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
 * in-process pass — same pattern as the other dispatchers here. The mcp-memory
 * auto-update runs inside brain-daemon-ensure after its daemon check; it does
 * not add another hook or detector process.
 * `policy-inject.js` ALSO stays wired standalone on `SubagentStart` (a
 * separate matcher with a single hook, not consolidated) — its `run(event)`
 * is shared, not duplicated logic.
 *
 * CONCURRENT with per-detector timeouts, exactly like
 * `user-prompt-submit-dispatcher.js` — see that file's header for the full
 * rationale (a plain sequential loop turns the old parallel processes'
 * `max()` latency into a `sum()`).
 *
 * The session waits only for what it needs. Every detector in the foreground pass has a
 * ceiling of a few seconds, and the process exits as soon as they settle, so a hung one
 * never holds the session start (it used to wait for the slowest ceiling: the mcp-memory
 * update alone had 120 s). The detectors flagged `bg` (maintenance with no text for the
 * session, and the mcp-memory update) run in a detached copy of this script started after
 * the answer is out (`CCB_SESSION_START_BACKGROUND=1`), with their long ceilings.
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

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readStdin, parsePayload, emitJson, emitEmpty } = require('./lib/hook-io.js');
const { settleWithin: withTimeout } = require('../engine/lib/settle-within.js');
const brainDaemonEnsure = require('./brain-daemon-ensure.js');
const memoryRotate = require('./memory-rotate.js');
const sessionWhitelist = require('./session-whitelist.js');
const brainHealth = require('./brain-health.js');
const projectSnapshot = require('./project-snapshot.js');
const curationSession = require('./curation-session.js');
const doctorAdvisory = require('./doctor-advisory.js');
const doctorFirstRun = require('./doctor-first-run.js');
const reviewChecklistAdvisory = require('./review-checklist-advisory.js');
const powershellAdvisory = require('./powershell-advisory.js');
const tuningAdvisory = require('./tuning-advisory.js');
const valueDigest = require('./value-digest.js');
const projectIdentityAdvisory = require('./project-identity-advisory.js');
const backendOnboardingAdvisory = require('./backend-onboarding-advisory.js');
const marketplaceAutoupdate = require('./marketplace-autoupdate-ensure.js');
const graphWarm = require('./graph-warm.js');
const policyInject = require('./policy-inject.js');
const runtimeSweep = require('./runtime-sweep.js');

const SEP = '\n\n';

// Marks the detached copy (argv stays untouched: the hook command's signature must not change its behavior).
const BACKGROUND_ENV = 'CCB_SESSION_START_BACKGROUND';

// Foreground ceilings are a few seconds; `bg` detectors keep the ceilings of their old standalone hooks.
const DETECTORS = [
  // The daemon check only: its update (download + restart) is the separate background step below.
  { name: 'brain-daemon-ensure', mod: { run: (event) => brainDaemonEnsure.run(event, { skipAutoUpdate: true }) }, timeoutMs: 5000 },
  { name: 'mcp-memory-auto-update', mod: { run: (event) => brainDaemonEnsure.runAutoUpdateInBackground(event) }, timeoutMs: 120000, bg: true },
  { name: 'memory-rotate', mod: memoryRotate, timeoutMs: 10000, bg: true },
  { name: 'runtime-sweep', mod: runtimeSweep, timeoutMs: 5000, bg: true },
  { name: 'session-whitelist', mod: sessionWhitelist, timeoutMs: 5000 },
  { name: 'brain-health', mod: brainHealth, timeoutMs: 3000 },
  { name: 'project-snapshot', mod: projectSnapshot, timeoutMs: 5000 },
  { name: 'curation-session', mod: curationSession, timeoutMs: 5000 },
  { name: 'doctor-advisory', mod: doctorAdvisory, timeoutMs: 5000 },
  // Once per build; only claims the run and starts the audit in a detached process (the notice comes on the next prompt).
  { name: 'doctor-first-run', mod: doctorFirstRun, timeoutMs: 5000 },
  { name: 'review-checklist-advisory', mod: reviewChecklistAdvisory, timeoutMs: 5000 },
  { name: 'tuning-advisory', mod: tuningAdvisory, timeoutMs: 3000 },
  { name: 'value-digest', mod: valueDigest, timeoutMs: 5000 },
  { name: 'project-identity-advisory', mod: projectIdentityAdvisory, timeoutMs: 5000 },
  { name: 'backend-onboarding-advisory', mod: backendOnboardingAdvisory, timeoutMs: 5000 },
  { name: 'marketplace-autoupdate', mod: marketplaceAutoupdate, timeoutMs: 15000, bg: true },
  { name: 'graph-warm', mod: graphWarm, timeoutMs: 5000, bg: true },
  { name: 'powershell-advisory', mod: powershellAdvisory, timeoutMs: 5000 },
  { name: 'policy-inject', mod: policyInject, timeoutMs: 3000 },
];

// SessionStart also fires after every compaction (source 'compact' — more often than real
// starts: 82 vs 62 in 3 days, p50 2 s each, blocking the session). There only what the
// compacted context may have lost is re-sent, plus the daemon check; maintenance, digests,
// the doctor and update checks already ran at the start of this session.
const COMPACT_DETECTORS = new Set([
  'brain-daemon-ensure', 'mcp-memory-auto-update', 'curation-session', 'review-checklist-advisory',
  'project-identity-advisory', 'powershell-advisory', 'policy-inject',
]);

/**
 * Race a detector's `run(event)` against its own ceiling. Resolves to a
 * tagged outcome (never rejects) so the caller can log an accurate message
 * for each of the three distinct cases — see `user-prompt-submit-dispatcher.js`
 * for the identical helper and full rationale.
 * @returns {Promise<{status:'ok', value:*}|{status:'timeout'}|{status:'error', err:Error}>}
 */

/**
 * Run every detector against the same event CONCURRENTLY, and concatenate
 * whatever STRING each one returns (side-effect-only detectors return
 * non-strings and are silently excluded — see header). Concatenation order
 * follows the `DETECTORS` array, not completion order (deterministic).
 * Pure (no stdio) so it can be exercised directly in unit tests.
 * `opts.detectors` overrides the real detector list (test-only — mirrors the
 * other dispatchers here).
 * @param {object} event  SessionStart payload
 * @param {{detectors?: Array<{name:string, mod:{run:Function}, timeoutMs?:number, bg?:boolean}>, phase?: 'foreground'|'background'}} [opts]
 *   phase: which detectors run — the ones the session waits for (default) or the `bg` ones.
 * @returns {Promise<string|null>}
 */
async function dispatch(event, opts = {}) {
  const all = Array.isArray(opts.detectors) ? opts.detectors : DETECTORS;
  const background = opts.phase === 'background';
  const phased = all.filter((d) => !!d.bg === background);
  const list = event && event.source === 'compact' ? phased.filter((d) => COMPACT_DETECTORS.has(d.name)) : phased;
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

/**
 * Starts the `bg` detectors in a hidden detached copy of this script and hands it the event on stdin.
 * Its stderr goes to `.runtime/session-start-background.log`.
 * @param {string} raw  the SessionStart payload as received
 * @returns {Promise<void>} settles once the event is in the child's pipe (exiting earlier would drop it)
 */
function startBackground(raw) {
  const log = path.join(require('../engine/lib/data-dir.js').dataDir(), '.runtime', 'session-start-background.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [__filename], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', fd], env: { ...process.env, [BACKGROUND_ENV]: '1' } });
    child.on('error', (err) => console.error(`[claude-code-boss:session-start-dispatcher] background start failed: ${err.message}`));
    child.unref();
    return new Promise((resolve) => {
      child.stdin.on('error', (err) => { console.error(`[claude-code-boss:session-start-dispatcher] background stdin: ${err.message}`); resolve(); });
      child.stdin.end(raw, resolve);
    });
  } finally {
    fs.closeSync(fd);
  }
}

/** The detached pass: the `bg` detectors only, no output. */
async function mainBackground() {
  const event = parsePayload(await readStdin()) || {};
  await dispatch(event, { phase: 'background' });
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const eventName = event.hook_event_name || 'SessionStart';
  // Here (a command hook) CLAUDE_PROJECT_DIR is real; daemon-served hooks never get it
  // (lib/session-root.js) — hand it over by session_id.
  require('./lib/session-root.js').recordSessionRoot(event.session_id, process.env.CLAUDE_PROJECT_DIR, { projectId: process.env.CCB_PROJECT_ID, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT });
  if (event.source === 'compact' || event.source === 'clear') require('./lib/glob-injected.js').reset(event.session_id);
  if (event.source === 'compact' || event.source === 'clear') require('./lib/scope-rules.js').resetInjected(event.session_id, { source: event.source });
  try { require('./lib/plugin-dir-heal.js').healOpenSessions(); } catch (err) { console.error(`[claude-code-boss:session-start-dispatcher] plugin dir heal: ${err.message}`); }
  const text = await dispatch(event);
  if (text) emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
  else emitEmpty();
  try { await startBackground(raw); } catch (err) { console.error(`[claude-code-boss:session-start-dispatcher] background start: ${err.message}`); }
}

// A detector that timed out may still hold handles: exit once stdout has flushed or the hook waits for it.
const exitAfterFlush = () => process.stdout.write('', () => process.exit(0));

if (require.main === module) {
  require('./lib/hook-prefix.js').install('session-start-dispatcher');
  const background = process.env[BACKGROUND_ENV] === '1';
  (background ? mainBackground() : main()).then(exitAfterFlush, (err) => {
    console.error(`[claude-code-boss:session-start-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    if (!background) emitEmpty();
    exitAfterFlush();
  });
}

module.exports = { dispatch, DETECTORS, COMPACT_DETECTORS, SEP, withTimeout };
