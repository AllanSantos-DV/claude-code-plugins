#!/usr/bin/env node
/**
 * posttoolusebash-dispatcher.js — the single PostToolUse/Bash-hook entry.
 *
 * Consolidates the per-Bash detectors (curation-detect.js, decision-detect.js)
 * into ONE in-process pass — same "N spawns → 1" pattern as `stop-dispatcher.js`
 * and `pretooluse-bash-dispatcher.js`. (error-resolve.js was removed with the
 * error-store: error-guard reads the session transcript now.)
 *
 * Both detectors are side-effect only (turn-journal append, pending-
 * promotion stash) and never block or inject context — the
 * reply is always `{}`. Each runs in its own try/catch so a crash in one never
 * blocks the others (same fail-open guarantee as separate processes); errors
 * are logged, never propagated into the reply.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const curationDetect = require('./curation-detect.js');
const decisionDetect = require('./decision-detect.js');

const DETECTORS = [
  { name: 'curation-detect', mod: curationDetect },
  { name: 'decision-detect', mod: decisionDetect },
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
