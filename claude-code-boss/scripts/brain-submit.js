#!/usr/bin/env node
/**
 * Brain Submit — PostToolUse hook.
 *
 * After significant Bash work, writes a payload to brain-pending/ for the
 * brain-indexer subagent. The subagent generates embeddings + saves to KB.
 *
 * Triggers when:
 *   - Bash output > minOutputChars (default: 500)
 *   - Bash command has significant side effects (test, build, deploy)
 *
 * Also triggered by brain-indexer via Stop hook for session summarization.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');

const { readStdin } = require('./lib/hook-io.js');
const { sanitizeSessionId } = require('./lib/session-id.js');

// Commands whose output is almost always worth indexing
const SIGNIFICANT_COMMANDS = [
  'npm test', 'npx vitest', 'npx jest', 'npx mocha',
  'npx tsc', 'npx eslint', 'npm run build',
  'cargo test', 'cargo build', 'cargo check',
  'dotnet test', 'dotnet build',
  'go test', 'go build',
  'python -m pytest', 'pytest', 'poetry run pytest',
  'git commit', 'git push',
];

// Trivial commands — bypass even if output is large (e.g. `git log` dumping
// 5000 chars of history is noise, not knowledge). Bash invocations starting
// with these prefixes are dropped before the significant/output checks.
const TRIVIAL_COMMAND_PREFIXES = [
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'ls', 'dir', 'pwd', 'cd ', 'echo ', 'whoami', 'date', 'hostname',
  'cat ', 'type ', 'head ', 'tail ', 'less ', 'more ',
  'which ', 'where ', 'env', 'printenv',
];

function isTrivialCommand(command) {
  const c = command.trim().toLowerCase();
  return TRIVIAL_COMMAND_PREFIXES.some(s => c === s.trim() || c.startsWith(s));
}

function isSignificantCommand(command) {
  const c = command.trim().toLowerCase();
  return SIGNIFICANT_COMMANDS.some(s => c.startsWith(s));
}

function detectEcosystem(command) {
  const c = command.trim().toLowerCase();
  if (/npm|npx|pnpm|yarn|bun/.test(c)) return 'node';
  if (/cargo/.test(c)) return 'rust';
  if (/dotnet/.test(c)) return 'dotnet';
  if (/go\s/.test(c)) return 'go';
  if (/python|pytest|pip|poetry/.test(c)) return 'python';
  if (/docker|kubectl|helm/.test(c)) return 'docker';
  return 'generic';
}

function guessWorkType(command) {
  const c = command.trim().toLowerCase();
  if (/test|vitest|jest|mocha|pytest/.test(c)) return 'test';
  if (/build|compile|tsc|bundle|webpack|vite|esbuild/.test(c)) return 'build';
  if (/lint|eslint|fmt|format|prettier/.test(c)) return 'lint';
  if (/deploy|release|publish/.test(c)) return 'deploy';
  if (/install|add|remove/.test(c)) return 'dependency';
  if (/add|commit|push|merge|rebase/.test(c)) return 'git';
  return 'development';
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const event = JSON.parse(raw);

    // Only handle Bash PostToolUse
    if (event.tool_name !== 'Bash') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const command = event.tool_input?.command || '';
    // Bash PostToolUse: real event format is { tool_response: { stdout, stderr, ... } }
    const tr = event.tool_response || {};
    const output = [tr.stdout || '', tr.stderr || ''].filter(Boolean).join('\n')
      || (typeof event.tool_result === 'string' ? event.tool_result : (event.tool_result?.text || ''));
    const sessionId = event.session_id || event.sessionId || 'default';
    const charCount = output.length;
    const lineCount = output.split('\n').length;

    const { minBashLines: minLines, minOutputChars: minChars } = require('./lib/brain-config.js').getSubmission();

    // Drop trivial commands BEFORE the size/significance gates — `git log`
    // dumping 5000 chars of history is noise, not knowledge.
    if (isTrivialCommand(command)) {
      process.stdout.write(JSON.stringify({ skipped: 'trivial_command' }));
      return;
    }

    // Determine if this is worth submitting
    const significant = isSignificantCommand(command);
    const hasOutput = charCount > minChars && lineCount >= minLines;

    if (!significant && !hasOutput) {
      process.stdout.write(JSON.stringify({ skipped: 'not_significant' }));
      return;
    }

    // Ensure pending directory
    if (!fs.existsSync(PENDING_DIR)) {
      fs.mkdirSync(PENDING_DIR, { recursive: true });
    }

    const payload = {
      version: 1,
      type: 'work',
      sessionId,
      timestamp: new Date().toISOString(),
      command: command.slice(0, 500),
      charCount,
      lineCount,
      ecosystem: detectEcosystem(command),
      workType: guessWorkType(command),
      outputPreview: output.slice(0, 2000),
      project: event.cwd
        ? path.basename(event.cwd)
        : 'unknown',
    };

    const safeSid = sanitizeSessionId(sessionId).slice(0, 8);
    const filename = `work-${safeSid}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(PENDING_DIR, filename),
      JSON.stringify(payload, null, 2)
    );

    console.error(`[BRAIN-SUBMIT] Payload written: ${filename} (${payload.ecosystem}/${payload.workType}, ${charCount} chars)`);

    process.stdout.write(JSON.stringify({
      written: filename,
      ecosystem: payload.ecosystem,
      workType: payload.workType,
      charCount,
      lineCount,
    }));
  } catch (err) {
    console.error(`[BRAIN-SUBMIT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
