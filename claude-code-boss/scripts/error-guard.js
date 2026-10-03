#!/usr/bin/env node
/**
 * Error Guard — PreToolUse hook for Bash tool calls (deterministic, Phase 2 micro-1).
 *
 * DENY-on-recurring-failure: when a shell command already FAILED >= threshold
 * times IN THIS SESSION, in the same directory, and no file was edited since its
 * last failure, this hook DENIES the blind re-run and injects the last output —
 * so the agent fixes the cause first instead of looping. Retrying never unblocks;
 * a success or an edit (a fix attempt) does. Source of truth: the session's own
 * transcript (lib/session-failures.js) — policy chosen by replaying real history
 * (backlog U2/U10); it replaced a 90-day project-wide store that blocked commands
 * from other sessions/directories and could only be lifted by a success that the
 * block itself prevented.
 *
 * Deterministic: canonicalSig + effective directory — NO semantic search, NO LLM.
 *
 * Cascade:
 *   1. not Bash / no command / no transcript_path        → abstain
 *   2. errorGuard.enabled === false                      → abstain
 *   3. >= threshold session failures, no edit since last → deny (inject output)
 *   4. default                                           → abstain
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
 * `pretooluse-bash-dispatcher.js` enforces the same rule in-process (its own
 * merge gives `error-guard`'s `deny` precedence but never lets an abstention
 * override `curation-guard`'s `updatedInput`).
 *
 * INVARIANT: only ONE hook on this matcher may emit a decision that carries
 * `tool_input` (today: curation-guard.js). Do not add an `allow`/`ask` return
 * path here without re-validating the auto-redirect E2E.
 */
'use strict';

const { hookLog } = require('./hook-logger.js');
const { runPreToolUseCli } = require('./lib/hook-io.js');
const sessionFailures = require('./lib/session-failures.js');
const { getErrorGuard } = require('./lib/hooks-config.js');

// Build a properly-formatted PreToolUse decision object per Claude Code docs.
// permissionDecision MUST be "allow" | "deny" | "ask" and live INSIDE
// hookSpecificOutput. Copied verbatim from curation-guard.js (proven shape).
// https://docs.claude.com/en/docs/claude-code/hooks
function decision(permissionDecision, { additionalContext, permissionDecisionReason } = {}) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  return { hookSpecificOutput };
}

/**
 * Pure detector entry point. Returns a `deny` decision object on a hit, or
 * `null` to ABSTAIN — see the "WHY ABSTAIN" note in the header: an explicit
 * `allow` here would clobber curation-guard's `updatedInput` rewrite when both
 * ran as siblings on the same matcher. Shared by the standalone CLI (below)
 * and `pretooluse-bash-dispatcher.js`, which preserves the same
 * deny-wins-over-allow precedence in-process.
 * @param {object} event  PreToolUse payload
 * @returns {Promise<object|null>}
 */
async function run(event) {
  try {
    if (!event || event.tool_name !== 'Bash') return null;

    const command = event.tool_input?.command || '';
    if (!command) return null;

    const cfg = getErrorGuard();
    if (cfg.enabled === false) return null;

    // Session-scoped, read from the session's own transcript (lib/session-failures.js):
    // blocks a command that failed >= threshold times in THIS session, in the SAME
    // directory, with no file edited since its last failure. No transcript → abstain.
    const res = sessionFailures.lookup(event.transcript_path, command, event.cwd || process.cwd(), {
      threshold: cfg.threshold,
    });

    if (res.hit) {
      const exit = res.exitCode === null || res.exitCode === undefined ? '?' : res.exitCode;
      const cause = res.cause ? `Última saída: ${res.cause}. ` : '';
      const reason = `[error-guard] \`${res.sig}\` já falhou ${res.count}× nesta sessão (exit ${exit}) e nenhum arquivo foi editado desde a última falha. ${cause}Rodar de novo do mesmo jeito vai falhar igual: corrija a causa primeiro (edite o que for preciso) e então rode.`;
      // C4: every block is counted — how often the guard saves a doomed re-run.
      require('./lib/metrics.js').fire('error-guard.denied', { sig: res.sig, failures: res.count }, { sessionId: event.session_id, cwd: event.cwd });
      return decision('deny', { additionalContext: reason, permissionDecisionReason: reason });
    }

    return null;
  } catch (err) {
    console.error(`[ERROR-GUARD] Error: ${err.message}`);
    hookLog('error', 'error-guard', `Unhandled error: ${err.message}`);
    return null;
  }
}

if (require.main === module) {
  runPreToolUseCli(run, 'error-guard');
}

module.exports = { run, decision };
