'use strict';
/**
 * scope-rules-hook.js — one declared hook for the owner's rules by scope (`hook_scope_rules`,
 * served by the brain daemon). PostToolUse (Read|Edit|Write|MultiEdit|NotebookEdit) records the
 * touched file as evidence and, when it switches on a new kind, delivers that scope's rules at
 * once; UserPromptSubmit asks the memory server for the rules of the touched scope and delivers
 * the ones the session has not received. See lib/scope-rules.js.
 */
const scopeRules = require('./lib/scope-rules.js');
const hooksConfig = require('./lib/hooks-config.js');
const { hookEnv } = require('./lib/hook-context.js');

/** The hook answers by this, well under its 5 s timeout, whatever the memory server does. */
const DEADLINE_MS = 3500;
const TOUCH_TOOL = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/;

function touchedPath(ev) {
  const ti = ev.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || '';
}

/**
 * @param {object} event hook payload
 * @param {{lookup?: Function, base?: string, deadlineMs?: number}} [deps] test seams passed through to scopeRules.inject; deadlineMs: how long the hook waits before answering without the rules
 * @returns {Promise<{context: string, notice: string}>} context for the model's additionalContext, notice for the owner's screen
 */
async function run(event, deps = {}) {
  const ms = deps.deadlineMs || DEADLINE_MS;
  let over = false;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      over = true;
      console.error(`[scope-rules] no answer within ${ms} ms: the hook answers without the rules`);
      resolve({ context: '', notice: scopeRules.deadlineNotice({ base: deps.base, ms }) });
    }, ms);
  });
  try { return await Promise.race([work(event, { ...deps, expired: () => over }), late]); } finally { clearTimeout(timer); }
}

async function work(event, deps) {
  const ev = event || {};
  const none = { context: '', notice: '' };
  const cfg = hooksConfig.getScopeRules();
  if (!cfg.enabled) return none;
  const onTouch = ev.hook_event_name === 'PostToolUse';
  if (onTouch) {
    if (!TOUCH_TOOL.test(ev.tool_name || '')) return none;
    scopeRules.recordTouched(ev.session_id, touchedPath(ev), { base: deps.base });
  } else if (ev.hook_event_name !== 'UserPromptSubmit') return none;
  const root = hookEnv().CLAUDE_PROJECT_DIR || '';
  const projectId = root ? require('../engine/lib/project-id.js').tryResolveProjectId({ cwd: root }) : null;
  return scopeRules.inject(ev, { ...deps, maxChars: cfg.maxChars, root, projectId: projectId || undefined, onTouch });
}

module.exports = { run, touchedPath, DEADLINE_MS };
