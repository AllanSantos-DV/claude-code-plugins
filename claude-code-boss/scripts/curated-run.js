#!/usr/bin/env node
/**
 * curated-run.js — runs a curated script on behalf of the PowerShell redirect.
 *
 * The Bash redirect prefixes the call with `CCB_PROJECT_ROOT="…" node "script"`; PowerShell has
 * no such prefix, and every PowerShell workaround (`$env:X=…; node …`, `& { … }`, try/finally)
 * either splits the command into statements (breaking `&&` → `if ($?)` chains) or hides the
 * script's failure from `$?` — so a failing curated test run would be reported as a success.
 * One native call has neither problem: this launcher takes the two variables as arguments,
 * runs the script with them in its environment and exits with the script's own status.
 *
 *   node curated-run.js [--root=<project>] [--report=<file>] <script.(mjs|cjs|js|ps1)> [args…]
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function parse(argv) {
  const env = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const m = /^--(root|report)=([\s\S]+)$/.exec(argv[i]);
    if (!m) break;
    env[m[1] === 'root' ? 'CCB_PROJECT_ROOT' : 'CCB_RAW_REPORT'] = m[2];
  }
  return { env, script: argv[i], args: argv.slice(i + 1) };
}

/** [program, args] that run `script`, or null for an extension this launcher does not run. */
function commandFor(script, args) {
  if (/\.(mjs|cjs|js)$/i.test(script)) return [process.execPath, [script, ...args]];
  if (/\.ps1$/i.test(script)) return ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]];
  return null;
}

function main(argv) {
  const { env, script, args } = parse(argv);
  const cmd = script && commandFor(path.resolve(script), args);
  if (!cmd) {
    console.error(`[curated-run] no runner for "${script || ''}" (only .mjs/.cjs/.js/.ps1)`);
    return 2;
  }
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) {
    console.error(`[curated-run] could not run ${script}: ${r.error.message}`);
    return 127;
  }
  return r.status === null ? 1 : r.status;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parse, commandFor, main };
