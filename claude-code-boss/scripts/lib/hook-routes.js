'use strict';
/**
 * lib/hook-routes.js — which daemon-served hook tools run for which tool call.
 *
 * hooks.json holds ONE `mcp_tool` entry per event (`hook_pretooluse_dispatcher`,
 * `hook_posttooluse_dispatcher`) instead of one per hook: every entry was a separate MCP
 * request to the shared daemon, and the guards on the Bash path timed out at 5 to 8 s.
 * The dispatcher picks the hooks to run here, by tool name, and each one keeps its own
 * switch (dashboard), deadline and latency record.
 *
 * `timeoutS` is the deadline the hook had as its own hooks.json entry (the margin is taken
 * off by hook-tools). `matcher` is a full-match regex over the tool name, like the host's.
 */

const POST_READ_BURST = 'Read|Grep|Glob|LS|mcp__smart-tool__smart_search|mcp__smart-tool__smart_search_result|mcp__smart-tool__smart_scout|Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';

const ROUTES = {
  PreToolUse: [
    { matcher: 'Bash', tool: 'hook_curation_guard', timeoutS: 5 },
    { matcher: 'Bash|PowerShell', tool: 'hook_error_guard', timeoutS: 5 },
    { matcher: 'PowerShell', tool: 'hook_powershell_guard', timeoutS: 5 },
    { matcher: 'Bash|PowerShell', tool: 'hook_session_practices', timeoutS: 5 },
    { matcher: 'Write', tool: 'hook_file_format_guard', timeoutS: 5 },
    { matcher: 'Edit', tool: 'hook_policy_enforce_shadow', timeoutS: 10 },
    { matcher: 'Grep|Glob', tool: 'hook_graph_guard', timeoutS: 5 },
  ],
  PostToolUse: [
    { matcher: 'Bash|PowerShell', tool: 'hook_posttoolusebash_dispatcher', timeoutS: 10 },
    { matcher: 'Skill', tool: 'hook_skill_metric', timeoutS: 5 },
    { matcher: 'Write', tool: 'hook_file_format_guard', timeoutS: 5 },
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit', tool: 'hook_file_edit_detect', timeoutS: 5 },
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit', tool: 'hook_policy_glob_inject', timeoutS: 10 },
    { matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit', tool: 'hook_scope_rules', timeoutS: 5 },
    { matcher: POST_READ_BURST, tool: 'hook_read_burst', timeoutS: 5 },
  ],
};

/** Dispatcher tool name → the event it serves. */
const DISPATCHERS = {
  hook_pretooluse_dispatcher: 'PreToolUse',
  hook_posttooluse_dispatcher: 'PostToolUse',
};

/** Tool-name matcher the one hooks.json entry of an event needs: the union of its routes. */
function unionMatcher(event) {
  return [...new Set(ROUTES[event].flatMap((r) => r.matcher.split('|')))].join('|');
}

const compiled = new Map();

/**
 * Full-match regex for a matcher, compiled once.
 * @param {string} matcher  alternation of tool names, e.g. 'Bash|PowerShell'
 * @returns {RegExp}
 */
function matcherRe(matcher) {
  let re = compiled.get(matcher);
  if (!re) { re = new RegExp(`^(?:${matcher})$`); compiled.set(matcher, re); }
  return re;
}

/** Routes of `event` that apply to `toolName`, in declared order. */
function routesFor(event, toolName) {
  return (ROUTES[event] || []).filter((r) => matcherRe(r.matcher).test(String(toolName || '')));
}

module.exports = { ROUTES, DISPATCHERS, unionMatcher, routesFor };
