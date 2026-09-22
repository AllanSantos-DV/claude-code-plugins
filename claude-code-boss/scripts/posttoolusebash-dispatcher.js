#!/usr/bin/env node
/**
 * posttoolusebash-dispatcher.js — the single PostToolUse/Bash-hook entry.
 *
 * Consolidates the 3 per-Bash Node spawns (curation-detect.js,
 * decision-detect.js, error-resolve.js) into ONE in-process pass — same
 * "N spawns → 1" pattern as `stop-dispatcher.js` and
 * `pretooluse-bash-dispatcher.js`.
 *
 * All three detectors are side-effect only (turn-journal append, pending-
 * promotion stash, error-store clear) and never block or inject context — the
 * reply is always `{}`. Each runs in its own try/catch so a crash in one never
 * blocks the others (same fail-open guarantee as separate processes); errors
 * are logged, never propagated into the reply.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const curationDetect = require('./curation-detect.js');
const decisionDetect = require('./decision-detect.js');
const errorResolve = require('./error-resolve.js');

const DETECTORS = [
  { name: 'curation-detect', mod: curationDetect },
  { name: 'decision-detect', mod: decisionDetect },
  { name: 'error-resolve', mod: errorResolve },
];

/**
 * Run every detector against the same event, in-process. Pure (no stdio) so
 * it can be exercised directly in unit tests.
 * @param {object} event  PostToolUse (Bash) payload
 */
async function dispatch(event) {
  for (const { name, mod } of DETECTORS) {
    try {
      await mod.run(event);
    } catch (err) {
      console.error(`[claude-code-boss:posttoolusebash-dispatcher] ${name}: ${err && err.message ? err.message : err}`);
    }
  }
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  await dispatch(event);
  emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[claude-code-boss:posttoolusebash-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

module.exports = { dispatch, DETECTORS };
