#!/usr/bin/env node
/**
 * user-prompt-submit-dispatcher.js — the single UserPromptSubmit Node-hook
 * entry (excludes `model-router-ensure.js`, which stays a separate spawn: it
 * calls `process.exit()` in its normal flow and does real multi-second waits,
 * so it cannot safely share a process with the other detectors).
 *
 * Consolidates 5 per-prompt Node spawns (brain-daemon-ensure.js,
 * brain-health.js, brain-status.js, correction-detect.js,
 * active-research-detect.js) into ONE in-process pass — same "N spawns → 1"
 * pattern as the other dispatchers here. The `mcp_tool` entry
 * (`brain_retrieve_context`) stays in `hooks.json` as-is — it is not a Node
 * spawn, Claude Code calls it directly.
 *
 * CONCURRENT, not sequential: when these were separate processes, each ran in
 * PARALLEL with its own `hooks.json` timeout (brain-daemon-ensure had 30s;
 * the other four had 5s each) — total perceived latency was `max()` of them.
 * `brain-daemon-ensure` legitimately does multi-second waits in its normal
 * flow (`ensureDaemon`'s `waitCurrent`/`waitGone`, up to ~9s/5s — the same
 * class of wait that got `model-router-ensure.js` excluded above, just
 * shorter). Running detectors in a plain sequential loop would turn that
 * `max()` into a `sum()` and let one slow detector delay the other four's
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
const correctionDetect = require('./correction-detect.js');
const activeResearchDetect = require('./active-research-detect.js');

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
  { name: 'brain-daemon-ensure', mod: brainDaemonEnsure, timeoutMs: 25000 },
  { name: 'brain-health', mod: brainHealth, timeoutMs: 5000 },
  { name: 'brain-status', mod: brainStatus, timeoutMs: 5000 },
  { name: 'correction-detect', mod: correctionDetect, timeoutMs: 5000 },
  { name: 'active-research-detect', mod: activeResearchDetect, timeoutMs: 5000 },
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
  const list = Array.isArray(opts.detectors) ? opts.detectors : DETECTORS;
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
  const text = await dispatch(event);
  if (text) {
    emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
    return;
  }
  emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[claude-code-boss:user-prompt-submit-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

module.exports = { dispatch, DETECTORS, SEP, withTimeout };
