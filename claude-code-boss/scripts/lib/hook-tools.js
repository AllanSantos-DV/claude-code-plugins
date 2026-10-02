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
 *
 * `lane: 'heavy'` runs in the daemon's hook worker (G2), never on the main thread
 * that serves every session's HTTP and the fast PreToolUse guards: these do
 * synchronous SQLite (brain-store/metrics-store) and transcript/journal I/O. The
 * worker is one FIFO queue, so a PostToolUse journal write still lands before
 * the Stop that reads it. `async: true` (reply is always `{}`) is acked at once
 * and runs in the background (G4, ADR-015 §Decisão 1); its failures ride on the
 * session's next Stop reply (see hook-worker.js).
 */
const HOOKS = {
  // async-eligible (side effect only, reply `{}`)
  hook_skill_metric: { lane: 'heavy', async: true, script: 'skill-metric.js', call: async (m, ev) => { await m.run(ev); return EMPTY; } },
  hook_file_edit_detect: { lane: 'heavy', async: true, script: 'file-edit-detect.js', call: async (m, ev) => { await m.run(ev); return EMPTY; } },
  hook_posttoolusebash_dispatcher: { lane: 'heavy', async: true, script: 'posttoolusebash-dispatcher.js', call: async (m, ev) => { await m.dispatch(ev); return EMPTY; } },
  hook_posttoolusefailure_dispatcher: { lane: 'heavy', async: true, script: 'posttoolusefailure-dispatcher.js', call: async (m, ev) => { await m.dispatch(ev); return EMPTY; } },
  hook_policy_enforce_shadow: { lane: 'heavy', async: true, script: 'policy-enforce-shadow.js', call: async (m, ev) => json(await m.evaluate(ev)) },
  // silent-except-alert
  hook_correction_detect: { script: 'correction-detect.js', call: async (m, ev) => additional(ev.hook_event_name || 'UserPromptSubmit', await m.run(ev)) },
  hook_active_research_detect: { script: 'active-research-detect.js', call: async (m, ev) => additional(ev.hook_event_name || 'UserPromptSubmit', await m.run(ev)) },
  hook_policy_glob_inject: { script: 'policy-glob-inject.js', call: async (m, ev) => json(await m.evaluate(ev)) },
  // context-bearing (G6): standing policies into every subagent's context. Was one
  // `node` spawn per subagent — the fan-out case. Echoes the event name like the CLI.
  hook_policy_inject: { script: 'policy-inject.js', call: async (m, ev) => additional(ev.hook_event_name || 'SessionStart', await m.run(ev)) },
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
  hook_stop_dispatcher: { lane: 'heavy', script: 'stop-dispatcher.js', call: async (m, ev) => json(await m.run(ev)) },
};

const degraded = (name, msg) => JSON.stringify({ systemMessage: `[claude-code-boss] hook ${name} degradado no daemon (fail-open): ${msg}` });

/**
 * Run one hook in THIS thread and return the stdout text of its `command` form.
 * Never throws: an unexpected error becomes the visible fail-open message.
 * Used directly (fast lane / no worker) and by the hook worker (heavy lane).
 */
async function runHookInline(pluginRoot, name, args) {
  const spec = HOOKS[name];
  if (!spec) throw new Error(`unknown hook tool: ${name}`);
  const scripts = path.join(pluginRoot, 'scripts');
  try {
    // Fresh config per call (parity with a fresh process).
    require(path.join(scripts, 'lib', 'hooks-config.js'))._resetCache();
    require(path.join(scripts, 'lib', 'brain-config.js'))._resetCache();
    const ev = rebuildEvent(args);
    const mod = require(path.join(scripts, spec.script));
    return await runWithHookEnv({ CLAUDE_PROJECT_DIR: (args && args.project_dir) || '' }, () => spec.call(mod, ev));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[hook-tools] ${name} degraded: ${msg}`);
    return degraded(name, msg);
  }
}

// G5: answer this long before Claude Code's own `timeout` gives up on the hook,
// so an overrun is OUR visible fail-open message, not a harness hook error.
const DEADLINE_MARGIN_MS = 1000;
const MIN_DEADLINE_MS = 500;
const DEFAULT_TIMEOUT_S = 10;

/**
 * Per-tool deadline (ms) from the `timeout` each hook declares in hooks.json —
 * the single source of truth, so the two can never drift apart.
 */
function deadlinesFromHooksJson(pluginRoot) {
  const out = {};
  const hooks = JSON.parse(require('fs').readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')).hooks || {};
  for (const group of Object.values(hooks).flat()) {
    for (const h of (group && group.hooks) || []) {
      if (h.type !== 'mcp_tool' || !HOOKS[h.tool]) continue;
      const s = Number(h.timeout) > 0 ? Number(h.timeout) : DEFAULT_TIMEOUT_S;
      out[h.tool] = Math.max(MIN_DEADLINE_MS, s * 1000 - DEADLINE_MARGIN_MS);
    }
  }
  return out;
}

/** Resolve `work` or, past `ms`, the visible fail-open message. The work is not
 *  aborted (sync JS cannot be) — it finishes in the background, its reply unused. */
function withDeadline(name, ms, work) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.error(`[hook-tools] ${name} passed its ${ms}ms deadline`);
      resolve(degraded(name, `prazo de ${ms}ms estourado`));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ pluginRoot: string, hookWorker?: { run: Function, enqueue: Function }, deadlines?: object }} opts
 *   hookWorker: the daemon's heavy-lane worker (servers/brain-server/lib/hook-worker-client.js).
 *   Absent (tests, tools without a daemon) → every hook runs inline, as before.
 *   deadlines: per-tool ms override (tests); default from hooks.json.
 * @returns {{ definitions: object[], names: Set<string>, handle: (name:string, args:object) => Promise<object> }}
 */
function createHookTools({ pluginRoot, hookWorker, deadlines } = {}) {
  if (!pluginRoot) throw new Error('createHookTools: pluginRoot is required');
  const deadlineMs = { ...deadlinesFromHooksJson(pluginRoot), ...(deadlines || {}) };
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
    const ms = deadlineMs[name] || DEFAULT_TIMEOUT_S * 1000 - DEADLINE_MARGIN_MS;
    let text;
    if (spec.lane === 'heavy' && hookWorker && spec.async) {
      hookWorker.enqueue(name, args);
      text = EMPTY;
    } else if (spec.lane === 'heavy' && hookWorker) {
      try {
        // The worker also skips the job outright if it is still queued past the deadline.
        text = await hookWorker.run(name, args, { timeoutMs: ms });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`[hook-tools] ${name} degraded: ${msg}`);
        text = degraded(name, msg);
      }
    } else {
      text = await withDeadline(name, ms, runHookInline(pluginRoot, name, args));
    }
    return { content: [{ type: 'text', text }] };
  }

  return { definitions, names: new Set(Object.keys(HOOKS)), handle };
}

module.exports = { createHookTools, runHookInline, deadlinesFromHooksJson, rebuildEvent, HOOKS, FIELDS };
