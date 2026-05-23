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

const SCRIPTS = path.resolve(__dirname);
const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

// ─── Helpers ───────────────────────────────────────────────────────────────

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const DIM    = s => `\x1b[2m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

function run(script, payload, args = []) {
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

  // ── PostToolUse / Bash ────────────────────────────────────────────────────
  {
    name: 'curation-detect   [PostToolUse/small→skip]',
    script: 'curation-detect.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_result: { text: 'On branch main\nnothing to commit' },
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
      tool_result: { text: LARGE_OUTPUT },
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
      tool_result: { text: 'abc123 fix something\ndef456 add feature' },
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
    payload: { event: 'Stop', session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'refine-research   [Stop→injects context]',
    script: 'refine-research.js',
    payload: { event: 'Stop', session_id: SESSION },
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
  const result = run(test.script, test.payload, test.args || []);
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
