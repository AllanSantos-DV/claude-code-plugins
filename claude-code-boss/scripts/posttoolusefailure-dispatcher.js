#!/usr/bin/env node
/**
 * posttoolusefailure-dispatcher.js — the single PostToolUseFailure-hook entry
 * (all tools).
 *
 * Consolidates the up-to-2 per-failure Node spawns (curation-detect.js —
 * Bash-only, checks `tool_name` itself — and failure-detect.js — all tools)
 * into ONE in-process pass, same pattern as the other dispatchers here.
 * `curation-detect.run()` already no-ops for non-Bash tools, so calling it
 * unconditionally reproduces today's Bash-only matcher without a separate
 * matcher on this dispatcher.
 *
 * Both detectors are side-effect only and never block; reply is always `{}`.
 * Each runs in its own try/catch so a crash in one never blocks the other.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const curationDetect = require('./curation-detect.js');
const failureDetect = require('./failure-detect.js');

const DETECTORS = [
  { name: 'curation-detect', mod: curationDetect },
  { name: 'failure-detect', mod: failureDetect },
];

/**
 * Run every detector against the same event, in-process. Pure (no stdio) so
 * it can be exercised directly in unit tests.
 * @param {object} event  PostToolUseFailure payload
 */
async function dispatch(event) {
  for (const { name, mod } of DETECTORS) {
    try {
      await mod.run(event);
    } catch (err) {
      console.error(`[claude-code-boss:posttoolusefailure-dispatcher] ${name}: ${err && err.message ? err.message : err}`);
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
    console.error(`[claude-code-boss:posttoolusefailure-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

module.exports = { dispatch, DETECTORS };
