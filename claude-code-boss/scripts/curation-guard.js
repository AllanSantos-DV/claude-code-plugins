#!/usr/bin/env node
/**
 * Curation Guard — PreToolUse hook for Bash tool calls.
 *
 * Single responsibility: decide whether a Bash command should be redirected
 * to a curated script. The hook does NOT classify commands itself (no
 * hardcoded "trivial" / "build tool" lists). Project-level discovery does that:
 *
 *   shells.json     — declares curated scripts + project whitelist
 *   curation-detect — PostToolUse: classifies bulky/noisy output
 *   curation-stop   — Stop: blocks turn until uncurated bulk gets a curated script
 *
 * Cascade:
 *   1. Bash + command matches curated entry (path or alias)
 *      a. invoking the curated script with no pipe → allow
 *      b. invoking the curated script with a pipe   → deny (edit the script)
 *      c. raw alias (not invoking the script)       → deny (redirect to script)
 *   2. command matches project whitelist → allow
 *   3. denyUnknown=true → deny (paranoid mode)
 *   4. default → allow (PostToolUse/Stop discovery loop handles the rest)
 */
const path = require('path');
const { hookLog } = require('./hook-logger.js');
const { loadCurationConfig } = require('./curation-paths.js');
const { readStdin } = require('./lib/hook-io.js');
const { findProjectRoot, loadShellsConfig, matchCuratedShell, _pathMatches, _tokenize } = require('./shells-config.js');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const _guardCfg = require('./lib/hooks-config.js').getCurationGuard();

/**
 * Case-insensitive prefix match with word boundary for project whitelist.
 */
function isWhitelisted(command, whitelist) {
  if (!whitelist || whitelist.length === 0) return false;
  const trimmed = command.trim().toLowerCase();
  for (const prefix of whitelist) {
    const p = prefix.trim().toLowerCase();
    if (trimmed === p || trimmed.startsWith(p + ' ')) return true;
  }
  return false;
}

/**
 * True if the command has a real pipe (`|`) — not the logical OR `||`.
 * Used to flag post-processing of a curated script's output.
 */
function hasPipe(command) {
  return /(?<!\|)\|(?!\|)/.test(command);
}

// Build a properly-formatted PreToolUse decision per Claude Code docs.
// permissionDecision MUST be "allow" | "deny" | "ask" and live INSIDE hookSpecificOutput.
// https://docs.claude.com/en/docs/claude-code/hooks
function decision(permissionDecision, { additionalContext, permissionDecisionReason } = {}) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  return JSON.stringify({ hookSpecificOutput });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(decision('allow'));
      return;
    }

    const event = JSON.parse(raw);

    if (event.tool_name !== 'Bash') {
      process.stdout.write(decision('allow'));
      return;
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      process.stdout.write(decision('allow'));
      return;
    }

    const projectRoot = findProjectRoot(event.cwd || process.cwd());
    const { shells, whitelist } = loadShellsConfig(projectRoot);

    // 1. Curated match (path or alias).
    const curatedShell = matchCuratedShell(command, shells);
    if (curatedShell) {
      const scriptPath = (curatedShell.script || '').trim();
      const tokens = _tokenize(command.trim());
      const isInvokingScript = scriptPath && tokens.some(t => _pathMatches(t, scriptPath));

      if (isInvokingScript) {
        if (hasPipe(command)) {
          const reason = `[curation-guard] Curated script \`${scriptPath}\` invoked with a pipe. Its output is already shaped (filter: ${curatedShell.outputFilter || 'summary'}, lines: ${curatedShell.outputLines || 200}) and is meant to be consumed as-is. If the output is not adequate, edit the script. See skill \`curation-script-pattern\`.`;
          process.stdout.write(decision('deny', { additionalContext: reason, permissionDecisionReason: reason }));
          return;
        }
        process.stdout.write(decision('allow'));
        return;
      }

      // Raw alias matched — redirect to the curated script.
      const reason = `[curation-guard] Command \`${command}\` has a curated script. Run \`${scriptPath}\` instead — output filtered (${curatedShell.outputFilter || 'summary'}, limit ${curatedShell.outputLines || 200} lines).`;
      process.stdout.write(decision('deny', { additionalContext: reason, permissionDecisionReason: reason }));
      return;
    }

    // 2. Project whitelist.
    if (isWhitelisted(command, whitelist)) {
      process.stdout.write(decision('allow'));
      return;
    }

    // 3. Paranoid mode.
    if (_guardCfg.denyUnknown) {
      const cfg = loadCurationConfig();
      const reason = `[curation-guard] Command \`${command}\` is unknown (denyUnknown mode active). Add it to the whitelist in \`${cfg.shellsConfigPath}\` or create a curated script in \`${cfg.scriptsDir}/\`.`;
      process.stdout.write(decision('deny', { additionalContext: reason, permissionDecisionReason: reason }));
      return;
    }

    // 4. Default: allow. If output is bulky, PostToolUse → Stop discovery
    //    loop will demand a curated script at end of turn.
    process.stdout.write(decision('allow'));
  } catch (err) {
    console.error(`[CURATION-GUARD] Error: ${err.message}`);
    hookLog('error', 'curation-guard', `Unhandled error: ${err.message}`);
    process.stdout.write(decision('allow'));
  }
})();
