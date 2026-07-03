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

module.exports = {
  readStdin,
  emitEmpty,
  emitJson,
  emitStopBlock,
  parsePayload,
  normalizeStopResult,
  runStopDetectorCli,
};
