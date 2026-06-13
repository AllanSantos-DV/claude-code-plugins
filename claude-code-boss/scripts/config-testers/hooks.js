'use strict';
/**
 * config-testers/hooks.js — validates every hook command in hooks/hooks.json.
 * For each script path: exists? syntax-checks (node --check)?
 *
 * Input:  { hooksRoot?, hooksConfig? }
 *   - hooksRoot defaults to ${CLAUDE_PLUGIN_ROOT}
 *   - hooksConfig defaults to the parsed hooks.json on disk
 * Output: { ok, details:{checked, missing:[], syntaxErrors:[], invalidCommands:[]}, ms }
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolvePluginRoot(input) {
  if (input && input.hooksRoot) return input.hooksRoot;
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(__dirname, '..', '..');
}

function extractScriptPath(cmd, root) {
  if (!cmd) return null;
  // Match: node "<...>/scripts/<file>"  or  node ${CLAUDE_PLUGIN_ROOT}/scripts/<file>
  const expanded = cmd.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, root.replace(/\\/g, '/'));
  const m = expanded.match(/node\s+"?([^"\s]+(?:\.js|\.mjs|\.cjs))"?/);
  if (!m) return null;
  return path.normalize(m[1]);
}

function syntaxCheck(scriptPath) {
  const r = spawnSync(process.execPath, ['--check', scriptPath], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim().split('\n').slice(0, 3).join(' | ') };
  return { ok: true };
}

async function test(input) {
  const t0 = Date.now();
  const root = resolvePluginRoot(input);
  let hooksConfig = input && input.hooksConfig;
  if (!hooksConfig) {
    const p = path.join(root, 'hooks', 'hooks.json');
    if (!fs.existsSync(p)) return { ok: false, error: `hooks.json not found at ${p}`, ms: Date.now() - t0 };
    try { hooksConfig = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (err) {
      const error = `hooks.json invalid: ${err.message}`;
      return { ok: false, error, ms: Date.now() - t0 };
    }
  }

  const missing = [];
  const syntaxErrors = [];
  const invalidCommands = [];
  let checked = 0;

  for (const [event, handlers] of Object.entries(hooksConfig.hooks || {})) {
    for (const h of handlers) {
      for (const hook of (h.hooks || [])) {
        const cmd = hook.command || '';
        checked++;
        const scriptPath = extractScriptPath(cmd, root);
        if (!scriptPath) { invalidCommands.push({ event, cmd }); continue; }
        if (!fs.existsSync(scriptPath)) { missing.push({ event, scriptPath }); continue; }
        const chk = syntaxCheck(scriptPath);
        if (!chk.ok) syntaxErrors.push({ event, scriptPath, error: chk.error });
      }
    }
  }

  const ok = missing.length === 0 && syntaxErrors.length === 0 && invalidCommands.length === 0;
  return {
    ok,
    error: ok ? undefined : `${missing.length} missing, ${syntaxErrors.length} syntax errors, ${invalidCommands.length} unparseable`,
    details: { checked, missing, syntaxErrors, invalidCommands },
    ms: Date.now() - t0,
  };
}

module.exports = { domain: 'hooks', test };
