#!/usr/bin/env node
/**
 * Error Guard — PreToolUse hook for Bash tool calls (deterministic, Phase 2 micro-1).
 *
 * DENY-on-recurring-failure: when a shell command whose canonical signature has
 * already FAILED >= threshold times within the window (recorded by
 * failure-detect into lib/error-store) is about to run AGAIN, this hook DENIES
 * it and injects the recorded cause — so the agent stops re-running a
 * known-failing command and fixes the cause first, instead of looping on it.
 *
 * Deterministic: exact canonicalSig match — NO semantic search, NO LLM. A
 * successful run clears the sig (error-resolve.js, PostToolUse) so a fixed
 * command is no longer guarded.
 *
 * Cascade:
 *   1. not Bash / no command            → allow
 *   2. errorGuard.enabled === false     → allow
 *   3. sig recorded, count >= threshold → deny (inject cause)
 *   4. default                          → allow
 *
 * Fail-open: any error → allow. The guard must never break the tool flow.
 */
'use strict';

const { hookLog } = require('./hook-logger.js');
const { readStdin } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');
const errorStore = require('./lib/error-store.js');
const { getErrorGuard } = require('./lib/hooks-config.js');

// Build a properly-formatted PreToolUse decision per Claude Code docs.
// permissionDecision MUST be "allow" | "deny" | "ask" and live INSIDE
// hookSpecificOutput. Copied verbatim from curation-guard.js (proven shape).
// https://docs.claude.com/en/docs/claude-code/hooks
function decision(permissionDecision, { additionalContext, permissionDecisionReason } = {}) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  return JSON.stringify({ hookSpecificOutput });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(decision('allow'));
      return;
    }

    const event = JSON.parse(raw);

    if (event.tool_name !== 'Bash') {
      process.stdout.write(decision('allow'));
      return;
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      process.stdout.write(decision('allow'));
      return;
    }

    const cfg = getErrorGuard();
    if (cfg.enabled === false) {
      process.stdout.write(decision('allow'));
      return;
    }

    const projectKey = errorStore.resolveProjectKey(event.cwd || process.cwd());
    const res = errorStore.lookup(dataDir(), projectKey, command, {
      threshold: cfg.threshold,
      windowDays: cfg.windowDays,
    });

    if (res.hit) {
      const exit = res.exitCode === null || res.exitCode === undefined ? '?' : res.exitCode;
      const cause = res.cause ? `Causa registrada: ${res.cause}. ` : '';
      const reason = `[error-guard] \`${res.sig}\` já falhou ${res.count}× (exit ${exit}) neste projeto. ${cause}NÃO repita o mesmo comando — corrija a causa (ou rode uma variação que resolva) antes de tentar de novo.`;
      process.stdout.write(decision('deny', { additionalContext: reason, permissionDecisionReason: reason }));
      return;
    }

    process.stdout.write(decision('allow'));
  } catch (err) {
    console.error(`[ERROR-GUARD] Error: ${err.message}`);
    hookLog('error', 'error-guard', `Unhandled error: ${err.message}`);
    process.stdout.write(decision('allow'));
  }
})();
