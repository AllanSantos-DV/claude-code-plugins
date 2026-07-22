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

// Isolate os.homedir()-derived state (the GLOBAL dir: active-data-dir pointer +
// brain user-config) into a throwaway home for the WHOLE run. data-dir.js
// PUBLISHES a pointer on every valid-env dataDir() call, and every spawned hook
// below inherits process.env via `run()`'s `...process.env` spread — without
// this, a hermetic test that passes its own temp CLAUDE_PLUGIN_DATA (e.g. the
// skill-metric test) would still leak into the developer's REAL
// ~/.claude/claude-code-boss, hijacking a live session's active-data-dir
// pointer (mirrors the same isolation test-units.js already applies). Set BOTH
// vars so os.homedir() resolves here on every platform (Windows prefers
// USERPROFILE, POSIX HOME).
process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hooks-home-'));
process.env.HOME = process.env.USERPROFILE;

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

// ─── error-guard fixtures (deterministic recurring-failure guard) ───────────
// The error-guard PreToolUse hook DENIES a Bash command whose canonical sig has
// already failed >= threshold times. To exercise it across a spawned subprocess
// we must seed the SAME error-store the hook reads: build each fixture ONCE so
// payload.cwd, the seeded projectKey (resolveProjectKey(cwd)) and
// CLAUDE_PLUGIN_DATA all agree. Each fixture gets its own temp cwd + dataDir.
const _errorStore = require('./lib/error-store.js');
function seedErrorGuard(command, { threshold = 2, cause = 'TS2345: type error in foo.ts', exitCode = 2 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-eg-proj-'));
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true }); // stable projectKey
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-eg-data-'));
  const pk = _errorStore.resolveProjectKey(cwd);
  for (let i = 0; i < threshold; i++) {
    _errorStore.record(dataDir, pk, { command, cause, exitCode });
  }
  return { cwd, dataDir, command };
}
// Recorded recurring failure — read-only across guard tests (deny/allow/gate).
const _egHit = seedErrorGuard('npm run build');
// Dedicated fixture the error-resolve test MUTATES (cleared on success).
const _egResolve = seedErrorGuard('npm run build');
// Fresh project (no seed) — failure-detect must POPULATE its error-store.
const _fdIntegration = (() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fd-proj-'));
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  return { cwd, command: 'cd /x && npm run typecheck -- --strict' };
})();

// ─── graph-guard fixtures (broad-search redirect to the Session Graph) ───────
// Plugin roots with a CONTROLLED brain-config (mkTempPluginRoot only writes the
// hooks config) + a data dir pre-seeded with a FRESH 'ready' readiness cache
// for the fixture cwd — so the spawned hook takes the cache path and NEVER
// probes the network (hermetic).
const _gg = (() => {
  const mkRoot = (hooksOverrides, backendType) => {
    const root = mkTempPluginRoot(hooksOverrides);
    fs.writeFileSync(
      path.join(root, 'config', 'brain-config.json'),
      JSON.stringify({ backend: { type: backendType, mcpMemory: {} } }),
    );
    return root;
  };
  const root = mkRoot({}, 'mcp-memory');            // shipped profile (standard) — graphGuard is ON in dev AND standard
  const rootLocal = mkRoot({}, 'local');
  const rootFree = mkRoot({ profile: 'free' }, 'mcp-memory');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gg-data-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gg-proj-'));       // READY graph WITH nodes → deny path
  const cwdNotIndexed = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gg-ni-')); // not_indexed → deny-once path
  const core = require('./lib/graph-guard-core.js');
  core.writeReadyCache(core.cachePath(dataDir, path.resolve(cwd)), 'ready', 1834);
  core.writeReadyCache(core.cachePath(dataDir, path.resolve(cwdNotIndexed)), 'not_indexed', 0);
  return { root, rootLocal, rootFree, dataDir, cwd, cwdNotIndexed };
})();

// ─── policy-inject fixtures (deterministic always-apply POLICY injection) ────
// The policy-inject SessionStart/SubagentStart hook LISTS the active policies for
// the current project and injects them as additionalContext. To make the spawned
// subprocess resolve the SAME projectId we seeded, each fixture computes
// projectId = basename(cwd) (resolveProjectId's marker-less fallback) and the
// tests pass CCB_PROJECT_ID:'' so the env-forced id can't shadow it.
const _policyStore = require('./lib/policy-store.js');
const POLICY_TEXT = 'never let pre-existing code errors pass';
function seedPolicy(text, { scope = 'project' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-proj-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-data-'));
  const projectId = path.basename(cwd);
  _policyStore.activate(dataDir, { text, scope, projectId });
  return { cwd, dataDir, text, projectId };
}
// One active project-scoped policy — reused (read-only) by the SessionStart,
// SubagentStart, and enabled=false tests.
const _polActive = seedPolicy(POLICY_TEXT, { scope: 'project' });
// Corrupt registry fixture: a garbage registry file → the hook must still emit a
// warning (never silently drop the user's standing constraints).
const _polCorrupt = (() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-corrupt-proj-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-corrupt-data-'));
  fs.mkdirSync(path.join(dataDir, 'policies'), { recursive: true });
  fs.writeFileSync(_policyStore.storePath(dataDir), 'not json {{{');
  return { cwd, dataDir };
})();
// Fresh empty dataDir + cwd — no active policy → the hook must stay silent.
const _polEmpty = {
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-empty-proj-')),
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-empty-data-')),
};
// GLOB-only policy: a per-file (mode:'glob') rule with NO always-mode record. The
// leak-guard regression asserts policy-inject (now listAlways) never surfaces it at
// SessionStart — a conditional advisory must not become an unconditional constraint.
const _polGlobOnly = (() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-globonly-proj-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pol-globonly-data-'));
  const projectId = path.basename(cwd);
  _policyStore.activate(dataDir, { text: 'glob-only rule that must stay conditional', projectId, globs: ['src/**'] });
  return { cwd, dataDir, projectId };
})();

// ─── policy-glob-inject fixtures (PostToolUse post-edit GLOB advisory) ───────
// The policy-glob-inject hook fires after Edit|Write|MultiEdit|NotebookEdit, and
// surfaces a project-scoped glob policy ONLY when the edited path matches. Each
// fixture seeds a glob policy under projectId=basename(cwd) and passes
// CCB_PROJECT_ID:'' so the spawned subprocess resolves the same id we seeded.
const GLOB_POLICY_TEXT = 'flag any leftover console.log in production source';
function seedGlobPolicy(text, globs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gpol-proj-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gpol-data-'));
  const projectId = path.basename(cwd);
  const res = _policyStore.activate(dataDir, { text, projectId, globs });
  return { cwd, dataDir, projectId, text, globs, id: res.id };
}
// Matching fixture — reused read-only by match / NotebookEdit / non-file / disabled.
const _gpMatch = seedGlobPolicy(GLOB_POLICY_TEXT, ['src/**']);
// Redaction fixture: a secret in the policy text must NEVER reach the injected block.
const GLOB_SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX12';
const _gpRedact = seedGlobPolicy(`avoid committing ${GLOB_SECRET} into source`, ['**']);
// Outside-project fixture: a matches-everything glob, but an out-of-tree path → empty.
const _gpOutside = seedGlobPolicy('nothing should surface for an out-of-project path', ['**']);
// A different-project cwd sharing _gpMatch's registry — proves cross-project isolation.
const _gpOtherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-gpol-otherproj-'));
// An absolute path guaranteed to be OUTSIDE the fixture cwd (other drive on Windows).
const _gpOutsidePath = process.platform === 'win32' ? 'Z:\\elsewhere\\secret.ts' : '/elsewhere/secret.ts';

// ─── policy-enforce-shadow fixtures (PreToolUse Edit-only SILENT measurement) ─
// The shadow hook fires BEFORE an Edit, measures whether the edit ADDS an
// occurrence of a shadow policy's literal (net count new>old), records ONE
// policy.shadow.evaluated metric (outcome trigger|pass|unevaluable), and ALWAYS
// emits {} — it never blocks and never speaks to the agent. Seed a shadow-assertion
// policy under projectId=basename(cwd) and pass CCB_PROJECT_ID:'' so the subprocess
// resolves the same id. The metric lands in
// <dataDir>/metrics/<sha256(basename(cwd)).slice(0,16)>/metrics.db — read it to
// prove the outcome (stdout is silent by design, so the DB is the only witness).
const _crypto = require('crypto');
const SHADOW_LITERAL = 'console.log';
function seedShadowPolicy(literal = SHADOW_LITERAL, globs = ['src/**']) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-shpol-proj-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-shpol-data-'));
  const projectId = path.basename(cwd);
  const res = _policyStore.activate(dataDir, {
    entryId: 'shadow-fixture', text: 'flag added ' + literal, projectId, globs,
    assert: { kind: 'forbid-added-literal', literal, caseSensitive: true }, enforcement: 'shadow',
  });
  return { cwd, dataDir, projectId, literal, activationId: res.activationId };
}
// The metrics project key the hook stamps: sha256(resolveProjectId(cwd)).slice(0,16);
// under CCB_PROJECT_ID:'' with no marker, resolveProjectId(cwd) === basename(cwd).
function shadowMetricsKey(cwd) {
  return _crypto.createHash('sha256').update(path.basename(cwd)).digest('hex').slice(0, 16);
}
// Read the recorded shadow-evaluation payloads under a fixture's dataDir. Returns an
// array of payload objects, null if none were written (a proven no-metric path), or
// {skip:true} if no SQLite backend is present (outcome unverifiable; silence still checked).
function readShadowOutcomes(dataDir, cwd) {
  const Database = require('./lib/sqlite-compat').loadSqlite();
  if (!Database) return { skip: true };
  const dbPath = path.join(dataDir, 'metrics', shadowMetricsKey(cwd), 'metrics.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT payload FROM metrics_event WHERE event_name = 'policy.shadow.evaluated'").all();
    return rows.length ? rows.map(r => JSON.parse(r.payload || '{}')) : null;
  } finally { db.close(); }
}
// Distinct fixtures (each its own dataDir/cwd → single-row, contamination-free reads).
const _shTrigger = seedShadowPolicy();  // Edit ADDS the literal → outcome 'trigger'
const _shPass = seedShadowPolicy();     // Edit PRESERVES the literal (same count) → 'pass'
const _shNoMatch = seedShadowPolicy();  // non-matching path → no metric
const _shNonEdit = seedShadowPolicy();  // non-Edit tool → no metric
const _shDisabled = seedShadowPolicy(); // policyInject.enabled=false → no metric

// micro-B1 trigger-evidence capture fixtures (each its own dataDir → contamination-free
// evidence reads). Capture is OPT-IN: only the enabled tests set captureTriggerEvidence.
const _shCapOff = seedShadowPolicy();    // trigger + DEFAULT config (capture OFF) → NO evidence
const _shCapOn = seedShadowPolicy();     // trigger + capture ON → ONE redacted evidence record
const _shCapPass = seedShadowPolicy();   // pass    + capture ON → NO evidence (only triggers capture)
const _shCapSecret = seedShadowPolicy(); // trigger whose added text holds a secret → redacted in store
// Read the captured trigger evidence a fixture stored. The hook keys it under the id it
// resolves — basename(cwd) when CCB_PROJECT_ID:'' (same as the metrics key), which the
// store sanitizes; passing basename(cwd) here reproduces that exact key. Array (maybe empty).
function readTriggerEvidence(dataDir, cwd) {
  return require('./lib/trigger-evidence-store.js').listEvidence(dataDir, path.basename(cwd), {});
}
// Reusable opted-in capture config (privacy default is OFF; these tests turn it ON).
const _capOnRoot = () => mkTempPluginRoot({ captureTriggerEvidence: { enabled: true, ttlDays: 7, maxPerProject: 500, maxSnippetChars: 2000 } });

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
    name: 'brain-health      [SessionStart/healthy]',
    script: 'brain-health.js',
    payload: { hook_event_name: 'SessionStart' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bh-ok-')) }),
    expect: { noError: true },
  },
  {
    name: 'brain-health      [SessionStart/defects→advisory]',
    script: 'brain-health.js',
    payload: { hook_event_name: 'SessionStart' },
    extraEnv: { CLAUDE_PLUGIN_ROOT: '/nonexistent-plugin-root' },
    expect: { hookEvent: 'SessionStart' },
  },
  {
    name: 'brain-health      [UserPromptSubmit/healthy]',
    script: 'brain-health.js',
    payload: { hook_event_name: 'UserPromptSubmit', cwd: process.cwd() },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bh-ups-')) }),
    expect: { noError: true },
  },
  {
    name: 'brain-health      [UserPromptSubmit/defects→advisory]',
    script: 'brain-health.js',
    payload: { hook_event_name: 'UserPromptSubmit', cwd: process.cwd() },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: '/nonexistent-plugin-root', CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bh-broken-')) }),
    expect: { hookEvent: 'UserPromptSubmit' },
  },

  // ── PreToolUse / Bash ─────────────────────────────────────────────────────
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

  // ── PreToolUse / Bash — error-guard (deterministic recurring-failure DENY) ─
  {
    name: 'error-guard       [PreToolUse/recurring-failure→deny+inject]',
    script: 'error-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: _egHit.command },
      session_id: SESSION,
      cwd: _egHit.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _egHit.dataDir }),
    validate: r => {
      const out = r.parsed?.hookSpecificOutput || {};
      if (out.permissionDecision !== 'deny') return `recurring failure must DENY, got: ${out.permissionDecision}`;
      const ctx = out.additionalContext || '';
      if (!ctx.includes('[error-guard]')) return `deny reason must be tagged [error-guard], got: ${ctx}`;
      if (!ctx.includes('npm run build')) return `deny reason must name the sig, got: ${ctx}`;
      if (!/já falhou 2×/.test(ctx)) return `deny reason must state the recurring count, got: ${ctx}`;
      if (!ctx.includes('TS2345')) return `deny reason must inject the recorded cause, got: ${ctx}`;
      if (out.permissionDecisionReason !== ctx) return 'permissionDecisionReason must mirror the injected reason';
      return null;
    },
  },
  {
    name: 'error-guard       [PreToolUse/clean-command→allow]',
    script: 'error-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: SESSION,
      cwd: _egHit.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _egHit.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `a command with no recorded failure must allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'error-guard       [PreToolUse/non-Bash→allow]',
    script: 'error-guard.js',
    payload: { tool_name: 'Write', tool_input: { file_path: 'foo.js' }, session_id: SESSION },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `non-Bash tool must allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'error-guard       [PreToolUse/errorGuard.enabled=false→allow-despite-hit]',
    script: 'error-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: _egHit.command },
      session_id: SESSION,
      cwd: _egHit.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({
      CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ errorGuard: { enabled: false } }),
      CLAUDE_PLUGIN_DATA: _egHit.dataDir,
    }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `errorGuard.enabled=false must allow even a recurring failure, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },

  // ── PreToolUse / Grep|Glob + Bash — graph-guard (broad-search → graph redirect) ─
  {
    name: 'graph-guard       [Grep broad + mcp-memory + graph READY → deny-once with redirect]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveProjectId' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => {
      const out = r.parsed?.hookSpecificOutput || {};
      if (out.permissionDecision !== 'deny') return `broad Grep with READY graph must DENY once, got: ${out.permissionDecision}`;
      const ctx = out.additionalContext || '';
      if (!ctx.includes('[graph-guard]')) return `deny reason must be tagged [graph-guard], got: ${ctx}`;
      if (!ctx.includes('graph_search')) return `deny reason must teach graph_search, got: ${ctx}`;
      if (out.permissionDecisionReason !== ctx) return 'permissionDecisionReason must mirror the reason';
      return null;
    },
  },
  {
    // SAME payload, SAME session/dataDir as above — the deny-once stamp must release it.
    name: 'graph-guard       [identical retry → allow (deny-once stamp)]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveProjectId' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `identical retry must pass (deny-once), got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'graph-guard       [scoped Grep (path) → allow, no interception]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'anotherSymbol', path: 'scripts/lib' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `scoped Grep must never be intercepted, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'graph-guard       [not_indexed + mcp-memory → deny-once, pushes graph_analyze]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'someBroadSymbol' },
      session_id: SESSION,
      cwd: _gg.cwdNotIndexed,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => {
      const out = r.parsed?.hookSpecificOutput || {};
      if (out.permissionDecision !== 'deny') return `not_indexed must DENY once (economics: index once vs per-query walk), got: ${out.permissionDecision}`;
      if (!/graph_analyze/.test(out.additionalContext || '')) return `deny reason must push graph_analyze, got: ${out.additionalContext}`;
      return null;
    },
  },
  {
    name: 'graph-guard       [backend local → allow (no graph to redirect to)]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'freshSymbolLocal' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.rootLocal, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `local backend must always allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    name: 'graph-guard       [profile free → allow despite READY graph]',
    script: 'graph-guard.js',
    payload: {
      tool_name: 'Grep',
      tool_input: { pattern: 'freshSymbolFree' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.rootFree, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `free profile is passthrough — must allow, got: ${r.parsed?.hookSpecificOutput?.permissionDecision}`,
  },
  {
    // The Bash surface rides curation-guard (no extra spawn): broad grep -r at
    // the repo root with READY graph → the SAME deny-once redirect.
    name: 'graph-guard       [Bash grep -r broad via curation-guard → deny with redirect]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "freshBashSymbol" .' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => {
      const out = r.parsed?.hookSpecificOutput || {};
      if (out.permissionDecision !== 'deny') return `broad bash grep with READY graph must DENY once, got: ${out.permissionDecision} (ctx: ${out.additionalContext})`;
      if (!(out.additionalContext || '').includes('[graph-guard]')) return `reason must be tagged [graph-guard], got: ${out.additionalContext}`;
      return null;
    },
  },
  {
    name: 'graph-guard       [Bash scoped grep -r subdir via curation-guard → allow]',
    script: 'curation-guard.js',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "freshBashSymbol2" scripts/lib' },
      session_id: SESSION,
      cwd: _gg.cwd,
    },
    expect: { hasKey: 'hookSpecificOutput', noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _gg.root, CLAUDE_PLUGIN_DATA: _gg.dataDir }),
    validate: r => r.parsed?.hookSpecificOutput?.permissionDecision === 'allow'
      ? null : `scoped bash grep must pass, got: ${r.parsed?.hookSpecificOutput?.permissionDecision} (ctx: ${r.parsed?.hookSpecificOutput?.additionalContext})`,
  },
  {
    name: 'error-resolve     [PostToolUse/Bash-success→clears recorded failure]',
    script: 'error-resolve.js',
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: _egResolve.command },
      session_id: SESSION,
      cwd: _egResolve.cwd,
    },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _egResolve.dataDir }),
    validateWithEnv: (r, env) => {
      const pk = _errorStore.resolveProjectKey(_egResolve.cwd);
      const store = _errorStore.load(env.CLAUDE_PLUGIN_DATA, pk);
      if (Object.keys(store.entries).length !== 0) return `success must clear the sig, entries remain: ${JSON.stringify(Object.keys(store.entries))}`;
      if (_errorStore.lookup(env.CLAUDE_PLUGIN_DATA, pk, _egResolve.command, { threshold: 2 }).hit) return 'guard must no longer hit after resolve';
      return null;
    },
  },
  {
    name: 'failure-detect    [PostToolUseFailure/Bash→records error-store]',
    script: 'failure-detect.js',
    payload: {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: _fdIntegration.command },
      error: 'Exit code 2\nsrc/foo.ts(3,5): error TS2345: boom',
      is_interrupt: false,
      session_id: SESSION,
      cwd: _fdIntegration.cwd,
    },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fd-data-')) }),
    validateWithEnv: (r, env) => {
      const pk = _errorStore.resolveProjectKey(_fdIntegration.cwd);
      // RAW command 'cd /x && npm run typecheck -- --strict' → sig 'npm run typecheck'.
      const l = _errorStore.lookup(env.CLAUDE_PLUGIN_DATA, pk, 'npm run typecheck', { threshold: 1 });
      if (!l.hit) return `failure-detect must record the Bash failure sig, got: ${JSON.stringify(l)}`;
      if (l.sig !== 'npm run typecheck') return `expected sig 'npm run typecheck', got '${l.sig}'`;
      if (l.exitCode !== 2) return `expected exitCode 2 (parsed from the failure), got ${l.exitCode}`;
      if (!/TS2345/.test(l.cause || '')) return `expected recorded cause to include the error snippet, got: ${l.cause}`;
      return null;
    },
  },

  // ── SessionStart / SubagentStart — policy-inject (always-apply POLICY) ─────
  {
    name: 'policy-inject     [SessionStart/active-policy→inject]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SessionStart', cwd: _polActive.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'SessionStart' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _polActive.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[BRAIN policy]')) return `injected block must be tagged [BRAIN policy], got: ${ctx}`;
      if (!ctx.includes(POLICY_TEXT)) return `injected block must contain the policy text, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'policy-inject     [SubagentStart/active-policy→inject+echo event]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SubagentStart', cwd: _polActive.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'SubagentStart' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _polActive.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[BRAIN policy]')) return `injected block must be tagged [BRAIN policy], got: ${ctx}`;
      if (!ctx.includes(POLICY_TEXT)) return `injected block must contain the policy text, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'policy-inject     [policyInject.enabled=false→empty despite active]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SessionStart', cwd: _polActive.cwd },
    expect: { noError: true },
    extraEnv: () => ({
      CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ policyInject: { enabled: false } }),
      CLAUDE_PLUGIN_DATA: _polActive.dataDir,
      CCB_PROJECT_ID: '',
    }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `enabled=false must emit empty {} even with an active policy, got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-inject     [no-active-policy→empty]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SessionStart', cwd: _polEmpty.cwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _polEmpty.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `no active policy must emit empty {}, got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-inject     [corrupt-registry→inject warning]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SessionStart', cwd: _polCorrupt.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'SessionStart' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _polCorrupt.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('unreadable')) return `a corrupt registry must inject a warning, got: ${ctx}`;
      return null;
    },
  },
  {
    // LEAK GUARD (micro-3 regression): policy-inject switched list→listAlways, so a
    // GLOB-mode policy must NOT be surfaced at SessionStart as an always constraint.
    name: 'policy-inject     [glob-only policy→NOT surfaced at SessionStart (leak guard)]',
    script: 'policy-inject.js',
    payload: { hook_event_name: 'SessionStart', cwd: _polGlobOnly.cwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _polGlobOnly.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `a glob-only policy must NOT inject at SessionStart, got: ${JSON.stringify(r.parsed)}`,
  },

  // ── PostToolUse — policy-glob-inject (post-edit GLOB advisory) ─────────────
  {
    name: 'policy-glob-inject[matching Edit path→inject [BRAIN policy]+text+PostToolUse]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' }, cwd: _gpMatch.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'PostToolUse' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpMatch.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[BRAIN policy]')) return `injected block must be tagged [BRAIN policy], got: ${ctx}`;
      if (!ctx.includes('completed edit')) return `injected block must be temporal ("completed edit"), got: ${ctx}`;
      if (!ctx.includes(GLOB_POLICY_TEXT)) return `injected block must contain the policy text, got: ${ctx}`;
      if (!ctx.includes('src/**')) return `injected block must cite the matched glob, got: ${ctx}`;
      if (!ctx.includes('"src/app.ts"')) return `injected block must JSON-quote the edited path, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'policy-glob-inject[non-matching path→empty]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'lib/app.ts' }, cwd: _gpMatch.cwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpMatch.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `a non-matching path must emit empty {}, got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-glob-inject[non-file tool (Bash)→empty]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { file_path: 'src/app.ts' }, cwd: _gpMatch.cwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpMatch.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `a non-edit tool must emit empty {}, got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-glob-inject[NotebookEdit notebook_path honored→inject]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'src/analysis.ipynb' }, cwd: _gpMatch.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'PostToolUse' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpMatch.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[BRAIN policy]')) return `NotebookEdit path must be honored + injected, got: ${JSON.stringify(r.parsed)}`;
      if (!ctx.includes('src/analysis.ipynb')) return `injected block must cite the notebook path, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'policy-glob-inject[cross-project→no leak (projB edit, projA policy)]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' }, cwd: _gpOtherCwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpMatch.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `a policy under project A must NOT inject for an edit under project B, got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-glob-inject[redaction→secret never in injected block]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'anything.ts' }, cwd: _gpRedact.cwd },
    expect: { hasKey: 'hookSpecificOutput', noError: true, hookEvent: 'PostToolUse' },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpRedact.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[BRAIN policy]')) return `a **-glob policy must inject for any path, got: ${JSON.stringify(r.parsed)}`;
      if (ctx.includes(GLOB_SECRET)) return `the raw secret must be REDACTED out of the injected block, got: ${ctx}`;
      return null;
    },
  },
  {
    name: 'policy-glob-inject[outside-project path→empty]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: _gpOutsidePath }, cwd: _gpOutside.cwd },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _gpOutside.dataDir, CCB_PROJECT_ID: '' }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `an out-of-project path must emit empty {} (never inject), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'policy-glob-inject[policyInject.enabled=false→empty despite match]',
    script: 'policy-glob-inject.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' }, cwd: _gpMatch.cwd },
    expect: { noError: true },
    extraEnv: () => ({
      CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ policyInject: { enabled: false } }),
      CLAUDE_PLUGIN_DATA: _gpMatch.dataDir,
      CCB_PROJECT_ID: '',
    }),
    validate: r => (r.parsed && !r.parsed.hookSpecificOutput)
      ? null : `enabled=false must emit empty {} even on a match, got: ${JSON.stringify(r.parsed)}`,
  },

  // ── PreToolUse — policy-enforce-shadow (Edit-only SILENT measurement) ──────
  {
    name: 'policy-enforce-shadow[Edit ADDS literal on matching path→SILENT {} + outcome trigger + minimal payload]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconsole.log(x);\n' }, cwd: _shTrigger.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _shTrigger.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      // (1) SILENT: shadow mode must emit {} — never a permissionDecision/additionalContext.
      if (r.parsed && r.parsed.hookSpecificOutput) return `shadow hook must be SILENT (no hookSpecificOutput), got: ${JSON.stringify(r.parsed)}`;
      const out = readShadowOutcomes(env.CLAUDE_PLUGIN_DATA, _shTrigger.cwd);
      if (out && out.skip) return null; // no sqlite backend → outcome unverifiable; silence already checked
      if (!out) return 'expected ONE policy.shadow.evaluated row, found none';
      if (out.length !== 1) return `expected exactly 1 evaluation, got ${out.length}`;
      const ev = out[0];
      // (2) outcome is NET-COUNT-INCREASE (0→1) → 'trigger'.
      if (ev.outcome !== 'trigger') return `added literal must yield outcome 'trigger', got: ${ev.outcome}`;
      if (ev.activationId !== _shTrigger.activationId) return `activationId must match the seeded policy, got: ${ev.activationId}`;
      // (3) privacy: payload must be EXACTLY {schema,activationId,outcome} — no file/snippet/literal/tool.
      const keys = Object.keys(ev).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['activationId', 'outcome', 'schema'])) return `payload must be ONLY {schema,activationId,outcome}, got keys: ${keys}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[Edit PRESERVES literal (same count)→outcome pass, not trigger]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: "console.log('a');\nconst x = 1;\n", new_string: "console.log('a');\nconst x = 2;\n" }, cwd: _shPass.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _shPass.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `shadow hook must be SILENT, got: ${JSON.stringify(r.parsed)}`;
      const out = readShadowOutcomes(env.CLAUDE_PLUGIN_DATA, _shPass.cwd);
      if (out && out.skip) return null;
      if (!out) return 'expected ONE policy.shadow.evaluated row, found none';
      // The literal is PRESERVED (count 1→1): net count did NOT increase → 'pass'. An
      // includes()-based rule would falsely fire 'trigger' here (the mutation-(a) guard).
      if (out[0].outcome !== 'pass') return `a preserved literal (1→1) must yield 'pass', got: ${out[0].outcome}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[non-matching path→SILENT {} + NO metric]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'lib/app.ts', old_string: '', new_string: 'console.log(1)\n' }, cwd: _shNoMatch.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _shNoMatch.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `must be SILENT, got: ${JSON.stringify(r.parsed)}`;
      const out = readShadowOutcomes(env.CLAUDE_PLUGIN_DATA, _shNoMatch.cwd);
      if (out && out.skip) return null;
      if (out) return `a non-matching path must record NO evaluation, got: ${JSON.stringify(out)}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[non-Edit tool (Write)→SILENT {} + NO metric]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/app.ts', content: 'console.log(1)\n' }, cwd: _shNonEdit.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _shNonEdit.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `must be SILENT, got: ${JSON.stringify(r.parsed)}`;
      const out = readShadowOutcomes(env.CLAUDE_PLUGIN_DATA, _shNonEdit.cwd);
      if (out && out.skip) return null;
      if (out) return `Write (out of the Edit-only allowlist) must record NO evaluation, got: ${JSON.stringify(out)}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[policyInject.enabled=false→SILENT {} + NO metric]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconsole.log(x);\n' }, cwd: _shDisabled.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({
      CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ policyInject: { enabled: false } }),
      CLAUDE_PLUGIN_DATA: _shDisabled.dataDir,
      CCB_PROJECT_ID: '',
    }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `disabled must emit empty {}, got: ${JSON.stringify(r.parsed)}`;
      const out = readShadowOutcomes(env.CLAUDE_PLUGIN_DATA, _shDisabled.cwd);
      if (out && out.skip) return null;
      if (out) return `enabled=false must record NO evaluation, got: ${JSON.stringify(out)}`;
      return null;
    },
  },
  // ── PreToolUse — micro-B1 OPT-IN trigger-evidence capture (still SILENT) ────
  {
    // Mutation-proof (a): the `capture.enabled === true` gate. Under the DEFAULT
    // (shipped) config capture is OFF, so a trigger must store NOTHING. Remove the
    // gate and this goes RED (evidence would be written whenever outcome==='trigger').
    name: 'policy-enforce-shadow[capture DEFAULT-OFF: a trigger writes NO evidence + stays SILENT]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconsole.log(x);\n' }, cwd: _shCapOff.cwd, session_id: SESSION },
    expect: { noError: true },
    // NO CLAUDE_PLUGIN_ROOT override → the real shipped config (captureTriggerEvidence.enabled=false).
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: _shCapOff.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `shadow hook must be SILENT, got: ${JSON.stringify(r.parsed)}`;
      const ev = readTriggerEvidence(env.CLAUDE_PLUGIN_DATA, _shCapOff.cwd);
      if (ev.length !== 0) return `capture is OFF by default — a trigger must write NO evidence, got ${ev.length}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[capture ON: a trigger writes ONE redacted evidence record + stays SILENT]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconsole.log(x);\n' }, cwd: _shCapOn.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _capOnRoot(), CLAUDE_PLUGIN_DATA: _shCapOn.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      // Capture must NEVER break the silent measurement path.
      if (r.parsed && r.parsed.hookSpecificOutput) return `capture must not break silence, got: ${JSON.stringify(r.parsed)}`;
      const ev = readTriggerEvidence(env.CLAUDE_PLUGIN_DATA, _shCapOn.cwd);
      if (ev.length !== 1) return `an opted-in trigger must write exactly ONE evidence record, got ${ev.length}`;
      const rec = ev[0];
      if (rec.activationId !== _shCapOn.activationId) return `evidence activationId must match the seeded policy, got ${rec.activationId}`;
      if (rec.file !== 'src/app.ts') return `evidence file must be the project-relative path, got ${rec.file}`;
      if (typeof rec.addedSnippet !== 'string' || !rec.addedSnippet.includes('console.log')) return `evidence snippet must hold the added (triggering) text, got ${JSON.stringify(rec.addedSnippet)}`;
      const keys = Object.keys(rec).sort().join(',');
      if (keys !== 'activationId,addedSnippet,eventId,file,sourceHash,ts') return `evidence record must hold ONLY the 6 honest fields, got ${keys}`;
      return null;
    },
  },
  {
    name: 'policy-enforce-shadow[capture ON: a PASS writes NO evidence (only triggers are captured)]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: "console.log('a');\nconst x = 1;\n", new_string: "console.log('a');\nconst x = 2;\n" }, cwd: _shCapPass.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _capOnRoot(), CLAUDE_PLUGIN_DATA: _shCapPass.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `must stay SILENT, got: ${JSON.stringify(r.parsed)}`;
      const ev = readTriggerEvidence(env.CLAUDE_PLUGIN_DATA, _shCapPass.cwd);
      if (ev.length !== 0) return `a 'pass' outcome must NOT capture evidence, got ${ev.length}`;
      return null;
    },
  },
  {
    // Mutation-proof (b): the snippet redaction. A secret in the added text must be
    // REDACTED in the stored snippet. Skip the redact() and this goes RED.
    name: 'policy-enforce-shadow[capture ON: a secret in the added text is REDACTED in the stored snippet]',
    script: 'policy-enforce-shadow.js',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', old_string: '', new_string: "console.log('x'); const k='sk-abcdefghijklmnopqrstuvwxyz012345';\n" }, cwd: _shCapSecret.cwd, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_ROOT: _capOnRoot(), CLAUDE_PLUGIN_DATA: _shCapSecret.dataDir, CCB_PROJECT_ID: '' }),
    validateWithEnv: (r, env) => {
      if (r.parsed && r.parsed.hookSpecificOutput) return `must stay SILENT, got: ${JSON.stringify(r.parsed)}`;
      const ev = readTriggerEvidence(env.CLAUDE_PLUGIN_DATA, _shCapSecret.cwd);
      if (ev.length !== 1) return `the trigger must capture one record, got ${ev.length}`;
      const snip = ev[0].addedSnippet;
      if (typeof snip !== 'string') return 'snippet missing';
      if (snip.includes('sk-abcdefghijklmnopqrstuvwxyz012345')) return 'the raw secret must be REDACTED out of the stored snippet';
      if (!snip.includes('[API_KEY]')) return `the secret must be replaced by a redaction marker, got ${JSON.stringify(snip)}`;
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
  {
    // Regression: content-surfacing curated script declaring outputLines must
    // NOT be flagged on legitimate output (35 lines < 60-line declared budget).
    // Before the fix the hardcoded 3L/500c summary budget flagged every run.
    name: 'curation-detect   [PostToolUse/curated-success-within-declared-budget→no-trigger]',
    script: 'curation-detect.js',
    payload: (() => {
      const f = require('./__fixtures__/post-tool-use-success-noisy.json');
      const projDir = mkTempProject({ shells: [{ id: 'test', script: '.vscode/scripts/test.mjs', aliases: ['npm test'], outputLines: 60 }], whitelist: [] });
      return { ...f, session_id: SESSION, cwd: projDir };
    })(),
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-det-cs-budget-')) }),
    validateWithEnv: (_r, env) => {
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const runtimeDir = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime');
      const prefix = `curation-turn-${safe}--`;
      if (!fs.existsSync(runtimeDir)) return null;
      const files = fs.readdirSync(runtimeDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
      if (files.length > 0) return `output within declared outputLines budget must not be flagged, got journal entry: ${files[0]}`;
      return null;
    },
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
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
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
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validate: r => {
      if (r.parsed?.decision !== 'block') return `expected escalated block (text-only ignore), got: ${JSON.stringify(r.parsed)}`;
      if (!(r.parsed?.reason || '').includes('[RETRY 2/3]')) return `expected [RETRY 2/3] marker, got: ${(r.parsed?.reason || '').slice(0, 200)}`;
      return null;
    },
  },
  (() => {
    // Regression (v1.19.0, observed live): the agent answers a curation block by
    // calling curation_mark_oneoff — an MCP tool, no Bash trace — and the retry
    // path kept re-blocking with the stale blockedEntries for all 3 attempts.
    // After reconciliation, a valid one-hit marking must RELEASE the retry.
    const PROJ = mkTempProject({ shells: [], whitelist: [] });
    return {
      name: 'curation-stop     [Stop→retry+one-hit-marked→release {}]',
      script: 'curation-stop.js',
      payload: { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true, cwd: PROJ },
      expect: { noError: true },
      extraEnv: () => {
        const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-oneoff-rel-'));
        const runtimeDir = path.join(tmpData, '.runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        fs.writeFileSync(
          path.join(runtimeDir, `curation-stop-${safe}.json`),
          JSON.stringify({
            attempts: 1,
            blockedSignature: 'CLAUDE_SKIP_EMBED_WARM=1 npm test 2>&1 | tail -40|',
            blockedEntries: [{ command: 'CLAUDE_SKIP_EMBED_WARM=1 npm test 2>&1 | tail -40', sig: 'npm test 2', curatedScript: null, reason: 'needs-curation', lines: 39, chars: 2572 }],
            firstBlockedAt: new Date(Date.now() - 10_000).toISOString(),
          }),
        );
        // The agent's mid-retry action: mark the blocked sig one-hit (exactly
        // what the block's reason asks for), via the real store lib.
        const oneoffLib = require('./lib/oneoff-store.js');
        const pk = oneoffLib.resolveProjectKey(PROJ);
        oneoffLib.mark(tmpData, pk, { sigs: ['npm test 2'], maxRecurrence: 3 });
        return { CLAUDE_PLUGIN_DATA: tmpData };
      },
      validateWithEnv: (r, env) => {
        if (Object.keys(r.parsed || {}).length !== 0) {
          return `expected {} (release after one-hit mark), got: ${JSON.stringify(r.parsed)}`;
        }
        // Escalation state must be cleared so the next turn starts fresh.
        const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const escPath = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime', `curation-stop-${safe}.json`);
        if (fs.existsSync(escPath)) return `escalation state should be cleared, still exists at ${escPath}`;
        return null;
      },
    };
  })(),
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
    // Regression: a CREATE block (curatedScript:null) resolved by the agent
    // registering a NEW curated alias mid-turn must be detected as progress by
    // filterUnresolved()/reconcileEntries() — not just REFINE blocks that
    // already reference a curatedScript path. Forces profile=dev (maxAttempts=3)
    // so the assertion exercises the reconciliation path itself, not the
    // standard profile's maxAttempts=1 safety-cap-relent (a different code path
    // that would also return {} for the wrong reason).
    name: 'curation-stop     [Stop→retry+CREATE-now-curated-via-alias→release {}]',
    script: 'curation-stop.js',
    payload: (() => {
      const cwd = mkTempProject({
        shells: [{ id: 'commit-overview', script: '.vscode/scripts/commit-overview.ps1', aliases: ['git show --stat HEAD'] }],
      });
      return { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true, cwd };
    })(),
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-create-curated-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({
          attempts: 1,
          blockedSignature: 'cd /x && git show --stat HEAD | tail -45|',
          blockedEntries: [{ command: 'cd /x && git show --stat HEAD | tail -45', reason: 'needs-curation', curatedScript: null }],
          firstBlockedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
      );
      // Empty journal — agent only authored+registered the script this turn.
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0
      ? null : `CREATE entry resolved by a registered alias must count as progress (release), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    // Negative guard: shells.json has no alias for the blocked command and was
    // NOT touched after the block → must still escalate, never over-release.
    name: 'curation-stop     [Stop→retry+CREATE-still-uncurated→escalated block]',
    script: 'curation-stop.js',
    payload: (() => {
      const cwd = mkTempProject({ shells: [{ id: 'other', script: '.vscode/scripts/other.ps1', aliases: ['npm run build'] }] });
      // Backdate shells.json so its mtime predates firstBlockedAt below.
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(cwd, '.vscode', 'shells.json'), old, old);
      return { hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true, cwd };
    })(),
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stop-create-uncurated-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(
        path.join(runtimeDir, `curation-stop-${safe}.json`),
        JSON.stringify({
          attempts: 1,
          blockedSignature: 'cd /x && git show --stat HEAD | tail -45|',
          blockedEntries: [{ command: 'cd /x && git show --stat HEAD | tail -45', reason: 'needs-curation', curatedScript: null }],
          firstBlockedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
      );
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validate: r => {
      if (r.parsed?.decision !== 'block') return `unresolved CREATE must still escalate, got: ${JSON.stringify(r.parsed)}`;
      if (!(r.parsed?.reason || '').includes('[RETRY 2/3]')) return `expected [RETRY 2/3] marker, got: ${(r.parsed?.reason || '').slice(0, 200)}`;
      return null;
    },
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

  // ── auto-continue-stop ────────────────────────────────────────────────────
  {
    name: 'auto-continue-stop [Stop→first-call→block+counter=1]',
    script: 'auto-continue-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-acs-blk-'));
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validateWithEnv: (r, env) => {
      if (r.parsed?.decision !== 'block') return `expected decision:'block', got: ${JSON.stringify(r.parsed)}`;
      if (!String(r.parsed?.reason || '').includes('auto-continue')) return `reason missing tag`;
      const cFile = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime', `auto-continue-${SESSION}.json`);
      if (!fs.existsSync(cFile)) return `counter file not written at ${cFile}`;
      const c = JSON.parse(fs.readFileSync(cFile, 'utf-8'));
      if (c.count !== 1) return `counter expected 1, got ${c.count}`;
      return null;
    },
  },
  {
    name: 'auto-continue-stop [Stop→already-blocked-once→release]',
    script: 'auto-continue-stop.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-acs-rel-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, `auto-continue-${SESSION}.json`), JSON.stringify({ count: 1 }));
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validateWithEnv: (r) => {
      if (Object.keys(r.parsed || {}).length !== 0) {
        return `expected release after first block, got: ${JSON.stringify(r.parsed)}`;
      }
      return null;
    },
  },

  // ── Stop dispatcher ───────────────────────────────────────────────────────
  {
    name: 'stop-dispatcher   [Stop→all-quiet→{}]',
    script: 'stop-dispatcher.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-disp-empty-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      // Neutralize the two detectors that fire from zero state:
      //   - skill-promote-trigger would spawn a detached scan → stamp it fresh.
      //   - auto-continue-stop blocks on the first Stop → pre-seed counter at cap.
      fs.writeFileSync(path.join(tmpData, '.skill-scan-last'), String(Date.now()));
      fs.writeFileSync(path.join(runtimeDir, `auto-continue-${SESSION}.json`), JSON.stringify({ count: 1 }));
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      const keys = Object.keys(r.parsed || {});
      return keys.length === 0 ? null : `expected {} (all detectors quiet), got: ${JSON.stringify(r.parsed)}`;
    },
  },
  {
    name: 'stop-dispatcher   [Stop→2 blocks→merged in priority order]',
    script: 'stop-dispatcher.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-disp-merge-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(tmpData, '.skill-scan-last'), String(Date.now()));
      // Seed one pending curation entry → curation-stop blocks (and clears the
      // journal). auto-continue-stop also blocks (fresh counter). failure-retro
      // runs first, sees the pending journal, and defers — proving the ordering.
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
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validate: r => {
      const p = r.parsed || {};
      if (p.decision !== 'block') return `expected decision:'block', got: ${JSON.stringify(p)}`;
      const reason = String(p.reason || '');
      const iCuration = reason.indexOf('npm test');
      const iAuto = reason.indexOf('[auto-continue]');
      if (iCuration < 0) return `merged reason missing curation block, got: ${reason.slice(0, 160)}`;
      if (iAuto < 0) return `merged reason missing auto-continue block, got: ${reason.slice(0, 160)}`;
      if (!reason.includes('---')) return 'expected separator between merged reasons';
      if (iCuration > iAuto) return 'priority order wrong: curation-stop must precede auto-continue';
      return null;
    },
  },
  {
    name: 'stop-dispatcher   [profile=free→passthrough→{}]',
    script: 'stop-dispatcher.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-disp-free-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      // Seed a pending curation entry that WOULD block under dev/standard — the
      // free short-circuit must skip every detector regardless.
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
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'free' }) };
    },
    validate: r => {
      const keys = Object.keys(r.parsed || {});
      return keys.length === 0 ? null : `expected {} (free passthrough), got: ${JSON.stringify(r.parsed)}`;
    },
  },

  // ── D2 verify-nudge ───────────────────────────────────────────────────────
  {
    name: 'file-edit-detect  [PostToolUse Edit→journals edit]',
    script: 'file-edit-detect.js',
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/foo.js' }, session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fed-')) }),
    validateWithEnv: (r, env) => {
      if (Object.keys(r.parsed || {}).length !== 0) return `expected {} (silent journaler), got: ${JSON.stringify(r.parsed)}`;
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const runtimeDir = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime');
      const files = fs.existsSync(runtimeDir)
        ? fs.readdirSync(runtimeDir).filter(f => f.startsWith(`turn-verify-${safe}--`) && f.endsWith('.json'))
        : [];
      if (files.length !== 1) return `expected 1 verify-journal file, got ${files.length}`;
      const entry = JSON.parse(fs.readFileSync(path.join(runtimeDir, files[0]), 'utf-8'));
      if (entry.kind !== 'edit' || entry.path !== 'src/foo.js') return `unexpected journal entry: ${JSON.stringify(entry)}`;
      return null;
    },
  },
  {
    name: 'verify-nudge      [Stop→edits+no-test→block]',
    script: 'verify-nudge.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-vn-blk-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000000-aaaaaaaa.json`),
        JSON.stringify({ ts: 1000000000000, kind: 'edit', path: 'src/a.js' }));
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000001-bbbbbbbb.json`),
        JSON.stringify({ ts: 1000000000001, kind: 'cmd', sig: 'git status', curated: null }));
      return { CLAUDE_PLUGIN_DATA: tmpData, CLAUDE_PLUGIN_ROOT: mkTempPluginRoot({ profile: 'dev' }) };
    },
    validateWithEnv: (r, env) => {
      if (r.parsed?.decision !== 'block') return `expected decision:'block', got: ${JSON.stringify(r.parsed)}`;
      if (!String(r.parsed?.reason || '').includes('[verify]')) return `reason missing [verify] tag`;
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      // Journal cleared (turn boundary) + counter bumped to 1.
      const runtimeDir = path.join(env.CLAUDE_PLUGIN_DATA, '.runtime');
      const left = fs.readdirSync(runtimeDir).filter(f => f.startsWith(`turn-verify-${safe}--`));
      if (left.length !== 0) return `verify-journal should be cleared, ${left.length} left`;
      const cFile = path.join(runtimeDir, `verify-nudge-${safe}.json`);
      if (!fs.existsSync(cFile)) return `counter file not written`;
      if (JSON.parse(fs.readFileSync(cFile, 'utf-8')).count !== 1) return `counter expected 1`;
      return null;
    },
  },
  {
    name: 'verify-nudge      [Stop→edits+test-ran→{}]',
    script: 'verify-nudge.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-vn-sup-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000000-aaaaaaaa.json`),
        JSON.stringify({ ts: 1000000000000, kind: 'edit', path: 'src/a.js' }));
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000001-bbbbbbbb.json`),
        JSON.stringify({ ts: 1000000000001, kind: 'cmd', sig: 'npm test', curated: null }));
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      return Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (test ran), got: ${JSON.stringify(r.parsed)}`;
    },
  },
  {
    name: 'verify-nudge      [Stop→edits+no-test but counter at cap→{}]',
    script: 'verify-nudge.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-vn-cap-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000000-aaaaaaaa.json`),
        JSON.stringify({ ts: 1000000000000, kind: 'edit', path: 'src/a.js' }));
      fs.writeFileSync(path.join(runtimeDir, `verify-nudge-${safe}.json`), JSON.stringify({ count: 1 }));
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      return Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (cap reached), got: ${JSON.stringify(r.parsed)}`;
    },
  },

  // ── U1 profile gating ─────────────────────────────────────────────────────
  {
    name: 'verify-nudge      [profile=standard→disabled→{}]',
    script: 'verify-nudge.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1root-vn-'));
      fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'config', 'hooks-config.json'),
        JSON.stringify({ profile: 'standard', verifyNudge: { maxBlocks: 1, testPatterns: [] } }));
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1data-vn-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      // Seed an edit with NO test → would nudge in dev; standard must suppress.
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000000-aaaaaaaa.json`),
        JSON.stringify({ ts: 1000000000000, kind: 'edit', path: 'src/a.js' }));
      return { CLAUDE_PLUGIN_ROOT: tmpRoot, CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (standard disables verify), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'pattern-detect    [profile=standard→disabled→{}]',
    script: 'pattern-detect.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1root-pd-'));
      fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'standard' }));
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1data-pd-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      // n=5 → next tick would fire in dev; standard must suppress before ticking.
      fs.writeFileSync(path.join(runtimeDir, 'pattern-detect-state.json'), JSON.stringify({ n: 5 }));
      return { CLAUDE_PLUGIN_ROOT: tmpRoot, CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (standard disables pattern), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'pattern-detect    [profile=dev+n=5→fires→block]',
    script: 'pattern-detect.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1root-pd2-'));
      fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'dev' }));
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1data-pd2-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, 'pattern-detect-state.json'), JSON.stringify({ n: 5 }));
      return { CLAUDE_PLUGIN_ROOT: tmpRoot, CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => {
      const p = r.parsed || {};
      if (p.decision !== 'block') return `expected block (dev, n=5 → 6th fires), got: ${JSON.stringify(p)}`;
      if (!String(p.reason || '').includes('capture_lesson')) return 'reason missing capture hint';
      return null;
    },
  },
  {
    name: 'correction-detect [profile=standard→ENABLED→nudge] (F1 wire)',
    script: 'correction-detect.js',
    payload: { prompt: 'nao era isso, esta errado', session_id: SESSION, transcript_path: '' },
    expect: { noError: true },
    extraEnv: () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1root-cd-'));
      fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'standard' }));
      return { CLAUDE_PLUGIN_ROOT: tmpRoot, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-u1data-cd-')) };
    },
    // F1: standard KEEPS the silent learning trigger. A corrective prompt must emit
    // the UserPromptSubmit additionalContext nudge (→ capture_lesson) and NEVER a
    // Stop block. This is the auto-learning-review wire test.
    validate: r => {
      const p = r.parsed || {};
      const hso = p.hookSpecificOutput || {};
      if (p.decision) return `must NOT emit a Stop block, got: ${JSON.stringify(p)}`;
      if (hso.hookEventName !== 'UserPromptSubmit') return `expected UserPromptSubmit nudge, got: ${JSON.stringify(p)}`;
      if (!/capture_lesson/.test(hso.additionalContext || '')) return `expected capture_lesson advisory, got: ${JSON.stringify(p)}`;
      return null;
    },
  },

  // ── D1 self-review ────────────────────────────────────────────────────────
  // NOTE: the "fires a block" path needs entries in the brain-store (not just the
  // inverted index), which can't be seeded synchronously here — it's covered by a
  // run()-level unit test in test-units.js. These E2E cases cover the {} paths.
  {
    name: 'self-review       [Stop→no edits→{}]',
    script: 'self-review.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-noedit-')) }),
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (no edits), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'self-review       [Stop→edits but no KB match→{}]',
    script: 'self-review.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => {
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-nomatch-'));
      const runtimeDir = path.join(tmpData, '.runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      fs.writeFileSync(path.join(runtimeDir, `turn-verify-${safe}--1000000000000-aaaaaaaa.json`),
        JSON.stringify({ ts: 1000000000000, kind: 'edit', path: 'scripts/zzz-unmatched.js' }));
      return { CLAUDE_PLUGIN_DATA: tmpData };
    },
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (no KB match), got: ${JSON.stringify(r.parsed)}`,
  },

  // ── U2 session-summary ────────────────────────────────────────────────────
  {
    name: 'session-summary   [Stop→no lessons→{}]',
    script: 'session-summary.js',
    payload: { hook_event_name: 'Stop', session_id: SESSION },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ss-e2e-')) }),
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (no lessons), got: ${JSON.stringify(r.parsed)}`,
  },

  // ── D3 review-checklist advisory ──────────────────────────────────────────
  {
    name: 'review-checklist-advisory [SessionStart→no checklist→{}]',
    script: 'review-checklist-advisory.js',
    payload: { hook_event_name: 'SessionStart', session_id: SESSION, cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rc-none-')) },
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rc-data-')) }),
    validate: r => Object.keys(r.parsed || {}).length === 0 ? null : `expected {} (no checklist), got: ${JSON.stringify(r.parsed)}`,
  },
  {
    name: 'review-checklist-advisory [SessionStart→checklist present→advisory]',
    script: 'review-checklist-advisory.js',
    payload: (() => {
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rc-yes-'));
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.claude', 'brain-review-checklist.md'), '# Brain review checklist\n\n- [ ] **Empty catch** (recurred 5×)\n- [ ] **Race** (recurred 3×)\n');
      return { hook_event_name: 'SessionStart', session_id: SESSION, cwd: proj };
    })(),
    expect: { noError: true },
    extraEnv: () => ({ CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rc-data2-')) }),
    validate: r => {
      const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
      if (!ctx.includes('[REVIEW]')) return `expected [REVIEW] advisory, got: ${JSON.stringify(r.parsed)}`;
      if (!ctx.includes('2 recurring lessons')) return `expected item count, got: ${ctx}`;
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
  // Isolate the per-user GLOBAL config dir (~/.claude/claude-code-boss: the active-data-dir
  // pointer + the brain/hooks/model-router user-config) BETWEEN tests. The suite shares ONE
  // temp HOME (top of file), so once any test materializes the global hooks profile (or the
  // v2.14.0 F1.5 backfill does), the `!exists` guard freezes it and every LATER test reads
  // that leaked profile instead of its own shipped one — a real order-dependent flake (e.g.
  // curation-stop reading 'standard' maxAttempts=1 instead of its configured 'dev').
  try {
    fs.rmSync(path.join(process.env.USERPROFILE, '.claude', 'claude-code-boss'), { recursive: true, force: true });
  } catch (err) { void err; /* nothing to clean yet → fine */ }
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
  // ─── curation-detect [concurrent appends → no lost entries] ────────────────
  const raceTestName = 'curation-detect   [concurrent appends→no lost entries]';
  if (!FILTER || raceTestName.toLowerCase().includes(FILTER.toLowerCase())) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-race-'));
    const N = 5;
    const fixture = require('./__fixtures__/post-tool-use-success-noisy.json');
    const { spawn } = require('child_process');

    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.resolve(SCRIPTS, '..'),
      CLAUDE_PLUGIN_DATA: dataDir,
    };

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

    const safe = SESSION.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const runtimeDir = path.join(dataDir, '.runtime');
    const prefix = `curation-turn-${safe}--`;
    const files = fs.existsSync(runtimeDir)
      ? fs.readdirSync(runtimeDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      : [];

    if (files.length === N) {
      passed++;
      console.log(`  ${GREEN('✓')} ${raceTestName}`);
    } else {
      failed++;
      console.log(`  ${RED('✗')} ${raceTestName}`);
      console.log(`      ${YELLOW('→')} expected ${N} journal files, got ${files.length}`);
    }
  }

  // ─── skill-metric [UserPromptExpansion → records skill.invoked] ─────────────
  // Validates Loop 4 contract: hook reads `command` from UserPromptExpansion
  // payload, derives skillName, and persists a `skill.invoked` row in the
  // dedicated metrics store (lib/metrics-store.js, its own DB — independent of
  // brain-store/the KB backend). Stdout-only validation can't see this — must
  // inspect the DB.
  const smTestName = 'skill-metric      [UserPromptExpansion→metrics_event row]';
  if (!FILTER || smTestName.toLowerCase().includes(FILTER.toLowerCase())) {
    const smDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-skm-'));
    const projectName = `skm-proj-${Date.now()}`;
    const projectCwd = path.join(smDataDir, projectName);
    fs.mkdirSync(projectCwd, { recursive: true });
    const skillName = 'loop';

    const r = run('skill-metric.js', {
      command: `/${skillName} 5m /foo`,
      session_id: SESSION,
      cwd: projectCwd,
    }, [], { CLAUDE_PLUGIN_DATA: smDataDir });

    let issue = null;
    if (r.status !== 0) issue = `exit code ${r.status}: ${r.stderr || ''}`;
    else if ((r.stdout || '').trim() !== '{}') issue = `stdout not "{}": ${r.stdout}`;
    else {
      const Database = require('./lib/sqlite-compat').loadSqlite();
      if (Database) {
        const dbPath = path.join(smDataDir, 'metrics', projectName, 'metrics.db');
        if (!fs.existsSync(dbPath)) issue = `metrics.db not created at ${dbPath}`;
        else {
          const db = new Database(dbPath, { readonly: true });
          const row = db.prepare(
            "SELECT event_name, payload FROM metrics_event WHERE event_name = 'skill.invoked' ORDER BY id DESC LIMIT 1",
          ).get();
          db.close();
          if (!row) issue = `no skill.invoked row in metrics_event`;
          else {
            const p = JSON.parse(row.payload || '{}');
            if (p.skillName !== skillName) issue = `skillName mismatch: got ${p.skillName}, want ${skillName}`;
          }
        }
      }
    }

    if (issue) {
      failed++;
      console.log(`  ${RED('✗')} ${smTestName}`);
      console.log(`      ${YELLOW('→')} ${issue}`);
    } else {
      passed++;
      console.log(`  ${GREEN('✓')} ${smTestName}`);
    }
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
