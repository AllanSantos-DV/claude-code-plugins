#!/usr/bin/env node
/**
 * dashboard-command.js — UserPromptExpansion hook that answers `/dashboard`
 * WITHOUT the model (the most requested fix: before, the slash command expanded
 * into a prompt and the agent spent turns running the starter, reading
 * dashboard.json and composing the URL).
 *
 * Claude Code lets a UserPromptExpansion hook BLOCK the expansion: the prompt
 * never reaches the model and the reason is shown to the user. So: ensure the
 * dashboard is up (dashboard-start.ensureDashboard — live HTTP probe), open the
 * browser, and block with the URL. A `command` hook on purpose: it must work
 * even when the brain daemon (mcp_tool transport) is down.
 *
 * Fail loud: if the dashboard can't be brought up, the block reason says why —
 * never a silent fall-through to the model.
 */
'use strict';
const { spawn } = require('child_process');
const { readStdin, parsePayload } = require('./lib/hook-io.js');

// Ours only: `/dashboard` or `/claude-code-boss:dashboard` — never another plugin's
// `/<other>:dashboard` (pre-release audit: any prefix used to be hijacked).
const IS_DASHBOARD = /^(?:claude-code-boss:)?dashboard$/;

function openBrowser(url) {
  if (process.env.DASHBOARD_NO_OPEN) return false;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', (err) => console.error(`[dashboard-command] browser open failed: ${err.message}`));
    c.unref();
    return true;
  } catch (err) {
    console.error(`[dashboard-command] browser open failed: ${err.message}`);
    return false;
  }
}

/**
 * @param {object} event UserPromptExpansion payload ({command_name, ...})
 * @param {{ensure?:Function, open?:Function}} [deps] test seams
 * @returns {Promise<object|null>} the hook output, or null when it isn't /dashboard
 */
async function run(event, deps = {}) {
  const name = String((event && (event.command_name || event.command)) || '').replace(/^\//, '').trim();
  if (!IS_DASHBOARD.test(name)) return null;
  const ensure = deps.ensure || require('./dashboard-start.js').ensureDashboard;
  const open = deps.open || openBrowser;
  const r = await ensure();
  if (!r || !r.ok) {
    return { decision: 'block', reason: `[claude-code-boss] Dashboard: falhou — ${(r && r.error) || 'erro desconhecido'}` };
  }
  const opened = open(r.url);
  return {
    decision: 'block',
    reason: `[claude-code-boss] Dashboard: ${r.url}${opened ? ' (aberto no navegador)' : ''}${r.status === 'started' ? ' — iniciado agora' : ''}. Abas: Home, Brain KB, Skills, Hooks, Insights, Logs, Router.`,
  };
}

/**
 * Same answer from the RAW prompt (UserPromptSubmit dispatcher). Proven in a real session:
 * a short `/dashboard` the CLI can't resolve as a command reaches the model as plain text
 * (unknown_command_fallback) — the expansion hook never fires. Catching the typed text
 * covers `/dashboard` and `/claude-code-boss:dashboard` however they resolve.
 */
async function runForPrompt(prompt, deps) {
  const m = /^\s*\/((?:claude-code-boss:)?dashboard)\s*$/i.exec(String(prompt || ''));
  return m ? run({ command_name: m[1].toLowerCase() }, deps) : null;
}

async function main() {
  const event = parsePayload(await readStdin()) || {};
  const out = await run(event);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main().catch((err) => {
    // Visible, and still blocking: falling through would hand /dashboard to the model.
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[claude-code-boss] Dashboard: falhou — ${err && err.message ? err.message : err}` }));
  });
}

module.exports = { run, runForPrompt, openBrowser, IS_DASHBOARD };
