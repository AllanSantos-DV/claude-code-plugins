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
 *   1. not Bash / no command            → abstain
 *   2. errorGuard.enabled === false     → abstain
 *   3. sig recorded, count >= threshold → deny (inject cause)
 *   4. default                          → abstain
 *
 * Fail-open: any error → abstain. The guard must never break the tool flow.
 *
 * WHY ABSTAIN (empty stdout) INSTEAD OF AN EXPLICIT `allow`:
 * This hook shares the PreToolUse `Bash` matcher with curation-guard.js, which
 * auto-redirects curated aliases via `allow` + `updatedInput`. Sibling hooks on
 * the same matcher run in parallel and the client resolves `tool_input` across
 * their outputs — an explicit `allow` here carries NO `updatedInput`, so it
 * clobbers curation-guard's rewrite and the ORIGINAL command executes
 * (reproduced E2E; matches upstream issues #75915 / #15897). Emitting nothing
 * leaves no competing decision to resolve against, so the rewrite survives.
 * Semantically identical: no output = no objection = the call proceeds.
 *
 * INVARIANT: only ONE hook on this matcher may emit a decision that carries
 * `tool_input` (today: curation-guard.js). Do not add an `allow`/`ask` return
 * path here without re-validating the auto-redirect E2E.
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

// Abstain: emit NOTHING. See the "WHY ABSTAIN" note in the header — an explicit
// `allow` here would clobber curation-guard's `updatedInput` rewrite.
function abstain() {
  return '';
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(abstain());
      return;
    }

    const event = JSON.parse(raw);

    if (event.tool_name !== 'Bash') {
      process.stdout.write(abstain());
      return;
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      process.stdout.write(abstain());
      return;
    }

    const cfg = getErrorGuard();
    if (cfg.enabled === false) {
      process.stdout.write(abstain());
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

    process.stdout.write(abstain());
  } catch (err) {
    console.error(`[ERROR-GUARD] Error: ${err.message}`);
    hookLog('error', 'error-guard', `Unhandled error: ${err.message}`);
    process.stdout.write(abstain());
  }
})();
