/**
 * hook-io.js — shared stdin/stdout helpers for hook scripts.
 *
 * Hook scripts share an invariant I/O shape:
 *   read JSON from stdin, write JSON (or empty `{}`) to stdout.
 *
 * Centralize so error paths are uniform.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function emitEmpty() {
  process.stdout.write('{}');
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * Emit a Stop-hook `block` directive.
 *
 * Both runtimes (Claude Code CLI/Desktop AND VS Code Copilot Chat) accept the
 * SAME top-level shape `{decision, reason}` for Stop hooks. The nested
 * `hookSpecificOutput` envelope is only valid for PreToolUse / UserPromptSubmit
 * / PostToolUse — emitting it for Stop fails schema validation with
 * "Hook JSON output validation failed — (root): Invalid input" in Copilot Chat.
 *
 * Centralized here so all Stop hooks stay consistent.
 *
 * @param {string} reason - Human-readable instruction injected back into the agent.
 */
function emitStopBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/**
 * Parse stdin payload; returns null on parse failure (caller decides response).
 * @param {string} raw
 * @returns {object|null}
 */
function parsePayload(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[hook-io] parsePayload: invalid JSON on stdin:', err.message);
    return null;
  }
}

/**
 * Normalize a Stop-detector result into a boolean-block shape.
 *
 * Detectors expose `run(event) -> { block:true, reason } | {} | null`. Both the
 * standalone CLI wrapper and the in-process dispatcher route the result through
 * here so "what counts as a block" is defined in exactly one place.
 *
 * @param {{block?:boolean, reason?:string}|null|undefined} res
 * @returns {{block:boolean, reason:string}}
 */
function normalizeStopResult(res) {
  if (res && res.block && typeof res.reason === 'string' && res.reason.length > 0) {
    return { block: true, reason: res.reason };
  }
  return { block: false, reason: '' };
}

/**
 * Thin CLI wrapper for a Stop-hook detector module.
 *
 * Preserves the standalone stdin->stdout contract (used by test-hooks.js and by
 * any direct `node <script>.js` invocation) after a detector's logic is extracted
 * into a pure `run(event)` for the in-process dispatcher: read+parse stdin, call
 * run, emit the `{decision:'block',reason}` or `{}` envelope. Never throws — a
 * detector crash degrades to "allow stop" (`{}`), matching prior per-hook fail-open.
 *
 * @param {(event:object)=>Promise<object>|object} run  detector entry point
 * @param {string} name  short label for error logs (e.g. 'pattern-detect')
 */
async function runStopDetectorCli(run, name) {
  let res = null;
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    res = await run(event);
  } catch (err) {
    console.error(`[${name}] ${err && err.message ? err.message : err}`);
    res = null;
  }
  const norm = normalizeStopResult(res);
  if (norm.block) emitStopBlock(norm.reason);
  else emitEmpty();
}

/**
 * Thin CLI wrapper for a PreToolUse-hook detector module, mirroring
 * `runStopDetectorCli` for the PreToolUse decision shape.
 *
 * `run(event)` returns either a full decision object
 * (`{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision, ...}}`)
 * or `null`/`undefined` to ABSTAIN. Abstain means EMPTY stdout, never an
 * explicit `allow` — a sibling hook on the same matcher may rely on
 * abstention so its own `updatedInput` isn't clobbered by a competing `allow`
 * (see error-guard.js's "WHY ABSTAIN" note; reproduces upstream
 * anthropics/claude-code#75915 / #15897 otherwise).
 *
 * `defaultDecision`, when provided, is what gets emitted if `run` itself
 * throws — for a detector that always opines (e.g. curation-guard, which
 * never abstains) this should be an explicit `allow` decision so a crash
 * degrades to permissive, never to a silent deny. Detectors that abstain by
 * design (e.g. error-guard) omit it, so a crash abstains too (matches their
 * existing catch-block behavior).
 *
 * @param {(event:object)=>Promise<object|null>|object|null} run
 * @param {string} name  short label for error logs
 * @param {{defaultDecision?: object|null}} [opts]
 */
async function runPreToolUseCli(run, name, { defaultDecision = null } = {}) {
  let out = null;
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    out = await run(event);
  } catch (err) {
    console.error(`[${name}] ${err && err.message ? err.message : err}`);
    out = defaultDecision;
  }
  if (out) emitJson(out);
  // else: abstain — emit nothing.
}

/**
 * Thin CLI wrapper for a side-effect-only PostToolUse(-Failure) detector —
 * one that never blocks or injects context, only performs a durable side
 * effect (journal entry, error-store update, pending-promotion stash) and
 * always answers `{}`. `run(event)`'s return value is ignored — the contract
 * is the side effect, not the reply — so a crash inside `run` degrades to the
 * exact same `{}` a healthy run would emit, just logged first. Mirrors
 * `runStopDetectorCli`/`runPreToolUseCli` for this third hook shape.
 *
 * @param {(event:object)=>Promise<void>|void} run
 * @param {string} name  short label for error logs
 */
async function runSideEffectCli(run, name) {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    await run(event);
  } catch (err) {
    console.error(`[${name}] ${err && err.message ? err.message : err}`);
  }
  emitEmpty();
}

/**
 * Thin CLI wrapper for a hook whose pure `run(event)` returns advisory text
 * (`string`) or `null` — the `additionalContext`-only shape shared by several
 * `UserPromptSubmit`-only detectors (correction-detect, active-research-detect).
 * Unlike `runPreToolUseCli`/`runSideEffectCli`, the emitted `hookEventName` is
 * a FIXED value (not echoed from the event) because these hooks only ever
 * fire on one event — see `runTextCli` below for the multi-event variant that
 * echoes `event.hook_event_name` instead.
 *
 * @param {(event:object)=>Promise<string|null>|string|null} run
 * @param {string} name  short label for error logs
 * @param {string} hookEventName  fixed event name to echo (e.g. 'UserPromptSubmit')
 */
async function runSideEffectTextCli(run, name, hookEventName) {
  let text = null;
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    text = await run(event);
  } catch (err) {
    console.error(`[${name}] ${err && err.message ? err.message : err}`);
    text = null;
  }
  if (text) emitJson({ hookSpecificOutput: { hookEventName, additionalContext: text } });
  else emitEmpty();
}

module.exports = {
  readStdin,
  emitEmpty,
  emitJson,
  emitStopBlock,
  parsePayload,
  normalizeStopResult,
  runStopDetectorCli,
  runPreToolUseCli,
  runSideEffectCli,
  runSideEffectTextCli,
};
