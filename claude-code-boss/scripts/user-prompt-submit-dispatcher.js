#!/usr/bin/env node
/**
 * user-prompt-submit-dispatcher.js — the single UserPromptSubmit Node-hook
 * entry. Since G7 it also runs `model-router-ensure.js` (its `run()` no longer
 * calls `process.exit()`; its multi-second waits are bounded by its own ceiling
 * below, concurrently with the others) — one node spawn per prompt instead of
 * two. On this machine the bare node process floor is ~70-90 ms and ~63 MB, so
 * the spawn itself, not the script, was most of the cost.
 *
 * Consolidates 4 per-prompt Node spawns (model-router-ensure.js,
 * brain-daemon-ensure.js, brain-health.js, brain-status.js) into ONE in-process pass — same "N spawns → 1"
 * pattern as the other dispatchers here. The `mcp_tool` entries
 * (`brain_retrieve_context`, and since Phase G / ADR-015 `hook_correction_detect`
 * + `hook_active_research_detect`) are not Node spawns — Claude Code calls the
 * brain daemon directly. These three stay here PERMANENTLY: they are the ones
 * that start/diagnose the daemon, so they cannot depend on it.
 *
 * CONCURRENT, not sequential: when these were separate processes, each ran in
 * PARALLEL with its own `hooks.json` timeout (brain-daemon-ensure had 30s;
 * the other two had 5s each) — total perceived latency was `max()` of them.
 * `brain-daemon-ensure` legitimately does multi-second waits in its normal
 * flow (`ensureDaemon`'s `waitCurrent`/`waitGone`, up to ~9s/5s — the same
 * class of wait that got `model-router-ensure.js` excluded above, just
 * shorter). Running detectors in a plain sequential loop would turn that
 * `max()` into a `sum()` and let one slow detector delay the other two's
 * cheap advisories on EVERY prompt — a real latency regression the
 * per-process-parallel design never had. `dispatch()` below runs all
 * detectors via `Promise.all` (concurrent) and bounds each one with its own
 * timeout (`TIMEOUTS`, mirroring each hook's OLD individual `hooks.json`
 * timeout) so a hung detector can't consume the shared 30s external timeout
 * either — it just contributes no text past its own ceiling, exactly as if
 * its OLD standalone process had been killed by `hooks.json`.
 *
 * Each detector's pure `run(event)` returns advisory text (`string`) or
 * `null`. No precedence to resolve (unlike `pretooluse-bash-dispatcher.js`) —
 * these detectors never block and never compete for the same field, so every
 * non-null text is concatenated in the SAME order they had in `hooks.json`
 * (not completion order — deterministic output), mirroring
 * `stop-dispatcher.js`'s `mergeBlocks` shape.
 *
 * Each detector runs in its own try/catch so a crash (or timeout) in one
 * never blocks the others — same fail-open guarantee as separate processes.
 */
'use strict';

const { readStdin, parsePayload, emitJson, emitEmpty } = require('./lib/hook-io.js');
const brainDaemonEnsure = require('./brain-daemon-ensure.js');
const brainHealth = require('./brain-health.js');
const brainStatus = require('./brain-status.js');
const modelRouterEnsure = require('./model-router-ensure.js');

const SEP = '\n\n';

// Ceilings mirror each detector's OLD standalone `hooks.json` timeout (ms),
// so a slow/hung detector degrades exactly like its old separate process
// being killed by Claude Code's own hook timeout — never longer.
// `brain-daemon-ensure` gets 25000 (not the full 30000 the external
// `hooks.json` timeout for THIS dispatcher allows) so its internal
// "give up gracefully" path has a real chance to win the race: the internal
// clock only starts once `dispatch()` begins (after stdin read/parse), which
// is strictly LATER than the external timeout's clock (process spawn) — with
// equal ceilings the external kill would always land first or tie, and the
// internal timeout would never get to run its graceful `null` path.
const DETECTORS = [
  // First: it was the first UserPromptSubmit hook in hooks.json, so its text keeps leading.
  // 25000 like brain-daemon-ensure: its old standalone timeout was 30 s (same reasoning).
  { name: 'model-router-ensure', mod: modelRouterEnsure, timeoutMs: 25000 },
  { name: 'brain-daemon-ensure', mod: brainDaemonEnsure, timeoutMs: 25000 },
  { name: 'brain-health', mod: brainHealth, timeoutMs: 5000, advisory: true },
  { name: 'brain-status', mod: brainStatus, timeoutMs: 5000, advisory: true },
  // Folder without project id: repeat the notice on EVERY user prompt until the id
  // exists or the user refuses (.memory/memory-off.json) — decided 2026-10-02.
  { name: 'project-identity', mod: require('./project-identity-advisory.js'), timeoutMs: 5000, advisory: true },
];

/**
 * Race a detector's `run(event)` against its own ceiling. Resolves to a
 * tagged outcome instead of rejecting/returning the bare value, so the
 * caller can tell apart THREE distinct cases with an accurate log message:
 * completed normally, exceeded its ceiling, or threw/rejected — collapsing
 * the last two into one ("timed out") would misreport a genuine crash as a
 * hang and discard the real error/stack the caller needs to debug it.
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
 * Run every detector against the same event CONCURRENTLY (see header for why
 * this must not be sequential), and concatenate whatever advisory text they
 * return, in DETECTOR-LIST order (deterministic, independent of completion
 * order). Pure (no stdio) so it can be exercised directly in unit tests.
 * `opts.detectors` overrides the real detector list (test-only — mirrors
 * `stop-dispatcher.dispatch`'s override), so the merge/concatenation/
 * fail-open/timeout logic can be unit-tested without depending on the real
 * detectors' environment (daemon/network probes).
 * @param {object} event  UserPromptSubmit payload
 * @param {{detectors?: Array<{name:string, mod:{run:Function}, timeoutMs?:number}>}} [opts]
 * @returns {Promise<string|null>}
 */
async function dispatch(event, opts = {}) {
  let list = Array.isArray(opts.detectors) ? opts.detectors : DETECTORS;
  // A synthetic prompt (a sub-agent's <task-notification>) is not the user typing:
  // keep the cheap idempotent ENSURES (they keep the daemon up inside the client's
  // reconnect window, G16) but skip the advisories — diagnostics injected into an
  // agent notification are noise.
  if (require('./lib/prompt-kind.js').isSyntheticPrompt(event && event.prompt)) list = list.filter((d) => !d.advisory);
  const results = await Promise.all(list.map(async ({ name, mod, timeoutMs }) => {
    const outcome = await withTimeout(Promise.resolve().then(() => mod.run(event)), timeoutMs || 5000);
    if (outcome.status === 'timeout') {
      console.error(`[claude-code-boss:user-prompt-submit-dispatcher] ${name}: timed out after ${timeoutMs || 5000}ms`);
      return null;
    }
    if (outcome.status === 'error') {
      const err = outcome.err;
      console.error(`[claude-code-boss:user-prompt-submit-dispatcher] ${name}: ${err && err.message ? err.message : err}`);
      return null;
    }
    return outcome.value;
  }));
  const texts = results.filter(Boolean);
  return texts.length ? texts.join(SEP) : null;
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const eventName = event.hook_event_name || 'UserPromptSubmit';
  // `/dashboard` is answered here, WITHOUT the model (blocks the prompt with the URL).
  const dash = await require('./dashboard-command.js').runForPrompt(event.prompt);
  if (dash) { emitJson(dash); return; }
  const text = await dispatch(event);
  if (text) {
    emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
    return;
  }
  emitEmpty();
}

// model-router-ensure leaves handles behind (it always ended with process.exit):
// exit explicitly once stdout has flushed, or the hook would hang until its timeout.
const exitAfterFlush = () => process.stdout.write('', () => process.exit(0));

if (require.main === module) {
  main().then(exitAfterFlush, (err) => {
    console.error(`[claude-code-boss:user-prompt-submit-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
    exitAfterFlush();
  });
}

module.exports = { dispatch, DETECTORS, SEP, withTimeout };
