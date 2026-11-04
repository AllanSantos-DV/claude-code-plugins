'use strict';
/**
 * scope-rules-hook.js — one declared hook for the owner's rules by scope (`hook_scope_rules`,
 * served by the brain daemon). PostToolUse (Read|Edit|Write|MultiEdit|NotebookEdit) records the
 * touched file as evidence; UserPromptSubmit asks the memory server for the rules of the touched
 * scope and delivers the ones the session has not received. See lib/scope-rules.js.
 */
const scopeRules = require('./lib/scope-rules.js');
const hooksConfig = require('./lib/hooks-config.js');
const { hookEnv } = require('./lib/hook-context.js');

const TOUCH_TOOL = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/;

function touchedPath(ev) {
  const ti = ev.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || '';
}

/**
 * @param {object} event hook payload
 * @param {{lookup?: Function, base?: string}} [deps] test seams passed through to scopeRules.inject
 * @returns {Promise<{context: string, notice: string}>} context for the model's additionalContext, notice for the owner's screen
 */
async function run(event, deps = {}) {
  const ev = event || {};
  const none = { context: '', notice: '' };
  const cfg = hooksConfig.getScopeRules();
  if (!cfg.enabled) return none;
  if (ev.hook_event_name === 'PostToolUse') {
    if (TOUCH_TOOL.test(ev.tool_name || '')) scopeRules.recordTouched(ev.session_id, touchedPath(ev), { base: deps.base });
    return none;
  }
  if (ev.hook_event_name !== 'UserPromptSubmit') return none;
  const root = hookEnv().CLAUDE_PROJECT_DIR || '';
  const projectId = root ? require('../engine/lib/project-id.js').tryResolveProjectId({ cwd: root }) : null;
  return scopeRules.inject(ev, { ...deps, maxChars: cfg.maxChars, root, projectId: projectId || undefined });
}

module.exports = { run, touchedPath };
