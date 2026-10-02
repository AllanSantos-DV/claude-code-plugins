'use strict';
/**
 * lib/hook-tools.js — Phase G (ADR-015) hook transport: one MCP tool per migrated
 * hook, served by the already-running brain daemon so the hook costs an HTTP
 * call instead of a fresh `node` process (~64MB, ~100ms each).
 *
 * Only the TRANSPORT changes: every tool imports the hook's existing pure entry
 * point (run/evaluate/dispatch) and returns, as text, exactly the JSON the
 * `command` form writes to stdout (parity is tested in test-units.js).
 *
 * hooks.json passes the event fields explicitly (the `mcp_tool` input has no
 * whole-payload placeholder): objects arrive as JSON strings, absent paths as "".
 * rebuildEvent() turns that back into the event object the hook expects.
 *
 * Daemon hygiene (the daemon is shared by every session, a spawned hook is not):
 *   - per-call env: CLAUDE_PROJECT_DIR comes from the call (runWithHookEnv),
 *     never from the daemon's own env (the first session's);
 *   - per-call config: hooks-config/brain-config caches are reset so an edit is
 *     seen on the next call, as a fresh process would.
 *
 * Fail-open VISIBLE: an unexpected throw returns a `systemMessage` naming the
 * degraded hook — never a silent `{}`, never a block. If the daemon itself is
 * unreachable Claude Code reports a non-blocking hook error (also visible).
 */
const path = require('path');
const { runWithHookEnv } = require('./hook-context.js');

const EMPTY = '{}';

/** Event fields a hook tool accepts (all strings on the wire). */
const FIELDS = {
  hook_event_name: 'Hook event name',
  session_id: 'Session id',
  cwd: 'Working directory',
  transcript_path: 'Transcript path',
  project_dir: 'CLAUDE_PROJECT_DIR of the calling session',
  tool_name: 'Tool name',
  tool_input: 'Tool input (JSON)',
  tool_response: 'Tool response (JSON)',
  error: 'Tool error text (PostToolUseFailure)',
  is_interrupt: 'true/false (PostToolUseFailure)',
  duration_ms: 'Duration in ms (PostToolUseFailure)',
  prompt: 'User prompt',
  command: 'Expanded slash command (UserPromptExpansion)',
  command_name: 'Expanded slash command name (UserPromptExpansion)',
  stop_hook_active: 'true/false (Stop)',
};
const JSON_FIELDS = new Set(['tool_input', 'tool_response']);
const BOOL_FIELDS = new Set(['is_interrupt', 'stop_hook_active']);

/**
 * Wire args → hook event. Empty strings (absent paths) are dropped; JSON fields
 * are parsed when they hold an object/array; booleans/numbers are coerced.
 */
function rebuildEvent(args) {
  const a = args || {};
  const ev = {};
  for (const k of Object.keys(FIELDS)) {
    if (k === 'project_dir') continue;
    let v = a[k];
    if (v === undefined || v === null || v === '') continue;
    if (JSON_FIELDS.has(k) && typeof v === 'string' && /^\s*[[{]/.test(v)) {
      v = JSON.parse(v);
    } else if (BOOL_FIELDS.has(k) && typeof v === 'string') {
      v = v === 'true';
    } else if (k === 'duration_ms' && typeof v === 'string' && Number.isFinite(Number(v))) {
      v = Number(v);
    }
    ev[k] = v;
  }
  return ev;
}

const json = (out) => (out && Object.keys(out).length ? JSON.stringify(out) : EMPTY);
const PRETOOL_ALLOW = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
const additional = (hookEventName, text) => (text ? JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) : EMPTY);

/**
 * Each entry: the script that owns the logic + how to turn its pure entry point
 * into the stdout text of the `command` form.
 */
const HOOKS = {
  // async-eligible (side effect only, reply `{}`)
  hook_skill_metric: { script: 'skill-metric.js', call: async (m, ev) => { await m.run(ev); return EMPTY; } },
  hook_file_edit_detect: { script: 'file-edit-detect.js', call: async (m, ev) => { await m.run(ev); return EMPTY; } },
  hook_posttoolusebash_dispatcher: { script: 'posttoolusebash-dispatcher.js', call: async (m, ev) => { await m.dispatch(ev); return EMPTY; } },
  hook_posttoolusefailure_dispatcher: { script: 'posttoolusefailure-dispatcher.js', call: async (m, ev) => { await m.dispatch(ev); return EMPTY; } },
  hook_policy_enforce_shadow: { script: 'policy-enforce-shadow.js', call: async (m, ev) => json(await m.evaluate(ev)) },
  // silent-except-alert
  hook_correction_detect: { script: 'correction-detect.js', call: async (m, ev) => additional(ev.hook_event_name || 'UserPromptSubmit', await m.run(ev)) },
  hook_active_research_detect: { script: 'active-research-detect.js', call: async (m, ev) => additional(ev.hook_event_name || 'UserPromptSubmit', await m.run(ev)) },
  hook_policy_glob_inject: { script: 'policy-glob-inject.js', call: async (m, ev) => json(await m.evaluate(ev)) },
  // sync-real. curation-guard + error-guard are SIBLING hooks on PreToolUse/Bash
  // (Claude Code: deny wins, verified in spike S1b): curation keeps the
  // dispatcher's default allow, error-guard only ever speaks to deny.
  hook_curation_guard: { script: 'curation-guard.js', call: async (m, ev) => JSON.stringify((await m.run(ev)) || PRETOOL_ALLOW) },
  hook_error_guard: {
    script: 'error-guard.js',
    call: async (m, ev) => {
      const out = await m.run(ev);
      return out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny' ? JSON.stringify(out) : EMPTY;
    },
  },
  hook_graph_guard: { script: 'graph-guard.js', call: async (m, ev) => m.run(ev) },
  // Stop stays ONE consolidated tool: sibling Stop hooks do not merge reasons (spike S4-iii).
  hook_stop_dispatcher: { script: 'stop-dispatcher.js', call: async (m, ev) => json(await m.run(ev)) },
};

/**
 * @param {{ pluginRoot: string }} opts
 * @returns {{ definitions: object[], names: Set<string>, handle: (name:string, args:object) => Promise<object> }}
 */
function createHookTools({ pluginRoot }) {
  if (!pluginRoot) throw new Error('createHookTools: pluginRoot is required');
  const scripts = path.join(pluginRoot, 'scripts');
  const properties = {};
  for (const [k, description] of Object.entries(FIELDS)) properties[k] = { type: 'string', description };
  const definitions = Object.keys(HOOKS).map((name) => ({
    name,
    description: `Internal hook transport (claude-code-boss hooks.json) — not for direct use. Runs ${HOOKS[name].script}.`,
    inputSchema: { type: 'object', properties },
  }));

  async function handle(name, args) {
    const spec = HOOKS[name];
    if (!spec) throw new Error(`unknown hook tool: ${name}`);
    let text;
    try {
      // Fresh config per call (parity with a fresh process).
      require(path.join(scripts, 'lib', 'hooks-config.js'))._resetCache();
      require(path.join(scripts, 'lib', 'brain-config.js'))._resetCache();
      const ev = rebuildEvent(args);
      const mod = require(path.join(scripts, spec.script));
      text = await runWithHookEnv({ CLAUDE_PROJECT_DIR: (args && args.project_dir) || '' }, () => spec.call(mod, ev));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[hook-tools] ${name} degraded: ${msg}`);
      text = JSON.stringify({ systemMessage: `[claude-code-boss] hook ${name} degradado no daemon (fail-open): ${msg}` });
    }
    return { content: [{ type: 'text', text }] };
  }

  return { definitions, names: new Set(Object.keys(HOOKS)), handle };
}

module.exports = { createHookTools, rebuildEvent, HOOKS, FIELDS };
