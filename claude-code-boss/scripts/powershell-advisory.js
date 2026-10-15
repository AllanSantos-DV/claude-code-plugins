#!/usr/bin/env node
/**
 * powershell-advisory.js — SessionStart hook.
 *
 * The agent does not know which PowerShell runs its commands and guesses syntax. Tells
 * it, once per session, which edition each tool uses and the handful of rules that
 * differ (lib/powershell-compat.js lints the same set at PreToolUse). Windows only.
 * pwsh is found by scanning PATH (no spawn).
 */
'use strict';

const hooksConfig = require('./lib/hooks-config.js');
const { runTextCli } = require('./lib/hook-io.js');

/** @returns {string|null} */
function advisory(pwsh) {
  const tool = pwsh
    ? 'a ferramenta PowerShell roda pwsh 7'
    : 'a ferramenta PowerShell roda o Windows PowerShell 5.1 (pwsh 7 não está no PATH)';
  return `[POWERSHELL] ${tool}; no Bash, \`powershell\` = 5.1 e \`pwsh\` = 7. `
    + 'Só no 7: `&&`/`||`, `??`/`?.`, ternário, `-AsHashtable`/`-Parallel`/`-AsByteStream`, `-Encoding utf8` sem BOM. '
    + 'Só no 5.1: Get-WmiObject/Get-EventLog (removidos no 7); `>`/`-Encoding utf8` gravam UTF-16/BOM; `2>&1` em exe nativo vira NativeCommandError (exit 1). '
    + 'Em `powershell -Command "…"` via Bash o bash expande `$_`/`$x`/crase: use aspas simples ou um .ps1.';
}

async function run() {
  const cfg = hooksConfig.getPowershellGuard();
  if (!cfg.enabled || !cfg.platforms.includes(process.platform)) return null;
  return advisory(require('../engine/lib/powershell-compat.js').pwshOnPath());
}

function main() { return runTextCli(run, 'POWERSHELL-ADVISORY', 'SessionStart'); }

if (require.main === module) main();

module.exports = { run, advisory };
