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
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return { kb: { submission: { minOutputChars: 500, dedupThreshold: 0.95 } } };
}

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
    const output = event.tool_response?.stdout || event.tool_response?.output || '';
    const sessionId = event.session_id || event.sessionId || 'default';
    const charCount = output.length;
    const lineCount = output.split('\n').length;

    const config = loadConfig();
    const subConfig = config.kb?.submission || {};
    const minChars = subConfig.minOutputChars || 500;

    // Determine if this is worth submitting
    const significant = isSignificantCommand(command);
    const hasOutput = charCount > minChars;

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

    const filename = `work-${sessionId.slice(0, 8)}-${Date.now()}.json`;
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
