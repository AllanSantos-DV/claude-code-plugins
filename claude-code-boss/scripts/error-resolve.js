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

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');
const errorStore = require('./lib/error-store.js');
const { getErrorGuard } = require('./lib/hooks-config.js');

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw);
  if (!ev) return emitEmpty();
  if (ev.tool_name !== 'Bash') return emitEmpty();
  // A failure means the command did NOT succeed — never clear its record here.
  if (typeof ev.error === 'string' && ev.error.trim()) return emitEmpty();
  const command = (ev.tool_input && ev.tool_input.command) || '';
  if (!command) return emitEmpty();
  try {
    if (getErrorGuard().enabled === false) return emitEmpty();
    const projectKey = errorStore.resolveProjectKey(ev.cwd || process.cwd());
    errorStore.resolve(dataDir(), projectKey, command);
  } catch (err) {
    console.error(`[error-resolve] ${err.message}`);
  }
  emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[error-resolve] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { main };
