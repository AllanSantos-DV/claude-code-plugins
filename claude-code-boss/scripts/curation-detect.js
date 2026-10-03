#!/usr/bin/env node
/**
 * Curation Detect — PostToolUse / PostToolUseFailure hook for Bash.
 *
 * In-loop design (replaces the old payload-on-disk + subagent pipeline):
 *  - During the turn, append-only journal entries land at
 *    ${CLAUDE_PLUGIN_DATA}/.runtime/curation-turn-<sid>--<ts>-<rand>.json
 *    (one file per entry — race-free, no read-modify-write).
 *  - At end of turn, curation-stop.js aggregates the journal via
 *    lib/turn-journal.js#readEntries and asks the main loop to act on the
 *    captured signals.
 *
 * Delegates classification to curation-classifier.js (pure function).
 * Delegates shells.json access to shells-config.js.
 *
 * Reasons recorded:
 *   needs-curation        — uncurated command, output exceeded raw thresholds
 *   curated-success-noisy — curated script succeeded but output > summary thresholds
 *   curated-failure-noisy — curated script failed, output exceeded raw thresholds
 *   (null)                — no condition matched; no entry recorded
 */
const { runSideEffectCli } = require('./lib/hook-io.js');
const turnJournal = require('./lib/turn-journal.js');
const verifyJournal = require('./lib/verify-journal.js');
const metrics = require('./lib/metrics.js');
const { canonicalSig } = require('./lib/command-signature.js');
const oneoff = require('./lib/oneoff-store.js');
const { classifyCommand } = require('./lib/curation-families.js');
const { unwrapShaped, splitTopLevel } = require('./lib/curation-redirect.js');

const { findProjectRoot, loadShellsConfig, matchCuratedShell, _tokenize, _pathMatches } = require('./shells-config.js');
const { classify, successBudgetFor }                            = require('./curation-classifier.js');

const { dataDir } = require('./lib/data-dir.js');
const { hookEnv } = require('./lib/hook-context.js');
const DATA_DIR = dataDir();
const brainConfig = require('./lib/brain-config.js');

// ─── Turn state ──────────────────────────────────────────────────────────────
// All state lives in the append-only turn journal (lib/turn-journal.js) —
// race-free because each entry writes its own file.

function appendTurnEntry(sessionId, entry) {
  turnJournal.appendEntry(sessionId, entry);
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Pure detector entry point — side-effect only (turn-journal append, verify-
 * journal record, one-hit accounting), never returns anything meaningful; the
 * reply is always `{}` regardless (see `runSideEffectCli`). A crash is caught
 * and logged here (keeping the `[CURATION-DETECT]` tag), never rethrown — so
 * both the standalone CLI and `posttoolusebash-dispatcher.js` /
 * `posttoolusefailure-dispatcher.js` land on the same silent `{}` on error
 * (previously the standalone path alone leaked `{error: msg}` to stdout, a
 * shape `PostToolUse`/`PostToolUseFailure` don't recognize anyway).
 * @param {object} event
 */
async function run(event) {
  try {
    // Only handle Bash tool PostToolUse
    if (!event || event.tool_name !== 'Bash') return;
    // Read per call (not at module load): in the shared daemon (Phase G) a
    // module-level snapshot would freeze the config for every later session.
    const _curationCfg = brainConfig.getCuration();
    const thresholds = { maxChars: _curationCfg.maxOutputChars, maxLines: _curationCfg.maxOutputLines };

    // Two different event shapes:
    //   PostToolUse (success):
    //     { tool_response: { stdout, stderr, interrupted, isImage, noOutputExpected } }
    //   PostToolUseFailure (failure):
    //     { error: "Exit code N\n<stdout+stderr>", is_interrupt: bool, duration_ms }
    //     (NO tool_response, NO separate exit_code)
    const hookEvent = event.hook_event_name || '';
    const isFailure = hookEvent === 'PostToolUseFailure';

    let stdout = '', stderr = '', output = '', interrupted = false, exitCode = null;
    if (isFailure) {
      const errStr = String(event.error || '');
      const m = errStr.match(/^Exit code (\d+)\s*\n?/);
      if (m) exitCode = parseInt(m[1], 10);
      output = m ? errStr.slice(m[0].length) : errStr;
      stderr = output;
      interrupted = event.is_interrupt === true;
    } else {
      const tr = event.tool_response || {};
      stdout = tr.stdout || '';
      stderr = tr.stderr || '';
      interrupted = tr.interrupted === true;
      exitCode = typeof tr.exit_code === 'number' ? tr.exit_code : null;
      output = [stdout, stderr].filter(Boolean).join('\n');
    }

    // A command the boss shaper wrapped (C2b) is judged as the ORIGINAL command
    // (exploration → never curated); the wrapper's `set -o pipefail` is not a task.
    const rawCommand = event.tool_input?.command || '';
    const command = unwrapShaped(rawCommand) || rawCommand;
    const topParts = splitTopLevel(command);
    const compound = !topParts || topParts.filter((p) => p.text.trim()).length > 1;
    const sessionId = event.session_id || event.sessionId || 'default';
    const cwd = event.cwd || hookEnv().CLAUDE_PROJECT_DIR || '';
    const charCount = output.length;
    const lineCount = output ? output.split('\n').length : 0;

    // Success determination:
    //   1. PostToolUseFailure → always failure
    //   2. PostToolUse with explicit exit_code → check it
    //   3. Otherwise (PostToolUse default) → success
    const isSuccess = isFailure ? false
      : (exitCode !== null ? exitCode === 0 : true);

    // Detect curated shell
    const projectRoot = findProjectRoot(cwd);
    const { shells } = loadShellsConfig(projectRoot);
    const curatedShell = matchCuratedShell(command, shells);
    const isCurated = curatedShell !== null;

    // D2 verify-nudge: record EVERY Bash command's signature in the per-turn
    // verify-journal (separate from the curation turn-journal) so the Stop
    // detector can tell whether a test/verify command ran this turn. Cheap and
    // spawn-free — piggybacks on this already-running Bash PostToolUse hook.
    verifyJournal.appendCommand(sessionId, {
      sig: canonicalSig(command),
      curated: curatedShell ? (curatedShell.id || curatedShell.script || null) : null,
    });

    // Classify — curated shells carry their declared outputLines/outputChars
    // budget so content-surfacing scripts aren't flagged on legitimate output.
    const { reason } = classify({
      command, isCurated, isSuccess, charCount, lineCount, thresholds,
      successBudget: curatedShell ? successBudgetFor(curatedShell) : undefined,
    });

    // One-hit / recurrence accounting (cross-session, per-project). Count every
    // invocation that matches a known signature (D1); create a fresh entry only
    // for volume-heavy commands (those that would be curated).
    const projectKey = oneoff.resolveProjectKey(cwd);
    const seen = oneoff.touch(DATA_DIR, projectKey, command, {
      sessionId, windowDays: _curationCfg.oneHitWindowDays, create: !!reason,
    });

    // C4: a curated script actually RAN (its path is a token — a raw alias match is not a
    // run; redirected commands arrive here already rewritten). Output size per run is what
    // the dashboard compares against the raw baseline of the same signature.
    const scriptRel = curatedShell ? String(curatedShell.script || '').trim() : '';
    if (scriptRel && _tokenize(command).some((t) => _pathMatches(t, scriptRel))) {
      metrics.fire('curation.used', { scriptId: curatedShell.id || scriptRel, chars: charCount, lines: lineCount, success: isSuccess, compound }, { sessionId, cwd });
    }

    // A COMPOUND that includes a curated script (`a.mjs; b.mjs; eslint … | tail`) produced
    // the output of every part: charging it to the script's budget asked to "refine" a
    // script whose own output was fine (seen live: test-hooks.mjs flagged for 42 lines of
    // test-units + lint + audit). The script's budget is judged on its solo runs only.
    if (curatedShell && compound) return;

    if (!reason) return;

    // U5: a SUB-AGENT's command (the hook input carries agent_id — verified in a
    // real Claude Code session, 2026-10-02) is not the parent turn's to curate: the
    // output landed in the sub-agent's context, and the parent's Stop would block on
    // a command it never ran. Recurrence above still counts it.
    if (event.agent_id) return;

    // C3 (Phase C): a per-project script only pays off for a TASK command that RECURS.
    // Exploration (git log/grep/cat…) is bounded generically — Token Guard or the boss
    // shaper — and inline code (`node -e`, heredoc) is single-use by definition; both
    // used to be curated on their first noisy output and the script was never used
    // again (18 of 41 in the field). A task's FIRST noisy occurrence stays pending; the
    // second one asks for the script. A noisy CURATED script still asks (tune it).
    if (reason === 'needs-curation') {
      const cls = classifyCommand(command);
      if (cls !== 'task') {
        metrics.fire('curation.skipped', { class: cls, chars: charCount, lines: lineCount }, { sessionId, cwd });
        return;
      }
      if (seen.count < 2) {
        metrics.fire('curation.pending', { sig: seen.sig, chars: charCount, lines: lineCount }, { sessionId, cwd });
        return;
      }
    }

    // A valid one-hit marking (still under the ceiling) suppresses the block, so
    // the Stop hook never re-asks to curate a genuine single-use command. A 1-token
    // sig can't be curated at all, so its marking holds past the ceiling.
    if (seen.matched && seen.oneHit && (seen.ceilingExempt || seen.count < _curationCfg.oneHitMaxRecurrence)) {
      console.error(`[CURATION-DETECT] suppressed one-hit (${seen.sig} ${seen.count}/${_curationCfg.oneHitMaxRecurrence})`);
      return;
    }

    // Append to per-turn state (curation-stop.js reads it at end of turn). The
    // signature + windowed recurrence travel with the entry so the Stop reason
    // can orient the agent (O1/O2).
    appendTurnEntry(sessionId, {
      command,
      reason,
      lines: lineCount,
      chars: charCount,
      isCurated,
      curatedScript: curatedShell?.script || null,
      isSuccess,
      interrupted,
      hookEvent,
      exitCode,
      sig: seen.sig,
      recurrence: seen.count,
      timestamp: new Date().toISOString(),
    });

    console.error(`[CURATION-DETECT] ${reason} (${seen.sig} ${seen.count}/${_curationCfg.oneHitMaxRecurrence}): ${charCount} chars, ${lineCount} lines`);
    // Value signal (U2): raw output that tripped the curation thresholds — the
    // dashboard sums these chars as "context saved". Fire-and-forget; never blocks.
    metrics.fire('curation.flagged', { chars: charCount, lines: lineCount, reason, isCurated, sig: seen.sig },
      { sessionId, cwd });
  } catch (err) {
    console.error(`[CURATION-DETECT] Error: ${err.message}`);
  }
}

if (require.main === module) {
  runSideEffectCli(run, 'curation-detect');
}

module.exports = { run };
