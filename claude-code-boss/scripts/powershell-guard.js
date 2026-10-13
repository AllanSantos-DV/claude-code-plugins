#!/usr/bin/env node
/**
 * powershell-guard.js — PreToolUse hook on the `PowerShell` tool.
 *
 * The agent never has to know which edition runs its command: on Windows PowerShell 5.1
 * (pwsh 7 absent from PATH) the 7-only `&&`/`||` chains are rewritten to `if ($?)`
 * (lib/powershell-compat.js) through `updatedInput`; whatever cannot be rewritten
 * exactly is linted and only warned about. This is the only hook on this matcher, so it
 * owns `updatedInput` (the Bash counterpart lives in curation-guard.js).
 */
'use strict';

const hooksConfig = require('./lib/hooks-config.js');
const metrics = require('./lib/metrics.js');
const { readStdin, emitEmpty, emitJson, preToolUseDecision } = require('./lib/hook-io.js');

/**
 * @param {object} event PreToolUse payload
 * @returns {object} {} (abstain), warn-only additionalContext, or a rewrite decision
 */
function run(event) {
  if (!event) return {};
  const cfg = hooksConfig.getPowershellGuard();
  if (!cfg.enabled || !cfg.platforms.includes(process.platform)) return {};
  const command = event.tool_input && event.tool_input.command;
  if (typeof command !== 'string' || !command) return {};
  const compat = require('./lib/powershell-compat.js');
  const edition = compat.toolEdition();
  const mctx = { sessionId: event.session_id, cwd: event.cwd };
  const fixed = edition === '5.1' && !cfg.advisory ? compat.fixChains51(command) : null;
  const next = fixed ? fixed.text : command;
  const hits = compat.lint(next, edition).map((h) => ({ ...h, edition }));
  const warn = compat.renderWarning(hits, `PowerShell ${edition}`);
  if (warn) metrics.fire('powershell.warned', { edition, ids: hits.map((h) => h.id) }, mctx);
  if (!fixed && !warn) return {};
  if (!fixed) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warn } };
  metrics.fire('powershell.rewritten', { edition, chains: fixed.count }, mctx);
  const note = `[boss] PowerShell 5.1: ${fixed.count} &&/|| → if ($?) ajustado automaticamente.`;
  const ctx = [note, warn].filter(Boolean).join(' ');
  const mode = event.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
  return preToolUseDecision(mode, {
    updatedInput: { ...event.tool_input, command: next },
    additionalContext: ctx,
    ...(mode === 'ask' ? { permissionDecisionReason: ctx } : {}),
  });
}

if (require.main === module) {
  readStdin().then((raw) => {
    const out = run(raw ? JSON.parse(raw) : null);
    if (out && out.hookSpecificOutput) emitJson(out); else emitEmpty();
  }).catch((err) => {
    console.error(`[powershell-guard] ${err.message}`);
    emitEmpty();
  });
}

module.exports = { run };
