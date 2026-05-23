#!/usr/bin/env node
/**
 * Curation Guard — PreToolUse hook for Bash tool calls.
 *
 * BLOCKING MODE: When a curated shell entry exists for the command,
 * the raw command is BLOCKED and redirected to the curated .mjs script.
 * This prevents Claude from running raw build commands whose output
 * would inflate context unnecessarily.
 *
 * The learning loop: first run of a build tool is ALLOWED (with warning),
 * PostToolUse detects if output is large, curation-improver creates a
 * curated script, and SUBSEQUENT runs are redirected to the curated script.
 *
 * Outcomes:
 * 1. CURATED SCRIPT (via .mjs) → allow silently (already curated)
 * 2. CURATED MATCH (raw cmd has curated entry) → BLOCK + redirect
 * 3. WHITELISTED → allow silently
 * 4. TRIVIAL → allow silently
 * 5. UNCURATED BUILD TOOL → allow with warning (learning loop)
 * 6. UNKNOWN → allow silently
 */
const fs = require('fs');
const path = require('path');
const { hookLog } = require('./hook-logger.js');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
function _loadGuardCfg() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'hooks-config.json'), 'utf-8'));
    return cfg.curationGuard || {};
  } catch (err) {
    console.error(`[CURATION-GUARD] Failed to load hooks-config.json: ${err.message}`);
    hookLog('error', 'curation-guard', `Failed to load hooks-config.json: ${err.message}`);
    return {};
  }
}
const _guardCfg = _loadGuardCfg();

// Commands inherently safe (read-only, trivial output, no curation needed)
// Extend via hooks-config.json curationGuard.extraTrivialCommands
const TRIVIAL_COMMANDS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'which',
  'cd', 'pushd', 'popd', 'dir', 'type',
  'date', 'whoami', 'hostname', 'uname', 'id',
  ...(_guardCfg.extraTrivialCommands || []),
]);

// Package managers / tools whose non-trivial subcommands need curation
// Extend via hooks-config.json curationGuard.extraBuildTools
const BUILD_TOOLS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'npx tsc', 'npx vitest', 'npx jest', 'npx mocha',
  'dotnet', 'cargo', 'mvn', 'gradle', 'go',
  'python', 'pip', 'poetry', 'uv',
  'docker', 'kubectl', 'helm',
  'make', 'cmake', 'meson',
  'pwsh', 'powershell', 'bash',
  'ruby', 'bundle', 'rake', 'gem',
  'composer', 'php',
  ...(_guardCfg.extraBuildTools || []),
]);

// Git subcommands that are inherently read-only
const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag',
  'describe', 'rev-parse', 'rev-list', 'ls-tree',
  'ls-files', 'config', 'help', 'version',
]);

// Git subcommands that write but are generally safe/trivial
const GIT_SAFE = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore',
  'stash', 'init', 'clean',
]);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

const { findProjectRoot, loadShellsConfig, matchCuratedShell } = require('./shells-config.js');

/**
 * Check whitelist from shells.json — command prefixes that always pass.
 * Case-insensitive prefix match with word boundary.
 */
function isWhitelisted(command, whitelist) {
  if (!whitelist || whitelist.length === 0) return false;
  const trimmed = command.trim().toLowerCase();
  for (const prefix of whitelist) {
    const p = prefix.trim().toLowerCase();
    // Exact match or prefix followed by space/end
    if (trimmed === p || trimmed.startsWith(p + ' ')) return true;
  }
  return false;
}

/**
 * Determine if a command is "trivial" — safe to execute without curation.
 * Only inherently low-output commands. Build tools are NOT trivial even when short.
 */
function isTrivial(command) {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.toLowerCase();

  // Pure trivial commands
  if (TRIVIAL_COMMANDS.has(firstToken)) return true;

  // git read-only subcommands (safe even if uncurated)
  if (firstToken === 'git' && tokens.length >= 2) {
    const sub = tokens[1]?.toLowerCase();
    if (GIT_READ_ONLY.has(sub)) return true;
    if (GIT_SAFE.has(sub)) return true;
    if (sub.startsWith('-')) return true;
  }

  // gh — mostly read-only
  if (firstToken === 'gh') return true;

  return false;
}

/**
 * Detect if a command uses a build tool that typically produces large output.
 */
function usesBuildTool(command) {
  const trimmed = command.trim().toLowerCase();
  for (const tool of BUILD_TOOLS) {
    if (trimmed.startsWith(tool)) return true;
  }
  return false;
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    const event = JSON.parse(raw);

    // Only handle Bash tool
    if (event.tool_name !== 'Bash') {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    const projectRoot = findProjectRoot(event.cwd || process.cwd());
    const { shells, whitelist } = loadShellsConfig(projectRoot);

    // 1. Check if command IS a curated script (.mjs) — allow silently
    if (command.trim().includes('.mjs') || command.trim().includes('.vscode/scripts/')) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    // 2. Check if command matches a curated shell entry — BLOCK + REDIRECT
    const curatedShell = matchCuratedShell(command, shells);
    if (curatedShell) {
      process.stdout.write(JSON.stringify({
        permissionDecision: 'denied',
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[curation-guard] 🔒 Comando \`${command}\` possui script curado. Execute \`${curatedShell.command}\` no lugar — output filtrado (${curatedShell.outputFilter || 'summary'}, limite ${curatedShell.outputLines || 200} linhas).` },
      }));
      return;
    }

    // 3. Check whitelist from shells.json (project-specific, already loaded by loadShellsConfig)
    if (isWhitelisted(command, whitelist)) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    // 4. Check if trivial
    if (isTrivial(command)) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
      return;
    }

    // 5. Check if it uses a build tool — warn but ALLOW (learning loop: first run is raw,
    //    PostToolUse detects large output, curation-improver creates script for NEXT time)
    if (usesBuildTool(command)) {
      process.stdout.write(JSON.stringify({
        permissionDecision: 'allowed',
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[curation-guard] ⚠️ Sem curadoria: \`${command}\`. Se produzir saída volumosa, o sistema criará script curado automaticamente.` },
      }));
      return;
    }

    // 6. Unknown command — allow by default; deny when denyUnknown is enabled
    if (_guardCfg.denyUnknown) {
      process.stdout.write(JSON.stringify({
        permissionDecision: 'denied',
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[curation-guard] 🔒 Comando \`${command}\` desconhecido (modo denyUnknown ativo). Adicione à whitelist em .vscode/shells.json ou crie um script curado.` },
      }));
    } else {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allowed' }));
    }
  } catch (err) {
    console.error(`[CURATION-GUARD] Error: ${err.message}`);
    hookLog('error', 'curation-guard', `Unhandled error: ${err.message}`);
    process.stdout.write(JSON.stringify({ permissionDecision: 'allowed', error: err.message }));
  }
})();
