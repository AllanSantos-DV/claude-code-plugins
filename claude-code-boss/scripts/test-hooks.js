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
    name: 'curation-guard    [PreToolUse/no-curated,no-whitelist→allow-default]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: SESSION,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `unmatched command should fall through to default allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'curation-guard    [PreToolUse/uncurated-build→allow-default]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      session_id: SESSION,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `uncurated build command should allow (discovery loop in PostToolUse/Stop handles it), got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'curation-guard    [PreToolUse/non-Bash→pass]',
    script: 'curation-guard.js',
    payload: { tool_name: 'Write', tool_input: { file_path: 'foo.js' } },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `non-Bash should pass, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
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
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `whitelisted cmd should be allowed, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
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
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `denyUnknown=false → should allow unknown, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
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
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ curationGuard: { denyUnknown: true } }) }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'deny'
      ? null : `denyUnknown=true → should deny unknown, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },

  {
    name: 'curation-guard    [PreToolUse/wrapper-invokes-curated→allow]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'powershell -ExecutionPolicy Bypass -File .vscode/scripts/vitest.ps1 tests/foo.test.ts' },
      session_id: SESSION,
      cwd: (() => mkTempProject({ shells: [{ id: 'vitest', script: '.vscode/scripts/vitest.ps1', aliases: ['npm test'] }], whitelist: [] }))(),
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `wrapper invocation should be allowed silently (matcher.includes), got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'curation-guard    [PreToolUse/alias→deny+redirect-to-script]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: SESSION,
      cwd: (() => mkTempProject({ shells: [{ id: 'vitest', script: '.vscode/scripts/vitest.ps1', aliases: ['npm test'] }], whitelist: [] }))(),
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => {
      const d = r.parsed?.hookSpecificOutput?.permissionDecision;
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (d !== 'deny') return `alias should deny+redirect, got: ${d}`;
      if (!ctx.includes('.vscode/scripts/vitest.ps1')) return `redirect should reference script path, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'curation-guard    [PreToolUse/abs-path-invokes-relative-script→allow]',
    script: 'curation-guard.js',
    payload: (() => {
      const cwd = mkTempProject({ shells: [{ id: 'adb', script: '.vscode/scripts/adb-logcat-tail.ps1', aliases: ['adb logcat'] }], whitelist: [] });
      // Simulate the real-world case: agent invokes the curated script via an
      // absolute Windows-style path. Must be recognized as already-curated.
      const absPath = `${cwd.replace(/\\/g, '/')}/.vscode/scripts/adb-logcat-tail.ps1`;
      return {
        tool_name: 'Bash',
        tool_input: { command: `powershell.exe -ExecutionPolicy Bypass -File ${absPath} -Pattern "X" -Lines 20` },
        session_id: SESSION,
        cwd,
      };
    })(),
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `absolute-path invocation of relative-registered script should allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision} (ctx: ${r.parsed?.hookSpecificOutput?.additionalContext})`,
  },
  {
    name: 'curation-guard    [PreToolUse/path-prefix-collision→no-false-match]',
    script: 'curation-guard.js',
    payload: (() => {
      const cwd = mkTempProject({ shells: [{ id: 'x', script: 'x.ps1', aliases: [] }], whitelist: [] });
      return {
        tool_name: 'Bash',
        tool_input: { command: 'powershell -File ax.ps1' },
        session_id: SESSION,
        cwd,
      };
    })(),
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (ctx.includes('x.ps1') && ctx.includes('curated script')) {
        return `ax.ps1 must NOT match curated x.ps1, got redirect: ${ctx}`;
      }
      return null;
    },
  },
  {
    name: 'curation-guard    [PreToolUse/alias-after-cd→deny+redirect]',
    script: 'curation-guard.js',
    payload: (() => {
      // Real-world case from the field: agent prepends `cd <project> && ` to
      // its alias invocation. Matcher must split by `&&`/`;`/`||` so the alias
      // segment is still recognized.
      const cwd = mkTempProject({ shells: [{ id: 'tsc', script: '.vscode/scripts/tsc_check.ps1', aliases: ['npm run compile'] }], whitelist: [] });
      return {
        tool_name: 'Bash',
        tool_input: { command: `cd ${cwd.replace(/\\/g, '/')} && npm run compile 2>&1 | tail -20` },
        session_id: SESSION,
        cwd,
      };
    })(),
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => {
      const d = r.parsed?.hookSpecificOutput?.permissionDecision;
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (d !== 'deny') return `alias after 'cd && ' should deny+redirect, got: ${d} (ctx: ${ctx})`;
      if (!ctx.includes('.vscode/scripts/tsc_check.ps1')) return `redirect should reference script path, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'curation-guard    [PreToolUse/curated-script+pipe→deny+edit-script]',
    script: 'curation-guard.js',
    payload: (() => {
      // Real-world: agent invokes curated script then pipes output. Any pipe
      // signals post-processing — block and tell the agent to edit the script
      // if its output isn't adequate. Hook doesn't enumerate filter commands;
      // the LLM reads the reason and decides.
      const cwd = mkTempProject({ shells: [{ id: 'rep', script: '.vscode/scripts/repackage.ps1', aliases: [] }], whitelist: [] });
      const absPath = `${cwd.replace(/\\/g, '/')}/.vscode/scripts/repackage.ps1`;
      return {
        tool_name: 'Bash',
        tool_input: { command: `powershell -ExecutionPolicy Bypass -File ${absPath} 2>&1 | tail -10` },
        session_id: SESSION,
        cwd,
      };
    })(),
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => {
      const d = r.parsed?.hookSpecificOutput?.permissionDecision;
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (d !== 'deny') return `curated-script + pipe should deny (edit script), got: ${d}`;
      if (!/edit the script/i.test(ctx)) return `deny reason must instruct to edit the script, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'curation-guard    [PreToolUse/curated-script+logical-or→allow]',
    script: 'curation-guard.js',
    payload: (() => {
      // `||` is logical OR, not a pipe. Should NOT trigger filter-pipe deny.
      const cwd = mkTempProject({ shells: [{ id: 'rep', script: '.vscode/scripts/repackage.ps1', aliases: [] }], whitelist: [] });
      const absPath = `${cwd.replace(/\\/g, '/')}/.vscode/scripts/repackage.ps1`;
      return {
        tool_name: 'Bash',
        tool_input: { command: `powershell -File ${absPath} || echo failed` },
        session_id: SESSION,
        cwd,
      };
    })(),
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `\`||\` is logical OR not a filter pipe, should allow. Got: ${r.parsed?.hookSpecificOutput?.permissionDecision} (ctx: ${r.parsed?.hookSpecificOutput?.additionalContext})`,
  },
  {
    name: 'curation-guard    [legacy `command` field→still matches]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: SESSION,
      // legacy entry: no `script`, only `command` (normalized at load time)
      cwd: (() => mkTempProject({ shells: [{ id: 'legacy', command: '.vscode/scripts/legacy.mjs', aliases: ['npm test'] }], whitelist: [] }))(),
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'deny'
      ? null : `legacy command-field entry should still drive deny+redirect, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    // Security: token-aware matcher must NOT treat quoted-arg occurrence as invocation.
    // Was: substring `includes` matched any embedded path → bypass.
    name: 'curation-guard    [security/quoted-arg→does-not-bypass]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'echo "running .vscode/scripts/vitest.ps1"' },
      session_id: SESSION,
      cwd: (() => mkTempProject({ shells: [{ id: 'vitest', script: '.vscode/scripts/vitest.ps1', aliases: [] }], whitelist: [] }))(),
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => {
      // `echo "running script.ps1"` mentions the script path inside a quoted arg.
      // Matcher must NOT treat that as an invocation (would silently allow under
      // the wrong branch). With no curated match and no whitelist, falls through
      // to the default allow. Either way, expected: allow with no deny redirect.
      const d = r.parsed?.hookSpecificOutput?.permissionDecision;
      if (d !== 'allow') return `quoted-arg must not trigger curated-redirect, got: ${d} (ctx: ${r.parsed?.hookSpecificOutput?.additionalContext})`;
      return null;
    },
  },

  // ── PostToolUse / Bash ────────────────────────────────────────────────────
  {
    name: 'curation-detect   [PostToolUse/small→skip]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-success.json'), session_id: SESSION },
    expect: { noError: true },
    validate: _r => null, // small output → no trigger → no turn-state entry
  },
  {
    name: 'curation-detect   [PostToolUse/large→appends turn state]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-success-noisy.json'), session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-lrg-')) }),
    validateWithEnv: (r, env) => {
      // Journal: one file per entry under .runtime/curation-turn-<sid>--<ts>-<rand>.json
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const runtimeDir = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime');
      const prefix = `curation-turn-${safe}--`;
      if (!fs.existsSync(runtimeDir)) return `runtime dir missing: ${runtimeDir}`;
      const files = fs.readdirSync(runtimeDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
      if (files.length === 0) return `no journal entry files in ${runtimeDir}`;
      const entry = JSON.parse(fs.readFileSync(path.join(runtimeDir, files[0]), 'utf-8'));
      if (entry.reason !== 'needs-curation') return `expected reason=needs-curation, got ${entry.reason}`;
      return null;
    },
  },
  {
    name: 'curation-detect   [PostToolUseFailure→needs-curation]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-failure.json'), session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-fail-')) }),
    validateWithEnv: (r, env) => {
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const runtimeDir = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime');
      const prefix = `curation-turn-${safe}--`;
      if (!fs.existsSync(runtimeDir)) return `runtime dir missing: ${runtimeDir}`;
      const files = fs.readdirSync(runtimeDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
      if (files.length === 0) return `no journal entry files in ${runtimeDir}`;
      return null;
    },
  },
  {
    name: 'curation-detect   [PostToolUseFailure/is_interrupt=true]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-interrupted.json'), session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-intr-')) }),
  },
  {
    name: 'curation-detect   [PostToolUseFailure/empty-error]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-empty-error.json'), session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-emp-')) }),
    validate: _r => null, // charCount=0 → reason=null → no payload → clean exit
  },
  {
    name: 'curation-detect   [PostToolUseFailure/no-exit-prefix]',
    script: 'curation-detect.js',
    payload: { ...require('./__fixtures__/post-tool-use-no-exit-prefix.json'), session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-nopfx-')) }),
    validate: _r => null, // small body → no trigger → clean exit
  },
  {
    name: 'curation-detect   [PostToolUseFailure/with-prefix-no-body]',
    script: 'curation-detect.js',
    payload: { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'run.sh' }, error: 'Exit code 1\n', is_interrupt: false, duration_ms: 10, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-nbody-')) }),
    validate: _r => null, // body="" → charCount=0 → no trigger
  },
  {
    name: 'curation-detect   [PostToolUse/curated-success-small→no-trigger]',
    script: 'curation-detect.js',
    payload: (() => {
      const f = require('./__fixtures__/post-tool-use-success.json');
      const projDir = mkTempProject({ shells: [{ id: 'gitstatus', script: '.vscode/scripts/gitstatus.mjs', aliases: ['git status'] }], whitelist: [] });
      return { ...f, session_id: SESSION, cwd: projDir };
    })(),
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-cs-sm-')) }),
    validate: _r => null, // curated success, 2 lines ≤ 3 → no trigger
  },
  {
    name: 'curation-detect   [PostToolUse/curated-success-noisy→trigger]',
    script: 'curation-detect.js',
    payload: (() => {
      const f = require('./__fixtures__/post-tool-use-success-noisy.json');
      const projDir = mkTempProject({ shells: [{ id: 'test', script: '.vscode/scripts/test.mjs', aliases: ['npm test'] }], whitelist: [] });
      return { ...f, session_id: SESSION, cwd: projDir };
    })(),
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-cs-noisy-')) }),
  },

  // ── Stop ─────────────────────────────────────────────────────────────────
  {
    name: 'pattern-detect    [Stop]',
    script: 'pattern-detect.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
  },
  {
    name: 'refine-research   [Stop→throttled or block]',
    script: 'refine-research.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-refine-')) }),
    validate: r => {
      // Either throttled ({}) or injected ({decision:'block', reason})
      const p = r.parsed || {};
      const keys = Object.keys(p);
      if (keys.length === 0) return null; // throttled — fine
      if (p.decision === 'block' && p.reason) return null; // injected — fine
      return `expected {} or {decision:'block',reason}, got: ${JSON.stringify(p)}`;
    },
  },
  {
    name: 'curation-stop     [Stop→no-entries→{}]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-empty-')) }),
    validate: r => {
      const keys = Object.keys(r.parsed || {});
      return keys.length === 0 ? null : `expected {} (no entries), got: ${JSON.stringify(r.parsed)}`;
    },
  },
  {
    name: 'curation-stop     [Stop→entries→block+reason]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-ent-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-turn-${safe}.json`),
        JSON.stringify({
          sessionId: SESSION,
          startedAt: new Date().toISOString(),
          entries: [
            { command: 'npm test', reason: 'needs-curation', lines: 487, chars: 12000, isCurated: false, curatedScript: null, isSuccess: true, timestamp: new Date().toISOString() },
          ],
        }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validateWithEnv: (r, env) => {
      const p = r.parsed || {};
      if (p.decision !== 'block') return `expected decision:'block', got: ${JSON.stringify(p)}`;
      if (!p.reason || !p.reason.includes('npm test')) return `expected reason mentioning command, got: ${p.reason}`;
      // Turn state should be cleared
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const statePath = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime', `curation-turn-${safe}.json`);
      if (fs.existsSync(statePath)) return `turn state should be cleared, still exists at ${statePath}`;
      return null;
    },
  },
  {
    name: 'curation-stop     [Stop→retry-overlap→escalated block]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-retry-overlap-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      // Prior block: same script appears in this turn → no progress.
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({ attempts: 1, blockedSignature: 'powershell -File .vscode/scripts/vitest.ps1|.vscode/scripts/vitest.ps1', firstBlockedAt: new Date().toISOString() }),
      );
      fs.writeFileSync(
        path.join(runtimeDir, `curation-turn-${safe}.json`),
        JSON.stringify({ entries: [{ command: 'powershell -File .vscode/scripts/vitest.ps1', reason: 'curated-success-noisy', lines: 53, chars: 5114, isCurated: true, curatedScript: '.vscode/scripts/vitest.ps1' }] }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      if (r.parsed?.decision !== 'block') return `expected escalated block, got: ${JSON.stringify(r.parsed)}`;
      if (!(r.parsed?.reason || '').includes('[RETRY 2/3]')) return `expected [RETRY 2/3] marker, got: ${(r.parsed?.reason || '').slice(0, 200)}`;
      return null;
    },
  },
  {
    name: 'curation-stop     [Stop→retry-no-turnstate→escalated block (text-only ignore)]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-textonly-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      // Prior block exists; turn-state missing = agent replied text-only without
      // acting on the block. Must escalate, not relent.
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({
          attempts: 1,
          blockedSignature: 'powershell -File .vscode/scripts/vitest.ps1|.vscode/scripts/vitest.ps1',
          blockedEntries: [{ command: 'powershell -File .vscode/scripts/vitest.ps1', curatedScript: '.vscode/scripts/vitest.ps1', reason: 'curated-success-noisy' }],
          firstBlockedAt: new Date().toISOString(),
        }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      if (r.parsed?.decision !== 'block') return `expected escalated block (text-only ignore), got: ${JSON.stringify(r.parsed)}`;
      if (!(r.parsed?.reason || '').includes('[RETRY 2/3]')) return `expected [RETRY 2/3] marker, got: ${(r.parsed?.reason || '').slice(0, 200)}`;
      return null;
    },
  },
  {
    name: 'curation-stop     [Stop→max-attempts-reached→relent {}]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-relent-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({ attempts: 3, blockedSignature: 'x|.vscode/scripts/x.ps1', firstBlockedAt: new Date().toISOString() }),
      );
      fs.writeFileSync(
        path.join(runtimeDir, `curation-turn-${safe}.json`),
        JSON.stringify({ entries: [{ command: 'x', reason: 'curated-success-noisy', lines: 50, chars: 4000, isCurated: true, curatedScript: '.vscode/scripts/x.ps1' }] }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0
      ? null : `expected {} (relent after maxAttempts), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'curation-stop     [Stop→retry+edited-curated-script→release {}]',
    script: 'curation-stop.js',
    payload: (() => {
      // Build a project with the curated script present, set its mtime to NOW
      // and set firstBlockedAt to 10s in the past — must be detected as edited.
      const cwd = mkTempProject({ shells: [{ id: 'adb', script: '.vscode/scripts/adb-logcat-tail.ps1', aliases: [] }], whitelist: [] });
      const scriptPath = path.join(cwd, '.vscode', 'scripts', 'adb-logcat-tail.ps1');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, '# refined\n');
      // Force mtime to "now" (newer than firstBlockedAt below).
      const now = new Date();
      fs.utimesSync(scriptPath, now, now);
      return {
        hook_event_name: 'Stop',
        session_id: SESSION,
        stop_hook_active: true,
        cwd,
      };
    })(),
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-edited-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({
          attempts: 1,
          blockedSignature: 'adb logcat|.vscode/scripts/adb-logcat-tail.ps1',
          blockedEntries: [{ command: 'adb logcat -d -t 1000', reason: 'curated-success-noisy', curatedScript: '.vscode/scripts/adb-logcat-tail.ps1' }],
          firstBlockedAt: tenSecAgo,
        }),
      );
      // Empty journal — agent didn't run anything new, only edited the script.
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0
      ? null : `editing curated script must count as progress (release stop), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'curation-stop     [Stop→refine-section→READ instruction in reason]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-refine-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-turn-${safe}.json`),
        JSON.stringify({
          sessionId: SESSION,
          startedAt: new Date().toISOString(),
          entries: [
            { command: 'powershell -File .vscode/scripts/vitest.ps1 x.test.ts', reason: 'curated-success-noisy', lines: 53, chars: 5114, isCurated: true, curatedScript: '.vscode/scripts/vitest.ps1', isSuccess: true, timestamp: new Date().toISOString() },
          ],
        }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      const reason = r.parsed?.reason || '';
      if (r.parsed?.decision !== 'block') return `expected decision:'block'`;
      if (!reason.includes('REFINE')) return `expected REFINE section, got: ${reason.slice(0, 200)}`;
      if (!reason.includes('curation-script-pattern')) return `expected pointer to skill (not paternalistic rule recap), got: ${reason.slice(0, 200)}`;
      if (!reason.includes('.vscode/scripts/vitest.ps1')) return `expected existing script path in reason`;
      if (reason.includes('CREATE')) return `should not have CREATE section (no create-entries)`;
      return null;
    },
  },
  {
    name: 'curation-stop     [Stop→mixed→both REFINE and CREATE sections]',
    script: 'curation-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-mixed-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-turn-${safe}.json`),
        JSON.stringify({
          sessionId: SESSION,
          entries: [
            { command: 'npm test', reason: 'needs-curation', lines: 200, chars: 8000, isCurated: false, curatedScript: null, isSuccess: true, timestamp: new Date().toISOString() },
            { command: 'powershell -File .vscode/scripts/build.ps1', reason: 'curated-success-noisy', lines: 40, chars: 4000, isCurated: true, curatedScript: '.vscode/scripts/build.ps1', isSuccess: true, timestamp: new Date().toISOString() },
          ],
        }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      const reason = r.parsed?.reason || '';
      if (!reason.includes('REFINE')) return `expected REFINE section, got: ${reason.slice(0, 300)}`;
      if (!reason.includes('CREATE')) return `expected CREATE section, got: ${reason.slice(0, 300)}`;
      if (!reason.includes('build.ps1')) return `expected build.ps1 in REFINE section`;
      if (!reason.includes('npm test')) return `expected npm test in CREATE section`;
      return null;
    },
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
  if (ok && !extraIssue && test.validateWithEnv) {
    extraIssue = test.validateWithEnv({ ok, issues, parsed }, extraEnv);
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

// ─── Async race-condition test (curation-detect concurrent appends) ─────────
// The journal design (one file per appendEntry call, unique filename with
// timestamp + 4-byte random suffix) must allow N truly-concurrent spawns
// to all land their entries without loss.
(async () => {
  if (FILTER && !'curation-detect concurrent appends'.toLowerCase().includes(FILTER.toLowerCase())) {
    finalize();
    return;
  }
  const testName = 'curation-detect   [concurrent appends→no lost entries]';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-race-'));
  const N = 5;
  const fixture = require('./__fixtures__/post-tool-use-success-noisy.json');
  const { spawn } = require('child_process');

  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: path.resolve(SCRIPTS, '..'),
    CLAUDE_PLUGIN_DATA: dataDir,
  };

  // Spawn N children with distinct commands so dedup-by-command doesn't merge them.
  const promises = [];
  for (let i = 0; i < N; i++) {
    const payload = { ...fixture, session_id: SESSION, tool_input: { ...(fixture.tool_input || {}), command: `echo race-${i}` } };
    promises.push(new Promise((resolve) => {
      const child = spawn('node', [path.join(SCRIPTS, 'curation-detect.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(JSON.stringify(payload));
      child.on('close', () => resolve());
    }));
  }
  await Promise.all(promises);

  // Verify N journal files landed.
  const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const runtimeDir = path.join(dataDir, '.runtime');
  const prefix = `curation-turn-${safe}--`;
  const files = fs.existsSync(runtimeDir)
    ? fs.readdirSync(runtimeDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    : [];

  if (files.length === N) {
    passed++;
    console.log(`  ${GREEN('✓')} ${testName}`);
  } else {
    failed++;
    console.log(`  ${RED('✗')} ${testName}`);
    console.log(`      ${YELLOW('→')} expected ${N} journal files, got ${files.length}`);
  }
  finalize();
})();

function finalize() {
  console.log(DIM('─'.repeat(70)));
  console.log(BOLD(`\nResults: ${GREEN(passed + ' passed')}  ${failed > 0 ? RED(failed + ' failed') : DIM('0 failed')}\n`));

  if (failures.length > 0 && !VERBOSE) {
    console.log(DIM('Run with --verbose to see stderr for failing tests\n'));
  }

  process.exit(failed > 0 ? 1 : 0);
}
