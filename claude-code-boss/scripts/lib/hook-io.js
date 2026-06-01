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

module.exports = { readStdin, emitEmpty, emitJson, emitStopBlock, parsePayload };
