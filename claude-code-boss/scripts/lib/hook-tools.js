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
const { performance } = require('perf_hooks');
const { runWithHookEnv } = require('./hook-context.js');

const EMPTY = '{}';

/** Event fields a hook tool accepts (all strings on the wire). */
const FIELDS = {
  hook_event_name: 'Hook event name',
  session_id: 'Session id',
  cwd: 'Working directory',
  transcript_path: 'Transcript path',
  project_dir: 'CLAUDE_PROJECT_DIR of the calling session (Claude Code sends "" — no env interpolation in mcp_tool input; resolved by session_id, lib/session-root.js)',
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
  // Set only for a SUB-AGENT's tool call (empty in the main session) — verified live.
  agent_id: 'Sub-agent id when the call came from a sub-agent',
  agent_type: 'Sub-agent type when the call came from a sub-agent',
  // C2: the redirect respects the session posture — bypassPermissions → allow, else ask.
  permission_mode: 'Session permission mode (default/acceptEdits/plan/bypassPermissions)',
  // The controlled-compaction module (hooks/compaction.mjs) sends its event as one JSON object.
  payload: 'Event payload (JSON) — hook_compaction_event',
};
const JSON_FIELDS = new Set(['tool_input', 'tool_response', 'payload']);
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
  hook_curation_guard: { script: 'curation-guard.js', call: async (m, ev) => json(await m.run(ev)) }, // {} = abstain (never a blanket allow)
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
  // Called by the function-hook module (hooks/compaction.mjs) through the daemon route
  // POST /hook/compaction-event (servers/brain-server/lib/http-daemon.js), not by hooks.json:
  // records the compaction trail + cache.turn (metrics store) and replies config / observed TTL.
  // caller 'module': absent from hooks.json on purpose (its deadline is the default).
  hook_compaction_event: { lane: 'heavy', caller: 'module', script: 'compaction-event.js', call: async (m, ev) => json(await m.run(ev)) },
};

// Last config source stamp seen per module path (one entry per thread: the main
// thread and the hook worker each keep their own module caches).
const _stamps = new Map();

/**
 * Reset a config module's cache only when one of its source files changed.
 * `dependents`: modules that cache a slice of this config themselves.
 */
function refreshConfig(modPath, dependents = []) {
  const mod = require(modPath);
  const stamp = mod.sourceStamp();
  if (_stamps.get(modPath) !== stamp) {
    mod._resetCache();
    for (const d of dependents) require(d)._resetConfigCache();
    _stamps.set(modPath, stamp);
  }
}

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
    // Config as fresh as a new process would see it: an edited file is picked up
    // on the next call (stat-based), without re-parsing on every call.
    // curation-paths caches its own copy of the `curation` block: without this an
    // edited curation config was never seen until the daemon restarted.
    refreshConfig(path.join(scripts, 'lib', 'hooks-config.js'), [path.join(scripts, 'curation-paths.js')]);
    refreshConfig(path.join(scripts, 'lib', 'brain-config.js'));
    const ev = rebuildEvent(args);
    const mod = require(path.join(scripts, spec.script));
    // `project_dir` arrives "" (Claude Code doesn't interpolate env vars into mcp_tool
    // input): the root SessionStart recorded for this session_id — see lib/session-root.js.
    // The session's CCB_PROJECT_ID comes from the same record (the daemon's env has none).
    const rec = require('./session-root.js').sessionRecordFor(args && args.session_id);
    const root = (args && args.project_dir) || rec.projectDir;
    return await runWithHookEnv({ CLAUDE_PROJECT_DIR: root || '', CCB_PROJECT_ID: rec.projectId || '' }, () => spec.call(mod, ev));
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
 *  aborted (sync JS cannot be) — it finishes in the background, its reply unused.
 *  `onExpire` lets the caller count the expiry (C4c latency stats). */
function withDeadline(name, ms, work, onExpire) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.error(`[hook-tools] ${name} passed its ${ms}ms deadline`);
      if (onExpire) onExpire();
      resolve(degraded(name, `prazo de ${ms}ms estourado`));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// C4c: per-hook latency, process-wide (the daemon builds one hookTools per MCP
// session; the stats must cover all of them). In memory only — /health exposes it,
// a daemon restart resets it. Last LAT_WINDOW durations per hook feed p50/p95.
const LAT_WINDOW = 200;
const _latency = new Map();
function recordLatency(name, ms, outcome) {
  let s = _latency.get(name);
  if (!s) { s = { calls: 0, ok: 0, degraded: 0, expired: 0, queued: 0, maxMs: 0, recent: [] }; _latency.set(name, s); }
  s.calls++; s[outcome]++;
  if (outcome === 'queued') return; // async enqueue: no latency the session waits on
  s.maxMs = Math.max(s.maxMs, ms);
  s.recent.push(ms); if (s.recent.length > LAT_WINDOW) s.recent.shift();
}
function hookLatencyStats() {
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const out = {};
  for (const [name, s] of _latency) {
    const sorted = [...s.recent].sort((a, b) => a - b);
    out[name] = { calls: s.calls, ok: s.ok, degraded: s.degraded, expired: s.expired, queued: s.queued,
      p50Ms: Math.round(pct(sorted, 0.5)), p95Ms: Math.round(pct(sorted, 0.95)), maxMs: Math.round(s.maxMs) };
  }
  return out;
}
function _resetLatencyStats() { _latency.clear(); }

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
    const t0 = performance.now();
    let text;
    let outcome = 'ok';
    if (spec.lane === 'heavy' && hookWorker && spec.async) {
      hookWorker.enqueue(name, args);
      text = EMPTY;
      outcome = 'queued';
    } else if (spec.lane === 'heavy' && hookWorker) {
      try {
        // The worker also skips the job outright if it is still queued past the deadline.
        text = await hookWorker.run(name, args, { timeoutMs: ms });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`[hook-tools] ${name} degraded: ${msg}`);
        text = degraded(name, msg);
        outcome = /deadline|timeout|prazo/i.test(msg) ? 'expired' : 'degraded';
      }
    } else {
      text = await withDeadline(name, ms, runHookInline(pluginRoot, name, args), () => { outcome = 'expired'; });
      if (outcome === 'ok' && text.includes(`hook ${name} degradado`)) outcome = 'degraded';
    }
    recordLatency(name, performance.now() - t0, outcome);
    return { content: [{ type: 'text', text }] };
  }

  return { definitions, names: new Set(Object.keys(HOOKS)), handle };
}

module.exports = { createHookTools, runHookInline, deadlinesFromHooksJson, rebuildEvent, hookLatencyStats, _resetLatencyStats, HOOKS, FIELDS };
