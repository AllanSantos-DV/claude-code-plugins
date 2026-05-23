#!/usr/bin/env node
/**
 * test-hooks.js — local test runner for all plugin hook scripts.
 *
 * Usage:
 *   node scripts/test-hooks.js
 *   node scripts/test-hooks.js --verbose   (show full output for each hook)
 *   node scripts/test-hooks.js curation    (run only tests matching "curation")
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPTS = path.resolve(__dirname);
const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

/**
 * Create a temp directory that mimics a minimal CLAUDE_PLUGIN_ROOT with
 * optional overrides to config/hooks-config.json. Returns the tmpDir path.
 */
function mkTempPluginRoot(configOverrides = {}) {
  const base = fs.readFileSync(path.join(SCRIPTS, '..', 'config', 'hooks-config.json'), 'utf-8');
  const config = Object.assign(JSON.parse(base), configOverrides);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-test-'));
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'hooks-config.json'), JSON.stringify(config, null, 2));
  return tmpDir;
}

/**
 * Create a temp project directory with a .vscode/shells.json for guard tests.
 * Returns the tmpDir path.
 */
function mkTempProject(shellsJson = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-proj-'));
  fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vscode', 'shells.json'), JSON.stringify(shellsJson, null, 2));
  return tmpDir;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const DIM    = s => `\x1b[2m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

function run(script, payload, args = [], extraEnv = {}) {
  const input = JSON.stringify(payload);
  const scriptPath = path.join(SCRIPTS, script);
  const result = spawnSync('node', [scriptPath, ...args], {
    input,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.resolve(SCRIPTS, '..'),
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ||
        path.join(require('os').homedir(), '.claude', 'plugins', 'data', 'claude-code-boss'),
      ...extraEnv,
    },
  });
  return result;
}

function check(result, expectations = {}) {
  const issues = [];

  if (result.status !== 0 && !expectations.nonZeroOk) {
    issues.push(`exit code ${result.status}`);
  }
  if (result.error) {
    issues.push(`spawn error: ${result.error.message}`);
  }

  let parsed = null;
  try {
    const stdout = (result.stdout || '').trim();
    if (stdout) {
      parsed = JSON.parse(stdout);
    } else if (!expectations.noOutput) {
      issues.push('empty stdout');
    }
  } catch (e) {
    issues.push(`stdout not valid JSON: ${(result.stdout || '').slice(0, 80)}`);
  }

  if (parsed) {
    if (expectations.hasKey && !(expectations.hasKey in parsed)) {
      issues.push(`missing key: ${expectations.hasKey}`);
    }
    if (expectations.noError && parsed.error) {
      issues.push(`error in output: ${parsed.error}`);
    }
    if (expectations.hookEvent) {
      const got = parsed.hookSpecificOutput?.hookEventName;
      if (got !== expectations.hookEvent) {
        issues.push(`hookEventName: expected ${expectations.hookEvent}, got ${got}`);
      }
    }
  }

  return { ok: issues.length === 0, issues, parsed };
}

// ─── Test Cases ─────────────────────────────────────────────────────────────

const LARGE_OUTPUT = 'x'.repeat(2000) + '\n'.repeat(35);
const SESSION = 'test-00000000-0000-0000-0000-000000000001';

const TESTS = [
  // ── SessionStart ──────────────────────────────────────────────────────────
  {
    name: 'memory-rotate    [SessionStart]',
    script: 'memory-rotate.js',
    payload: {},
    expect: { noError: true },
  },
  {
    name: 'session-whitelist [SessionStart]',
    script: 'session-whitelist.js',
    payload: { session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'model-router      [SessionStart]',
    script: 'model-router.js',
    payload: { session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'plugin-updater    [SessionStart]',
    script: 'plugin-updater.js',
    payload: { session_id: SESSION },
    expect: { noError: true },
  },

  // ── PreToolUse / Write|Edit ───────────────────────────────────────────────
  {
    name: 'brain-retrieve    [PreToolUse/Edit]',
    script: 'brain-retrieve.js',
    payload: {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(SCRIPTS, '..', 'scripts', 'curation-guard.js') },
      session_id: SESSION,
    },
    expect: { noError: true },
  },
  {
    name: 'discipline-guard  [PreToolUse/Edit]',
    script: 'discipline-guard.js',
    payload: {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(SCRIPTS, '..', 'scripts', 'curation-guard.js') },
      session_id: SESSION,
    },
    expect: { noError: true },
  },

  // ── PreToolUse / Bash ─────────────────────────────────────────────────────
  {
    name: 'brain-retrieve    [PreToolUse/Bash]',
    script: 'brain-retrieve.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: SESSION,
    },
    expect: { noError: true },
  },
  {
    name: 'curation-guard    [PreToolUse/git→trivial]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: SESSION,
    },
    expect: { hasKey: 'permissionDecision', noError: true },
    validate: r => r.parsed?.permissionDecision === 'allowed'
      ? null : `git should be allowed, got: ${r.parsed?.permissionDecision}`,
  },
  {
    name: 'curation-guard    [PreToolUse/npm→build tool warning]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      session_id: SESSION,
    },
    expect: { hasKey: 'permissionDecision', noError: true },
    validate: r => r.parsed?.permissionDecision === 'allowed'
      ? null : `npm should be allowed (with warning), got: ${r.parsed?.permissionDecision}`,
  },
  {
    name: 'curation-guard    [PreToolUse/non-Bash→pass]',
    script: 'curation-guard.js',
    payload: { tool_name: 'Write', tool_input: { file_path: 'foo.js' } },
    expect: { hasKey: 'permissionDecision', noError: true },
    validate: r => r.parsed?.permissionDecision === 'allowed'
      ? null : `non-Bash should pass, got: ${r.parsed?.permissionDecision}`,
  },
  {
    // loadShellsConfig: whitelisted command loaded from temp .vscode/shells.json
    name: 'curation-guard    [loadShellsConfig→whitelist-hit]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'my-exotic-allowed-command' },
      session_id: SESSION,
      cwd: (() => {
        const d = mkTempProject({ shells: [], whitelist: ['my-exotic-allowed-command'] });
        return d;
      })(),
    },
    expect: { hasKey: 'permissionDecision', noError: true },
    validate: r => r.parsed?.permissionDecision === 'allowed'
      ? null : `whitelisted cmd should be allowed, got: ${r.parsed?.permissionDecision}`,
  },
  {
    // denyUnknown=false (default): unknown command still allowed
    name: 'curation-guard    [denyUnknown=false→allows-unknown]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'some-totally-unknown-command-xyz123' },
      session_id: SESSION,
    },
    expect: { hasKey: 'permissionDecision', noError: true },
    validate: r => r.parsed?.permissionDecision === 'allowed'
      ? null : `denyUnknown=false → should allow unknown, got: ${r.parsed?.permissionDecision}`,
  },
  {
    // denyUnknown=true: unknown command is denied with additionalContext
    name: 'curation-guard    [denyUnknown=true→denies-unknown]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'some-totally-unknown-command-xyz123' },
      session_id: SESSION,
    },
    expect: { hasKey: 'permissionDecision', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ curationGuard: { extraTrivialCommands: [], extraBuildTools: [], denyUnknown: true } }) }),
    validate: r => r.parsed?.permissionDecision === 'denied'
      ? null : `denyUnknown=true → should deny unknown, got: ${r.parsed?.permissionDecision}`,
  },

  // ── PostToolUse / Bash ────────────────────────────────────────────────────
  {
    name: 'curation-detect   [PostToolUse/small→skip]',
    script: 'curation-detect.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: { stdout: 'On branch main\nnothing to commit', stderr: '' },
      session_id: SESSION,
    },
    expect: { noError: true },
    validate: _r => {
      // Should NOT write a payload file (small output)
      return null; // just check it runs clean
    },
  },
  {
    name: 'curation-detect   [PostToolUse/large→writes payload]',
    script: 'curation-detect.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_response: { stdout: LARGE_OUTPUT, stderr: '' },
      session_id: SESSION,
    },
    expect: { noError: true },
  },
  {
    name: 'brain-submit      [PostToolUse/Bash]',
    script: 'brain-submit.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline -5' },
      tool_response: { stdout: 'abc123 fix something\ndef456 add feature', stderr: '' },
      session_id: SESSION,
    },
    expect: { noError: true },
  },

  // ── SubagentStart / SubagentStop ──────────────────────────────────────────
  {
    name: 'ack-tracker       [SubagentStart]',
    script: 'ack-tracker.js',
    args: ['start'],
    payload: { session_id: SESSION, subagent_id: 'test-agent-001' },
    expect: { noError: true },
  },
  {
    name: 'ack-tracker       [SubagentStop]',
    script: 'ack-tracker.js',
    args: ['stop'],
    payload: { session_id: SESSION, subagent_id: 'test-agent-001' },
    expect: { noError: true },
  },
  {
    name: 'ack-tracker       [Stop/report]',
    script: 'ack-tracker.js',
    args: ['report'],
    payload: { event: 'Stop', session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'cost-tracker      [SubagentStop]',
    script: 'cost-tracker.js',
    payload: {
      session_id: SESSION,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
    },
    expect: { noError: true },
  },

  // ── Stop ─────────────────────────────────────────────────────────────────
  {
    name: 'pattern-detect    [Stop]',
    script: 'pattern-detect.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'refine-research   [Stop→injects context]',
    script: 'refine-research.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { hookEvent: 'Stop', noError: true },
  },

  // ── UserPromptSubmit ──────────────────────────────────────────────────────
  {
    name: 'correction-detect [UserPromptSubmit]',
    script: 'correction-detect.js',
    payload: {
      prompt: 'isso nao esta funcionando como esperado',
      session_id: SESSION,
      transcript_path: '',
    },
    expect: { noError: true },
  },
  {
    name: 'brain-retrieve-prompt [UserPromptSubmit]',
    script: 'brain-retrieve-prompt.js',
    payload: {
      prompt: 'como configurar os hooks do plugin',
      session_id: SESSION,
    },
    expect: { noError: true },
  },
  {
    name: 'lesson-inject     [UserPromptSubmit→reads memory]',
    script: 'lesson-inject.js',
    payload: {
      prompt: 'version bump no workflow do CI causou conflito',
      session_id: SESSION,
    },
    expect: { noError: true },
  },
  {
    // curation-backlog: first run (clean state) with 1 pending payload → injects additionalContext
    name: 'curation-backlog  [UserPromptSubmit→first-run-injects]',
    script: 'curation-backlog.js',
    payload: { prompt: 'o que fazer agora', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bklog-'));
      const detectDir = path.join(tmpData, 'detect-curation');
      fs.mkdirSync(detectDir, { recursive: true });
      // Write one pending payload
      fs.writeFileSync(
        path.join(detectDir, `curation-${Date.now()}-testabcd.json`),
        JSON.stringify({ detectedAt: new Date().toISOString(), command: 'npm install', charCount: 5000, lineCount: 120, sessionId: SESSION, cwd: '/tmp', outputPreview: 'added 42 packages' }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext;
      return ctx && ctx.includes('curation payload') ? null : `expected additionalContext with payload count, got: ${JSON.stringify(r.parsed)}`;
    },
  },
  {
    // curation-backlog: second run after injection → cooldown active (turnsSinceLast=0 < 5)
    name: 'curation-backlog  [UserPromptSubmit→cooldown-active]',
    script: 'curation-backlog.js',
    payload: { prompt: 'proxima pergunta', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bklog-cool-'));
      const detectDir = path.join(tmpData, 'detect-curation');
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(detectDir, { recursive: true });
      fs.mkdirSync(runtimeDir, { recursive: true });
      // Write payload and state that simulates "just injected" (turnsSinceLast=0)
      fs.writeFileSync(
        path.join(detectDir, `curation-${Date.now()}-testcool.json`),
        JSON.stringify({ detectedAt: new Date().toISOString(), command: 'npm test', charCount: 6000, lineCount: 200, sessionId: SESSION, cwd: '/tmp', outputPreview: 'tests passed' }),
      );
      fs.writeFileSync(
        path.join(runtimeDir, 'curation-backlog-state.json'),
        JSON.stringify({ lastInjectedAt: new Date().toISOString(), lastInjectedTurnId: SESSION, turnsSinceLast: 0 }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      // Should return {} (empty) — cooldown active
      const keys = Object.keys(r.parsed || {});
      return keys.length === 0 ? null : `expected {} (cooldown), got: ${JSON.stringify(r.parsed)}`;
    },
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

const filtered = FILTER
  ? TESTS.filter(t => t.name.toLowerCase().includes(FILTER.toLowerCase()))
  : TESTS;

let passed = 0, failed = 0, _warned = 0;
const failures = [];

console.log(BOLD(`\n🔬 Plugin Hook Test Suite — ${filtered.length} tests\n`));
console.log(DIM('─'.repeat(70)));

for (const test of filtered) {
  const extraEnv = typeof test.extraEnv === 'function' ? test.extraEnv() : (test.extraEnv || {});
  const result = run(test.script, test.payload, test.args || [], extraEnv);
  const { ok, issues, parsed } = check(result, test.expect || {});

  let extraIssue = null;
  if (ok && test.validate) {
    extraIssue = test.validate({ ok, issues, parsed });
  }

  const allOk = ok && !extraIssue;
  const allIssues = [...issues, ...(extraIssue ? [extraIssue] : [])];

  if (allOk) {
    passed++;
    const detail = parsed && VERBOSE
      ? DIM(`\n     stdout: ${JSON.stringify(parsed).slice(0, 120)}`)
      : '';
    console.log(`  ${GREEN('✓')} ${test.name}${detail}`);
  } else {
    failed++;
    failures.push({ name: test.name, issues: allIssues, result });
    console.log(`  ${RED('✗')} ${test.name}`);
    for (const issue of allIssues) {
      console.log(`      ${YELLOW('→')} ${issue}`);
    }
    if (VERBOSE && result.stderr) {
      console.log(DIM(`    stderr: ${result.stderr.trim().slice(0, 200)}`));
    }
  }
}

console.log(DIM('─'.repeat(70)));
console.log(BOLD(`\nResults: ${GREEN(passed + ' passed')}  ${failed > 0 ? RED(failed + ' failed') : DIM('0 failed')}\n`));

if (failures.length > 0 && !VERBOSE) {
  console.log(DIM('Run with --verbose to see stderr for failing tests\n'));
}

process.exit(failed > 0 ? 1 : 0);
