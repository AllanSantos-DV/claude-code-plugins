#!/usr/bin/env node
/**
 * powershell-guard.js — PreToolUse hook on the `PowerShell` tool.
 *
 * The agent never has to know which edition runs its command: on Windows PowerShell 5.1
 * (pwsh 7 absent from PATH) the 7-only `&&`/`||` chains are rewritten to `if ($?)`
 * (lib/powershell-compat.js) through `updatedInput`; whatever cannot be rewritten
 * exactly is linted and only warned about. This is the only hook on this matcher, so it
 * owns `updatedInput` (the Bash counterpart lives in curation-guard.js) — and therefore also
 * composes the curation redirect (curation-guard.js `run`, PowerShell flavour) into the same
 * single rewrite, instead of registering curation-guard a second time on this matcher.
 */
'use strict';

const hooksConfig = require('./lib/hooks-config.js');
const metrics = require('../engine/lib/metrics.js');
const { readStdin, emitEmpty, emitJson, preToolUseDecision } = require('./lib/hook-io.js');

/**
 * The curation redirect (curation-guard.js, the same cascade Bash uses) over the command as
 * the agent wrote it. Runs BEFORE the 5.1 chain fix: its output is single native calls, so
 * `a && npm test` becomes `a && node '…curated-run.js' …`, which the chain fix then handles.
 * @returns {{deny:object}|{command:string|null, ctx:string|null}}
 */
async function curate(event, command) {
  try {
    const out = await require('./curation-guard.js').run(event);
    const hso = out && out.hookSpecificOutput;
    if (!hso) return { command: null, ctx: null };
    if (hso.permissionDecision === 'deny') return { deny: out };
    const next = hso.updatedInput && hso.updatedInput.command;
    return { command: typeof next === 'string' && next !== command ? next : null, ctx: hso.additionalContext || null };
  } catch (err) {
    console.error(`[powershell-guard] curation failed (fail-open): ${err.message}`);
    return { command: null, ctx: null };
  }
}

/**
 * ONE hook, ONE updatedInput for the PowerShell tool: the curation redirect and the 5.1
 * `&&`/`||` fix are composed here (two hooks on the same matcher returning updatedInput
 * overwrite each other), with one additionalContext and the session's permission posture.
 * @param {object} event PreToolUse payload
 * @returns {Promise<object>} {} (abstain), warn-only additionalContext, a deny, or a rewrite decision
 */
async function run(event, deps = {}) {
  if (!event) return {};
  const command = event.tool_input && event.tool_input.command;
  if (typeof command !== 'string' || !command) return {};
  const cur = await curate(event, command);
  if (cur.deny) return cur.deny;
  const cfg = hooksConfig.getPowershellGuard();
  const active = cfg.enabled && cfg.platforms.includes(process.platform);
  const base = cur.command || command;
  let fixed = null;
  let warn = null;
  if (active) {
    const compat = require('../engine/lib/powershell-compat.js');
    const edition = deps.edition || compat.toolEdition(); // deps.edition: test seam
    const mctx = { sessionId: event.session_id, cwd: event.cwd };
    fixed = edition === '5.1' && !cfg.advisory ? compat.fixChains51(base) : null;
    const hits = compat.lint(fixed ? fixed.text : base, edition).map((h) => ({ ...h, edition }));
    warn = compat.renderWarning(hits, `PowerShell ${edition}`);
    if (warn) metrics.fire('powershell.warned', { edition, ids: hits.map((h) => h.id) }, mctx);
    if (fixed) metrics.fire('powershell.rewritten', { edition, chains: fixed.count }, mctx);
  }
  const next = fixed ? fixed.text : base;
  if (next === command) {
    const note = [cur.ctx, warn].filter(Boolean).join(' ');
    return note ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } } : {};
  }
  const chainNote = fixed ? `[boss] PowerShell 5.1: ${fixed.count} &&/|| → if ($?) ajustado automaticamente.` : null;
  const ctx = [cur.ctx, chainNote, warn].filter(Boolean).join(' ');
  const mode = event.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
  return preToolUseDecision(mode, {
    updatedInput: { ...event.tool_input, command: next },
    additionalContext: ctx,
    ...(mode === 'ask' ? { permissionDecisionReason: ctx } : {}),
  });
}

if (require.main === module) {
  readStdin().then(async (raw) => {
    const out = await run(raw ? JSON.parse(raw) : null);
    if (out && out.hookSpecificOutput) emitJson(out); else emitEmpty();
  }).catch((err) => {
    console.error(`[powershell-guard] ${err.message}`);
    emitEmpty();
  });
}

module.exports = { run };
