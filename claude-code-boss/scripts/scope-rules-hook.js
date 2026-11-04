'use strict';
/**
 * scope-rules-hook.js — one declared hook for the owner's rules by scope (`hook_scope_rules`,
 * served by the brain daemon). PostToolUse (Read|Edit|Write|MultiEdit|NotebookEdit) records the
 * touched file as evidence; UserPromptSubmit delivers the rules newly in scope, once per scope
 * per session. See lib/scope-rules.js.
 */
const scopeRules = require('./lib/scope-rules.js');
const hooksConfig = require('./lib/hooks-config.js');

const TOUCH_TOOL = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/;

function touchedPath(ev) {
  const ti = ev.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || '';
}

/**
 * @param {object} event hook payload
 * @returns {Promise<string>} text for the UserPromptSubmit additionalContext, '' otherwise
 */
async function run(event) {
  const ev = event || {};
  const cfg = hooksConfig.getScopeRules();
  if (!cfg.enabled) return '';
  if (ev.hook_event_name === 'PostToolUse') {
    if (TOUCH_TOOL.test(ev.tool_name || '')) scopeRules.recordTouched(ev.session_id, touchedPath(ev));
    return '';
  }
  if (ev.hook_event_name === 'UserPromptSubmit') return scopeRules.inject(ev, { maxChars: cfg.maxChars });
  return '';
}

module.exports = { run, touchedPath };
