#!/usr/bin/env node
/**
 * pretooluse-bash-dispatcher.js — the single PreToolUse/Bash-hook entry.
 *
 * Consolidates the 2 per-Bash Node spawns (curation-guard.js, error-guard.js)
 * into ONE in-process pass: read stdin once, run both pure `run(event)`
 * detectors in-process, and merge into a single decision — mirroring
 * `stop-dispatcher.js`'s "N spawns → 1" pattern for `Stop`.
 *
 * Merge rule (deny wins, replicated from Claude Code's own
 * multi-hook precedence for the same matcher):
 *   - `error-guard` returns `null` (abstain) or a `deny` decision — never
 *     `allow`/`ask` (see error-guard.js's "WHY ABSTAIN" note).
 *   - `curation-guard` returns `{}` (abstain — never a blanket `allow`, which would
 *     bypass Claude Code's permission system), `deny`, or `allow`/`ask` +
 *     `updatedInput` for a rewrite (curated redirect / shaper).
 *   - If `error-guard` denies, THAT decision wins — even over
 *     `curation-guard`'s `updatedInput` — because the call never runs anyway.
 *   - Otherwise, `curation-guard`'s decision is emitted as-is.
 * This reproduces exactly what the two hooks running as siblings on the same
 * matcher already do today; consolidating into one process only removes the
 * extra spawn, not the semantics.
 *
 * Each detector runs in its own try/catch so a crash in one never blocks the
 * other — same fail-open guarantee as when they were separate processes.
 */
'use strict';

const { readStdin, parsePayload, emitJson } = require('./lib/hook-io.js');
const curationGuard = require('./curation-guard.js');
const errorGuard = require('./error-guard.js');

const DEFAULT_PASS = {}; // abstain: the user's permission flow decides

/**
 * Run both detectors against the same event and merge per the deny-wins rule.
 * Exported (pure, no stdio) so it can be exercised directly in unit tests.
 * @param {object} event  PreToolUse payload
 * @returns {Promise<object>} decision object to emit
 */
async function dispatch(event) {
  let curationOut = null;
  try {
    curationOut = await curationGuard.run(event);
  } catch (err) {
    console.error(`[claude-code-boss:pretooluse-bash-dispatcher] curation-guard: ${err && err.message ? err.message : err}`);
  }

  let errorOut = null;
  try {
    errorOut = await errorGuard.run(event);
  } catch (err) {
    console.error(`[claude-code-boss:pretooluse-bash-dispatcher] error-guard: ${err && err.message ? err.message : err}`);
  }

  if (errorOut && errorOut.hookSpecificOutput && errorOut.hookSpecificOutput.permissionDecision === 'deny') {
    return errorOut;
  }
  return curationOut || DEFAULT_PASS;
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const out = await dispatch(event);
  emitJson(out);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[claude-code-boss:pretooluse-bash-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitJson(DEFAULT_PASS);
  });
}

module.exports = { dispatch, DEFAULT_PASS };
