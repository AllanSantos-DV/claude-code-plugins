#!/usr/bin/env node
/**
 * error-resolve.js — PostToolUse hook for Bash (success path).
 *
 * Counterpart to error-guard: when a Bash command SUCCEEDS, clear any recorded
 * failure for its canonical signature (lib/error-store.resolve) so a now-passing
 * command stops being guarded by error-guard — preventing a false-positive DENY
 * after the cause has been fixed.
 *
 * PostToolUse fires on success; failures go through PostToolUseFailure
 * (failure-detect records them). As defense-in-depth we still skip when the
 * payload carries an `error`, so a failed call routed here can never clear the
 * failure it just produced. Never blocks: always emits `{}`.
 */
'use strict';

const { runSideEffectCli } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');
const errorStore = require('./lib/error-store.js');
const { getErrorGuard } = require('./lib/hooks-config.js');

/**
 * Pure detector entry point — side effect only (clears a recorded failure's
 * signature on success). Reply is always `{}`.
 * @param {object} ev
 */
async function run(ev) {
  if (!ev) return;
  if (ev.tool_name !== 'Bash') return;
  // A failure means the command did NOT succeed — never clear its record here.
  if (typeof ev.error === 'string' && ev.error.trim()) return;
  const command = (ev.tool_input && ev.tool_input.command) || '';
  if (!command) return;
  try {
    if (getErrorGuard().enabled === false) return;
    const projectKey = errorStore.resolveProjectKey(ev.cwd || process.cwd());
    errorStore.resolve(dataDir(), projectKey, command);
  } catch (err) {
    console.error(`[error-resolve] ${err.message}`);
  }
}

if (require.main === module) {
  runSideEffectCli(run, 'error-resolve');
}

module.exports = { run };
