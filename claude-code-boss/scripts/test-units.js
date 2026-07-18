#!/usr/bin/env node
/**
 * test-units.js — pure-function unit tests for shared libraries.
 *
 * Complements test-hooks.js (which spawns full hook subprocesses).
 * Runs the modules in-process, so it's fast and easy to inspect failures.
 *
 * Coverage:
 *   - curation-classifier  (classification matrix)
 *   - lib/text-utils       (extractKeywords + STOP_WORDS)
 *   - lib/session-id       (sanitizeSessionId)
 *   - lib/hooks-config     (getters + defaults)
 *   - lib/turn-journal     (append/read/clear roundtrip)
 *   - brain-backend        (minScore regression: keyword path honors threshold)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = __dirname;
const ROOT = path.resolve(SCRIPTS, '..');

// Force a deterministic plugin root so hooks-config loads from this repo.
process.env.CLAUDE_PLUGIN_ROOT = ROOT;
// Isolate runtime artifacts.
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-units-'));

// Isolate os.homedir()-derived state (the GLOBAL dir: active-data-dir pointer +
// brain user-config) into a throwaway home for the WHOLE run. data-dir.js now
// PUBLISHES a pointer on every valid-env dataDir() call and brain-config backfills
// the user-config up to globalDir(); without this, the test run would scribble
// into — and read back from — the developer's real ~/.claude/claude-code-boss,
// hijacking a live session's backend choice. Set BOTH vars so os.homedir()
// resolves here on every platform (Windows prefers USERPROFILE, POSIX HOME).
process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-units-home-'));
process.env.HOME = process.env.USERPROFILE;

// ─── Tiny test runner ────────────────────────────────────────────────────────
const RESULTS = [];
const PENDING = [];

function test(name, fn) {
  let p;
  try {
    const maybe = fn();
    if (maybe && typeof maybe.then === 'function') {
      p = maybe.then(
        () => RESULTS.push({ name, ok: true }),
        err => RESULTS.push({ name, ok: false, err: err && err.stack || String(err) }),
      );
    } else {
      RESULTS.push({ name, ok: true });
    }
  } catch (err) {
    RESULTS.push({ name, ok: false, err: err && err.stack || String(err) });
  }
  if (p) PENDING.push(p);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'expected =='}: got ${a}, want ${e}`);
}

// Run `fn` with os.homedir() pointed at a FRESH throwaway home (both HOME and
// USERPROFILE, so it holds on every platform), restoring the prior values after.
// Needed because data-dir.js publishes an active-data-dir pointer and reads it
// back: a test asserting the bare HOME_FALLBACK must start from a home with no
// pointer, and must not inherit one written by an earlier test in the shared
// run-wide temp home. Returns whatever `fn` returns; `fn` receives the home path.
function withTempHome(fn) {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ─── curation-classifier ─────────────────────────────────────────────────────
const { classify, successBudgetFor, CURATED_SUCCESS_MAX_CHARS, CURATED_SUCCESS_MAX_LINES, CURATED_CHARS_PER_LINE } = require('./curation-classifier.js');
const TH = { maxChars: 1000, maxLines: 20 };

test('curation-classifier: uncurated small → null', () => {
  const r = classify({ command: 'ls', isCurated: false, isSuccess: true, charCount: 100, lineCount: 5, thresholds: TH });
  assertEq(r.reason, null);
});

test('curation-classifier: uncurated large chars → needs-curation', () => {
  const r = classify({ command: 'ls -R', isCurated: false, isSuccess: true, charCount: 5000, lineCount: 5, thresholds: TH });
  assertEq(r.reason, 'needs-curation');
});

test('curation-classifier: uncurated large lines → needs-curation', () => {
  const r = classify({ command: 'ls -R', isCurated: false, isSuccess: true, charCount: 100, lineCount: 50, thresholds: TH });
  assertEq(r.reason, 'needs-curation');
});

test('curation-classifier: curated success small → null', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: true, charCount: 100, lineCount: 2, thresholds: TH });
  assertEq(r.reason, null);
});

test('curation-classifier: curated success noisy (chars) → curated-success-noisy', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: true, charCount: CURATED_SUCCESS_MAX_CHARS + 1, lineCount: 1, thresholds: TH });
  assertEq(r.reason, 'curated-success-noisy');
});

test('curation-classifier: curated success noisy (lines) → curated-success-noisy', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: true, charCount: 50, lineCount: CURATED_SUCCESS_MAX_LINES + 1, thresholds: TH });
  assertEq(r.reason, 'curated-success-noisy');
});

test('curation-classifier: curated failure small → null', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: false, charCount: 50, lineCount: 2, thresholds: TH });
  assertEq(r.reason, null);
});

test('curation-classifier: curated failure noisy → curated-failure-noisy', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: false, charCount: 5000, lineCount: 5, thresholds: TH });
  assertEq(r.reason, 'curated-failure-noisy');
});

// Per-shell success budget (outputLines/outputChars from shells.json) — the
// live bug: a content-surfacing script (outputLines: 60) emitting 4L/563c was
// flagged curated-success-noisy against the hardcoded 3L/500c on every run.
test('curation-classifier: per-shell budget → legitimate content output not flagged', () => {
  const budget = successBudgetFor({ outputLines: 60 });
  const r = classify({ command: 'mine.mjs', isCurated: true, isSuccess: true, charCount: 563, lineCount: 4, thresholds: TH, successBudget: budget });
  assertEq(r.reason, null);
});

test('curation-classifier: per-shell budget exceeded → curated-success-noisy with that budget', () => {
  const budget = successBudgetFor({ outputLines: 60 });
  const r = classify({ command: 'mine.mjs', isCurated: true, isSuccess: true, charCount: 100, lineCount: 61, thresholds: TH, successBudget: budget });
  assertEq(r.reason, 'curated-success-noisy');
  assertEq(r.threshold, { maxChars: 6000, maxLines: 60 });
});

test('curation-classifier: no budget passed → default still flags 4-line curated success', () => {
  const r = classify({ command: 'cur.mjs', isCurated: true, isSuccess: true, charCount: 100, lineCount: 4, thresholds: TH });
  assertEq(r.reason, 'curated-success-noisy');
  assertEq(r.threshold, { maxChars: CURATED_SUCCESS_MAX_CHARS, maxLines: CURATED_SUCCESS_MAX_LINES });
});

test('curation-classifier: successBudgetFor without declared fields → summary defaults', () => {
  assertEq(successBudgetFor({}), { maxLines: CURATED_SUCCESS_MAX_LINES, maxChars: CURATED_SUCCESS_MAX_CHARS });
  assertEq(successBudgetFor(null), { maxLines: CURATED_SUCCESS_MAX_LINES, maxChars: CURATED_SUCCESS_MAX_CHARS });
});

test('curation-classifier: successBudgetFor derives chars from outputLines', () => {
  assertEq(successBudgetFor({ outputLines: 60 }), { maxLines: 60, maxChars: 60 * CURATED_CHARS_PER_LINE });
});

test('curation-classifier: successBudgetFor honors explicit outputChars', () => {
  assertEq(successBudgetFor({ outputLines: 60, outputChars: 2500 }), { maxLines: 60, maxChars: 2500 });
});

test('curation-classifier: successBudgetFor rejects invalid declarations', () => {
  assertEq(successBudgetFor({ outputLines: 0, outputChars: -5 }), { maxLines: CURATED_SUCCESS_MAX_LINES, maxChars: CURATED_SUCCESS_MAX_CHARS });
  assertEq(successBudgetFor({ outputLines: '60' }), { maxLines: CURATED_SUCCESS_MAX_LINES, maxChars: CURATED_SUCCESS_MAX_CHARS });
});

// ─── text-utils ──────────────────────────────────────────────────────────────
const { extractKeywords, STOP_WORDS } = require('./lib/text-utils.js');

test('text-utils: basic tokenization + lowercase', () => {
  const kw = extractKeywords('Brain RETRIEVE keyword');
  assert(kw.includes('brain'));
  assert(kw.includes('retrieve'));
  assert(kw.includes('keyword'));
});

test('text-utils: stop-words filtered', () => {
  const kw = extractKeywords('the brain has retrieve');
  assert(!kw.includes('the'));
  assert(!kw.includes('has'));
  assert(STOP_WORDS.has('the'));
});

test('text-utils: minLen honored', () => {
  const kw = extractKeywords('go run build', { minLen: 4 });
  assert(!kw.includes('go'));
  assert(!kw.includes('run'));
  assert(kw.includes('build'));
});

test('text-utils: allowPath=false strips slashes/dots', () => {
  const kw = extractKeywords('src/lib/foo.js bar', { allowPath: false });
  assert(!kw.some(w => w.includes('/')));
  assert(!kw.some(w => w.includes('.')));
});

test('text-utils: allowPath=true preserves paths', () => {
  const kw = extractKeywords('open src/lib/foo.js fast', { allowPath: true });
  assert(kw.some(w => w.includes('/') || w.includes('.')));
});

test('text-utils: empty input → []', () => {
  assertEq(extractKeywords(''), []);
  assertEq(extractKeywords(null), []);
});

test('text-utils: maxTokens cap', () => {
  const kw = extractKeywords('alpha beta gamma delta epsilon zeta', { maxTokens: 3 });
  assert(kw.length <= 3);
});

// ─── session-id ──────────────────────────────────────────────────────────────
const { sanitizeSessionId } = require('./lib/session-id.js');

test('session-id: null → default', () => {
  assertEq(sanitizeSessionId(null), 'default');
  assertEq(sanitizeSessionId(undefined), 'default');
});

test('session-id: normal uuid passes through', () => {
  assertEq(sanitizeSessionId('abc-123_DEF'), 'abc-123_DEF');
});

test('session-id: path traversal sanitized', () => {
  const out = sanitizeSessionId('../../etc/passwd');
  assert(!out.includes('/'));
  assert(!out.includes('.'));
});

test('session-id: max 64 chars', () => {
  const out = sanitizeSessionId('x'.repeat(200));
  assert(out.length === 64, `got len ${out.length}`);
});

test('session-id: non-string coerced', () => {
  assertEq(sanitizeSessionId(42), '42');
});

// ─── hooks-config ────────────────────────────────────────────────────────────
const hooksConfig = require('./lib/hooks-config.js');

test('hooks-config: getCurationStop defaults', () => {
  const cs = hooksConfig.getCurationStop();
  assert(typeof cs.enabled === 'boolean');
  assert(Number.isInteger(cs.maxAttempts) && cs.maxAttempts > 0);
});

test('hooks-config: getCuration returns object', () => {
  const c = hooksConfig.getCuration();
  assert(c && typeof c === 'object');
});

// ─── hooks-config: profiles (U1) ─────────────────────────────────────────────
test('hooks-config.resolveProfileConfig: dev preset is empty (behavior untouched)', () => {
  const r = hooksConfig.resolveProfileConfig({ curationStop: { enabled: true } });
  // No standard delta → maxAttempts stays absent (getter default 3 applies).
  assertEq(r.curationStop.maxAttempts, undefined);
  assertEq(r.patternDetect, undefined);
});

test('hooks-config.resolveProfileConfig: standard applies the full delta', () => {
  const r = hooksConfig.resolveProfileConfig({ profile: 'standard', curationStop: { enabled: true } });
  assertEq(r.curationStop.maxAttempts, 1);
  assertEq(r.curationStop.enabled, true);            // file value preserved
  assertEq(r.patternDetect.enabled, false);
  assert(r.correctionDetect === undefined, 'correction-detect is no longer forced off by standard (silent learning stays ON)');
  assertEq(r.decisionScan.enabled, false);
  assertEq(r.verifyNudge.enabled, false);
});

test('hooks-config.resolveProfileConfig: explicit file value beats preset (override wins)', () => {
  const r = hooksConfig.resolveProfileConfig({ profile: 'standard', verifyNudge: { enabled: true }, curationStop: { maxAttempts: 5 } });
  assertEq(r.verifyNudge.enabled, true);
  assertEq(r.curationStop.maxAttempts, 5);
});

test('hooks-config.resolveProfileConfig: unknown profile falls back to dev', () => {
  const r = hooksConfig.resolveProfileConfig({ profile: 'bogus' });
  assertEq(r.patternDetect, undefined); // no standard delta
});

test('hooks-config.resolveProfileConfig: non-object input tolerated', () => {
  assert(hooksConfig.resolveProfileConfig(null) && typeof hooksConfig.resolveProfileConfig(null) === 'object');
});

test('hooks-config.resolveProfileConfig: result never aliases PROFILE_PRESETS (pure)', () => {
  const r = hooksConfig.resolveProfileConfig({ profile: 'standard' });
  r.patternDetect.enabled = true; // mutate the returned "pure" result
  // Shared preset must be untouched → a fresh resolve still reports disabled.
  assertEq(hooksConfig.resolveProfileConfig({ profile: 'standard' }).patternDetect.enabled, false);
  assertEq(hooksConfig.PROFILE_PRESETS.standard.patternDetect.enabled, false);
});

// Getter-level resolution via a temp CLAUDE_PLUGIN_ROOT + fresh module instance.
// CLAUDE_PLUGIN_DATA and HOME/USERPROFILE are repointed at the same temp dir so a
// stray real user override (globalDir()/hooks/user-config.json — now home-based —
// or a legacy DATA_DIR/hooks one) never leaks into these shipped-config assertions.
function withHooksConfigFile(obj, fn) {
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hcfg-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'hooks-config.json'), JSON.stringify(obj));
  process.env.CLAUDE_PLUGIN_ROOT = dir;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.HOME = dir;          // isolate globalDir() so no real user override leaks in
  process.env.USERPROFILE = dir;   // (Windows homedir source)
  delete require.cache[require.resolve('./lib/hooks-config.js')];
  const hc = require('./lib/hooks-config.js');
  try { return fn(hc); }
  finally {
    process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
    if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedData;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    delete require.cache[require.resolve('./lib/hooks-config.js')];
  }
}

test('hooks-config getters: dev profile → all detectors enabled, maxAttempts=3', () => {
  withHooksConfigFile({ profile: 'dev', curationStop: { enabled: true }, verifyNudge: { maxBlocks: 1, testPatterns: [] } }, (hc) => {
    assertEq(hc.getProfile(), 'dev');
    assertEq(hc.getCurationStop().maxAttempts, 3);
    assertEq(hc.getVerifyNudge().enabled, true);
    assertEq(hc.getPatternDetect().enabled, true);
    assertEq(hc.getCorrectionDetect().enabled, true);
    assertEq(hc.getDecisionScan().enabled, true);
  });
});

test('hooks-config getters: standard profile → capture/verify off, maxAttempts=1', () => {
  withHooksConfigFile({ profile: 'standard', verifyNudge: { maxBlocks: 1, testPatterns: [] } }, (hc) => {
    assertEq(hc.getProfile(), 'standard');
    assertEq(hc.getCurationStop().enabled, true);      // the one soft block stays
    assertEq(hc.getCurationStop().maxAttempts, 1);
    assertEq(hc.getVerifyNudge().enabled, false);
    assertEq(hc.getPatternDetect().enabled, false);
    assertEq(hc.getCorrectionDetect().enabled, true);   // F1: silent learning trigger STAYS ON in standard
    assertEq(hc.getDecisionScan().enabled, false);       // still off until F1b (deferred surface)
    // newly profile-gated Stop blockers → silent in standard
    assertEq(hc.getRefineResearch().enabled, false);
    assertEq(hc.getFailureRetro().enabled, false);
    assertEq(hc.getResearchFollowup().enabled, false);
    assertEq(hc.getAutoContinue().enabled, false);
    // session-summary stays (1x/session positive) in standard
    assertEq(hc.getSessionSummary().enabled, true);
  });
});

test('hooks-config getters: dev profile → newly gated blockers all enabled', () => {
  withHooksConfigFile({ profile: 'dev' }, (hc) => {
    assertEq(hc.getRefineResearch().enabled, true);
    assertEq(hc.getFailureRetro().enabled, true);
    assertEq(hc.getResearchFollowup().enabled, true);
    assertEq(hc.getAutoContinue().enabled, true);
    assertEq(hc.getSessionSummary().enabled, true);
    // thresholds preserved from getter defaults
    assertEq(hc.getFailureRetro().minFailures, 2);
    assertEq(hc.getAutoContinue().maxBlocks, 1);
  });
});

test('F1: standard KEEPS the silent learning trigger (correction-detect) ON — auto-learning is the soul', () => {
  // The `standard` profile must stay QUIET (no Stop-block nags) WITHOUT killing
  // capture. correction-detect is a SILENT UserPromptSubmit additionalContext
  // injection (invisible to the user) — the #1 learning trigger. Silencing it made
  // `standard` stop learning (the reported regression). It stays ON; the truly
  // interruptive nudges remain OFF.
  withHooksConfigFile({ profile: 'standard' }, (hc) => {
    assertEq(hc.getCorrectionDetect().enabled, true);
    assertEq(hc.getPatternDetect().enabled, false);
    assertEq(hc.getFailureRetro().enabled, false);
    assertEq(hc.getAutoContinue().enabled, false);
  });
});

test('hooks-config getters: free profile → EVERYTHING off (passthrough)', () => {
  withHooksConfigFile({ profile: 'free' }, (hc) => {
    assertEq(hc.getProfile(), 'free');
    assertEq(hc.getCurationStop().enabled, false);
    assertEq(hc.getVerifyNudge().enabled, false);
    assertEq(hc.getPatternDetect().enabled, false);
    assertEq(hc.getCorrectionDetect().enabled, false);
    assertEq(hc.getDecisionScan().enabled, false);
    assertEq(hc.getSelfReview().enabled, false);
    assertEq(hc.getRefineResearch().enabled, false);
    assertEq(hc.getFailureRetro().enabled, false);
    assertEq(hc.getResearchFollowup().enabled, false);
    assertEq(hc.getAutoContinue().enabled, false);
    assertEq(hc.getSessionSummary().enabled, false);
  });
});

test('hooks-config: resolveProfileConfig free preset disables curationStop + sessionSummary', () => {
  const r = hooksConfig.resolveProfileConfig({ profile: 'free' });
  assertEq(r.curationStop.enabled, false);
  assertEq(r.sessionSummary.enabled, false);
  assertEq(r.refineResearch.enabled, false);
});

test('hooks-config: profileNames lists dev/standard/free', () => {
  const names = hooksConfig.profileNames();
  assert(names.includes('dev') && names.includes('standard') && names.includes('free'),
    `expected dev/standard/free, got ${names.join(',')}`);
});

test('hooks-config: GLOBAL user-config overrides shipped profile (update-safe)', () => {
  withTempHome((home) => {
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hcfg-ovr-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    // shipped says standard...
    fs.writeFileSync(path.join(dir, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'standard' }));
    // ...the GLOBAL user-config says dev → user wins, surviving BOTH shipped updates
    // AND data-folder switches (it lives at globalDir()/hooks, not under DATA_DIR).
    const gp = path.join(home, '.claude', 'claude-code-boss', 'hooks', 'user-config.json');
    fs.mkdirSync(path.dirname(gp), { recursive: true });
    fs.writeFileSync(gp, JSON.stringify({ profile: 'dev' }));
    process.env.CLAUDE_PLUGIN_ROOT = dir;
    process.env.CLAUDE_PLUGIN_DATA = dir;
    delete require.cache[require.resolve('./lib/hooks-config.js')];
    const hc = require('./lib/hooks-config.js');
    try {
      assertEq(hc.getProfile(), 'dev');
      assertEq(hc.getRefineResearch().enabled, true); // dev turns the blockers back on
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
      delete require.cache[require.resolve('./lib/hooks-config.js')];
    }
  });
});

test('hooks-config: saveProfile writes the GLOBAL override; invalid name throws', () => {
  withTempHome((home) => {
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hcfg-save-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'dev' }));
    process.env.CLAUDE_PLUGIN_ROOT = dir;
    process.env.CLAUDE_PLUGIN_DATA = dir;
    delete require.cache[require.resolve('./lib/hooks-config.js')];
    const hc = require('./lib/hooks-config.js');
    try {
      const p = hc.saveProfile('free');
      // saveProfile persists to the STABLE GLOBAL path, not the volatile data dir.
      assertEq(p, path.join(home, '.claude', 'claude-code-boss', 'hooks', 'user-config.json'));
      assert(fs.existsSync(p), 'user-config not written');
      assertEq(JSON.parse(fs.readFileSync(p, 'utf-8')).profile, 'free');
      assertEq(hc.getProfile(), 'free'); // cache reset inside saveProfile
      let threw = false;
      try { hc.saveProfile('nope'); } catch { threw = true; }
      assert(threw, 'saveProfile should throw on invalid name');
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
      delete require.cache[require.resolve('./lib/hooks-config.js')];
    }
  });
});

test('hooks-config getters: shipped config is valid standard (regression)', () => {
  // The shipped default profile is 'standard' (quiet/net-positive for normal use):
  // dev-only capture/verify nudges are off and curation blocks once (maxAttempts=1).
  assertEq(hooksConfig.getProfile(), 'standard');
  assertEq(hooksConfig.getCurationStop().maxAttempts, 1);
  assertEq(hooksConfig.getVerifyNudge().enabled, false);
});

// ─── hook-io.emitStopBlock (Stop wire shape) ─────────────────────────────────
// Both Claude Code and VS Code Copilot Chat require Stop hooks to use the
// top-level {decision, reason} shape. Nested hookSpecificOutput is rejected
// by Copilot Chat's schema validator (only valid for PreToolUse /
// UserPromptSubmit / PostToolUse).

function captureStopBlock(reason) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    require('./lib/hook-io.js').emitStopBlock(reason);
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join(''));
}

test('hook-io.emitStopBlock: emits top-level {decision,reason}', () => {
  const out = captureStopBlock('do the thing');
  assertEq(out, { decision: 'block', reason: 'do the thing' });
});

test('hook-io.emitStopBlock: never nests under hookSpecificOutput', () => {
  const out = captureStopBlock('x');
  assert(out.hookSpecificOutput === undefined,
    `Stop must NOT use hookSpecificOutput envelope (Copilot Chat rejects it); got: ${JSON.stringify(out)}`);
});

// ─── turn-journal ────────────────────────────────────────────────────────────
const turnJournal = require('./lib/turn-journal.js');

test('turn-journal: append + read roundtrip', () => {
  const sid = 'unit-test-rw-' + Date.now();
  turnJournal.appendEntry(sid, { command: 'echo a', reason: 'needs-curation' });
  turnJournal.appendEntry(sid, { command: 'echo b', reason: 'needs-curation' });
  const entries = turnJournal.readEntries(sid);
  assert(entries.length === 2, `expected 2, got ${entries.length}`);
  assertEq(entries.map(e => e.command).sort(), ['echo a', 'echo b']);
  turnJournal.clearEntries(sid);
  assertEq(turnJournal.readEntries(sid), []);
});

test('turn-journal: dedup by (command,reason)', async () => {
  const sid = 'unit-test-dedup-' + Date.now();
  turnJournal.appendEntry(sid, { command: 'echo x', reason: 'needs-curation', metric: 1 });
  // Ensure the second entry's timestamp+rand sorts strictly after the first
  // (Date.now ms granularity → two appends in the same tick could tie).
  await new Promise(r => setTimeout(r, 5));
  turnJournal.appendEntry(sid, { command: 'echo x', reason: 'needs-curation', metric: 2 });
  const entries = turnJournal.readEntries(sid);
  assertEq(entries.length, 1);
  assertEq(entries[0].metric, 2, 'later entry wins on dedup');
  turnJournal.clearEntries(sid);
});

test('turn-journal: legacy single-file format readable', () => {
  const sid = 'unit-test-legacy';
  const safe = sid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const runtimeDir = path.join(process.env.CLAUDE_PLUGIN_DATA, '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const legacy = path.join(runtimeDir, `curation-turn-${safe}.json`);
  fs.writeFileSync(legacy, JSON.stringify({ entries: [{ command: 'legacy', reason: 'needs-curation' }] }));
  const entries = turnJournal.readEntries(sid);
  assert(entries.some(e => e.command === 'legacy'), 'legacy entry not surfaced');
  turnJournal.clearEntries(sid);
  assert(!fs.existsSync(legacy), 'clearEntries should remove legacy file');
});

// ─── brain-backend (minScore regression) ─────────────────────────────────────
test('brain-backend: keyword path applies minScore threshold', async () => {
  // Use a fresh project dir to avoid touching real KB.
  const projectKey = 'unit-test-' + Date.now();

  // brain-store reads CLAUDE_PLUGIN_DATA at module load — reset cache + env.
  delete require.cache[require.resolve('./brain-store.js')];
  delete require.cache[require.resolve('./brain-index.js')];
  delete require.cache[require.resolve('./brain-graph.js')];
  delete require.cache[require.resolve('./brain-embedder.js')];
  delete require.cache[require.resolve('./brain-backend.js')];
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bb-'));

  const backend = require('./brain-backend.js');
  try {
    await backend.init({ mode: 'local', project: projectKey });
  } catch (err) {
    throw new Error(`backend.init failed: ${err.message}`);
  }

  const baseEntry = {
    type: 'note',
    tags: [],
    confidence: 0.8,
    source: { kind: 'test' },
  };

  try {
    await backend.save({
      ...baseEntry,
      id: 'high-score-entry',
      title: 'alpha alpha alpha xenoblastic',
      summary: 'alpha alpha alpha xenoblastic',
      content: { text: 'alpha alpha alpha xenoblastic' },
    });
    await backend.save({
      ...baseEntry,
      id: 'low-score-entry',
      title: 'unrelated topic',
      summary: 'mentions alpha exactly once amid many other words',
      content: { text: 'mentions alpha exactly once amid many other words zeta omega gamma' },
    });
  } catch (err) {
    throw new Error(`backend.save failed: ${err.message}`);
  }

  // Query has 2 distinct keywords; high entry matches both (score 1.0),
  // low entry matches only 'alpha' (score 0.5). minScore 0.6 excludes low.
  const high = await backend.search('alpha xenoblastic', { topK: 10, minScore: 0.6 });
  assert(Array.isArray(high), 'search must return array');
  assert(
    !high.some(r => r && r.id === 'low-score-entry'),
    `low-score entry leaked past minScore filter (got: ${JSON.stringify(high.map(r => ({ id: r && r.id, score: r && r.score })))})`,
  );

  // Sanity: search with minScore 0 should return at least one.
  const all = await backend.search('alpha xenoblastic', { topK: 10, minScore: 0 });
  assert(all.length >= 1, `baseline search returned ${all.length} results`);

  await backend.close();
});

// Brain-backend is a module singleton and the runner awaits async tests
// concurrently — two in-process tests mutating the singleton + process.env race.
// Run each brain scenario in an isolated child process (synchronous → no race).
function runBrainScenario(script) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-brain-'));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: tmp, CLAUDE_PLUGIN_ROOT: ROOT };
  const body = `const backend=require(${JSON.stringify(path.join(SCRIPTS, 'brain-backend.js'))});`
    + `const assert=(c,m)=>{if(!c){console.error('FAIL: '+m);process.exit(1)}};`
    + `(async()=>{try{${script};process.exit(0)}catch(e){console.error(e&&e.stack||e);process.exit(1)}})();`;
  try {
    require('child_process').execFileSync(process.execPath, ['-e', body], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (e) {
    throw new Error((e.stderr && e.stderr.toString().trim()) || e.message);
  }
}

test('SP6 brain-backend saveLocal: entry persists + is retrievable without an embedder (durability)', () => {
  // Sprint-3 C1 durability: a cold/failed embedder must NOT lose the entry — it's
  // saved WITHOUT a vector (a later brain-reembed backfills) and keyword search
  // still finds it. The test embedder is cold, so this exercises the no-vector path.
  // skipEmbedder:true deterministically forces the no-vector path (no model
  // load / network) so this really exercises the cold-embedder durability path.
  runBrainScenario(`
    await backend.init({project:'dur',skipEmbedder:true});
    const id = await backend.save({type:'note',tags:['xylophone'],confidence:0.8,source:{kind:'test'},title:'quokka xylophone',summary:'quokka xylophone',content:{text:'quokka xylophone'}});
    assert(id,'save must return an id');
    const r = await backend.search('quokka xylophone',{topK:5,minScore:0});
    assert(r.some(x=>x&&x.id===id),'saved entry must be retrievable (persisted despite no embedder)');
    await backend.close();
  `);
});

test('SP6 brain-backend project switch: close+reinit re-scopes with no leak or null-deref (C2/B)', () => {
  // The realistic contract behind Sprint-3 C2 (close() resets _useSqlite/_useJson/
  // _initialized) and B (project isolation): init(A) → init(B) tears down A and
  // re-scopes. Flags must reset (no _useSqlite=true+_db=null null-deref), B must not
  // see A's entries, and switching back to A must reload A's data from disk.
  runBrainScenario(`
    const E={type:'note',tags:[],confidence:0.8,source:{kind:'test'}};
    await backend.init({project:'projA',skipEmbedder:true});
    await backend.save({...E,id:'a1',title:'apple apple',summary:'apple apple',content:{text:'apple apple'}});
    await backend.init({project:'projB',skipEmbedder:true});
    const bView = await backend.search('apple apple',{topK:5,minScore:0});
    assert(!bView.some(r=>r&&r.id==='a1'),'projA entry must NOT leak into projB (isolation)');
    await backend.save({...E,id:'b1',title:'banana banana',summary:'banana banana',content:{text:'banana banana'}});
    await backend.init({project:'projA',skipEmbedder:true});
    const aView = await backend.search('apple apple',{topK:5,minScore:0});
    assert(aView.some(r=>r&&r.id==='a1'),'projA entry must survive the round-trip (close reset flags, reinit reloaded)');
    assert(!aView.some(r=>r&&r.id==='b1'),'projB entry must not leak into projA');
    await backend.close();
  `);
});

test('SP6 brain daemon requestAllowed: origin guard (DNS-rebinding) + token auth', async () => {
  const fileUrl = require('url').pathToFileURL(
    path.join(ROOT, 'servers', 'brain-server', 'lib', 'daemon-common.js'),
  ).href;
  const { requestAllowed } = await import(fileUrl);
  const TOKEN = 'secret-token-123'; // 16 chars
  // Foreign origin → 403 (DNS-rebinding guard) even with the right token.
  const foreign = requestAllowed({ headers: { origin: 'http://evil.example.com', 'x-brain-token': TOKEN } }, TOKEN, '/d');
  assertEq(foreign.ok, false); assertEq(foreign.code, 403);
  // Loopback origin + correct token → allowed.
  const ok = requestAllowed({ headers: { origin: 'http://127.0.0.1:9111', 'x-brain-token': TOKEN } }, TOKEN, '/d');
  assertEq(ok.ok, true);
  // Same-length WRONG token → 401.
  const bad = requestAllowed({ headers: { origin: 'http://localhost:9111', 'x-brain-token': 'wrong-token-1234' } }, TOKEN, '/d');
  assertEq(bad.ok, false); assertEq(bad.code, 401);
  // No Origin header (native/curl client) + correct token → allowed.
  const noOrigin = requestAllowed({ headers: { 'x-brain-token': TOKEN } }, TOKEN, '/d');
  assertEq(noOrigin.ok, true);
});

// ─── MCP HTTP (StreamableHTTP) transport + remote mappings ───────────────────
const http = require('http');

/** Start a fake daemon mimicking the /mcp contract; returns {url, port, seen, close}. */
function startFakeDaemon(opts = {}) {
  const seen = { initProjectId: null, initHadSession: false, toolsListSession: null, callSession: null, callArgs: null };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'healthy', version: opts.version || '9.9.9' }));
    }
    if (req.method === 'DELETE' && req.url === '/mcp') { res.writeHead(200); return res.end(); }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg = {}; try { msg = JSON.parse(body); } catch (err) { console.error('fake parse', err.message); }
        const sid = req.headers['mcp-session-id'] || null;
        if (msg.method === 'initialize') {
          seen.initProjectId = msg.params && msg.params.projectId;
          seen.initHadSession = !!sid;
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123', 'MCP-Protocol-Version': '2025-06-18' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '9.9.9' }, capabilities: {} } }));
        }
        if (msg.method === 'notifications/initialized') { res.writeHead(204); return res.end(); }
        if (msg.method === 'tools/list') {
          seen.toolsListSession = sid;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'add_document' }, { name: 'search_memory' }] } }));
        }
        if (msg.method === 'tools/call') {
          seen.callSession = sid;
          seen.callArgs = msg.params;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const result = (typeof opts.toolResult === 'function')
            ? opts.toolResult(msg.params)
            : { content: [{ type: 'text', text: 'OK:' + (msg.params && msg.params.name) }] };
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        }
        res.writeHead(400); return res.end('bad');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('mcp-client http: handshake captures session + stamps projectId + echoes session id', async () => {
  const McpClient = require('./mcp-client.js');
  const daemon = await startFakeDaemon();
  try {
    const c = new McpClient({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    assert(c.isConnected(), 'should be connected');
    assertEq(c._sessionId, 'sess-123');
    assertEq(daemon.seen.initProjectId, 'P1');
    assert(!daemon.seen.initHadSession, 'initialize must NOT carry a session id');
    assertEq(daemon.seen.toolsListSession, 'sess-123');
    const r = await c.callTool('search_memory', { query: 'x' });
    assertEq(r.text, 'OK:search_memory');
    assertEq(daemon.seen.callSession, 'sess-123');
    assertEq(daemon.seen.callArgs.arguments.query, 'x');
    c.close();
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    await daemon.close();
  }
});

test('mcp-client: hasToolAvailable() reflects tools/list (fail-loud guard for compose_recall)', () => {
  const McpClient = require('./mcp-client.js');
  const c = new McpClient({ transport: 'http', serverUrl: 'http://127.0.0.1:1', projectId: 'P' });
  // Before handshake it must be SAFE (no throw) and report nothing available.
  assertEq(typeof c.hasToolAvailable, 'function');
  assertEq(c.hasToolAvailable('compose_recall'), false);
  // After a handshake populates the advertised tool list:
  c._availableTools = ['search_memory', 'compose_recall', 'ingest_conversation'];
  assertEq(c.hasToolAvailable('compose_recall'), true);
  assertEq(c.hasToolAvailable('ingest_conversation'), true);
  assertEq(c.hasToolAvailable('nope'), false);
  assertEq(c.hasToolAvailable(''), false);
  assertEq(c.hasToolAvailable(), false);
});

test('brain-backend: needsReinit() re-scopes on explicit project change (cross-project leak guard)', () => {
  const { needsReinit } = require('./brain-backend.js').__testHooks;
  assertEq(typeof needsReinit, 'function');
  // Not initialized → never reinit.
  assertEq(needsReinit({ initialized: false, mode: 'mcp-memory', project: 'A' }, 'B'), false);
  // Same project → no-op (no churn on repeated same-project init).
  assertEq(needsReinit({ initialized: true, mode: 'mcp-memory', project: 'A' }, 'A'), false);
  // Different explicit project → MUST reinit (the leak the gate found in brain-backend.js:410).
  assertEq(needsReinit({ initialized: true, mode: 'mcp-memory', project: 'A' }, 'B'), true);
  assertEq(needsReinit({ initialized: true, mode: 'local', project: 'A' }, 'B'), true);
  // No explicit project (undefined/empty) → never clobber the current scope.
  assertEq(needsReinit({ initialized: true, mode: 'mcp-memory', project: 'A' }, undefined), false);
  assertEq(needsReinit({ initialized: true, mode: 'mcp-memory', project: 'A' }, ''), false);
});

test('brain-backend mcp: init() re-handshakes on project change (BLOCKING-B leak fix)', async () => {
  const daemon = await startFakeDaemon();
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  backend.__testHooks._injectConfig({ backend: { type: 'mcp-memory', mcpMemory: { transport: 'http', serverUrl: daemon.url } } });
  try {
    await backend.init({ project: 'projA' });
    assertEq(daemon.seen.initProjectId, 'projA');
    // Second session, DIFFERENT project → must re-handshake scoped to projB.
    daemon.seen.initProjectId = null;
    await backend.init({ project: 'projB' });
    assertEq(daemon.seen.initProjectId, 'projB');
    // Same project again → NO re-handshake (no churn).
    daemon.seen.initProjectId = null;
    await backend.init({ project: 'projB' });
    assertEq(daemon.seen.initProjectId, null);
    await backend.close();
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
    await daemon.close();
  }
});

test('brain-backend compose: parseComposeEnvelope splits facts(text)/capabilities(pointers), excludes invalidated, derives title (DH4)', () => {
  const { parseComposeEnvelope } = require('./brain-backend.js').__testHooks;
  const envelope = { text: JSON.stringify({
    query: 'q',
    blocks: [
      { block: 'procedural', scope: 'home', items: [{ id: 'p1', name: null, description: null, type: 'procedural', score: 0.9, text: 'restart the pod then flush cache' }] },
      { block: 'skill_global', scope: 'home', items: [{ id: 'sg1', name: 'global-skill', description: 'a global skill', type: 'skill', score: 0.8 }] },
      { block: 'knowledge', scope: 'projA', items: [
        { id: 'k1', name: null, description: null, type: 'knowledge', score: 0.87, text: 'the deploy runbook lives here' },
        { id: 'k2', name: 'named', description: 'd', type: 'knowledge', score: 0.5, text: 'x', lifecycleState: { status: 'invalidated' } },
      ] },
      { block: 'skill', scope: 'projA', items: [{ id: 's1', name: 'rollback', description: 'rollback a release', type: 'skill', score: 0.7 }] },
      { block: 'setup', scope: 'projA', items: [{ id: 'setup1', name: 'setup-x', description: 'project setup', type: 'setup', score: 0.6 }] },
    ],
  }) };
  const { facts, capabilities, entries } = parseComposeEnvelope(envelope);
  // FACTS = procedural + knowledge(k1); k2 excluded (invalidated); title derived from text when name=null (DH4).
  assertEq(facts.length, 2);
  assertEq(facts[0].id, 'p1');
  assert(facts[0].title && facts[0].title.indexOf('restart') === 0, `title derived from text, got "${facts[0].title}"`);
  assertEq(facts[0].text, 'restart the pod then flush cache');
  assertEq(facts[1].id, 'k1');
  assert(facts.every(f => f.id !== 'k2'), 'invalidated k2 must be excluded');
  // CAPABILITIES = skill_global + skill + setup (pointers, no text).
  assertEq(capabilities.map(c => c.id).sort(), ['s1', 'setup1', 'sg1']);
  assert(capabilities.every(c => c.text === undefined), 'capabilities are pointers (no text)');
  // entries mirror facts for retrieval telemetry (% cited) — every one has a usable title.
  assertEq(entries.length, 2);
  assert(entries.every(e => e.title && e.title.length > 0), 'every fact entry has a usable title (DH4 fix)');
});

test('brain-backend mcp: ingestConversation ships raw transcript to ingest_conversation (consumerId/session/raw)', async () => {
  const daemon = await startFakeDaemon();
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  backend.__testHooks._injectConfig({ backend: { type: 'mcp-memory', mcpMemory: { transport: 'http', serverUrl: daemon.url } } });
  try {
    await backend.init({ project: 'projX' });
    await backend.ingestConversation('raw-jsonl-here', { sessionId: 'sessX' });
    assertEq(daemon.seen.callArgs.name, 'ingest_conversation');
    assertEq(daemon.seen.callArgs.arguments.consumerId, 'claude-code-boss');
    assertEq(daemon.seen.callArgs.arguments.sessionId, 'sessX');
    assertEq(daemon.seen.callArgs.arguments.raw, 'raw-jsonl-here');
    await backend.close();
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
    await daemon.close();
  }
});

test('brain-backend mcp: saveMcp REJECTS on a tool-level isError (no fabricated uuid → no phantom capture)', async () => {
  const daemon = await startFakeDaemon({ toolResult: (p) => p.name === 'add_document'
    ? { isError: true, content: [{ type: 'text', text: 'add_document failed: disk full' }] }
    : { content: [{ type: 'text', text: 'OK:' + (p && p.name) }] } });
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  backend.__testHooks._injectConfig({ backend: { type: 'mcp-memory', mcpMemory: { transport: 'http', serverUrl: daemon.url } } });
  try {
    await backend.init({ project: 'projErr' });
    let threw = false;
    try {
      await backend.save({ title: 't', summary: 's', content: { detail: 'd' }, type: 'lesson' });
    } catch (err) {
      threw = true;
      assert(/add_document|failed|isError/i.test(err.message), `error surfaces the tool failure, got: ${err.message}`);
    }
    // Without the fix, saveMcp returns parseAddedId(errResult) || uuid() → a FABRICATED
    // id → resolves as success → the remote capture_lesson path acks 'captured' → the
    // Stop reconcile drains cycles that were never stored (silent lesson loss).
    assert(threw, 'a failed remote add_document MUST reject (not fabricate a uuid and resolve)');
    await backend.close();
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
    await daemon.close();
  }
});
test('brain-backend mcp: warmPool fires home-federated search_memory (includeHome:true) for graduation signal', async () => {
  const daemon = await startFakeDaemon();
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  backend.__testHooks._injectConfig({ backend: { type: 'mcp-memory', mcpMemory: { transport: 'http', serverUrl: daemon.url } } });
  try {
    await backend.init({ project: 'projW' });
    await backend.warmPool('deploy runbook', { topK: 7 });
    assertEq(daemon.seen.callArgs.name, 'search_memory');
    assertEq(daemon.seen.callArgs.arguments.query, 'deploy runbook');
    assertEq(daemon.seen.callArgs.arguments.includeHome, true);
    assertEq(daemon.seen.callArgs.arguments.topK, 7);
    await backend.close();
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
    await daemon.close();
  }
});

test('brain-backend: warmPool off the mcp-memory backend → no-op (compose/pool are server capabilities)', async () => {
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  try {
    // No init → _mode is not 'mcp-memory' → warmPool must short-circuit without any MCP/store call.
    assertEq(await backend.warmPool('x'), []);
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
  }
});

test('brain-backend __testHooks: MCP-tool mappings match the real daemon contract', () => {
  const h = require('./brain-backend.js').__testHooks;
  // add_document returns plain text "Document added with ID: <uuid>"
  assertEq(h.parseAddedId({ text: 'Document added with ID: de2d91b3-08f4-4129-95e7-27292c75cf8e' }), 'de2d91b3-08f4-4129-95e7-27292c75cf8e');
  assertEq(h.parseAddedId({ text: 'no id here' }), '');
  // search_memory returns an OBJECT {results:[...]} — not a bare array
  const sr = h.parseSearchResults({ text: JSON.stringify({ results: [{ text: 'hello', score: 0.9, documentId: 'd1' }] }) });
  assertEq(sr.length, 1);
  assertEq(sr[0].documentId, 'd1');
  assertEq(h.parseSearchResults({ text: JSON.stringify([{ documentId: 'a' }]) }).length, 1);
  // content packing + result normalization (no metadata in search hits → derive)
  assertEq(h.entryToContent({ title: 'T', summary: 'S', content: { detail: 'D' } }), 'T\n\nS\n\nD');
  const item = h.normalizeSearchItem({ text: 'hello world', score: 0.5, documentId: 'd2' });
  assertEq(item.id, 'd2');
  assertEq(item.summary, 'hello world');
  assertEq(item.type, 'memory');
  assertEq(h.deriveTitle('first line\nsecond line'), 'first line');
});

test('config-testers: mcp-memory http mode probes the daemon /health', async () => {
  const tester = require('./config-testers/mcp-memory.js');
  const daemon = await startFakeDaemon({ version: '2.10.1' });
  try {
    const ok = await tester.test({ transport: 'http', serverUrl: daemon.url });
    assert(ok.ok, `remote health should pass: ${ok.error || ''}`);
    assertEq(ok.details.daemonVersion, '2.10.1');
    const bad = await tester.test({ transport: 'http', serverUrl: '', runDir: path.join(os.tmpdir(), 'no-daemon-' + Date.now()) });
    assert(!bad.ok, 'missing daemon should fail');
  } finally {
    await daemon.close();
  }
});

// ─── decision-detect (regex extractors + heuristic) ─────────────────────────
const dd = require('./decision-detect.js');


test('decision-detect: extractCommitMsg — -m "..."', () => {
  const out = dd.extractCommitMsg('git commit -m "feat(x): use foo over bar because perf"');
  assertEq(out, 'feat(x): use foo over bar because perf');
});

test('decision-detect: extractCommitMsg — -m \'...\'', () => {
  const out = dd.extractCommitMsg("git commit -m 'fix: typo'");
  assertEq(out, 'fix: typo');
});

test('decision-detect: extractCommitMsg — --message=...', () => {
  const out = dd.extractCommitMsg('git commit --message="chore: bump"');
  assertEq(out, 'chore: bump');
});

test('decision-detect: extractCommitMsg — heredoc', () => {
  const cmd = "git commit -m \"$(cat <<'EOF'\nfeat(brain): swap voyage for v4\n\nbecause v3 is paid\nEOF\n)\"";
  const out = dd.extractCommitMsg(cmd);
  assert(out.startsWith('feat(brain): swap voyage for v4'), 'heredoc body extracted');
  assert(out.includes('because v3 is paid'), 'heredoc preserves rationale');
});

test('decision-detect: extractCommitMsg — non-git returns null', () => {
  assertEq(dd.extractCommitMsg('ls -la'), null);
});

test('decision-detect: extractPrBody — --body "..."', () => {
  const out = dd.extractPrBody('gh pr create --title "x" --body "we picked X over Y because perf"');
  assertEq(out, 'we picked X over Y because perf');
});

test('decision-detect: extractPrBody — heredoc', () => {
  const cmd = "gh pr edit 12 --body \"$(cat <<'EOF'\n## Summary\n\nWe adopted X instead of Y.\nEOF\n)\"";
  const out = dd.extractPrBody(cmd);
  assert(out.includes('adopted X instead of Y'), 'pr heredoc extracted');
});

test('decision-detect: looksLikeDecision — verb of choice', () => {
  assert(dd.looksLikeDecision('we chose redis over memcached'), 'verb of choice');
});

test('decision-detect: looksLikeDecision — rationale connector', () => {
  assert(dd.looksLikeDecision('refactored the module because tests were brittle'), 'rationale connector');
});

test('decision-detect: looksLikeDecision — pt-BR verb', () => {
  assert(dd.looksLikeDecision('trocamos voyage por v4 em vez de v3'), 'pt-BR verb of choice + connector');
});

test('decision-detect: looksLikeDecision — multi-paragraph body', () => {
  const body = 'feat: refactor\n\nsome reasoning line one\nsome reasoning line two\nthird thought';
  assert(dd.looksLikeDecision(body), 'multi-paragraph >=3 non-empty lines');
});

test('decision-detect: looksLikeDecision — trivial chore rejected', () => {
  assert(!dd.looksLikeDecision('chore: bump version'), 'no choice verb, no rationale, single line → false');
  assert(!dd.looksLikeDecision('fix typo'), 'trivial fix rejected');
});

// ─── config-testers (registry + per-domain) ──────────────────────────────────
const testers = require('./config-testers');

test('config-testers: registry lists all 4 domains', () => {
  const list = testers.list();
  for (const d of ['embedder', 'mcp-memory', 'curation', 'hooks']) {
    assert(list.includes(d), `missing domain: ${d}`);
  }
});

test('config-testers: unknown domain returns ok=false', async () => {
  const out = await testers.run('unknown-domain-xyz', {});
  assert(out.ok === false, 'should be false');
  assert(/Unknown domain/.test(out.error), `expected "Unknown domain" got: ${out.error}`);
});

test('config-testers: embedder rejects invalid provider', async () => {
  const out = await testers.run('embedder', { provider: 'bogus', model: 'x' });
  assert(out.ok === false, 'should be false');
  assert(/Invalid provider/.test(out.error), `expected "Invalid provider" got: ${out.error}`);
});

test('config-testers: embedder requires model', async () => {
  const out = await testers.run('embedder', { provider: 'transformers', model: '' });
  assert(out.ok === false, 'should be false');
  assert(/Model is required/.test(out.error), `expected "Model is required" got: ${out.error}`);
});

test('config-testers: mcp-memory rejects nonexistent jar', async () => {
  const out = await testers.run('mcp-memory', { jarPath: '/nonexistent/path/to.jar' });
  assert(out.ok === false, 'should be false');
  assert(/JAR file not found/.test(out.error), `expected "JAR file not found" got: ${out.error}`);
});

test('config-testers: mcp-memory rejects empty jar and empty url', async () => {
  const out = await testers.run('mcp-memory', { jarPath: '', downloadUrl: '' });
  assert(out.ok === false, 'should be false');
  assert(/downloadUrl is empty|empty/.test(out.error), `expected empty-url err got: ${out.error}`);
});

test('config-testers: mcp-memory rejects non-JAR file (no PK magic)', async () => {
  const tmp = path.join(process.env.CLAUDE_PLUGIN_DATA, 'not-a-jar.jar');
  fs.writeFileSync(tmp, 'hello world this is not a jar');
  const out = await testers.run('mcp-memory', { jarPath: tmp });
  assert(out.ok === false, 'should be false');
  assert(/not a valid JAR/.test(out.error), `expected "not a valid JAR" got: ${out.error}`);
});

test('config-testers: curation resolves valid paths', async () => {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const scriptsDir = path.join(dataDir, 'scripts');
  const shellsCfg = path.join(dataDir, 'shells.json');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'foo.mjs'), '// test');
  fs.writeFileSync(shellsCfg, JSON.stringify({ shells: [{ id: 'x', command: 'echo' }] }));
  const out = await testers.run('curation', { cwd: dataDir, scriptsDir: 'scripts', shellsConfigPath: 'shells.json' });
  assert(out.ok === true, `expected ok=true, got ${JSON.stringify(out)}`);
  assert(out.details.scriptCount === 1, `expected 1 script, got ${out.details.scriptCount}`);
  assert(out.details.shellCount === 1, `expected 1 shell, got ${out.details.shellCount}`);
});

test('config-testers: curation rejects invalid JSON in shells', async () => {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const shellsCfg = path.join(dataDir, 'shells-bad.json');
  fs.writeFileSync(shellsCfg, '{ not: valid json ');
  const out = await testers.run('curation', { cwd: dataDir, shellsConfigPath: 'shells-bad.json' });
  assert(out.ok === false, 'should be false');
  assert(/invalid JSON/.test(out.error), `expected "invalid JSON" got: ${out.error}`);
});

test('config-testers: hooks validates this repo hooks.json (all green)', async () => {
  const out = await testers.run('hooks', { hooksRoot: ROOT });
  assert(out.ok === true, `expected ok=true, got: ${out.error || ''} (missing=${out.details?.missing?.length}, syntaxErrors=${out.details?.syntaxErrors?.length})`);
  assert(out.details.checked > 5, `expected >5 hooks, got ${out.details.checked}`);
  assert(out.details.missing.length === 0, `unexpected missing: ${JSON.stringify(out.details.missing)}`);
});

test('config-testers: hooks reports missing script', async () => {
  const fakeCfg = { hooks: { SessionStart: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/does-not-exist.js"' }] }] } };
  const out = await testers.run('hooks', { hooksRoot: ROOT, hooksConfig: fakeCfg });
  assert(out.ok === false, 'should be false');
  assert(out.details.missing.length === 1, `expected 1 missing, got ${out.details.missing.length}`);
});

test('config-testers: hooks parses exec form (command:node + args)', async () => {
  const okCfg = { hooks: { SessionStart: [{ hooks: [{ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/brain-health.js'] }] }] } };
  const okOut = await testers.run('hooks', { hooksRoot: ROOT, hooksConfig: okCfg });
  assert(okOut.ok === true, `exec form valid script should pass, got: ${okOut.error || ''}`);
  assert(okOut.details.invalidCommands.length === 0, `exec form should be parseable, got ${JSON.stringify(okOut.details.invalidCommands)}`);

  const missCfg = { hooks: { SessionStart: [{ hooks: [{ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/does-not-exist.js'] }] }] } };
  const missOut = await testers.run('hooks', { hooksRoot: ROOT, hooksConfig: missCfg });
  assert(missOut.ok === false, 'exec form missing script should fail');
  assert(missOut.details.missing.length === 1, `expected 1 missing, got ${missOut.details.missing.length}`);
});

// ─── project-snapshot (formatter + parsers) ──────────────────────────────────
const snap = require('./project-snapshot.js');

test('project-snapshot: parseGhJson handles valid array', () => {
  const v = snap.parseGhJson('[{"a":1}]');
  assert(Array.isArray(v) && v[0].a === 1, `expected parsed array, got ${JSON.stringify(v)}`);
});

test('project-snapshot: parseGhJson returns null on garbage', () => {
  assert(snap.parseGhJson('not json') === null, 'should be null');
  assert(snap.parseGhJson('') === null, 'empty should be null');
});

test('project-snapshot: format returns empty string when no data', () => {
  assert(snap.formatSnapshot({ local: null, gh: null }) === '', 'empty inputs → empty');
  assert(snap.formatSnapshot({ local: {}, gh: null }) === '', 'empty local + no gh → empty (no useful fields)');
});

test('project-snapshot: format renders branch + age', () => {
  const md = snap.formatSnapshot({ local: { branch: 'main', branchAgeDays: 3, ahead: 0, behind: 0, dirtyOld: [], stashCount: 0 }, gh: null });
  assert(/Project snapshot/.test(md), 'has header');
  assert(/main \(tip 3d old\)/.test(md), `expected branch+age, got: ${md}`);
  assert(!/Stashes/.test(md), 'should omit stash section when 0');
  assert(!/vs main/.test(md), 'should omit ahead/behind when both 0');
});

test('project-snapshot: format renders ahead/behind only when non-zero', () => {
  const md = snap.formatSnapshot({ local: { branch: 'feat/x', branchAgeDays: 1, ahead: 2, behind: 5, dirtyOld: [], stashCount: 0 }, gh: null });
  assert(/vs main:\*\* 2 ahead, 5 behind/.test(md), `expected vs main, got: ${md}`);
});

test('project-snapshot: format truncates dirty file list at max', () => {
  const dirty = Array.from({ length: 8 }, (_, i) => ({ file: `f${i}.js`, ageDays: 30 - i }));
  const md = snap.formatSnapshot({ local: { branch: 'x', branchAgeDays: 0, ahead: 0, behind: 0, dirtyOld: dirty, stashCount: 0 }, gh: null, max: 3 });
  assert(/\+5 more/.test(md), `expected "+5 more" tail, got: ${md}`);
});

test('project-snapshot: format renders CI status icons', () => {
  const ok = snap.formatSnapshot({ local: null, gh: { lastCi: { conclusion: 'success', workflowName: 'CI', headBranch: 'main', createdAt: new Date().toISOString() }, openPRs: null, reviewRequests: null } });
  assert(/✓ CI on main/.test(ok), `expected success icon, got: ${ok}`);
  const fail = snap.formatSnapshot({ local: null, gh: { lastCi: { conclusion: 'failure', workflowName: 'CI', headBranch: 'main', createdAt: new Date().toISOString() }, openPRs: null, reviewRequests: null } });
  assert(/✗ CI/.test(fail), `expected failure icon, got: ${fail}`);
});

test('project-snapshot: format flags draft PRs', () => {
  const md = snap.formatSnapshot({ local: null, gh: { openPRs: [{ number: 87, title: 'wip', isDraft: true }], lastCi: null, reviewRequests: null } });
  assert(/#87\(draft\) wip/.test(md), `expected draft tag, got: ${md}`);
});

test('project-snapshot: format hard-caps total length', () => {
  const huge = Array.from({ length: 200 }, (_, i) => ({ file: `path/to/some/file${i}.tsx`, ageDays: i }));
  const md = snap.formatSnapshot({ local: { branch: 'x', branchAgeDays: 0, ahead: 0, behind: 0, dirtyOld: huge, stashCount: 0 }, gh: null, max: 200 });
  assert(md.length <= 1400, `expected <=1400, got ${md.length}`);
});

test('project-snapshot: relTime sane formatting', () => {
  assert(snap.relTime(null) === '?', 'null → ?');
  assert(snap.relTime(new Date().toISOString()) === 'now', `expected "now", got ${snap.relTime(new Date().toISOString())}`);
  const t = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  assert(snap.relTime(t) === '3h ago', `expected "3h ago", got ${snap.relTime(t)}`);
});

// ─── failure-detect + failure-retro (loop detection) ─────────────────────────
const fdetect = require('./failure-detect.js');
const fretro = require('./failure-retro.js');
const fjournal = require('./lib/failure-journal.js');
const cooldownStore = require('./lib/cooldown-store.js');

test('failure-detect: normalizeCmd strips timestamps and SHAs', () => {
  const a = fdetect.normalizeCmd('git log --since 1733433600');
  assert(a.includes('<TS>'), `expected <TS>, got ${a}`);
  const b = fdetect.normalizeCmd('git checkout 4407bcf28a');
  assert(b.includes('<SHA>'), `expected <SHA>, got ${b}`);
});

test('failure-detect: normalizeCmd caps length + collapses whitespace', () => {
  const long = 'x'.repeat(500);
  const out = fdetect.normalizeCmd(long);
  assert(out.length === 200, `expected 200, got ${out.length}`);
  assert(fdetect.normalizeCmd('a   b\n\tc') === 'a b c', 'whitespace collapse');
});

test('failure-detect: parseExitCode reads leading Exit code N', () => {
  assert(fdetect.parseExitCode('Exit code 137\nKilled') === 137);
  assert(fdetect.parseExitCode('no exit here') === null);
});

test('failure-detect: extractTarget pulls command then file_path', () => {
  assertEq(fdetect.extractTarget({ command: 'npm test' }), 'npm test');
  assertEq(fdetect.extractTarget({ file_path: '/x/y.ts' }), '/x/y.ts');
  assertEq(fdetect.extractTarget(null), '');
});

test('failure-detect: buildEntry shape', () => {
  const ev = { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nfoo', duration_ms: 42 };
  const e = fdetect.buildEntry(ev);
  assertEq(e.tool, 'Bash');
  assertEq(e.cmd, 'npm test');
  assertEq(e.exitCode, 1);
  assert(e.snippet === 'foo', `snippet=${e.snippet}`);
  assert(e.duration === 42, 'duration kept');
  assert(Number.isFinite(e.ts), 'ts set');
});

test('failure-retro: 1 failure → no trigger', () => {
  const entries = [{ ts: Date.now(), tool: 'Bash', cmd: 'npm test', exitCode: 1 }];
  const trig = fretro.evaluateTriggers(entries, { minFailures: 2, timeWindowMin: 10, consecutiveThreshold: 3 });
  assert(trig.length === 0, `expected 0, got ${trig.length}`);
});

test('failure-retro: same cmd 2x within window → repeated trigger', () => {
  const now = Date.now();
  const entries = [
    { ts: now - 60000, tool: 'Bash', cmd: 'npm test', exitCode: 1 },
    { ts: now, tool: 'Bash', cmd: 'npm test', exitCode: 1 },
  ];
  const trig = fretro.evaluateTriggers(entries, { minFailures: 2, timeWindowMin: 10, consecutiveThreshold: 3 }, now);
  assert(trig.some(t => t.kind === 'repeated'), `expected repeated, got ${JSON.stringify(trig.map(x => x.kind))}`);
});

test('failure-retro: failures outside window ignored', () => {
  const now = Date.now();
  const entries = [
    { ts: now - 30 * 60 * 1000, tool: 'Bash', cmd: 'npm test', exitCode: 1 },
    { ts: now - 25 * 60 * 1000, tool: 'Bash', cmd: 'npm test', exitCode: 1 },
  ];
  const trig = fretro.evaluateTriggers(entries, { minFailures: 2, timeWindowMin: 10, consecutiveThreshold: 3 }, now);
  assert(trig.length === 0, `expected 0, got ${trig.length}`);
});

test('failure-retro: 3 different failures → consecutive trigger', () => {
  const now = Date.now();
  const entries = [
    { ts: now - 3000, tool: 'Bash', cmd: 'a', exitCode: 1 },
    { ts: now - 2000, tool: 'Bash', cmd: 'b', exitCode: 2 },
    { ts: now - 1000, tool: 'Bash', cmd: 'c', exitCode: 3 },
  ];
  const trig = fretro.evaluateTriggers(entries, { minFailures: 5, timeWindowMin: 10, consecutiveThreshold: 3 }, now);
  assert(trig.some(t => t.kind === 'consecutive'), `expected consecutive, got ${JSON.stringify(trig.map(x => x.kind))}`);
});

test('failure-retro: buildRetroPrompt has 4 numbered steps', () => {
  const trig = [{ kind: 'repeated', key: 'k', group: [{ tool: 'Bash', cmd: 'npm test', exitCode: 1, ts: Date.now() }] }];
  const md = fretro.buildRetroPrompt(trig);
  assert(md.includes('1. '), '1.');
  assert(md.includes('2. '), '2.');
  assert(md.includes('3. '), '3.');
  assert(md.includes('4. '), '4.');
  assert(md.includes('capture_lesson'), 'mentions capture_lesson');
});

test('cooldown-store: has/add roundtrip + isolation', () => {
  const sid = `cooltest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  assert(!cooldownStore.has(sid, 'k1'), 'fresh has nothing');
  cooldownStore.add(sid, 'k1');
  assert(cooldownStore.has(sid, 'k1'), 'add registered');
  assert(!cooldownStore.has(sid, 'k2'), 'k2 still absent');
  cooldownStore.clear(sid);
  assert(!cooldownStore.has(sid, 'k1'), 'clear wiped');
});

test('failure-journal: append + read roundtrip', () => {
  const sid = `fjtest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  fjournal.appendEntry(sid, { ts: 1, tool: 'Bash', cmd: 'a', exitCode: 1 });
  fjournal.appendEntry(sid, { ts: 2, tool: 'Bash', cmd: 'b', exitCode: 2 });
  const all = fjournal.readEntries(sid);
  assert(all.length === 2, `expected 2 entries, got ${all.length}`);
  fjournal.clearEntries(sid);
  assert(fjournal.readEntries(sid).length === 0, 'clear wiped');
});

// ─── retrieval-feedback (Plan #1) ────────────────────────────────────────────
const rfeedback = require('./retrieval-feedback.js');
const rjournal = require('./lib/retrieval-journal.js');
const brainStore = require('./brain-store.js');

test('retrieval-feedback: titleTokens dedupes + drops short/stopwords', () => {
  const t = rfeedback.titleTokens('The The local install via install-local takes effect');
  assert(t.length === new Set(t).size, 'tokens deduped');
  for (const tok of t) assert(tok.length >= 4, `token "${tok}" too short`);
  assert(t.includes('install'), 'kept "install"');
});

test('retrieval-feedback: citationMatch — 2 token matches → cited', () => {
  const title = 'Local install via install-local takes effect immediately';
  const reply = 'I just ran install-local — it took effect for the hooks immediately.';
  const m = rfeedback.citationMatch(title, reply);
  assert(m.cited === true, `expected cited, got ${JSON.stringify(m)}`);
});

test('retrieval-feedback: citationMatch — 1 token only → not cited', () => {
  const title = 'Local install via install-local takes effect immediately';
  const reply = 'Some generic mention of install but nothing else relevant.';
  const m = rfeedback.citationMatch(title, reply);
  // "install" is the only distinctive token shared; should NOT trigger citation
  assert(m.cited === false, `expected not cited, got ${JSON.stringify(m)}`);
});

test('retrieval-feedback: citationMatch — paraphrase via long substring → cited', () => {
  const title = 'Pre-paint inline script for localStorage theme to avoid FOUC';
  const reply = 'Use a pre-paint inline script for localStorage to dodge the flash.';
  const m = rfeedback.citationMatch(title, reply);
  assert(m.cited === true, `expected cited via substring, got ${JSON.stringify(m)}`);
});

test('retrieval-feedback: findCitations dedupes ids across retrievals', () => {
  const journal = [
    { returnedIds: ['id-a', 'id-b'], returnedTitles: ['Local install via install-local takes effect immediately', 'Pre-paint inline script for localStorage theme'] },
    { returnedIds: ['id-a'], returnedTitles: ['Local install via install-local takes effect immediately'] },
  ];
  const reply = 'I ran install-local and it took effect for the hooks immediately. Also the pre-paint inline script for localStorage tip is gold.';
  const out = rfeedback.findCitations(journal, reply);
  const ids = out.map(c => c.id).sort();
  assertEq(ids, ['id-a', 'id-b']);
});

test('retrieval-feedback: extractAssistantText handles array + string content', () => {
  assertEq(
    rfeedback.extractAssistantText({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'there' }] } }),
    'hi there',
  );
  assertEq(
    rfeedback.extractAssistantText({ role: 'assistant', content: 'plain' }),
    'plain',
  );
  assertEq(
    rfeedback.extractAssistantText({ role: 'user', content: 'nope' }),
    '',
  );
});

test('retrieval-feedback: extractUserText pulls user turns, skips tool_result + assistant', () => {
  assertEq(
    rfeedback.extractUserText({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'faça' }, { type: 'text', text: 'X' }] } }),
    'faça X',
  );
  assertEq(rfeedback.extractUserText({ role: 'user', content: 'oi' }), 'oi');
  // tool_result blocks are tool output echoed as a "user" turn — not the human.
  assertEq(
    rfeedback.extractUserText({ role: 'user', content: [{ type: 'tool_result', text: 'output' }] }),
    '',
  );
  assertEq(rfeedback.extractUserText({ role: 'assistant', content: 'nope' }), '');
});

test('retrieval-journal: append + read + clear roundtrip', () => {
  const sid = `rjtest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  rjournal.appendEntry(sid, { retrievalId: 'r1', returnedIds: ['x'], returnedTitles: ['T'] });
  rjournal.appendEntry(sid, { retrievalId: 'r2', returnedIds: ['y'], returnedTitles: ['U'] });
  const all = rjournal.readEntries(sid);
  assert(all.length === 2, `expected 2 entries, got ${all.length}`);
  rjournal.clearEntries(sid);
  assert(rjournal.readEntries(sid).length === 0, 'clear wiped');
});

test('brain-store: citationMultiplier monotonic + capped', () => {
  const cfg = { enabled: true, alpha: 0.1, cap: 1.5 };
  const m0 = brainStore.citationMultiplier(0, cfg);
  const m1 = brainStore.citationMultiplier(1, cfg);
  const m10 = brainStore.citationMultiplier(10, cfg);
  const m1000 = brainStore.citationMultiplier(1000, cfg);
  assert(m0 === 1, `m0=${m0}`);
  assert(m1 > m0, 'mono 0→1');
  assert(m10 > m1, 'mono 1→10');
  assert(m1000 <= 1.5, `cap respected, got ${m1000}`);
});

test('brain-store: citationMultiplier disabled returns 1', () => {
  assertEq(brainStore.citationMultiplier(999, { enabled: false }), 1);
  assertEq(brainStore.citationMultiplier(999, null), 1);
});

test('brain-store: recordCitation persists + bumps when SQLite available', async () => {
  // Isolate from other brain-* tests: fresh module + fresh data dir (same
  // pattern as the brain-backend test below, to avoid races on _db / _project).
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-cite-'));
  const isolatedStore = require('./brain-store.js');
  try {
    await isolatedStore.init({ project: 'ccb-units-citation' });
    if (isolatedStore.getStorageType() !== 'sqlite') {
      // JSON fallback: recordCitation is a no-op by design; just verify it doesn't throw.
      assertEq(isolatedStore.recordCitation('nonexistent'), 0);
      return;
    }
    const id = `cite-test-${Date.now()}`;
    await isolatedStore.save({
      id, type: 'lesson', title: 'T', summary: 'S',
      content: { text: 'x' }, tags: [], confidence: 0.5,
    });
    const c1 = isolatedStore.recordCitation(id);
    const c2 = isolatedStore.recordCitation(id);
    assert(c1 === 1, `first bump → 1, got ${c1}`);
    assert(c2 === 2, `second bump → 2, got ${c2}`);
    // missing id is a safe noop
    assertEq(isolatedStore.recordCitation('does-not-exist'), 0);
  } finally {
    try { await isolatedStore.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

// ─── active-research-detect (Plan #4) ────────────────────────────────────────
const ardetect = require('./active-research-detect.js');
const arstate = require('./lib/active-research-state.js');

test('active-research: detectSignals — libMention fires for known lib', () => {
  const sigs = ardetect.detectSignals('How do I configure Stripe webhooks?', ardetect.DEFAULTS.triggers);
  const kinds = sigs.map(s => s.kind).sort();
  // stripe → libMention; "webhooks" → integrationMention
  assert(kinds.includes('libMention'), `expected libMention, got ${kinds.join(',')}`);
  assert(kinds.includes('integrationMention'), `expected integrationMention, got ${kinds.join(',')}`);
});

test('active-research: detectSignals — neutral prompt → 0 signals', () => {
  const sigs = ardetect.detectSignals('rename function getCwd to getCurrentWorkingDirectory', ardetect.DEFAULTS.triggers);
  assertEq(sigs.length, 0);
});

test('active-research: detectSignals — bestPracticeAsk', () => {
  const sigs = ardetect.detectSignals('what is the best way to handle errors here?', ardetect.DEFAULTS.triggers);
  assert(sigs.some(s => s.kind === 'bestPracticeAsk'), 'bestPracticeAsk expected');
});

test('active-research: detectSignals — versionMention', () => {
  const sigs = ardetect.detectSignals('upgrade to next.js v15.0.0', ardetect.DEFAULTS.triggers);
  const kinds = sigs.map(s => s.kind);
  assert(kinds.includes('versionMention'), `expected versionMention, got ${kinds}`);
  assert(kinds.includes('libMention'), `expected libMention (next.js), got ${kinds}`);
});

test('active-research: shouldFire — libMention (1.0) alone passes threshold', () => {
  assert(ardetect.shouldFire([{ kind: 'libMention', weight: 1.0 }]) === true);
});

test('active-research: shouldFire — bestPractice alone (0.7) below threshold', () => {
  assert(ardetect.shouldFire([{ kind: 'bestPracticeAsk', weight: 0.7 }]) === false);
});

test('active-research: shouldFire — best+integration (0.7+0.8=1.5) passes', () => {
  assert(ardetect.shouldFire([
    { kind: 'bestPracticeAsk', weight: 0.7 },
    { kind: 'integrationMention', weight: 0.8 },
  ]) === true);
});

test('active-research: normalizeQuery — strips code/url, lowercases, caps 120', () => {
  const long = 'How do I integrate Stripe `webhooks` with my app? See https://stripe.com/docs. Also more.';
  const q = ardetect.normalizeQuery(long);
  assert(q.length <= 120, `len=${q.length}`);
  assert(!q.includes('https://'), 'url stripped');
  assert(!q.includes('`'), 'backticks stripped');
  assert(q === q.toLowerCase(), 'lowercased');
  assert(q.includes('stripe'), 'kept stripe');
});

test('active-research: normalizeQuery — takes first sentence only', () => {
  const q = ardetect.normalizeQuery('First sentence. Second one with lib stripe.');
  assertEq(q, 'first sentence');
});

test('active-research: lib regex word-boundary — "next month" not matched as next.js', () => {
  const sigs = ardetect.detectSignals('see you next month at the conference', ardetect.DEFAULTS.triggers);
  const libs = sigs.filter(s => s.kind === 'libMention');
  assertEq(libs.length, 0);
});

test('active-research-state: recordFire bumps count + cooldown applies', () => {
  arstate.resetForTests();
  const sid = `arstest-${Date.now()}`;
  assertEq(arstate.getSessionCount(sid), 0);
  arstate.recordFire(sid, 'how do i use stripe');
  assertEq(arstate.getSessionCount(sid), 1);
  assert(arstate.isCoolingDown('how do i use stripe', 60_000) === true, 'cooldown active');
  assert(arstate.isCoolingDown('different query', 60_000) === false, 'other query not cooled');
  arstate.recordFire(sid, 'another query');
  assertEq(arstate.getSessionCount(sid), 2);
  arstate.resetForTests();
});

// ─── metrics (Plan #5 — lib/metrics-store.js, independent of brain-store/KB backend) ──

test('metrics-store: recordMetric inserts + getMetricsSummary aggregates', () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-'));
  const isolated = require('./lib/metrics-store.js');
  try {
    if (!isolated.init({ project: 'ccb-units-metrics' })) {
      assertEq(isolated.recordMetric('retrieve.fired', { x: 1 }, 'sid'), 0);
      return;
    }
    const id1 = isolated.recordMetric('retrieve.fired', { topScore: 0.5 }, 'sid-a');
    const id2 = isolated.recordMetric('retrieve.fired', { topScore: 0.7 }, 'sid-a');
    const id3 = isolated.recordMetric('retrieve.cited', { entryId: 'x' }, 'sid-a');
    assert(id1 > 0 && id2 > id1 && id3 > id2, `ids should be increasing, got ${id1},${id2},${id3}`);

    const summary = isolated.getMetricsSummary(7);
    assertEq(summary.totals['retrieve.fired'], 2);
    assertEq(summary.totals['retrieve.cited'], 1);
    assert(Array.isArray(summary.daily) && summary.daily.length >= 1, 'daily rows present');
  } finally {
    isolated.close();
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics-store: recordMetric rejects invalid event names', () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-bad-'));
  const isolated = require('./lib/metrics-store.js');
  try {
    if (!isolated.init({ project: 'ccb-units-metrics-bad' })) return;
    assertEq(isolated.recordMetric('', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('UPPER.case', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('1starts.with.digit', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('has spaces', {}, 'sid'), 0);
    assert(isolated.recordMetric('valid.name_ok-1', {}, 'sid') > 0, 'valid name accepted');
  } finally {
    isolated.close();
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics-store: getEventLogIsolated reads another project\'s DB without touching the singleton', () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-iso-'));
  const isolated = require('./lib/metrics-store.js');
  try {
    // Write a metric into '__user__' project's own DB.
    if (!isolated.init({ project: '__user__' })) return;
    isolated.recordMetric('lesson.captured', { type: 'research' }, null);
    isolated.close();

    // Re-init the SAME module instance to a DIFFERENT project — this is what
    // a Stop detector's metricsStore.init({project: currentProject}) leaves in
    // place. (No require-cache dance: STORE_DIR is read once at require time
    // from CLAUDE_PLUGIN_DATA, so re-requiring under a concurrently-mutated
    // env var — other tests run interleaved via Promise.all — would race;
    // reusing the instance and switching project via init() does not.)
    if (!isolated.init({ project: 'other-proj' })) return;

    // The singleton's own getEventLog must NOT see the __user__ event.
    assertEq(isolated.getEventLog({ eventName: 'lesson.captured', limit: 50 }).length, 0);

    // getEventLogIsolated reads the __user__ DB directly, singleton untouched.
    const rows = isolated.getEventLogIsolated('__user__', { eventName: 'lesson.captured', limit: 50 });
    assertEq(rows.length, 1);
    assertEq(rows[0].payload.type, 'research');
  } finally {
    isolated.close();
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics-store: getEventLog filters + caps to 500', () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-log-'));
  const isolated = require('./lib/metrics-store.js');
  try {
    if (!isolated.init({ project: 'ccb-units-metrics-log' })) return;
    for (let i = 0; i < 5; i++) isolated.recordMetric('retrieve.fired', { i }, 'sid');
    for (let i = 0; i < 3; i++) isolated.recordMetric('failure.retro.fired', { i }, 'sid');
    const all = isolated.getEventLog({ limit: 50 });
    assertEq(all.length, 8);
    const filtered = isolated.getEventLog({ eventName: 'retrieve.fired', limit: 50 });
    assertEq(filtered.length, 5);
    const capped = isolated.getEventLog({ limit: 99999 });
    assert(capped.length <= 500, `cap applied, got ${capped.length}`);
  } finally {
    isolated.close();
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics-store: cleanupMetrics deletes rows older than cutoff', () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-cleanup-'));
  const isolated = require('./lib/metrics-store.js');
  try {
    if (!isolated.init({ project: 'ccb-units-metrics-cleanup' })) return;
    // Insert 3 fresh rows, then manually backdate two of them to >40d ago.
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(isolated.recordMetric('retrieve.fired', { i }, 'sid'));
    const db = isolated._getDbForTests();
    const oldTs = Date.now() - 40 * 86400_000;
    db.prepare(`UPDATE metrics_event SET ts = ? WHERE id IN (?, ?)`).run(oldTs, ids[0], ids[1]);
    const deleted = isolated.cleanupMetrics(30);
    assertEq(deleted, 2);
    const remaining = isolated.getEventLog({ limit: 50 });
    assertEq(remaining.length, 1);
  } finally {
    isolated.close();
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

// ─── Plan #7 — scope sanitizer + two-pass retrieval helpers ─────────────────

test('scope: inferDefaultScope routes by type then by tag hints', () => {
  const { inferDefaultScope } = require('./lib/scope-sanitizer.js');
  assertEq(inferDefaultScope('decision', []), 'project');
  assertEq(inferDefaultScope('code', []), 'project');
  assertEq(inferDefaultScope('reference', []), 'user');
  assertEq(inferDefaultScope('research', []), 'user');
  assertEq(inferDefaultScope('lesson', []), 'project');
  assertEq(inferDefaultScope('lesson', ['workflow']), 'user');
  assertEq(inferDefaultScope('lesson', ['Token-Efficiency']), 'user');
  assertEq(inferDefaultScope('pattern', ['agent-behavior']), 'user');
  assertEq(inferDefaultScope('note', ['some-random-tag']), 'project');
});

// ─── capture_lesson schema ⊇ hook-requested types (regression) ──────────────
// Bug: the tool's inputSchema enum only listed ['lesson','pattern'], but the
// plugin's OWN Stop hooks instruct the agent to call
// capture_lesson({type:'decision'}) (decision-scan-response.js) and
// capture_lesson({type:'research'}) (active-research-detect.js /
// research-followup-detect.js). The handler accepts any type string, so this
// was silent today — but a schema-enforcing MCP host would reject exactly the
// calls the hooks request. Guard: every type any hook nudge text asks for must
// be in the declared enum.
test('mcp-server: capture_lesson schema enum covers every type hooks nudge for', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, '..', 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const toolMatch = src.match(/name:\s*'capture_lesson'[\s\S]*?inputSchema:\s*\{[\s\S]*?\}\s*,\s*\n\s*\},/);
  assert(toolMatch, 'capture_lesson tool definition not found in mcp-server.js');
  const enumMatch = toolMatch[0].match(/type:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/);
  assert(enumMatch, 'capture_lesson type enum not found');
  const declared = new Set(enumMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')));

  const requested = new Set();
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (!f.endsWith('.js')) continue;
    const body = fs.readFileSync(path.join(SCRIPTS, f), 'utf-8');
    for (const m of body.matchAll(/capture_lesson\(\{\s*type\s*:\s*'([a-z]+)'/g)) requested.add(m[1]);
  }
  assert(requested.size > 0, 'no capture_lesson({type:...}) nudge found in scripts/ — test fixture drifted');
  const missing = [...requested].filter(t => !declared.has(t));
  assertEq(missing, [], `hook(s) nudge type(s) not in the declared enum: ${missing.join(', ')}`);
});

test('scope: sanitizeForUserScope strips paths, emails, project name', () => {
  const { sanitizeForUserScope } = require('./lib/scope-sanitizer.js');
  const out = sanitizeForUserScope(
    'In C:\\Users\\allan\\Desktop\\Projetos\\claude-code, also /home/joe/repo and /Users/anna/work; ping me at user@example.com — see claude-code thing',
    'claude-code'
  );
  if (out.includes('allan')) throw new Error(`Windows path not stripped: ${out}`);
  if (out.includes('/home/joe')) throw new Error(`Unix /home not stripped: ${out}`);
  if (out.includes('/Users/anna')) throw new Error(`/Users not stripped: ${out}`);
  if (out.includes('user@example.com')) throw new Error(`Email not stripped: ${out}`);
  if (/\bclaude-code\b/.test(out)) throw new Error(`Project name not stripped: ${out}`);
  if (!out.includes('<email>') || !out.includes('<project>') || !out.includes('~')) {
    throw new Error(`Expected sanitization tokens in: ${out}`);
  }
});

test('scope: sanitizeForUserScope is safe with empty/null and no project', () => {
  const { sanitizeForUserScope } = require('./lib/scope-sanitizer.js');
  assertEq(sanitizeForUserScope('', 'anything'), '');
  assertEq(sanitizeForUserScope(null, 'anything'), '');
  // No project arg → don't try to escape, just clean paths/emails
  const out = sanitizeForUserScope('hello /home/x and foo@bar.io', null);
  if (out.includes('/home/x')) throw new Error('path not stripped');
  if (out.includes('foo@bar.io')) throw new Error('email not stripped');
});

test('scope: detectSecrets catches well-known prefixes, ignores benign text', () => {
  const { detectSecrets } = require('./lib/scope-sanitizer.js');
  // Positive cases
  if (!detectSecrets('here is sk-' + 'A'.repeat(40) + ' token')) throw new Error('sk- not detected');
  if (!detectSecrets('sk-ant-api03-' + 'AbCd12-_'.repeat(6) + 'ZZ')) throw new Error('modern Anthropic key not detected');
  if (!detectSecrets('sk-proj-' + 'Ab12Cd34'.repeat(5))) throw new Error('modern OpenAI project key not detected');
  if (!detectSecrets('ghp_' + 'a'.repeat(36))) throw new Error('ghp_ not detected');
  if (!detectSecrets('AKIA' + 'BCDEFGHIJKLMNOP1')) throw new Error('AKIA not detected');
  if (!detectSecrets('AIza' + 'a'.repeat(35))) throw new Error('AIza not detected');
  if (!detectSecrets('xoxb-' + 'a'.repeat(20))) throw new Error('xoxb not detected');
  // Negative
  if (detectSecrets('totally benign text about an api key')) throw new Error('false positive on benign');
  if (detectSecrets('')) throw new Error('false positive on empty');
  if (detectSecrets(null)) throw new Error('false positive on null');
});

test('scope: prepareForUserScope sanitizes safe fields and rejects secrets', () => {
  const { prepareForUserScope } = require('./lib/scope-sanitizer.js');
  const ok = prepareForUserScope(
    { title: 'note about myproj', summary: 'see /home/alice/x', detail: 'ping foo@bar.io' },
    'myproj'
  );
  if (ok.rejected) throw new Error('benign entry should not be rejected');
  assertEq(ok.safe.title, 'note about <project>');
  assertEq(ok.safe.summary, 'see ~/x');
  assertEq(ok.safe.detail, 'ping <email>');

  const bad = prepareForUserScope(
    { title: 't', summary: 'tok=ghp_' + 'a'.repeat(36), detail: '' },
    'myproj'
  );
  if (!bad.rejected) throw new Error('secret should be rejected');
  if (!bad.reason || !/secret/i.test(bad.reason)) throw new Error('reason should mention secret');

  // Missing fields tolerated.
  const partial = prepareForUserScope({ title: 'x' }, 'myproj');
  if (partial.rejected) throw new Error('partial entry should not be rejected');
  assertEq(partial.safe.summary, '');
  assertEq(partial.safe.detail, '');
});

test('scope: splitTopK splits topK by 60/40 ratio with sensible floors', () => {
  const { splitTopK } = require('./lib/scope-search.js');
  let s = splitTopK(5);
  assertEq(s.projectK, 3);
  assertEq(s.userK, 2);
  s = splitTopK(10);
  assertEq(s.projectK, 6);
  assertEq(s.userK, 4);
  // Edge: topK=1 → projectK=1, userK=0
  s = splitTopK(1);
  assertEq(s.projectK, 1);
  assertEq(s.userK, 0);
  // Falsy → defaults to 5
  s = splitTopK();
  assertEq(s.projectK + s.userK, 5);
});

test('scope: mergeResults dedups by id (project wins) and sorts by score', () => {
  const { mergeResults } = require('./lib/scope-search.js');
  const project = [
    { id: 'a', score: 0.9, title: 'project-A' },
    { id: 'b', score: 0.5, title: 'project-B' },
  ];
  const user = [
    { id: 'a', score: 0.95, title: 'user-A' }, // dup id — project wins
    { id: 'c', score: 0.7, title: 'user-C' },
  ];
  const merged = mergeResults(project, user, 5);
  assertEq(merged.length, 3);
  // Order by score desc
  assertEq(merged[0].id, 'a');
  assertEq(merged[0].title, 'project-A'); // project version, not user's
  assertEq(merged[0].scope, 'project');
  assertEq(merged[1].id, 'c');
  assertEq(merged[1].scope, 'user');
  assertEq(merged[2].id, 'b');
  assertEq(merged[2].scope, 'project');
  // Cap to topK
  const capped = mergeResults(project, user, 2);
  assertEq(capped.length, 2);
});

test('scope: brain-store persists scope column and survives migration', async () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scope-'));
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  delete require.cache[require.resolve('./brain-store.js')];
  const isolated = require('./brain-store.js');
  try {
    await isolated.init({ project: 'p1', skipEmbedder: true });
    const e1 = { type: 'note', title: 'project-default', summary: 's', tags: [], scope: 'project' };
    await isolated.save(e1);
    const e2 = { type: 'note', title: 'user-scope', summary: 's', tags: [], scope: 'user' };
    await isolated.save(e2);
    const got1 = await isolated.get(e1.id);
    const got2 = await isolated.get(e2.id);
    assertEq(got1.scope, 'project');
    assertEq(got2.scope, 'user');
    // Entry without explicit scope falls back to 'project'
    const e3 = { type: 'note', title: 'no-scope', summary: 's', tags: [] };
    await isolated.save(e3);
    const got3 = await isolated.get(e3.id);
    assertEq(got3.scope, 'project');
  } finally {
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

// ─── skill-promote-trigger (cooldown + cfg loader) ──────────────────────────
const skillTrigger = require('./skill-promote-trigger.js');

test('skill-promote-trigger.shouldRun: missing stamp → true', () => {
  const stamp = path.join(process.env.CLAUDE_PLUGIN_DATA, 'skill-trigger-missing.stamp');
  try { fs.unlinkSync(stamp); } catch { /* ok */ }
  assert(skillTrigger.shouldRun(stamp, 60_000) === true);
});

test('skill-promote-trigger.shouldRun: fresh stamp → false', () => {
  const stamp = path.join(process.env.CLAUDE_PLUGIN_DATA, 'skill-trigger-fresh.stamp');
  fs.writeFileSync(stamp, String(Date.now()));
  assert(skillTrigger.shouldRun(stamp, 60_000) === false);
});

test('skill-promote-trigger.shouldRun: stale stamp → true', () => {
  const stamp = path.join(process.env.CLAUDE_PLUGIN_DATA, 'skill-trigger-stale.stamp');
  fs.writeFileSync(stamp, String(Date.now() - 10 * 60_000));
  assert(skillTrigger.shouldRun(stamp, 60_000) === true);
});

test('skill-promote-trigger.shouldRun: garbage stamp → true', () => {
  const stamp = path.join(process.env.CLAUDE_PLUGIN_DATA, 'skill-trigger-garbage.stamp');
  fs.writeFileSync(stamp, 'not-a-number');
  assert(skillTrigger.shouldRun(stamp, 60_000) === true);
});

test('skill-promote-trigger.loadCfg: missing config → {}', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-trigger-'));
  assertEq(skillTrigger.loadCfg(tmpRoot), {});
});

test('skill-promote-trigger.loadCfg: reads kb.skillPromotion block', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-trigger-'));
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'config', 'brain-config.json'),
    JSON.stringify({ kb: { skillPromotion: { enabled: false, minRecurrence: 5 } } }),
  );
  const cfg = skillTrigger.loadCfg(tmpRoot);
  assertEq(cfg.enabled, false);
  assertEq(cfg.minRecurrence, 5);
});

// ─── brain-health (countPendingDrafts) ───────────────────────────────────────
const brainHealth = require('./brain-health.js');

test('brain-health.countPendingDrafts: missing dir → 0', () => {
  if (!brainHealth.countPendingDrafts) return; // not exported yet
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pending-'));
  const r = brainHealth.countPendingDrafts(tmp);
  assertEq(r.count, 0);
});

test('brain-health.countPendingDrafts: counts only subdirs with SKILL.md', () => {
  if (!brainHealth.countPendingDrafts) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pending-'));
  const staging = path.join(tmp, 'skills-pending');
  fs.mkdirSync(path.join(staging, 'a'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'a', 'SKILL.md'), '# a');
  fs.mkdirSync(path.join(staging, 'b'), { recursive: true });
  // b has no SKILL.md
  fs.mkdirSync(path.join(staging, 'c'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'c', 'SKILL.md'), '# c');
  fs.writeFileSync(path.join(staging, 'orphan.md'), '# not a dir');
  const r = brainHealth.countPendingDrafts(tmp);
  assertEq(r.count, 2);
});

// ─── research-followup-detect (decideNudge purity) ──────────────────────────
const researchFollowup = require('./research-followup-detect.js');

test('research-followup.decideNudge: no fire → no nudge', () => {
  const r = researchFollowup.decideNudge([], null);
  assert(r.nudge === false);
  assertEq(r.reason, 'no-fire');
});

test('research-followup.decideNudge: fire + no capture → nudge', () => {
  const events = [
    { eventName: 'nudge.emitted', ts: 1000, payload: { kind: 'research', signals: ['libMention'] } },
  ];
  const r = researchFollowup.decideNudge(events, null);
  assert(r.nudge === true);
  assertEq(r.reason, 'pending-capture');
});

test('research-followup.decideNudge: fire + capture(type=research) AFTER → no nudge', () => {
  const events = [
    { eventName: 'lesson.captured', ts: 2000, payload: { type: 'research' } },
    { eventName: 'nudge.emitted', ts: 1000, payload: { kind: 'research', signals: ['libMention'] } },
  ];
  const r = researchFollowup.decideNudge(events, null);
  assert(r.nudge === false);
  assertEq(r.reason, 'captured');
});

test('research-followup.decideNudge: fire + capture(type=lesson) → still nudge', () => {
  const events = [
    { eventName: 'lesson.captured', ts: 2000, payload: { type: 'lesson' } },
    { eventName: 'nudge.emitted', ts: 1000, payload: { kind: 'research', signals: ['libMention'] } },
  ];
  const r = researchFollowup.decideNudge(events, null);
  assert(r.nudge === true);
  assertEq(r.reason, 'pending-capture');
});

test('research-followup.decideNudge: fire + capture BEFORE fire → still nudge', () => {
  const events = [
    { eventName: 'nudge.emitted', ts: 2000, payload: { kind: 'research', signals: ['libMention'] } },
    { eventName: 'lesson.captured', ts: 1000, payload: { type: 'research' } },
  ];
  const r = researchFollowup.decideNudge(events, null);
  assert(r.nudge === true);
});

test('research-followup.decideNudge: stamp matches latest trigger → already-nudged', () => {
  const events = [
    { eventName: 'nudge.emitted', ts: 1000, payload: { kind: 'research', signals: ['libMention'] } },
  ];
  const r = researchFollowup.decideNudge(events, { firedAt: 1000 });
  assert(r.nudge === false);
  assertEq(r.reason, 'already-nudged');
});

test('research-followup.decideNudge: newer trigger after stamp → nudge again', () => {
  const events = [
    { eventName: 'nudge.emitted', ts: 3000, payload: { kind: 'research', signals: ['libMention'] } },
    { eventName: 'nudge.emitted', ts: 1000, payload: { kind: 'research', signals: ['libMention'] } },
  ];
  const r = researchFollowup.decideNudge(events, { firedAt: 1000 });
  assert(r.nudge === true);
  assertEq(r.reason, 'pending-capture');
});

// ─── research-followup-detect.run: cross-scope capture regression ──────────
// Bug: capture_lesson({type:'research', ...}) always resolves to scope 'user'
// (inferDefaultScope maps type 'research' → 'user' unconditionally), so the
// admitted entry's `lesson.captured` metric lands in the __user__ project's
// OWN brain.db — a separate SQLite file from the current project's. run()
// used to read only the current-project singleton's getEventLog(), so it
// never saw that capture and false-nudged "no capture followed" even though
// one was admitted in the same turn. Fixed by also reading __user__ via
// getEventLogIsolated (no singleton mutation) and merging both streams.
test('research-followup.run: capture_lesson({type:research}) in __user__ scope suppresses the nudge', async () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-xscope-'));
  // Isolate globalDir() so forcing the dev profile via the GLOBAL user-config can't
  // pollute the run-wide home. research-followup is dev-only now; force dev so run()
  // actually exercises suppression.
  const rfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-xscope-home-'));
  process.env.HOME = rfHome;
  process.env.USERPROFILE = rfHome;
  const gp = path.join(rfHome, '.claude', 'claude-code-boss', 'hooks', 'user-config.json');
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  fs.writeFileSync(gp, JSON.stringify({ profile: 'dev' }));
  hooksConfig._resetCache();
  const isolatedStore = require('./lib/metrics-store.js');
  delete require.cache[require.resolve('./research-followup-detect.js')];
  const rf = require('./research-followup-detect.js');
  try {
    const currentProject = 'rf-xscope-proj';

    // 1) active-research-detect fires a nudge in the CURRENT project.
    if (!isolatedStore.init({ project: currentProject })) return;
    isolatedStore.recordMetric('nudge.emitted', { kind: 'research', signals: ['libMention'] }, 'sid-1');

    // 2) capture_lesson({type:'research'}) admits — MCP handler writes into
    //    __user__ (mirrors mcp-server.js's storageProject switch + restore).
    isolatedStore.close();
    isolatedStore.init({ project: '__user__' });
    isolatedStore.recordMetric('lesson.captured', { type: 'research', decision: 'admit', scope: 'user' }, null);
    isolatedStore.close();
    isolatedStore.init({ project: currentProject });

    // 3) Stop hook runs for this session/project.
    const result = await rf.run({ session_id: 'sid-1', cwd: `/fake/${currentProject}` });
    assertEq(result.block, undefined, `expected no block, got: ${JSON.stringify(result)}`);

    isolatedStore.close();
  } finally {
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    delete require.cache[require.resolve('./research-followup-detect.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    hooksConfig._resetCache();
  }
});

test('research-followup.run: no capture at all still nudges (regression guard)', async () => {
  delete require.cache[require.resolve('./lib/metrics-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-nocap-'));
  // Isolate globalDir() as above; research-followup is dev-only now, so force dev
  // (via the GLOBAL user-config) so run() emits the nudge.
  const rfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-nocap-home-'));
  process.env.HOME = rfHome;
  process.env.USERPROFILE = rfHome;
  const gp = path.join(rfHome, '.claude', 'claude-code-boss', 'hooks', 'user-config.json');
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  fs.writeFileSync(gp, JSON.stringify({ profile: 'dev' }));
  hooksConfig._resetCache();
  const isolatedStore = require('./lib/metrics-store.js');
  delete require.cache[require.resolve('./research-followup-detect.js')];
  const rf = require('./research-followup-detect.js');
  try {
    const currentProject = 'rf-nocap-proj';
    if (!isolatedStore.init({ project: currentProject })) return;
    isolatedStore.recordMetric('nudge.emitted', { kind: 'research', signals: ['libMention'] }, 'sid-2');

    const result = await rf.run({ session_id: 'sid-2', cwd: `/fake/${currentProject}` });
    assertEq(result.block, true, 'nudge should still fire with no capture at all');

    isolatedStore.close();
  } finally {
    delete require.cache[require.resolve('./lib/metrics-store.js')];
    delete require.cache[require.resolve('./research-followup-detect.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    hooksConfig._resetCache();
  }
});

// ─── decision-scan-response (response-mode shape detector) ──────────────────
const dsr = require('./decision-scan-response.js');

test('decision-scan-response: choice + rationale (en) → match', () => {
  const t = "I'll use SQLite instead of DuckDB because it's embed-friendly and zero-config.";
  const out = dsr.findDecisionSpan(t);
  assert(out, `expected match, got ${out}`);
  assert(/SQLite/.test(out));
});

test('decision-scan-response: choice + rationale (pt-BR) → match', () => {
  const t = 'Vou usar SQLite em vez de DuckDB porque embed é mais simples.';
  const out = dsr.findDecisionSpan(t);
  assert(out, `expected match, got ${out}`);
});

test('decision-scan-response: choice without rationale → no match', () => {
  assertEq(dsr.findDecisionSpan("I'll use SQLite for storage."), null);
});

test('decision-scan-response: rationale without choice verb → no match', () => {
  assertEq(dsr.findDecisionSpan('this works because of caching'), null);
});

test('decision-scan-response: too short → no match', () => {
  assertEq(dsr.findDecisionSpan('use X over Y'), null);
});

test('decision-scan-response: spanKey is sid+hash deterministic', () => {
  const k1 = dsr.spanKey('s1', 'use foo over bar because perf');
  const k2 = dsr.spanKey('s1', 'use foo over bar because perf');
  const k3 = dsr.spanKey('s2', 'use foo over bar because perf');
  assertEq(k1, k2);
  assert(k1 !== k3);
  assert(k1.startsWith('resp:s1:'));
});

// ─── skill-roi (aggregateSkillRoi) ───────────────────────────────────────────
const skillRoi = require('./lib/skill-roi.js');

test('skill-roi: empty inputs → []', () => {
  assertEq(skillRoi.aggregateSkillRoi([], []).length, 0);
});

test('skill-roi: counts invocations and outcomes per skill', () => {
  const inv = [
    { payload: { skillName: 'a' } },
    { payload: { skillName: 'a' } },
    { payload: { skillName: 'b' } },
  ];
  const out = [
    { payload: { skillName: 'a', success: 1 } },
    { payload: { skillName: 'a', success: 0 } },
    { payload: { skillName: 'b', success: 1 } },
  ];
  const rows = skillRoi.aggregateSkillRoi(inv, out);
  const a = rows.find(r => r.skillName === 'a');
  const b = rows.find(r => r.skillName === 'b');
  assertEq(a.invocations, 2);
  assertEq(a.outcomes_recorded, 2);
  assertEq(a.successes, 1);
  assertEq(a.success_rate, 0.5);
  assertEq(b.success_rate, 1);
});

test('skill-roi: success_rate null when no outcomes recorded', () => {
  const rows = skillRoi.aggregateSkillRoi([{ payload: { skillName: 'x' } }], []);
  assertEq(rows[0].success_rate, null);
  assertEq(rows[0].warn, false);
});

test('skill-roi: warn flag fires only at threshold (≥10 invocations & <30%)', () => {
  const inv = Array.from({ length: 12 }, () => ({ payload: { skillName: 'low' } }));
  const out = Array.from({ length: 10 }, (_, i) => ({ payload: { skillName: 'low', success: i < 2 ? 1 : 0 } }));
  const rows = skillRoi.aggregateSkillRoi(inv, out);
  assertEq(rows[0].warn, true);
  assertEq(rows[0].invocations, 12);
});

test('skill-roi: warn=false when invocations <10 even with low rate', () => {
  const inv = Array.from({ length: 5 }, () => ({ payload: { skillName: 'few' } }));
  const out = Array.from({ length: 5 }, () => ({ payload: { skillName: 'few', success: 0 } }));
  const rows = skillRoi.aggregateSkillRoi(inv, out);
  assertEq(rows[0].warn, false);
});

test('skill-roi: rows sorted by invocations desc', () => {
  const inv = [
    { payload: { skillName: 'low' } },
    { payload: { skillName: 'high' } },
    { payload: { skillName: 'high' } },
    { payload: { skillName: 'high' } },
  ];
  const rows = skillRoi.aggregateSkillRoi(inv, []);
  assertEq(rows[0].skillName, 'high');
  assertEq(rows[1].skillName, 'low');
});

test('skill-roi: skips events without skillName', () => {
  const inv = [{ payload: {} }, { payload: { skillName: 'ok' } }];
  const rows = skillRoi.aggregateSkillRoi(inv, []);
  assertEq(rows.length, 1);
  assertEq(rows[0].skillName, 'ok');
});

// ─── skill-success-detect (computeOutcomes) ──────────────────────────────────
const ssd = require('./skill-success-detect.js');

test('skill-success-detect: skill before any failure → success=1', () => {
  const inv = [{ id: 1, ts: 100, payload: { skillName: 'foo' } }];
  const fail = [];
  const out = ssd.computeOutcomes(inv, fail, []);
  assertEq(out.length, 1);
  assertEq(out[0].success, 1);
  assertEq(out[0].skillName, 'foo');
});

test('skill-success-detect: failure after skill → success=0', () => {
  const inv = [{ id: 1, ts: 100, payload: { skillName: 'foo' } }];
  const fail = [{ id: 9, ts: 200 }];
  const out = ssd.computeOutcomes(inv, fail, []);
  assertEq(out[0].success, 0);
});

test('skill-success-detect: failure BEFORE skill → success=1', () => {
  const inv = [{ id: 1, ts: 200, payload: { skillName: 'foo' } }];
  const fail = [{ id: 9, ts: 100 }];
  const out = ssd.computeOutcomes(inv, fail, []);
  assertEq(out[0].success, 1);
});

test('skill-success-detect: settled ids are skipped', () => {
  const inv = [{ id: 1, ts: 100, payload: { skillName: 'foo' } }];
  const out = ssd.computeOutcomes(inv, [], [1]);
  assertEq(out.length, 0);
});

test('skill-success-detect: skips entries without skillName', () => {
  const inv = [{ id: 1, ts: 100, payload: {} }, { id: 2, ts: 100, payload: { skillName: 'ok' } }];
  const out = ssd.computeOutcomes(inv, [], []);
  assertEq(out.length, 1);
  assertEq(out[0].skillName, 'ok');
});

// ─── retrieve-core (pure parts; no model load) ───────────────────────────────
const retrieveCore = require('./lib/retrieve-core.js');

test('retrieve-core: formatContext empty → ""', () => {
  assertEq(retrieveCore.formatContext([]), '');
  assertEq(retrieveCore.formatContext(null), '');
});

test('retrieve-core: formatContext renders title + summary', () => {
  const s = retrieveCore.formatContext([{ title: 'Use Read not cat', type: 'lesson', summary: 'always Read' }]);
  assert(s.startsWith('[BRAIN] 1 relevant lesson(s):'), `header missing: ${s}`);
  assert(s.includes('"Use Read not cat"') && s.includes('always Read'), 'title/summary missing');
});

test('retrieve-core: formatContext two sections (facts + capability pointers, ADR-015)', () => {
  const s = retrieveCore.formatContext(
    [{ title: 'Deploy runbook', type: 'knowledge', summary: 'restart pod then flush' }],
    [{ name: 'rollback', description: 'rollback a release' }, { name: 'setup-x', description: '' }],
  );
  assert(s.startsWith('[BRAIN] 1 relevant lesson(s):'), `facts header: ${s}`);
  assert(s.includes('[BRAIN·SKILLS] 2 available capability pointer(s):'), `skills header: ${s}`);
  assert(s.includes('- rollback — rollback a release'), `pointer line: ${s}`);
  assert(s.includes('- setup-x'), `pointer without desc: ${s}`);
});

test('retrieve-core: formatContext facts-only (no capabilities arg) has no skills section', () => {
  const s = retrieveCore.formatContext([{ title: 'X', type: 'lesson', summary: 'y' }]);
  assert(s.startsWith('[BRAIN] 1 relevant lesson(s):'), s);
  assert(s.indexOf('SKILLS') === -1, 'no skills section when no capabilities');
});

test('retrieve-core.pickInjectable: home-spine filter + dedup + topK + char budget', () => {
  const facts = [
    { title: 'A', summary: 'x'.repeat(100), scope: 'home' },
    { title: 'B', summary: 'y'.repeat(100), scope: 'projX' },
    { title: 'B', summary: 'dup', scope: 'projX' },
    { title: 'C', summary: 'z'.repeat(100), scope: 'projX' },
  ];
  const caps = [{ name: 'g', scope: 'home' }, { name: 'p', scope: 'projX' }];
  // home spine ON: keep A; dedup B; big budget/topK.
  let r = retrieveCore.pickInjectable(facts, caps, { topK: 5, maxChars: 10000, includeHomeSpine: true });
  assertEq(r.facts.map((f) => f.title), ['A', 'B', 'C']);
  assertEq(r.capabilities.map((c) => c.name), ['g', 'p']);
  // home spine OFF: drop home fact A + home capability g.
  r = retrieveCore.pickInjectable(facts, caps, { topK: 5, maxChars: 10000, includeHomeSpine: false });
  assertEq(r.facts.map((f) => f.title), ['B', 'C']);
  assertEq(r.capabilities.map((c) => c.name), ['p']);
  // topK cap.
  assertEq(retrieveCore.pickInjectable(facts, caps, { topK: 1, maxChars: 10000, includeHomeSpine: true }).facts.length, 1);
  // char budget: first always kept, second exceeds remaining → stop.
  assertEq(retrieveCore.pickInjectable(facts, caps, { topK: 5, maxChars: 150, includeHomeSpine: true }).facts.length, 1);
});

test('recall-health.isDegraded: classifies degraded vs ok reasons', () => {
  const rh = require('./lib/recall-health.js');
  assert(rh.isDegraded('no-compose') && rh.isDegraded('remote-error') && rh.isDegraded('timeout'), 'degraded reasons');
  assert(!rh.isDegraded('no-match') && !rh.isDegraded(undefined) && !rh.isDegraded(''), 'ok reasons');
});

test('brain-config.getRecallCompose: sane defaults', () => {
  const c = require('./lib/brain-config.js').getRecallCompose();
  assertEq(c.includeHomeSpine, true);
  assert(c.maxInjectChars > 0, 'maxInjectChars default');
  assert(c.timeoutMs > 0, 'timeoutMs default');
  assertEq(c.overlay, null);
  assertEq(c.poolWarming, true);
});

test('retrieve-core: short prompt pre-filters (no embedder)', async () => {
  const r = await retrieveCore.retrieve('oi', { project: 'ccb-nonexistent-test' });
  assertEq(r.reason, 'short');
  assertEq(r.entries.length, 0);
});

// ─── brain-config: contextExcludeTypes + DATA_DIR user-override deep-merge ────
const brainConfig = require('./lib/brain-config.js');

// Run `fn` with a temp per-user override at the GLOBAL path (globalDir()/
// user-config.json — the new canonical location load() reads). Isolates a fresh
// home AND data dir per call so each exercises a clean override with no bleed from
// a prior call's global file. `obj === undefined` writes nothing (the "absent"
// path). Restores HOME/USERPROFILE/CLAUDE_PLUGIN_DATA + the cache no matter what.
function withUserConfig(obj, fn) {
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-usercfg-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-usercfg-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  if (obj !== undefined) {
    const gp = path.join(home, '.claude', 'claude-code-boss', 'user-config.json');
    fs.mkdirSync(path.dirname(gp), { recursive: true });
    fs.writeFileSync(gp, JSON.stringify(obj));
  }
  brainConfig._resetCache();
  try {
    return fn();
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = savedData;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    brainConfig._resetCache();
  }
}

test('brain-config.getContextExcludeTypes: absent override → [] (shipped default)', () => {
  withUserConfig(undefined, () => {
    assertEq(brainConfig.getContextExcludeTypes(), []);
  });
});

test('brain-config.getContextExcludeTypes: normalizes (trim + lowercase)', () => {
  withUserConfig({ kb: { retrieval: { contextExcludeTypes: [' Lesson ', 'PATTERN', ''] } } }, () => {
    assertEq(brainConfig.getContextExcludeTypes(), ['lesson', 'pattern']);
  });
});

test('brain-config.getContextExcludeTypes: non-array → []', () => {
  withUserConfig({ kb: { retrieval: { contextExcludeTypes: 'lesson' } } }, () => {
    assertEq(brainConfig.getContextExcludeTypes(), []);
  });
});

test('brain-config user-override: deep-merge keeps shipped retrieval fields', () => {
  // Capture shipped retrieval getters with NO override…
  const shippedFast = withUserConfig(undefined, () => brainConfig.getRetrievalFast());
  const shippedDeep = withUserConfig(undefined, () => brainConfig.getRetrievalDeep());
  // …then prove the override merges (exclude wins) WITHOUT wiping the siblings.
  withUserConfig({ kb: { retrieval: { contextExcludeTypes: ['lesson'] } } }, () => {
    assertEq(brainConfig.getContextExcludeTypes(), ['lesson']);
    assertEq(brainConfig.getRetrievalFast(), shippedFast);
    assertEq(brainConfig.getRetrievalDeep(), shippedDeep);
  });
});

// ─── GAP2: deepDiff (dashboard persists only the delta vs the shipped config) ─
test('brain-config.deepDiff: identical trees → {}', () => {
  assertEq(brainConfig.deepDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), {});
});

test('brain-config.deepDiff: captures only the changed nested leaf', () => {
  assertEq(
    brainConfig.deepDiff(
      { backend: { type: 'local', mcpMemory: { transport: 'stdio' } } },
      { backend: { type: 'mcp-memory', mcpMemory: { transport: 'stdio' } } },
    ),
    { backend: { type: 'mcp-memory' } },
  );
});

test('brain-config.deepDiff: a brand-new key in next is captured', () => {
  assertEq(
    brainConfig.deepDiff(
      { backend: { type: 'local' } },
      { backend: { type: 'local', ingestion: { enabled: true } } },
    ),
    { backend: { ingestion: { enabled: true } } },
  );
});

test('brain-config.deepDiff: arrays replace wholesale (never merged)', () => {
  assertEq(brainConfig.deepDiff({ a: [1, 2] }, { a: [1, 2, 3] }), { a: [1, 2, 3] });
  assertEq(brainConfig.deepDiff({ a: [1, 2] }, { a: [1, 2] }), {});
});

// ─── GAP2: brain-backend activates the backend from shipped ⊕ per-user override
const brainBackend = require('./brain-backend.js');

test('brain-backend.peekMode: no override → local (shipped factory default)', () => {
  withUserConfig(undefined, () => {
    brainBackend._resetConfig();
    assertEq(brainBackend.peekMode(), 'local');
  });
});

test('brain-backend.peekMode: per-user override flips to mcp-memory (shipped untouched)', () => {
  withUserConfig({ backend: { type: 'mcp-memory' } }, () => {
    brainBackend._resetConfig();
    assertEq(brainBackend.peekMode(), 'mcp-memory');
  });
  // Absent override → back to shipped default: the flip was per-user, not global.
  withUserConfig(undefined, () => {
    brainBackend._resetConfig();
    assertEq(brainBackend.peekMode(), 'local');
  });
});

// ─── GAP1: conversation-ingest (opt-in daemon ingestion) ─────────────────────
const convIngest = require('./conversation-ingest.js');

test('conversation-ingest.clampRaw: small passes through; oversize → line-aligned trailing window', () => {
  assertEq(convIngest.clampRaw('line1\nline2\n'), 'line1\nline2\n');
  assertEq(convIngest.clampRaw(''), '');
  assertEq(convIngest.clampRaw(null), '');
  const oversize = 'x'.repeat(3800000) + '\n' + 'y'.repeat(3800000); // 7,600,001 > SAFE_MAX
  const clamped = convIngest.clampRaw(oversize);
  assert(clamped.length <= 7500000, `windowed to <= SAFE_MAX, got ${clamped.length}`);
  assertEq(clamped[0], 'y'); // aligned past the newline boundary → valid JSONL tail
});

test('conversation-ingest.transcriptKey: stable per (sid, transcript), differs by content/session', () => {
  assertEq(convIngest.transcriptKey('s', 'abc'), convIngest.transcriptKey('s', 'abc'));
  assert(convIngest.transcriptKey('s', 'abc') !== convIngest.transcriptKey('s', 'abd'), 'content change → new key');
  assert(convIngest.transcriptKey('s1', 'abc') !== convIngest.transcriptKey('s2', 'abc'), 'session change → new key');
});

test('conversation-ingest.run: backend=local → no-op (never ingests to local KB)', async () => {
  const r = await withUserConfig(undefined, () => {
    brainBackend._resetConfig();
    return convIngest.run({ session_id: 's', transcript_path: '' });
  });
  assertEq(Object.keys(r || {}).length, 0);
});

test('conversation-ingest.run: mcp-memory but ingestion OFF → no-op', async () => {
  const r = await withUserConfig({ backend: { type: 'mcp-memory', ingestion: { enabled: false } } }, () => {
    brainBackend._resetConfig();
    return convIngest.run({ session_id: 's', transcript_path: '' });
  });
  assertEq(Object.keys(r || {}).length, 0);
});

// ─── project-id: client-side identity resolver (env → marker → basename) ─────
const projectId = require('./lib/project-id.js');

// Fake fs where `present` is a set of absolute marker paths → contents.
function fakeFs(present) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(present, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(present, p)) throw new Error('ENOENT');
      return present[p];
    },
  };
}

test('project-id.sanitize: first non-empty line, trimmed, control-stripped, capped', () => {
  assertEq(projectId.sanitize('  positiva  '), 'positiva');
  assertEq(projectId.sanitize('\n\n  minha-app \nsegunda'), 'minha-app');
  assertEq(projectId.sanitize('a\u0000b\u0007c'), 'abc');
  assertEq(projectId.sanitize(123), '');
  assertEq(projectId.sanitize('x'.repeat(200)).length, 120);
});

test('project-id: env CCB_PROJECT_ID wins over everything', () => {
  const cwd = path.join('C:', 'Users', 'x', 'Hpositiva');
  const fs = fakeFs({ [path.join(cwd, '.claude-boss-project')]: 'marker-name' });
  assertEq(
    projectId.resolveProjectId({ cwd, env: { CCB_PROJECT_ID: ' forced ' }, fs }),
    'forced',
  );
});

test('project-id: .claude-boss-project marker beats the folder name (the positiva case)', () => {
  const cwd = path.join('C:', 'Users', 'x', 'Hpositiva');
  const fs = fakeFs({ [path.join(cwd, '.claude-boss-project')]: 'positiva\n' });
  assertEq(projectId.resolveProjectId({ cwd, env: {}, fs }), 'positiva');
});

test('project-id: marker found by walking up from a subdir', () => {
  const root = path.join('C:', 'proj');
  const sub = path.join(root, 'packages', 'api', 'src');
  const fs = fakeFs({ [path.join(root, '.claude-boss-project')]: 'monorepo-id' });
  assertEq(projectId.resolveProjectId({ cwd: sub, env: {}, fs }), 'monorepo-id');
});

test('project-id: no override → basename(cwd) (unchanged legacy default)', () => {
  const cwd = path.join('C:', 'Users', 'x', 'my-repo');
  const fs = fakeFs({});
  assertEq(projectId.resolveProjectId({ cwd, env: {}, fs }), 'my-repo');
});

test('project-id: no cwd and no env → default', () => {
  assertEq(projectId.resolveProjectId({ cwd: '', env: {}, fs: fakeFs({}) }), 'default');
});

// ─── project-identity-advisory: fragile-basename nudge (SessionStart) ─────────
const pia = require('./project-identity-advisory.js');

test('pia.needsNudge: local backend → never nudge (basename is by design)', () => {
  const cwd = path.join('C:', 'proj', 'app');
  assert(pia.needsProjectIdentityNudge({ mode: 'local', cwd, env: {}, fs: fakeFs({}) }) === false);
});

test('pia.needsNudge: mcp-memory + CCB_PROJECT_ID → stable, no nudge', () => {
  const cwd = path.join('C:', 'proj', 'app');
  const env = { CCB_PROJECT_ID: ' positiva ' };
  assert(pia.needsProjectIdentityNudge({ mode: 'mcp-memory', cwd, env, fs: fakeFs({}) }) === false);
});

test('pia.needsNudge: mcp-memory + config mcpProjectId → stable, no nudge (handshake override)', () => {
  const cwd = path.join('C:', 'proj', 'app');
  const opts = { mode: 'mcp-memory', cwd, env: {}, mcpProjectId: 'my-stable-id', fs: fakeFs({}) };
  assert(pia.needsProjectIdentityNudge(opts) === false);
});

test('pia.needsNudge: mcp-memory + whitespace-only mcpProjectId → still stamped raw by handshake → no nudge', () => {
  // brain-backend: `mcpCfg.projectId || _project` + mcp-client: `projectId ? {projectId} : {}`
  // → a truthy '   ' is sent RAW as the scope (wins over the marker), so the marker
  // remedy would be inert; nudging there repeats Finding 1. Faithful superset ⇒ silent.
  const cwd = path.join('C:', 'proj', 'app');
  const opts = { mode: 'mcp-memory', cwd, env: {}, mcpProjectId: '   ', fs: fakeFs({}) };
  assert(pia.needsProjectIdentityNudge(opts) === false);
});

test('pia.needsNudge: mcp-memory + marker in tree → stable, no nudge', () => {
  const cwd = path.join('C:', 'proj', 'app');
  const fs = fakeFs({ [path.join(cwd, '.claude-boss-project')]: 'positiva\n' });
  assert(pia.needsProjectIdentityNudge({ mode: 'mcp-memory', cwd, env: {}, fs }) === false);
});

test('pia.needsNudge: mcp-memory + no marker + no env + no config id → nudge (basename fallback)', () => {
  const cwd = path.join('C:', 'proj', 'app');
  assert(pia.needsProjectIdentityNudge({ mode: 'mcp-memory', cwd, env: {}, fs: fakeFs({}) }) === true);
});

test('pia.needsNudge: marker in an ANCESTOR (monorepo) → no nudge', () => {
  const root = path.join('C:', 'mono');
  const sub = path.join(root, 'packages', 'api');
  const fs = fakeFs({ [path.join(root, '.claude-boss-project')]: 'mono-id' });
  assert(pia.needsProjectIdentityNudge({ mode: 'mcp-memory', cwd: sub, env: {}, fs }) === false);
});

test('pia cooldown: absent→false; stamped→true; boundary half-open at +COOLDOWN_MS', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pia-')), 'f.json');
  const t0 = 1000000;
  assert(pia.onCooldown(file, t0) === false, 'absent → not on cooldown');
  pia.stamp(file, t0);
  assert(pia.onCooldown(file, t0 + pia.COOLDOWN_MS - 1) === true, 'inside window → cooldown');
  assert(pia.onCooldown(file, t0 + pia.COOLDOWN_MS) === false, 'at boundary → fires (half-open)');
  assert(pia.onCooldown(file, t0 + pia.COOLDOWN_MS + 1) === false, 'past window → fires');
});

test('pia cooldown: corrupt/torn stamp file → fail-open (fires), no crash', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pia-')), 'f.json');
  fs.writeFileSync(file, '{ this is not json');
  assert(pia.onCooldown(file, Date.now()) === false, 'unparseable → not on cooldown (fail-open)');
});

test('pia stampFileFor: same cwd → same file; different cwd → different file (per-folder isolation)', () => {
  const a = path.join('C:', 'proj', 'a');
  const b = path.join('C:', 'proj', 'b');
  assert(pia.stampFileFor(a) === pia.stampFileFor(a), 'stable per folder');
  assert(pia.stampFileFor(a) !== pia.stampFileFor(b), 'distinct folders → distinct files (no shared mutation)');
});

test('pia stamp: two folders write independent files — no cross-folder lost update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-pia-'));
  const fileA = path.join(dir, 'A.json');
  const fileB = path.join(dir, 'B.json');
  pia.stamp(fileA, 100);
  pia.stamp(fileB, 200);
  assertEq(pia.readTs(fileA), 100);
  assertEq(pia.readTs(fileB), 200);
});

test('pia.buildAdvisory: names the marker file + the basename, consent-first', () => {
  const msg = pia.buildAdvisory('my-repo');
  assert(msg.includes(projectId.MARKER_FILE), 'mentions .claude-boss-project');
  assert(msg.includes('my-repo'), 'mentions the fragile basename');
  assert(/OFEREÇA|ofere/i.test(msg), 'consent-first (offers, never auto-writes)');
});

// ─── Sprint 1 — security hardening (injection / XSS / traversal / rebinding) ──
test('project-id.sanitizeProjectId: rejects separators/traversal (no coercion → no scope collision)', () => {
  // Reject, don't coerce: distinct ids must never collapse to one segment.
  assertEq(projectId.sanitizeProjectId('../../etc'), '');
  assertEq(projectId.sanitizeProjectId('..\\..\\win'), '');
  assertEq(projectId.sanitizeProjectId('foo/bar'), '');
  assertEq(projectId.sanitizeProjectId('a\\b\\c'), '');
  assertEq(projectId.sanitizeProjectId('orgA/api'), '');   // would collide with 'api' if coerced
  assertEq(projectId.sanitizeProjectId('C:\\abs'), '');
  assertEq(projectId.sanitizeProjectId('C:foo'), '');       // drive-colon
  assertEq(projectId.sanitizeProjectId('x::$DATA'), '');    // NTFS ADS
  assertEq(projectId.sanitizeProjectId('/etc/passwd'), '');
  assertEq(projectId.sanitizeProjectId('..'), '');
  assertEq(projectId.sanitizeProjectId('.'), '');
  assertEq(projectId.sanitizeProjectId(''), '');
  assertEq(projectId.sanitizeProjectId('   '), '');
  // clean flat ids pass unchanged (spaces/accents ok — no separators)
  assertEq(projectId.sanitizeProjectId('normal-id'), 'normal-id');
  assertEq(projectId.sanitizeProjectId('my_proj.2'), 'my_proj.2');
  assertEq(projectId.sanitizeProjectId('café-app'), 'café-app');
  // every accepted id is separator-free → path.join(brainDir, id) can't escape
  for (const raw of ['../../etc', 'orgA/api', 'C:\\abs', 'x::$DATA', '..']) {
    assertEq(projectId.sanitizeProjectId(raw), '');
  }
});

test('S2+ dashboard index.html: project/type/doctor/model fields escaped (no unescaped innerHTML sinks)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
  assert(!/<td>\$\{p\.project\}<\/td>/.test(src), 'p.project must be escaped in the projects table');
  assert(!/<td>\$\{p\.type\}<\/td>/.test(src), 'p.type must be escaped in the consolidate table');
  assert(!/<option value="\$\{p\.project\}">\$\{p\.project\}/.test(src), 'project <option> must escape p.project');
  assert(!/<option value="\$\{m\.value\}">\$\{m\.label\}/.test(src), 'model <option> must escape value/label');
  assert(/escapeHtml\(p\.project\)/.test(src), 'p.project must be escaped');
  assert(/escapeHtml\(p\.type\)/.test(src), 'p.type must be escaped');
  assert(/escapeHtml\(r\.label\)/.test(src) && /escapeHtml\(r\.detail\)/.test(src), 'doctor label/detail must be escaped');
  assert(/escapeHtml\(m\.value\)/.test(src) && /escapeHtml\(m\.label\)/.test(src), 'model option must be escaped');
});

test('S1 dashboard: runBrainPromote uses execFileSync (no shell); callers pass argv arrays', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dashboard.js'), 'utf-8');
  const fn = src.match(/function runBrainPromote[\s\S]*?\n\}/);
  assert(fn, 'runBrainPromote not found');
  assert(/execFileSync\(process\.execPath,\s*\[scriptPath,\s*\.\.\.argvArray\]/.test(fn[0]), 'must call execFileSync with an argv array');
  assert(!/execSync\(`/.test(fn[0]), 'must not build a shell string');
  assert(!/runBrainPromote\(argv\.join/.test(src), 'scanSkillCandidates must pass the argv array, not a joined string');
  assert(/runBrainPromote\(\['approve', slug\]\)/.test(src), 'approveSkillDraft must pass an array');
});

test('S5 sink: brain-promote scan() sanitizes --project (sibling traversal sink closed)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'brain-promote.js'), 'utf-8');
  assert(/require\('\.\/lib\/project-id\.js'\)/.test(src), 'brain-promote must import project-id');
  assert(/sanitizeProjectId\(arg\('project'/.test(src), 'scan() must run --project through sanitizeProjectId before store.init');
});

test('S4 brain-embedder: embedOllama uses execFileSync (no shell)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'brain-embedder.js'), 'utf-8');
  const fn = src.match(/function embedOllama[\s\S]*?\n\}/);
  assert(fn, 'embedOllama not found');
  assert(/execFileSync\('ollama',\s*\['run', model\]/.test(fn[0]), 'must use execFileSync with argv');
  assert(!/execSync\(/.test(fn[0]), 'must not use execSync');
});

test('S2 dashboard index.html: brain-search results escape KB content + use data-* handlers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
  assert(/title="\$\{escapeHtml\(r\.title\)\}">\$\{escapeHtml\(r\.title\)\}/.test(src), 'r.title must be escaped in the results row');
  assert(/\$\{escapeHtml\(r\.summary/.test(src), 'r.summary must be escaped');
  assert(!/onclick="viewBrainEntry\('\$\{srcProject\}/.test(src), 'must not build an onclick with raw interpolated args');
  assert(/data-act="view"/.test(src) && /data-id="\$\{escapeHtml\(r\.id\)\}"/.test(src), 'action buttons must use escaped data-* attributes');
});

test('S5 model-router: isLoopbackHost blocks non-loopback Host AND cross-site Origin', () => {
  const mr = require(path.join(ROOT, 'servers', 'model-router', 'index.js'));
  const H = (host, origin) => ({ headers: origin === undefined ? { host } : { host, origin } });
  // loopback Host, no Origin (curl / same-origin) → allow
  assert(mr.isLoopbackHost(H('127.0.0.1:8080')) === true);
  assert(mr.isLoopbackHost(H('localhost:8080')) === true);
  assert(mr.isLoopbackHost(H('[::1]:8080')) === true);
  // non-loopback Host → block (DNS-rebinding)
  assert(mr.isLoopbackHost(H('evil.com')) === false);
  assert(mr.isLoopbackHost(H('127.0.0.1.evil.com:8080')) === false);
  assert(mr.isLoopbackHost(H('')) === false);
  // loopback Host BUT cross-site Origin → block (drive-by CSRF)
  assert(mr.isLoopbackHost(H('localhost:8080', 'http://evil.com')) === false);
  assert(mr.isLoopbackHost(H('127.0.0.1:8080', 'https://attacker.example')) === false);
  assert(mr.isLoopbackHost(H('localhost:8080', 'not-a-url')) === false);
  // loopback Host + loopback Origin → allow (legit dashboard fetch)
  assert(mr.isLoopbackHost(H('localhost:8080', 'http://localhost:8080')) === true);
  assert(mr.isLoopbackHost(H('127.0.0.1:8080', 'http://127.0.0.1:8080')) === true);
});

test('S5 model-router: /metrics/reset calls isLoopbackHost before resetMetrics', () => {
  const src = fs.readFileSync(path.join(ROOT, 'servers', 'model-router', 'index.js'), 'utf-8');
  const block = src.match(/req\.url === '\/metrics\/reset'[\s\S]*?resetMetrics\(\)/);
  assert(block && /isLoopbackHost\(req\)/.test(block[0]), '/metrics/reset must check isLoopbackHost before resetMetrics');
});

test('S-minor dashboard serveStatic: traversal guard uses path.sep boundary', () => {
  // The guard now lives in the extracted lib/dashboard-static.js (SP6), and
  // dashboard.js routes through it. Assert both: the boundary check is present
  // in the lib, and serveStatic uses resolveStaticPath (no inline re-implementation).
  const lib = fs.readFileSync(path.join(SCRIPTS, 'lib', 'dashboard-static.js'), 'utf-8');
  assert(/filePath !== dashboardDir && !filePath\.startsWith\(dashboardDir \+ path\.sep\)/.test(lib),
    'resolveStaticPath must bound with dashboardDir + path.sep');
  const dash = fs.readFileSync(path.join(SCRIPTS, 'dashboard.js'), 'utf-8');
  assert(/resolveStaticPath\(DASHBOARD_DIR, req\.url\)/.test(dash),
    'serveStatic must route through resolveStaticPath');
});

test('S-minor model-router-ensure: env-var name validated before the PowerShell string', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'model-router-ensure.js'), 'utf-8');
  const matches = src.match(/\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$\/\.test\(name\)/g) || [];
  assert(matches.length >= 2, 'both getSystemEnvVar and clearSystemEnvVar must validate name');
});

test('R1 dashboard brain HTTP handlers sanitize project (traversal class closed on the exposed surface)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dashboard.js'), 'utf-8');
  assert(/require\('\.\/lib\/project-id\.js'\)/.test(src), 'dashboard must import sanitizeProjectId');
  assert(!/=\s*url\.searchParams\.get\('project'\)\s*\|\|\s*'';/.test(src), 'no raw project query read may reach store.init');
  const wrapped = src.match(/sanitizeProjectId\((?:url\.searchParams\.get\('project'\)|parsed\.targetProject|bundle\.project)/g) || [];
  assert(wrapped.length >= 6, `expected >=6 sanitized project reads in brain handlers, got ${wrapped.length}`);
});

// ─── retrieve-core.filterInjectableEntries ───────────────────────────────────
test('retrieve-core.filterInjectableEntries: empty/null → []', () => {
  assertEq(retrieveCore.filterInjectableEntries([]), []);
  assertEq(retrieveCore.filterInjectableEntries(null), []);
});

test('retrieve-core.filterInjectableEntries: default [] passes all types', () => {
  withUserConfig(undefined, () => {
    const es = [{ type: 'lesson' }, { type: 'reference' }, { type: 'pattern' }];
    assertEq(retrieveCore.filterInjectableEntries(es), es);
  });
});

test('retrieve-core.filterInjectableEntries: excludes lesson, keeps others (case-insensitive)', () => {
  withUserConfig({ kb: { retrieval: { contextExcludeTypes: ['lesson'] } } }, () => {
    const es = [
      { id: 1, type: 'Lesson' },
      { id: 2, type: 'reference' },
      { id: 3, type: 'pattern' },
      { id: 4, type: 'LESSON' },
    ];
    assertEq(retrieveCore.filterInjectableEntries(es).map((e) => e.id), [2, 3]);
  });
});

// ─── command-signature ────────────────────────────────────────────────────────
const cmdSig = require(path.join(SCRIPTS, 'lib', 'command-signature.js'));

test('command-signature: strips cd prefix + flags', () => {
  assertEq(cmdSig.canonicalSig('cd /proj && git --no-pager log -5'), 'git log');
});
test('command-signature: strips leading env assignment', () => {
  assertEq(cmdSig.canonicalSig('NODE_ENV=test npm test -- --watch'), 'npm test');
});
test('command-signature: strips wrapper (env/sudo)', () => {
  assertEq(cmdSig.canonicalSig('env FOO=bar sudo npm ci'), 'npm ci');
});
test('command-signature: pipe is NOT a separator', () => {
  assertEq(cmdSig.canonicalSig('git log | head'), 'git log');
});
test('command-signature: picks first non-nav across separators', () => {
  assertEq(cmdSig.canonicalSig('cd a ; pushd b && npm run build'), 'npm run build');
});
test('command-signature: masked variants collapse to same sig', () => {
  assertEq(cmdSig.canonicalSig('git log'), cmdSig.canonicalSig('cd /x && git --no-pager log --stat'));
});
test('command-signature: empty → ""', () => {
  assertEq(cmdSig.canonicalSig('   '), '');
});
test('command-signature: isGenericAlias (D4)', () => {
  assert(cmdSig.isGenericAlias('git'), 'git generic');
  assert(cmdSig.isGenericAlias('cat'), 'cat generic');
  assert(cmdSig.isGenericAlias(''), 'empty generic');
  assert(!cmdSig.isGenericAlias('git log'), 'git log specific');
  assert(!cmdSig.isGenericAlias('npm test'), 'npm test specific');
});
test('command-signature: quoted/escaped metachars are data, not a cut point', () => {
  // Observed live (v1.19.0): the \| inside the grep pattern truncated the sig
  // to `grep "oneoff\` — losing operands and colliding unrelated greps.
  assertEq(
    cmdSig.canonicalSig('grep -n "oneoff\\|curation-stop" scripts/a.js | head -30'),
    'grep "oneoff\\|curation-stop" scripts/a.js',
  );
  assertEq(cmdSig.canonicalSig('echo "a > b" > out.txt'), 'echo "a > b"');
  assertEq(cmdSig.canonicalSig("awk '{print $1 > \"f\"}' data.txt"), "awk '{print $1 > \"f\"}' data.txt");
  // Escaped pipe outside quotes is data too.
  assertEq(cmdSig.canonicalSig('grep a\\|b file.txt'), 'grep a\\|b file.txt');
});
test('command-signature: distinct quoted greps no longer collide', () => {
  const a = cmdSig.canonicalSig('grep -n "oneoff\\|curation-stop" scripts/test-units.js | head');
  const b = cmdSig.canonicalSig('grep -n "ANTHROPIC_BASE_URL\\|apiKey" scripts/model-router-ensure.js | head');
  assert(a !== b, `sigs must differ, both = ${a}`);
});
test('command-signature: unquoted pipe/redirect still cuts (sig identity preserved)', () => {
  // Historical identity `npm test 2` (from `2>&1`) must survive the fix —
  // stored one-off entries keyed on it stay matchable.
  assertEq(cmdSig.canonicalSig('CLAUDE_SKIP_EMBED_WARM=1 npm test 2>&1 | tail -40'), 'npm test 2');
  assertEq(cmdSig.canonicalSig('git log | head -5'), 'git log');
});

// ─── oneoff-store ─────────────────────────────────────────────────────────────
const oneoff = require(path.join(SCRIPTS, 'lib', 'oneoff-store.js'));
const freshDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-oneoff-'));

test('oneoff-store: touch creates + counts masked recurrence (D1)', () => {
  const dd = freshDataDir(); const pk = 'p'; const t0 = 1_700_000_000_000;
  let r = oneoff.touch(dd, pk, 'git log', { sessionId: 's1', now: t0, create: true });
  assertEq([r.matched, r.created, r.count], [true, true, 1]);
  r = oneoff.touch(dd, pk, 'cd /x && git --no-pager log -5', { sessionId: 's2', now: t0 + 1000, create: false });
  assertEq([r.matched, r.created, r.count], [true, false, 2]);
});
test('oneoff-store: touch no-create on miss', () => {
  const dd = freshDataDir();
  assertEq(oneoff.touch(dd, 'p', 'npm test', { create: false }).matched, false);
});
test('oneoff-store: window excludes stale occurrences (D5)', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 2_000_000_000_000;
  oneoff.touch(dd, pk, 'git log', { now: now - 100 * 86400000, create: true });
  assertEq(oneoff.touch(dd, pk, 'git log', { now, create: false }).count, 1);
});
test('oneoff-store: ceiling refuses re-mark (D2)', () => {
  const dd = freshDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  oneoff.touch(dd, pk, 'git log', { now: now++, create: true });
  assertEq(oneoff.mark(dd, pk, { aliases: ['git log'], now: now++, maxRecurrence: 3 }).decision, 'merged');
  oneoff.touch(dd, pk, 'git log', { now: now++, create: false });
  oneoff.touch(dd, pk, 'git log', { now: now++, create: false });
  const m = oneoff.mark(dd, pk, { aliases: ['git log'], now: now++, maxRecurrence: 3 });
  assertEq(m.decision, 'rejected');
  assert(m.count >= 3, `count ${m.count}`);
});
test('oneoff-store: mark merges overlapping alias, no fragment (D3)', () => {
  const dd = freshDataDir(); const pk = 'p';
  oneoff.mark(dd, pk, { aliases: ['git log'], maxRecurrence: 99 });
  assertEq(oneoff.mark(dd, pk, { aliases: ['git log --stat'], maxRecurrence: 99 }).decision, 'merged');
  assertEq(Object.keys(oneoff.load(dd, pk).entries).length, 1);
});
test('oneoff-store: prune removes cold entries (D5)', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 2_000_000_000_000;
  oneoff.touch(dd, pk, 'git log', { now: now - 200 * 86400000, create: true });
  oneoff.touch(dd, pk, 'npm test', { now, create: true });
  assertEq(oneoff.prune(dd, pk, { now, windowDays: 90 }), 1);
  assertEq(oneoff.summary(dd, pk).total, 1);
});
test('oneoff-store: marked one-hit under ceiling is suppressible (detect path)', () => {
  const dd = freshDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  oneoff.mark(dd, pk, { aliases: ['npm run weird'], now: now++, maxRecurrence: 3 });
  const r = oneoff.touch(dd, pk, 'cd /x && npm run weird --flag', { now: now++, create: false });
  assert(r.matched && r.oneHit && r.count < 3, `expected suppressible, got ${JSON.stringify(r)}`);
});
test('oneoff-store: mark accepts exact sigs verbatim (no alias derivation)', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  // sig copied verbatim from a Stop-hook reason — includes a token an alias
  // derivation would never produce ("npm test 2" from `npm test 2>&1 | tail`).
  const m = oneoff.mark(dd, pk, { sigs: ['npm test 2'], now, maxRecurrence: 3 });
  assertEq(m.decision, 'marked');
  assertEq(m.sig, 'npm test 2');
  const store = oneoff.load(dd, pk);
  assert(oneoff.isOneHit(store, { command: 'CLAUDE_SKIP_EMBED_WARM=1 npm test 2>&1 | tail -40' }, { now }),
    'raw command must resolve to the sig-marked entry');
});
test('oneoff-store: isOneHit matches by journaled sig and respects ceiling', () => {
  const dd = freshDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  oneoff.mark(dd, pk, { aliases: ['git ls-files'], now: now++, maxRecurrence: 3 });
  let store = oneoff.load(dd, pk);
  assert(oneoff.isOneHit(store, { sig: 'git ls-files' }, { now, maxRecurrence: 3 }), 'marked → one-hit');
  assert(!oneoff.isOneHit(store, { sig: 'git log' }, { now }), 'unrelated sig → false');
  // Past the ceiling the marking no longer suppresses.
  oneoff.touch(dd, pk, 'git ls-files', { now: now++, create: false });
  oneoff.touch(dd, pk, 'git ls-files', { now: now++, create: false });
  oneoff.touch(dd, pk, 'git ls-files', { now: now++, create: false });
  store = oneoff.load(dd, pk);
  assert(!oneoff.isOneHit(store, { sig: 'git ls-files' }, { now, maxRecurrence: 3 }), 'at ceiling → not suppressible');
});
test('oneoff-store: markedSince sees only markings at/after the cutoff', () => {
  const dd = freshDataDir(); const pk = 'p'; const t0 = 1_700_000_000_000;
  oneoff.mark(dd, pk, { aliases: ['npm run one'], now: t0, maxRecurrence: 3 });
  const store = oneoff.load(dd, pk);
  assert(oneoff.markedSince(store, t0 - 1), 'mark after cutoff → true');
  assert(oneoff.markedSince(store, t0), 'mark at cutoff → true');
  assert(!oneoff.markedSince(store, t0 + 1), 'mark before cutoff → false');
  assert(!oneoff.markedSince(store, NaN), 'invalid cutoff → false');
});

// ── FIX #9: curation_mark_oneoff response must reflect ALL marked signatures ──
// A batch mark COALESCES its sigs into ONE entry (aliasSigs cover them all) — the
// suppression/count semantics are correct and UNCHANGED here; the only gap was that
// the response echoed just the representative `sig`. These tests pin that `signatures`
// now lists every covered sig, while `sig` stays the first for backward compat.
test('oneoff-store (FIX #9): mark surfaces ALL batch signatures, not just the representative first', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  const m = oneoff.mark(dd, pk, { sigs: ['npm run alpha', 'npm run beta'], now, maxRecurrence: 3 });
  assertEq(m.decision, 'marked');
  assert(Array.isArray(m.signatures), 'response carries a signatures[] array');
  assertEq(m.signatures.slice().sort(), ['npm run alpha', 'npm run beta'], 'BOTH marked sigs surfaced (not only the first)');
  assertEq(m.sig, 'npm run alpha', 'sig stays the representative (first) for backward compat');
  // Semantics UNCHANGED: one coalesced entry; BOTH sigs resolve to it (suppression covers all).
  const store = oneoff.load(dd, pk);
  assertEq(Object.keys(store.entries).length, 1, 'still a single coalesced entry');
  assert(oneoff.isOneHit(store, { sig: 'npm run alpha' }, { now, maxRecurrence: 3 }), 'first sig suppressible');
  assert(oneoff.isOneHit(store, { sig: 'npm run beta' }, { now, maxRecurrence: 3 }), 'second sig ALSO suppressible');
});
test('oneoff-store (FIX #9): a single-sig mark still returns exactly that one signature', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  const m = oneoff.mark(dd, pk, { sigs: ['npm run solo'], now, maxRecurrence: 3 });
  assertEq(m.decision, 'marked');
  assertEq(m.signatures, ['npm run solo'], 'signatures has the single sig');
  assertEq(m.sig, 'npm run solo', 'sig unchanged');
});
test('oneoff-store (FIX #9): a merge surfaces the FULL post-merge signature set', () => {
  const dd = freshDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  oneoff.mark(dd, pk, { sigs: ['npm run alpha'], now: now++, maxRecurrence: 99 });
  const m = oneoff.mark(dd, pk, { sigs: ['npm run alpha', 'npm run gamma'], now: now++, maxRecurrence: 99 });
  assertEq(m.decision, 'merged');
  assert(m.signatures.includes('npm run alpha') && m.signatures.includes('npm run gamma'),
    `merged signatures cover the whole entry, got ${JSON.stringify(m.signatures)}`);
});
test('curation_mark_oneoff (FIX #9): handler response lists ALL batch signatures + an accurate count', async () => {
  const url = require('url');
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  const mod = await import(url.pathToFileURL(path.join(R, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
  const server = mod.createBrainServer({ pluginRoot: R, mode: 'stdio' });
  // Isolated project key: a fresh temp cwd with a .git marker (resolveProjectKey stops there).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-mark9-'));
  fs.mkdirSync(path.join(work, '.git'), { recursive: true });
  const res = await server.handleTool('curation_mark_oneoff', { sigs: ['npm run alpha', 'npm run beta'], cwd: work });
  const out = JSON.parse(res.content[0].text);
  assertEq(out.decision, 'marked');
  assert(Array.isArray(out.signatures), 'handler response has a signatures[] array');
  assertEq(out.signatures.slice().sort(), ['npm run alpha', 'npm run beta'], 'BOTH sigs surfaced in the handler response');
  assertEq(out.signature, 'npm run alpha', 'signature stays the representative (backward compat)');
  assert(/2 signature/.test(out.message || ''), `message reflects the batch count, got: ${out.message}`);
});

// ─── error-store (deterministic error-guard: recurring Bash failures) ────────
const errstore = require(path.join(SCRIPTS, 'lib', 'error-store.js'));
const freshErrDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-errstore-'));

test('error-store: record creates an entry keyed by canonicalSig', () => {
  const dd = freshErrDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  const r = errstore.record(dd, pk, { command: 'cd /proj && npm run build', cause: 'TS2345', exitCode: 2, sessionId: 's1', now });
  assertEq([r.recorded, r.sig, r.count], [true, 'npm run build', 1]);
  const store = errstore.load(dd, pk);
  // Keyed by the canonical signature — the nav prefix (`cd /proj &&`) is dropped.
  assertEq(Object.keys(store.entries), ['npm run build']);
  assertEq(store.entries['npm run build'].exitCode, 2);
  assertEq(store.entries['npm run build'].cause, 'TS2345');
});

test('error-store: record on empty/whitespace command is a no-op', () => {
  const dd = freshErrDataDir();
  assertEq(errstore.record(dd, 'p', { command: '   ' }).recorded, false);
  assertEq(Object.keys(errstore.load(dd, 'p').entries).length, 0);
});

test('error-store: second record bumps the windowed count (same sig)', () => {
  const dd = freshErrDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  assertEq(errstore.record(dd, pk, { command: 'npm test', now: now++ }).count, 1);
  assertEq(errstore.record(dd, pk, { command: 'npm test', now: now++ }).count, 2);
  assertEq(Object.keys(errstore.load(dd, pk).entries).length, 1);
});

test('error-store: lookup is hit:false below threshold, hit:true at/above it', () => {
  const dd = freshErrDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  errstore.record(dd, pk, { command: 'npm run lint', cause: 'eslint boom', exitCode: 1, now: now++ });
  let l = errstore.lookup(dd, pk, 'npm run lint', { now, threshold: 2 });
  assertEq([l.hit, l.count], [false, 1]);
  errstore.record(dd, pk, { command: 'npm run lint', cause: 'eslint boom 2', exitCode: 1, now: now++ });
  l = errstore.lookup(dd, pk, 'npm run lint', { now, threshold: 2 });
  assertEq([l.hit, l.count, l.sig, l.cause, l.exitCode], [true, 2, 'npm run lint', 'eslint boom 2', 1]);
});

test('error-store: lookup normalizes cwd/env/flags/pipe to the SAME sig', () => {
  const dd = freshErrDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  errstore.record(dd, pk, { command: 'cd /p && npm test', now: now++ });
  errstore.record(dd, pk, { command: 'NODE_ENV=x npm test -- --watch', now: now++ });
  // Both variants collapse to a single entry keyed 'npm test' (no fragmentation).
  assertEq(Object.keys(errstore.load(dd, pk).entries), ['npm test']);
  assert(errstore.lookup(dd, pk, 'cd /y && npm test | grep FAIL', { now, threshold: 2 }).hit,
    'a wrapped/piped variant must resolve to the same sig-entry and hit');
});

test('error-store: resolve clears the entry → subsequent lookup is hit:false', () => {
  const dd = freshErrDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  errstore.record(dd, pk, { command: 'npm run build', now: now++ });
  errstore.record(dd, pk, { command: 'npm run build', now: now++ });
  assert(errstore.lookup(dd, pk, 'npm run build', { now, threshold: 2 }).hit, 'precondition: recurring → hit');
  const rv = errstore.resolve(dd, pk, 'cd /x && npm run build --flag', { now });
  assertEq([rv.resolved, rv.sig], [true, 'npm run build']);
  assertEq(Object.keys(errstore.load(dd, pk).entries).length, 0);
  assertEq(errstore.lookup(dd, pk, 'npm run build', { now, threshold: 2 }).hit, false);
});

test('error-store: resolve on an unrecorded sig is a no-op', () => {
  const dd = freshErrDataDir();
  assertEq(errstore.resolve(dd, 'p', 'git status').resolved, false);
});

test('error-store: window excludes stale failures (90d)', () => {
  const dd = freshErrDataDir(); const pk = 'p'; const now = 2_000_000_000_000;
  errstore.record(dd, pk, { command: 'npm test', now: now - 100 * 86400000 });
  errstore.record(dd, pk, { command: 'npm test', now });
  // The 100d-old failure falls outside the 90d window; only the fresh one counts.
  assertEq(errstore.lookup(dd, pk, 'npm test', { now, windowDays: 90, threshold: 2 }).count, 1);
});

test('error-store: prune removes cold entries', () => {
  const dd = freshErrDataDir(); const pk = 'p'; const now = 2_000_000_000_000;
  errstore.record(dd, pk, { command: 'git log', now: now - 200 * 86400000 });
  errstore.record(dd, pk, { command: 'npm test', now });
  assertEq(errstore.prune(dd, pk, { now, windowDays: 90 }), 1);
  assertEq(Object.keys(errstore.load(dd, pk).entries), ['npm test']);
});

test('error-store: reuses oneoff resolveProjectKey (stores agree on key)', () => {
  assert(errstore.resolveProjectKey === oneoff.resolveProjectKey,
    'error-store must re-export oneoff-store.resolveProjectKey so both stores key alike');
});

test('error-store: redacts secrets/PII in the sig AND the cause (no durable secret, stable matching)', () => {
  const dd = freshErrDataDir(); const pk = 'p'; let now = 1_700_000_000_000;
  const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX';
  const cmd = `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com/x`;
  const cause = `401 Unauthorized: token ${SECRET} rejected; contact a.user@example.com`;
  const r = errstore.record(dd, pk, { command: cmd, cause, exitCode: 22, now: now++ });
  // The PERSISTED key (sig) — which is also injected back to the agent — must not carry the raw secret.
  assert(!r.sig.includes(SECRET), `sig must be redacted, got: ${r.sig}`);
  const entry = errstore.load(dd, pk).entries[r.sig];
  assert(entry && !JSON.stringify(entry).includes(SECRET), 'no raw secret anywhere in the stored entry (sig+cause)');
  assert(!entry.cause.includes(SECRET) && !entry.cause.includes('a.user@example.com'), 'cause redacts secret + email PII');
  // Matching stays STABLE: the same secret-command (redacted deterministically) resolves
  // to the same entry and hits at threshold — leak-free without breaking the guard.
  errstore.record(dd, pk, { command: cmd, cause, now: now++ });
  const l = errstore.lookup(dd, pk, cmd, { now, threshold: 2 });
  assert(l.hit && !l.sig.includes(SECRET) && !(l.cause || '').includes(SECRET),
    'lookup hits with a redacted sig/cause (stable + leak-free)');
});

// ─── policy-store (deterministic always-apply POLICY injection registry) ─────
const polstore = require(path.join(SCRIPTS, 'lib', 'policy-store.js'));
const freshPolDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-polstore-'));

test('policy-store: activate stores a REDACTED, capped record and list returns it for the project', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX';
  const r = polstore.activate(dd, { text: `never let errors pass token ${SECRET}`, scope: 'project', projectId: 'acme/api', now });
  assertEq([r.activated, typeof r.id, /^[0-9a-f]{64}$/.test(r.sig)], [true, 'string', true]);
  const active = polstore.list(dd, { projectId: 'acme/api' });
  assertEq(active.length, 1);
  const rec = active[0];
  // The stored (and injected) text must NOT carry the raw secret, and must be capped.
  assert(!JSON.stringify(rec).includes(SECRET), `policy text must be redacted, got: ${rec.text}`);
  assert(rec.text.includes('[GH_TOKEN]'), 'redaction replaces the token with a placeholder');
  assert(rec.text.length <= polstore.MAX_POLICY_CHARS, 'stored text is capped');
  assertEq([rec.mode, rec.scope, rec.projectId], ['always', 'project', 'acme/api']);
});

test('policy-store: user-scope is visible from any project; project-scope is NOT cross-visible', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  polstore.activate(dd, { text: 'project rule', scope: 'project', projectId: 'acme/api', now: now++ });
  polstore.activate(dd, { text: 'global rule', scope: 'user', projectId: '', now: now++ });
  // The project policy is scoped to acme/api; the user policy applies everywhere.
  const here = polstore.list(dd, { projectId: 'acme/api' }).map(r => r.text);
  const elsewhere = polstore.list(dd, { projectId: 'other/x' }).map(r => r.text);
  assertEq(here.sort(), ['global rule', 'project rule']);
  assertEq(elsewhere, ['global rule']);
});

test('policy-store: deactivate removes the record (idempotent second call)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const r = polstore.activate(dd, { text: 'temp rule', scope: 'project', projectId: 'z', now });
  assertEq(polstore.list(dd, { projectId: 'z' }).length, 1);
  assertEq(polstore.deactivate(dd, r.id), { deactivated: true, id: r.id });
  assertEq(polstore.list(dd, { projectId: 'z' }).length, 0);
  // Second deactivate is a no-op, not a false success.
  assertEq(polstore.deactivate(dd, r.id), { deactivated: false, id: r.id });
});

test('policy-store: budget — activating past maxPolicies is refused and NOT stored', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) {
    assertEq(polstore.activate(dd, { text: `rule ${i}`, scope: 'project', projectId: 'z', now: now++ }, { maxPolicies: 3, maxChars: 99999 }).activated, true);
  }
  const over = polstore.activate(dd, { text: 'rule 4', scope: 'project', projectId: 'z', now: now++ }, { maxPolicies: 3, maxChars: 99999 });
  assertEq(over, { activated: false, reason: 'budget' });
  // Refusal must not have stored the 4th policy.
  assertEq(polstore.list(dd, { projectId: 'z' }).length, 3);
});

test('policy-store: budget — total-chars overflow is refused (no silent truncation)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const big = 'x'.repeat(300);
  const r = polstore.activate(dd, { text: big, scope: 'project', projectId: 'z', now }, { maxPolicies: 10, maxChars: 200 });
  assertEq(r, { activated: false, reason: 'budget' });
  assertEq(polstore.list(dd, { projectId: 'z' }).length, 0);
});

test('policy-store: empty/whitespace text is refused', () => {
  const dd = freshPolDataDir();
  assertEq(polstore.activate(dd, { text: '   ', scope: 'project', projectId: 'z' }), { activated: false, reason: 'empty' });
  assertEq(polstore.activate(dd, { text: '', scope: 'user', projectId: '' }), { activated: false, reason: 'empty' });
});

test('policy-store: corrupt registry → loadResult.corrupt===true and list returns []', () => {
  const dd = freshPolDataDir();
  fs.mkdirSync(path.join(dd, 'policies'), { recursive: true });
  fs.writeFileSync(polstore.storePath(dd), 'not json {{{');
  const lr = polstore.loadResult(dd);
  assertEq(lr.corrupt, true);
  assertEq(polstore.list(dd, { projectId: 'z' }), []);
});

test('policy-store: re-activating the same entryId UPSERTS (no duplicate)', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  polstore.activate(dd, { entryId: 'kb-42', text: 'first', scope: 'project', projectId: 'z', now: now++ });
  polstore.activate(dd, { entryId: 'kb-42', text: 'second', scope: 'project', projectId: 'z', now: now++ });
  const active = polstore.list(dd, { projectId: 'z' });
  assertEq(active.length, 1);
  assertEq(active[0].text, 'second');
});

// ─── glob-match (ReDoS-safe SEGMENT matcher for glob-scoped policies, micro-3) ─
const globm = require(path.join(SCRIPTS, 'lib', 'glob-match.js'));

test('glob-match: basename fallback — *.ts matches app.ts AND src/app.ts', () => {
  assertEq([globm.matchGlob('*.ts', 'app.ts'), globm.matchGlob('*.ts', 'src/app.ts')], [true, true]);
});

test('glob-match: src/** matches nested + shallow, rejects a sibling dir', () => {
  assertEq([
    globm.matchGlob('src/**', 'src/a/b.ts'),
    globm.matchGlob('src/**', 'src/x.ts'),
    globm.matchGlob('src/**', 'lib/x.ts'),
  ], [true, true, false]);
});

test('glob-match: src/**/*.ts matches .ts under src, rejects .js', () => {
  assertEq([
    globm.matchGlob('src/**/*.ts', 'src/a/b.ts'),
    globm.matchGlob('src/**/*.ts', 'src/a/b.js'),
  ], [true, false]);
});

test('glob-match: a/*/c — single-star segment consumes EXACTLY one dir', () => {
  assertEq([globm.matchGlob('a/*/c', 'a/b/c'), globm.matchGlob('a/*/c', 'a/b/d/c')], [true, false]);
});

test('glob-match: ** matches anything; ? matches exactly one char', () => {
  assertEq([
    globm.matchGlob('**', 'a/b/c'),
    globm.matchGlob('**', 'x'),
    globm.matchGlob('?', 'a'),
    globm.matchGlob('?', 'ab'),
    globm.matchGlob('?', ''),
  ], [true, true, true, false, false]);
});

test('glob-match: ** consumes ZERO directories (src/** matches src)', () => {
  assertEq(globm.matchGlob('src/**', 'src'), true);
});

test('glob-match: Windows backslash input normalizes on BOTH sides', () => {
  assertEq([
    globm.matchGlob('src/api/**', 'src\\api\\x.ts'),
    globm.matchGlob('src\\api\\**', 'src/api/x.ts'),
  ], [true, true]);
});

test('glob-match: leading ./ is stripped on both glob and path', () => {
  assertEq([globm.matchGlob('./src/**', 'src/a.ts'), globm.matchGlob('src/**', './src/a.ts')], [true, true]);
});

test('glob-match: anyGlobMatches / firstGlobMatch (deterministic first)', () => {
  assertEq(globm.anyGlobMatches(['docs/**', '*.md'], 'README.md'), true);
  assertEq(globm.anyGlobMatches(['docs/**'], 'src/a.ts'), false);
  assertEq(globm.firstGlobMatch(['docs/**', 'src/**'], 'src/a.ts'), 'src/**');
  assertEq(globm.firstGlobMatch(['*.md'], 'a.ts'), null);
  assertEq(globm.anyGlobMatches('not-array', 'a'), false);
});

test('glob-match: ADVERSARIAL pathological glob returns quickly (no ReDoS)', () => {
  const evil = '*a'.repeat(30) + 'b';   // regex-from-glob would backtrack pathologically
  const hay = 'a'.repeat(2000);          // long, never-matching (no trailing 'b')
  const t0 = Date.now();
  const res = globm.matchGlob(evil, hay);
  const dt = Date.now() - t0;
  assertEq(res, false);
  assert(dt < 1000, `matcher must be polynomial, took ${dt}ms`);
});

// ─── policy-store glob-scoped extensions (Phase 2 micro-3) ───────────────────
test('policy-store: glob activate stores mode:glob with CANONICAL (sorted+deduped) globs', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const r = polstore.activate(dd, { text: 'no console.log in src', projectId: 'acme/api', globs: ['src/**/*.ts', 'src/**/*.ts', 'docs/**'], now });
  assertEq([r.activated, r.mode], [true, 'glob']);
  const rec = polstore.loadResult(dd).records[r.id];
  assertEq([rec.mode, rec.scope, rec.projectId], ['glob', 'project', 'acme/api']);
  assertEq(rec.globs, ['docs/**', 'src/**/*.ts']); // sorted + deduped
});

test('policy-store: glob activate FORCES project scope even when scope:user is passed', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const r = polstore.activate(dd, { text: 'rule', scope: 'user', projectId: 'z', globs: ['*.ts'], now });
  assertEq(r.activated, true);
  assertEq(polstore.loadResult(dd).records[r.id].scope, 'project');
});

test('policy-store: listAlways EXCLUDES glob policies; listVisible INCLUDES both', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  polstore.activate(dd, { text: 'always rule', projectId: 'z', now: now++ });
  polstore.activate(dd, { text: 'glob rule', projectId: 'z', globs: ['src/**'], now: now++ });
  assertEq(polstore.listAlways(dd, { projectId: 'z' }).map(r => r.text), ['always rule']);
  assertEq(polstore.listVisible(dd, { projectId: 'z' }).map(r => r.text).sort(), ['always rule', 'glob rule']);
});

test('policy-store: a glob policy is NEVER returned by listAlways (SessionStart leak guard)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  polstore.activate(dd, { text: 'glob only', projectId: 'z', globs: ['**'], now });
  assertEq(polstore.listAlways(dd, { projectId: 'z' }), []);
});

test('policy-store: legacy record with missing mode is treated as always', () => {
  const dd = freshPolDataDir();
  fs.mkdirSync(path.join(dd, 'policies'), { recursive: true });
  fs.writeFileSync(polstore.storePath(dd), JSON.stringify({ records: {
    legacy: { id: 'legacy', scope: 'project', projectId: 'z', text: 'legacy rule', activatedAt: 1 },
  } }));
  assertEq(polstore.listAlways(dd, { projectId: 'z' }).map(r => r.text), ['legacy rule']);
});

test('policy-store: listGlobMatching returns only path-matching glob policies for the project', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  polstore.activate(dd, { text: 'ts rule', projectId: 'proj', globs: ['src/**/*.ts'], now: now++ });
  polstore.activate(dd, { text: 'docs rule', projectId: 'proj', globs: ['docs/**'], now: now++ });
  polstore.activate(dd, { text: 'always', projectId: 'proj', now: now++ }); // always → never surfaces here
  assertEq(polstore.listGlobMatching(dd, { projectId: 'proj', filePath: 'src/a/b.ts' }).map(r => r.text), ['ts rule']);
  assertEq(polstore.listGlobMatching(dd, { projectId: 'proj', filePath: 'lib/x.ts' }), []);
});

test('policy-store: listGlobMatching is project-scoped (no cross-project leak)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  polstore.activate(dd, { text: 'projA rule', projectId: 'projA', globs: ['**'], now });
  assertEq(polstore.listGlobMatching(dd, { projectId: 'projB', filePath: 'x.ts' }), []);
});

test('policy-store: invalid/empty globs → {activated:false, reason:invalid-globs}, NOTHING stored (atomic)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  for (const bad of [[], ['   '], 'not-array', [''], ['x'.repeat(201)]]) {
    assertEq(polstore.activate(dd, { text: 'rule', projectId: 'z', globs: bad, now }), { activated: false, reason: 'invalid-globs' });
  }
  const tooMany = Array.from({ length: 21 }, (_, i) => `d${i}/**`);
  assertEq(polstore.activate(dd, { text: 'rule', projectId: 'z', globs: tooMany, now }), { activated: false, reason: 'invalid-globs' });
  // No always fallback, no partial glob record — registry stays empty.
  assertEq(Object.keys(polstore.loadResult(dd).records).length, 0);
});

test('policy-store: different glob SETS on the same text produce DIFFERENT ids (no overwrite)', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const a = polstore.activate(dd, { text: 'same text', projectId: 'z', globs: ['src/**'], now });
  const b = polstore.activate(dd, { text: 'same text', projectId: 'z', globs: ['docs/**'], now });
  assert(a.id !== b.id, `distinct glob sets must not collide: ${a.id} vs ${b.id}`);
  assertEq(polstore.listVisible(dd, { projectId: 'z' }).length, 2);
});

test('policy-store: glob budget — activating past MAX_GLOB_POLICIES_PER_PROJECT is refused', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  const MAX = polstore.MAX_GLOB_POLICIES_PER_PROJECT;
  for (let i = 0; i < MAX; i++) {
    assertEq(polstore.activate(dd, { text: `rule ${i}`, projectId: 'z', globs: [`d${i}/**`], now: now++ }).activated, true);
  }
  assertEq(polstore.activate(dd, { text: 'one too many', projectId: 'z', globs: ['extra/**'], now: now++ }), { activated: false, reason: 'budget' });
  assertEq(polstore.activeGlob(polstore.loadResult(dd).records, 'z').length, MAX);
});

test('policy-store: glob policy budget is SEPARATE from the always budget', () => {
  const dd = freshPolDataDir(); let now = 1_700_000_000_000;
  // Fill the always budget to its max; a glob policy must still activate.
  for (let i = 0; i < 3; i++) {
    assertEq(polstore.activate(dd, { text: `always ${i}`, projectId: 'z', now: now++ }, { maxPolicies: 3, maxChars: 99999 }).activated, true);
  }
  const g = polstore.activate(dd, { text: 'glob one', projectId: 'z', globs: ['src/**'], now: now++ }, { maxPolicies: 3, maxChars: 99999 });
  assertEq(g.activated, true);
  // And the glob policy did not consume an always slot: a 4th always is still refused.
  assertEq(polstore.activate(dd, { text: 'always 4', projectId: 'z', now: now++ }, { maxPolicies: 3, maxChars: 99999 }).reason, 'budget');
});

test('policy-store: glob policy text is REDACTED before storage', () => {
  const dd = freshPolDataDir(); const now = 1_700_000_000_000;
  const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX';
  const r = polstore.activate(dd, { text: `avoid leaking ${SECRET}`, projectId: 'z', globs: ['**'], now });
  const rec = polstore.loadResult(dd).records[r.id];
  assert(!JSON.stringify(rec).includes(SECRET), `glob policy text must be redacted, got: ${rec.text}`);
});

test('policy-store: toRelPath — inside-project normalizes; outside/other-drive/empty → null', () => {
  assertEq(polstore.toRelPath('src\\a\\b.ts'), 'src/a/b.ts');       // relative input normalized
  assertEq(polstore.toRelPath('./src/a.ts'), 'src/a.ts');           // leading ./ stripped
  const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const inside = process.platform === 'win32' ? 'C:\\proj\\src\\a.ts' : '/proj/src/a.ts';
  const outside = process.platform === 'win32' ? 'D:\\other\\a.ts' : '/other/a.ts';
  assertEq(polstore.toRelPath(inside, cwd), 'src/a.ts');            // absolute inside cwd → rel
  assertEq(polstore.toRelPath(outside, cwd), null);                 // outside / other drive → null
  assertEq(polstore.toRelPath('', cwd), null);                      // empty → null
});

// ─── policy shadow-assertion + shipped bug fixes (Phase 3 micro-A) ───────────
const shadowHook = require(path.join(SCRIPTS, 'policy-enforce-shadow.js'));
const { metricsProjectKey } = require(path.join(SCRIPTS, 'lib', 'metrics-project.js'));
const SHADOW_CWD = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const shadowAssert = (extra) => ({ kind: 'forbid-added-literal', literal: 'console.log', ...(extra || {}) });

// — shipped bug #1: toRelPath must reject a RELATIVE ../escape (pre-fix returned it) —
test('policy-store: toRelPath rejects a RELATIVE ../escape and keeps inside paths (shipped bug fix)', () => {
  assertEq(polstore.toRelPath('../outside.js', SHADOW_CWD), null);   // relative escape → null (was returned unchanged)
  assertEq(polstore.toRelPath('src/a.js', SHADOW_CWD), 'src/a.js');  // inside stays
  const inside = process.platform === 'win32' ? 'C:\\proj\\src\\a.js' : '/proj/src/a.js';
  const other = process.platform === 'win32' ? 'D:\\o\\a.js' : '/other/a.js';
  assertEq(polstore.toRelPath(inside, SHADOW_CWD), 'src/a.js');      // absolute inside → rel
  assertEq(polstore.toRelPath(other, SHADOW_CWD), null);            // other drive / outside → null
});

// — shipped bug #2: activate must honor save() and refuse a corrupt registry —
test('policy-store: activate surfaces {reason:persist} when save() cannot write (shipped bug fix)', () => {
  const dd = freshPolDataDir();
  // Plant a FILE where the registry DIR must be → writeJsonAtomic mkdir fails → save()=false.
  fs.writeFileSync(path.join(dd, 'policies'), 'x');
  assertEq(polstore.activate(dd, { text: 'rule', projectId: 'z', now: 1 }), { activated: false, reason: 'persist' });
});

test('policy-store: activate REFUSES up-front on a corrupt registry (never overwrites it)', () => {
  const dd = freshPolDataDir();
  fs.mkdirSync(path.join(dd, 'policies'), { recursive: true });
  const reg = path.join(dd, 'policies', 'registry.json');
  fs.writeFileSync(reg, '{ this is not json');
  assertEq(polstore.activate(dd, { text: 'rule', projectId: 'z', now: 1 }), { activated: false, reason: 'corrupt' });
  assertEq(fs.readFileSync(reg, 'utf-8'), '{ this is not json'); // nothing stored — corrupt bytes untouched
});

// — finding #4 (LWW window narrowed): mutate() re-reads the FRESHEST on-disk state —
test('policy-store: mutate() applies its change to the FRESHEST on-disk state (narrows the lost-update window)', () => {
  const dd = freshPolDataDir();
  const rec = (id) => ({ id, entryId: null, mode: 'always', scope: 'project', projectId: 'z', text: id, sourceHash: id, activatedAt: 1 });
  assert(polstore.save(dd, { records: { A: rec('A') } }), 'seed record A on disk');

  // Model a CONCURRENT writer that lands record C AFTER mutate() is entered but BEFORE
  // its read: an io.loadResult that (once) writes C, then returns the fresh load. If the
  // read were a stale top-of-function snapshot ({A}), the subsequent write would clobber
  // C; because mutate() reads LATE, C is present and survives.
  let injected = false;
  const io = {
    loadResult: (d) => {
      if (!injected) { injected = true; const cur = polstore.loadResult(d); cur.records.C = rec('C'); polstore.save(d, { records: cur.records }); }
      return polstore.loadResult(d);
    },
  };
  const out = polstore.mutate(dd, (loaded) => { loaded.records.B = rec('B'); return { commit: true, result: 'ok' }; }, io);
  assertEq([out.saved, out.result], [true, 'ok'], 'commit:true persists and passes the result through');
  assertEq(Object.keys(polstore.loadResult(dd).records).sort(), ['A', 'B', 'C'],
    'B is written on top of the concurrent {A,C} — C is NOT lost to a stale snapshot');

  // commit:false must write nothing and surface {saved:null, result}.
  const noop = polstore.mutate(dd, () => ({ commit: false, result: 42 }));
  assertEq([noop.saved, noop.result], [null, 42], 'commit:false → no write, result surfaced');
  assertEq(Object.keys(polstore.loadResult(dd).records).sort(), ['A', 'B', 'C'], 'commit:false left the store untouched');
});

test('policy-store: activate() routes its read through the io seam so a CONCURRENT activation is not clobbered', () => {
  const dd = freshPolDataDir();
  assertEq(polstore.activate(dd, { entryId: 'p1', text: 'rule one', projectId: 'zc', now: 1 }).activated, true);

  // While p3 is being activated, a concurrent writer activates p2 (a real save) right
  // before the LATE read. Pre-fix, activate() captured its records snapshot at
  // function-top and would DROP p2; routing the read through mutate(io) means p3 is
  // written on top of {p1,p2}, so all three survive.
  let injected = false;
  const io = {
    loadResult: (d) => {
      if (!injected) { injected = true; polstore.activate(d, { entryId: 'p2', text: 'rule two', projectId: 'zc', now: 2 }); }
      return polstore.loadResult(d);
    },
  };
  const r3 = polstore.activate(dd, { entryId: 'p3', text: 'rule three', projectId: 'zc', now: 3 }, {}, io);
  assertEq(r3.activated, true, 'p3 activated');
  const ids = polstore.listVisible(dd, { projectId: 'zc' }).map((r) => r.id).sort();
  assertEq(ids, ['p1', 'p2', 'p3'], 'the concurrent p2 survives alongside p1 and p3 (no lost update)');
});

test('policy-store: shadow-assertion activate stores activationId + enforcement:shadow (caseSensitive default true)', () => {
  const dd = freshPolDataDir();
  const r = polstore.activate(dd, { entryId: 'sh1', text: 'no console.log in prod', projectId: 'z', globs: ['src/**'], assert: shadowAssert(), enforcement: 'shadow', now: 1 });
  assertEq([r.activated, r.mode, r.enforcement, /^[0-9a-f]{24}$/.test(r.activationId)], [true, 'glob', 'shadow', true]);
  const rec = polstore.loadResult(dd).records[r.id];
  assertEq([rec.enforcement, rec.assert.kind, rec.assert.literal, rec.assert.caseSensitive], ['shadow', 'forbid-added-literal', 'console.log', true]);
  assertEq(rec.activationId, r.activationId);
});

test('policy-store: shadow — a wrong assert.kind is refused (bad-assert-kind, nothing stored)', () => {
  const dd = freshPolDataDir();
  assertEq(polstore.activate(dd, { entryId: 'shK', text: 't', projectId: 'z', globs: ['**'], assert: { kind: 'nope', literal: 'x' }, enforcement: 'shadow', now: 1 }),
    { activated: false, reason: 'bad-assert-kind' });
  assertEq(Object.keys(polstore.loadResult(dd).records).length, 0);
});

test('policy-store: shadow — oversized literal → literal-too-long (nothing stored, no truncation)', () => {
  const dd = freshPolDataDir();
  const big = 'x'.repeat(polstore.MAX_LITERAL_CHARS + 1);
  assertEq(polstore.activate(dd, { entryId: 'shBig', text: 'big', projectId: 'z', globs: ['**'], assert: shadowAssert({ literal: big }), enforcement: 'shadow', now: 1 }),
    { activated: false, reason: 'literal-too-long' });
  assertEq(Object.keys(polstore.loadResult(dd).records).length, 0);
});

test('policy-store: shadow — secret-bearing literal is REJECTED (sensitive-literal), never stored unredacted', () => {
  const dd = freshPolDataDir();
  const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX';
  assertEq(polstore.activate(dd, { entryId: 'shTok', text: 't', projectId: 'z', globs: ['**'], assert: shadowAssert({ literal: SECRET }), enforcement: 'shadow', now: 1 }),
    { activated: false, reason: 'sensitive-literal' });
  const raw = JSON.stringify(polstore.loadResult(dd).records);
  assert(!raw.includes(SECRET) && raw === '{}', 'a secret literal is neither stored nor leaked');
});

test('policy-store: shadow — enforcement must be shadow this micro (enforce → unsupported-enforcement)', () => {
  const dd = freshPolDataDir();
  assertEq(polstore.activate(dd, { entryId: 'shEnf', text: 't', projectId: 'z', globs: ['**'], assert: shadowAssert(), enforcement: 'enforce', now: 1 }),
    { activated: false, reason: 'unsupported-enforcement' });
  assertEq(Object.keys(polstore.loadResult(dd).records).length, 0);
});

test('policy-store: shadow budget is SEPARATE and capped at MAX_SHADOW_POLICIES_PER_PROJECT', () => {
  const dd = freshPolDataDir(); let now = 1;
  for (let i = 0; i < polstore.MAX_SHADOW_POLICIES_PER_PROJECT; i++) {
    assertEq(polstore.activate(dd, { entryId: 'shb' + i, text: 'r' + i, projectId: 'z', globs: ['src/' + i + '/**'], assert: shadowAssert(), enforcement: 'shadow', now: now++ }).activated, true);
  }
  assertEq(polstore.activate(dd, { entryId: 'shbX', text: 'rX', projectId: 'z', globs: ['x/**'], assert: shadowAssert(), enforcement: 'shadow', now: now++ }),
    { activated: false, reason: 'budget' });
  assertEq(polstore.activeShadow(polstore.loadResult(dd).records, 'z').length, polstore.MAX_SHADOW_POLICIES_PER_PROJECT);
});

test('policy-store: shadow upsert REUSES activationId for the same definition, MINTS a new one when the literal changes', () => {
  const dd = freshPolDataDir(); let now = 1;
  const a1 = polstore.activate(dd, { entryId: 'up', text: 'r', projectId: 'z', globs: ['src/**'], assert: shadowAssert({ literal: 'AAA' }), enforcement: 'shadow', now: now++ });
  const a2 = polstore.activate(dd, { entryId: 'up', text: 'r', projectId: 'z', globs: ['src/**'], assert: shadowAssert({ literal: 'AAA' }), enforcement: 'shadow', now: now++ });
  assertEq(a2.activationId, a1.activationId); // unchanged definition → REUSE the telemetry key
  const a3 = polstore.activate(dd, { entryId: 'up', text: 'r', projectId: 'z', globs: ['src/**'], assert: shadowAssert({ literal: 'BBB' }), enforcement: 'shadow', now: now++ });
  assert(a3.activationId !== a1.activationId, 'a changed literal is a new definition → new activationId');
  assertEq(Object.keys(polstore.loadResult(dd).records).length, 1); // same id → upsert, not a fork
});

test('policy-store: listShadowMatching returns ONLY shadow+matching records (excludes plain-glob and non-shadow enforcement)', () => {
  const dd = freshPolDataDir(); let now = 1;
  const sh = polstore.activate(dd, { entryId: 'lm-shadow', text: 'shadow rule', projectId: 'proj', globs: ['src/**'], assert: shadowAssert(), enforcement: 'shadow', now: now++ });
  polstore.activate(dd, { entryId: 'lm-plain', text: 'plain glob', projectId: 'proj', globs: ['src/**'], now: now++ }); // plain glob (no assert) → excluded
  // Hand-craft a legacy record: assert present but enforcement !== 'shadow' → MUST be excluded.
  const { records } = polstore.loadResult(dd);
  records['lm-legacy'] = { id: 'lm-legacy', entryId: 'lm-legacy', mode: 'glob', scope: 'project', projectId: 'proj', text: 'legacy', globs: ['src/**'], assert: { kind: 'forbid-added-literal', literal: 'x', caseSensitive: true }, enforcement: 'enforce', activationId: 'deadbeefdeadbeefdeadbeef', sourceHash: 'x', activatedAt: now++ };
  polstore.save(dd, { records });
  assertEq(polstore.listShadowMatching(dd, { projectId: 'proj', filePath: 'src/a.ts', cwd: SHADOW_CWD }).map(r => r.id), [sh.id]);
  assertEq(polstore.listShadowMatching(dd, { projectId: 'proj', filePath: 'lib/x.ts', cwd: SHADOW_CWD }), []); // non-matching path → none
});

test('policy-shadow: countOccurrences counts NON-OVERLAPPING and respects caseSensitive', () => {
  const c = shadowHook.countOccurrences;
  assertEq(c('a console.log b console.log', 'console.log', true), 2);
  assertEq(c('aaaa', 'aa', true), 2);                  // non-overlapping (not 3)
  assertEq(c('CONSOLE.LOG', 'console.log', true), 0);  // case-sensitive miss
  assertEq(c('CONSOLE.LOG', 'console.log', false), 1); // case-insensitive hit
  assertEq(c('anything', '', true), 0);                // empty needle → 0
});

test('policy-shadow: outcome is NET-COUNT-INCREASE (preserve=pass, add=trigger) — not includes()', () => {
  const c = shadowHook.countOccurrences;
  const lit = 'console.log';
  // PRESERVE: literal present before AND after with the SAME count → NOT a trigger. Under an
  // includes()-based rule this would falsely fire — this is the (a) mutation-guard invariant.
  assert(!(c('x console.log y', lit, true) > c('a console.log b', lit, true)), 'preserved literal (1→1) is a pass');
  assert(c('console.log', lit, true) > c('nothing', lit, true), 'added literal (0→1) is a trigger');
  assert(c('console.log console.log', lit, true) > c('console.log', lit, true), 'added literal (1→2) is a trigger');
});

test('metrics-project: metricsProjectKey is stable + path-safe (no separators) for the same cwd', () => {
  const k1 = metricsProjectKey(SHADOW_CWD);
  assertEq(k1, metricsProjectKey(SHADOW_CWD));            // stable across calls
  assert(/^[0-9a-f]{16}$/.test(k1), `path-safe 16-hex (no / \\ :), got: ${k1}`);
});

test('metrics-store: getEvaluationCounts aggregates EXACT per-(activationId,outcome) counts past 500 (no log cap)', () => {
  const ms = require(path.join(SCRIPTS, 'lib', 'metrics-store.js'));
  const project = 'evalcounts-' + Date.now();
  assert(ms.init({ project }), 'metrics db init');
  try {
    const plan = [['AA', 'trigger', 200], ['AA', 'pass', 150], ['BB', 'trigger', 100], ['BB', 'pass', 100], ['BB', 'unevaluable', 50]];
    let total = 0;
    for (const [aid, outcome, n] of plan) {
      for (let i = 0; i < n; i++) { ms.recordMetric('policy.shadow.evaluated', { schema: 1, activationId: aid, outcome }, 's'); total++; }
    }
    assertEq(total, 600); // inserted MORE than the 500-row event-log cap
    const rows = ms.getEvaluationCounts({ eventName: 'policy.shadow.evaluated', sinceTs: 0 });
    const cell = (aid, o) => (rows.find(r => r.activationId === aid && r.outcome === o) || {}).count;
    assertEq([cell('AA', 'trigger'), cell('AA', 'pass'), cell('BB', 'trigger'), cell('BB', 'pass'), cell('BB', 'unevaluable')], [200, 150, 100, 100, 50]);
    assertEq(rows.reduce((s, r) => s + r.count, 0), 600); // EXACT total — SQL GROUP BY, not truncated at 500
    // Isolated (throwaway-connection) read of the SAME project sees identical tallies.
    const iso = ms.getEvaluationCountsIsolated(project, { eventName: 'policy.shadow.evaluated', sinceTs: 0 });
    assertEq(iso.reduce((s, r) => s + r.count, 0), 600);
    // Windowing: a future sinceTs excludes everything (honest empty).
    assertEq(ms.getEvaluationCounts({ eventName: 'policy.shadow.evaluated', sinceTs: Date.now() + 3_600_000 }), []);
  } finally {
    ms.close();
  }
});

// ─── curation-reconcile (Stop-hook blocked-entry reconciliation) ─────────────
const reconcile = require(path.join(SCRIPTS, 'lib', 'curation-reconcile.js'));

test('curation-reconcile: one-hit-marked entries drop from pending (mid-retry mark)', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  oneoff.mark(dd, pk, { sigs: ['npm test 2'], now, maxRecurrence: 3 });
  const store = oneoff.load(dd, pk);
  const entries = [
    { command: 'CLAUDE_SKIP_EMBED_WARM=1 npm test 2>&1 | tail -40', sig: 'npm test 2', curatedScript: null, reason: 'needs-curation' },
    { command: 'git diff HEAD~3', sig: 'git diff HEAD~3', curatedScript: null, reason: 'needs-curation' },
  ];
  const { pending, resolved } = reconcile.reconcileEntries(entries, { store, now });
  assertEq(pending.length, 1);
  assertEq(pending[0].sig, 'git diff HEAD~3');
  assertEq(resolved.length, 1);
});
test('curation-reconcile: all entries resolved → pending empty (release path)', () => {
  const dd = freshDataDir(); const pk = 'p'; const now = 1_700_000_000_000;
  oneoff.mark(dd, pk, { sigs: ['npm test 2', 'git ls-files'], now, maxRecurrence: 3 });
  const store = oneoff.load(dd, pk);
  const entries = [
    { command: 'npm test 2>&1', sig: 'npm test 2', curatedScript: null },
    { command: 'git ls-files | grep x', sig: 'git ls-files', curatedScript: null },
  ];
  assertEq(reconcile.reconcileEntries(entries, { store, now }).pending.length, 0);
});
test('curation-reconcile: newly-curated command resolves; refine entries stay pending', () => {
  const store = { entries: {} }; // no one-hit markings
  const matchShell = (cmd) => (/^npm run build/.test(cmd) ? { id: 'build' } : null);
  const entries = [
    { command: 'npm run build', sig: 'npm run build', curatedScript: null, reason: 'needs-curation' },
    // Already-curated entry (refine case): a shells match must NOT resolve it.
    { command: 'node .vscode/scripts/build.mjs', sig: 'node .vscode/scripts/build.mjs', curatedScript: '.vscode/scripts/build.mjs', reason: 'curated-success-noisy' },
  ];
  const { pending, resolved } = reconcile.reconcileEntries(entries, { store, matchShell });
  assertEq(resolved.length, 1);
  assertEq(resolved[0].sig, 'npm run build');
  assertEq(pending.length, 1);
  assertEq(pending[0].curatedScript, '.vscode/scripts/build.mjs');
});
test('curation-reconcile: no markings, no shells → everything stays pending (regression)', () => {
  const entries = [
    { command: 'npm test', sig: 'npm test', curatedScript: null },
    { command: 'git log', sig: 'git log', curatedScript: null },
  ];
  const { pending, resolved } = reconcile.reconcileEntries(entries, { store: { entries: {} } });
  assertEq(pending.length, 2);
  assertEq(resolved.length, 0);
});

// ─── shell-register (curation_register_shell backing module) ─────────────────
const shellRegister = require(path.join(SCRIPTS, 'lib', 'shell-register.js'));
const freshProjectRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-shellreg-'));
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'shells.json'), JSON.stringify({ version: 1, shells: [] }, null, 2));
  return dir;
};

test('shell-register: creates script + entry when shells.json already has version/shells', () => {
  const root = freshProjectRoot();
  const res = shellRegister.register({
    id: 'grep-file', scriptPath: '.vscode/scripts/grep-file.mjs', content: '#!/usr/bin/env node\nconsole.log("OK  0 matches (0ms)");\n',
    aliases: ['grep -n foo'], cwd: root,
  });
  assertEq(res.decision, 'registered');
  assert(fs.existsSync(path.join(root, '.vscode', 'scripts', 'grep-file.mjs')), 'script file written');
  const shells = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'shells.json'), 'utf-8'));
  assertEq(shells.shells.length, 1);
  assertEq(shells.shells[0].id, 'grep-file');
  assertEq(shells.shells[0].command, '.vscode/scripts/grep-file.mjs');
  assertEq(shells.shells[0].aliases, ['grep -n foo']);
});

test('shell-register: creates shells.json from scratch when missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-shellreg-'));
  const res = shellRegister.register({
    id: 'foo', scriptPath: '.vscode/scripts/foo.mjs', content: 'console.log("OK  x (0ms)");\n',
    aliases: ['npm run foo'], cwd: root,
  });
  assertEq(res.decision, 'registered');
  const shells = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'shells.json'), 'utf-8'));
  assertEq(shells.shells.length, 1);
});

test('shell-register: same id twice updates in place, no duplicate', () => {
  const root = freshProjectRoot();
  shellRegister.register({ id: 'dup', scriptPath: '.vscode/scripts/dup.mjs', content: 'v1', aliases: ['npm run dup'], cwd: root });
  const res2 = shellRegister.register({ id: 'dup', scriptPath: '.vscode/scripts/dup.mjs', content: 'v2', aliases: ['npm run dup2'], cwd: root });
  assertEq(res2.decision, 'updated');
  const shells = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'shells.json'), 'utf-8'));
  assertEq(shells.shells.length, 1);
  assertEq(shells.shells[0].aliases, ['npm run dup2']);
  assertEq(fs.readFileSync(path.join(root, '.vscode', 'scripts', 'dup.mjs'), 'utf-8'), 'v2');
});

test('shell-register: rejects generic alias (D4 parity with curation_mark_oneoff)', () => {
  const root = freshProjectRoot();
  const res = shellRegister.register({ id: 'x', scriptPath: '.vscode/scripts/x.mjs', content: 'c', aliases: ['git'], cwd: root });
  assert(res.isError, 'expected isError');
  assert(/alias too broad/.test(res.message), `got: ${res.message}`);
});

test('shell-register: rejects missing required fields', () => {
  const root = freshProjectRoot();
  assert(shellRegister.register({ scriptPath: '.vscode/scripts/x.mjs', content: 'c', aliases: ['npm run x'], cwd: root }).isError, 'missing id');
  assert(shellRegister.register({ id: 'x', content: 'c', aliases: ['npm run x'], cwd: root }).isError, 'missing scriptPath');
  assert(shellRegister.register({ id: 'x', scriptPath: '.vscode/scripts/x.mjs', aliases: ['npm run x'], cwd: root }).isError, 'missing content');
  assert(shellRegister.register({ id: 'x', scriptPath: '.vscode/scripts/x.mjs', content: 'c', aliases: [], cwd: root }).isError, 'empty aliases');
});

test('shell-register: rejects scriptPath escaping the scripts dir', () => {
  const root = freshProjectRoot();
  const res = shellRegister.register({ id: 'escape', scriptPath: '.vscode/scripts/../../outside.mjs', content: 'c', aliases: ['npm run escape'], cwd: root });
  assert(res.isError, 'expected isError for path traversal');
  assert(!fs.existsSync(path.join(root, '..', 'outside.mjs')), 'no file written outside project root');
});

test('shell-register: shells.json stays pretty-printed (2-space indent)', () => {
  const root = freshProjectRoot();
  shellRegister.register({ id: 'pretty', scriptPath: '.vscode/scripts/pretty.mjs', content: 'c', aliases: ['npm run pretty'], cwd: root });
  const raw = fs.readFileSync(path.join(root, '.vscode', 'shells.json'), 'utf-8');
  assert(raw.includes('\n  "version"') || raw.includes('\n  "shells"'), `expected 2-space indent, got: ${raw.slice(0, 80)}`);
  JSON.parse(raw); // must still be valid JSON
});

// ─── capture-rate (nudge→capture conversion) ──────────────────────────────────
const capRate = require(path.join(SCRIPTS, 'lib', 'capture-rate.js'));

test('capture-rate: nudge converted by following capture → rate 1', () => {
  const r = capRate.aggregateCaptureRate([
    { eventName: 'nudge.emitted', payload: { kind: 'correction' }, project: 'p', ts: 1 },
    { eventName: 'lesson.captured', payload: { type: 'lesson' }, project: 'p', ts: 2 },
  ]);
  assertEq([r.byKind.correction.nudges, r.byKind.correction.captures, r.byKind.correction.rate], [1, 1, 1]);
});
test('capture-rate: nudge with no capture → rate 0', () => {
  const r = capRate.aggregateCaptureRate([
    { eventName: 'nudge.emitted', payload: { kind: 'decision' }, project: 'p', ts: 1 },
  ]);
  assertEq([r.byKind.decision.nudges, r.byKind.decision.captures, r.byKind.decision.rate], [1, 0, 0]);
});
test('capture-rate: capture with no preceding nudge → spontaneous', () => {
  const r = capRate.aggregateCaptureRate([
    { eventName: 'lesson.captured', payload: { type: 'pattern' }, project: 'p', ts: 5 },
  ]);
  assertEq(r.spontaneous.pattern, 1);
  assertEq(r.byKind.pattern.captures, 0);
});
test('capture-rate: one capture consumed by one nudge only (no double-count)', () => {
  const r = capRate.aggregateCaptureRate([
    { eventName: 'nudge.emitted', payload: { kind: 'correction' }, project: 'p', ts: 1 },
    { eventName: 'nudge.emitted', payload: { kind: 'failure' }, project: 'p', ts: 2 },
    { eventName: 'lesson.captured', payload: { type: 'lesson' }, project: 'p', ts: 3 },
  ]);
  assertEq(r.byKind.correction.captures, 1);
  assertEq(r.byKind.failure.captures, 0);
  assertEq(Object.keys(r.spontaneous).length, 0);
});
test('capture-rate: cross-project capture does not convert another project nudge', () => {
  const r = capRate.aggregateCaptureRate([
    { eventName: 'nudge.emitted', payload: { kind: 'research' }, project: 'A', ts: 1 },
    { eventName: 'lesson.captured', payload: { type: 'research' }, project: 'B', ts: 2 },
  ]);
  assertEq(r.byKind.research.captures, 0);
  assertEq(r.spontaneous.research, 1);
});

// ─── model-router: dynamic model catalog (cat) ───────────────────────────────
const catalog = require('../servers/model-router/catalog.js');
const router  = require('../servers/model-router/index.js');

const CAT_RAW = [
  { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6', created_at: '2025-09-01T00:00:00Z',
    capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true } } } },
  { id: 'claude-sonnet-5-20260101', display_name: 'Sonnet 5', created_at: '2026-01-01T00:00:00Z',
    capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } },
  { id: 'claude-opus-5', display_name: 'Opus 5', created_at: '2026-01-05T00:00:00Z',
    capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5', created_at: '2025-10-01T00:00:00Z',
    capabilities: { effort: { supported: false } } },
];

function startFakeModelsServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

test('catalog: familyOf classifies by substring', () => {
  assertEq(catalog.familyOf('claude-sonnet-5-x'), 'sonnet');
  assertEq(catalog.familyOf('claude-opus-5'), 'opus');
  assertEq(catalog.familyOf('claude-haiku-4-5'), 'haiku');
  assertEq(catalog.familyOf('gpt-4o'), null);
});

test('catalog: effortLevelsFrom reads capabilities.effort in canonical order', () => {
  assertEq(catalog.effortLevelsFrom(CAT_RAW[1]), ['low', 'medium', 'high', 'xhigh', 'max']);
  assertEq(catalog.effortLevelsFrom(CAT_RAW[3]), []); // haiku: effort.supported=false
  assertEq(catalog.effortLevelsFrom({}), []);
});

test('catalog: buildCatalog elects newest model per family by created_at', () => {
  const snap = catalog.buildCatalog(CAT_RAW);
  assertEq(snap.byFamily.sonnet.model, 'claude-sonnet-5-20260101'); // newer than 4-6
  assertEq(snap.byFamily.opus.model, 'claude-opus-5');
  assertEq(snap.byFamily.haiku.model, 'claude-haiku-4-5-20251001');
  assertEq(snap.byFamily.sonnet.effort, ['low', 'medium', 'high', 'xhigh', 'max']);
  assertEq(snap.byFamily.haiku.effort, []);
  assertEq(snap.count, 4);
});

test('catalog: effortForModel exact / prefix / [] / null', () => {
  catalog._setSnapshot(CAT_RAW);
  assertEq(catalog.effortForModel('claude-sonnet-5-20260101'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assertEq(catalog.effortForModel('claude-opus-5-20260105'), ['low', 'medium', 'high', 'xhigh', 'max']); // prefix match
  assertEq(catalog.effortForModel('claude-haiku-4-5-20251001'), []); // known, no effort
  assertEq(catalog.effortForModel('gpt-foo'), null); // unknown
  catalog._reset();
  assertEq(catalog.effortForModel('claude-sonnet-5-20260101'), null); // no snapshot
});

test('catalog: modelForFamily null without snapshot', () => {
  catalog._reset();
  assertEq(catalog.modelForFamily('sonnet'), null);
});

test('router.resolveModel: catalog-aware when warmed, static when disabled', () => {
  catalog._setSnapshot(CAT_RAW);
  const on = { routing: { catalog: { enabled: true } } };
  assertEq(router.resolveModel('sonnet', on), 'claude-sonnet-5-20260101'); // dynamic newest
  assertEq(router.resolveModel('opus', on), 'claude-opus-5');
  const off = { routing: { catalog: { enabled: false } } };
  assertEq(router.resolveModel('sonnet', off), 'claude-sonnet-4-6'); // static fallback
  catalog._reset();
  assertEq(router.resolveModel('sonnet', on), 'claude-sonnet-4-6'); // not warmed → static
});

test('router.reconcileEffort: catalog effort overrides static (keep + strip)', () => {
  catalog._setSnapshot(CAT_RAW);
  const cfg = { routing: { catalog: { enabled: true } } };
  const keep = { output_config: { effort: 'xhigh' } }; // sonnet-5 supports xhigh
  assertEq(router.reconcileEffort(keep, 'claude-sonnet-5-20260101', cfg).action, 'keep');
  const strip = { output_config: { effort: 'high' } }; // haiku has no effort
  assertEq(router.reconcileEffort(strip, 'claude-haiku-4-5-20251001', cfg).action, 'strip');
  assertEq(strip.output_config, undefined);
  catalog._reset();
});

test('catalog.fetchModels: paginates via has_more/last_id', async () => {
  catalog._reset();
  const srv = await startFakeModelsServer((req, res) => {
    const after = new URL(req.url, 'http://x').searchParams.get('after_id');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!after) res.end(JSON.stringify({ data: [CAT_RAW[0], CAT_RAW[1]], has_more: true, last_id: CAT_RAW[1].id }));
    else res.end(JSON.stringify({ data: [CAT_RAW[2], CAT_RAW[3]], has_more: false, last_id: CAT_RAW[3].id }));
  });
  const models = await new Promise((resolve, reject) => {
    catalog.fetchModels({ host: '127.0.0.1', port: srv.port, protocol: 'http:', headers: {}, timeoutMs: 2000 },
      (err, m) => (err ? reject(err) : resolve(m)));
  });
  srv.close();
  assertEq(models.length, 4);
  assertEq(models.map((m) => m.id).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-sonnet-5-20260101']);
});

test('catalog.fetchModels: 403 → error so caller keeps static map', async () => {
  catalog._reset();
  const srv = await startFakeModelsServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error' } }));
  });
  let errMsg = null;
  await new Promise((resolve) => {
    catalog.fetchModels({ host: '127.0.0.1', port: srv.port, protocol: 'http:', headers: {}, timeoutMs: 2000 },
      (err) => { errMsg = err ? err.message : null; resolve(); });
  });
  srv.close();
  assert(errMsg && errMsg.includes('403'), `expected 403 error, got ${errMsg}`);
});

test('catalog.maybeRefresh: warms snapshot then serves modelForFamily', async () => {
  catalog._reset();
  const srv = await startFakeModelsServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: CAT_RAW, has_more: false, last_id: CAT_RAW[3].id }));
  });
  await new Promise((resolve, reject) => {
    catalog.maybeRefresh({ host: '127.0.0.1', port: srv.port, protocol: 'http:', headers: {}, ttlMs: 60000,
      onRefresh: () => resolve(), onError: (e) => reject(e) });
  });
  srv.close();
  assertEq(catalog.modelForFamily('sonnet'), 'claude-sonnet-5-20260101');
  const snap = catalog.getSnapshot();
  assert(snap && snap.count === 4, 'snapshot should be warmed with 4 models');
  catalog._reset();
});

// ─── model-router-shim (instalador do shim do claude.exe, Windows) ────────────
// Testes herméticos: NUNCA tocam no claude.exe real — usam dirs temporários com
// arquivos "grandes" (>1MB = original) e "pequenos" (<1MB = wrapper). A lógica de
// estado/instalação/remoção é agnóstica de plataforma; só a compilação via csc é
// Windows-only (guardada). O rename-in-use real do Windows já foi provado ao vivo.
const shimMod = require('./model-router-shim.js');

function mkBig(p) { fs.writeFileSync(p, Buffer.alloc(shimMod.WRAPPER_MAX_BYTES + 4096, 0x41)); }
function mkSmall(p) { fs.writeFileSync(p, Buffer.alloc(8192, 0x42)); }
function shimTmp(name) {
  const d = path.join(process.env.CLAUDE_PLUGIN_DATA, 'shim-' + name + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const NOLOG = () => {};

test('shim.cmpVer: 2.1.197 > 2.1.187', () => assert(shimMod.cmpVer('2.1.197', '2.1.187') > 0));
test('shim.cmpVer: 2.1.9 < 2.1.10 (numérico, não lexical)', () => assert(shimMod.cmpVer('2.1.9', '2.1.10') < 0));
test('shim.cmpVer: iguais → 0', () => assertEq(shimMod.cmpVer('2.1.0', '2.1.0'), 0));

test('shim.shimState: not-installed (só claude.exe grande)', () => {
  const d = shimTmp('st1'); mkBig(path.join(d, 'claude.exe'));
  assertEq(shimMod.shimState(d), 'not-installed');
});
test('shim.shimState: ok (wrapper pequeno + real grande)', () => {
  const d = shimTmp('st2'); mkSmall(path.join(d, 'claude.exe')); mkBig(path.join(d, 'claude-real.exe'));
  assertEq(shimMod.shimState(d), 'ok');
});
test('shim.shimState: redownloaded (claude grande + real grande)', () => {
  const d = shimTmp('st3'); mkBig(path.join(d, 'claude.exe')); mkBig(path.join(d, 'claude-real.exe'));
  assertEq(shimMod.shimState(d), 'redownloaded');
});
test('shim.shimState: orphan-wrapper (só wrapper, sem real)', () => {
  const d = shimTmp('st4'); mkSmall(path.join(d, 'claude.exe'));
  assertEq(shimMod.shimState(d), 'orphan-wrapper');
});

test('shim.installShim: instala (rename + wrapper) e é idempotente', () => {
  const d = shimTmp('in1'); mkBig(path.join(d, 'claude.exe'));
  const wrap = path.join(d, '_wrap.exe'); mkSmall(wrap);
  assertEq(shimMod.installShim(d, wrap, NOLOG), 'installed');
  assert(fs.existsSync(path.join(d, 'claude-real.exe')), 'claude-real.exe ausente');
  assert(fs.statSync(path.join(d, 'claude-real.exe')).size >= shimMod.WRAPPER_MAX_BYTES, 'real não é o grande');
  assert(fs.statSync(path.join(d, 'claude.exe')).size < shimMod.WRAPPER_MAX_BYTES, 'claude.exe não é o wrapper');
  assertEq(shimMod.installShim(d, wrap, NOLOG), 'already');
});
test('shim.installShim: reaplica após app rebaixar claude.exe (redownloaded→ok)', () => {
  const d = shimTmp('in2'); mkBig(path.join(d, 'claude-real.exe')); mkBig(path.join(d, 'claude.exe'));
  const wrap = path.join(d, '_wrap.exe'); mkSmall(wrap);
  assertEq(shimMod.installShim(d, wrap, NOLOG), 'reinstalled');
  assertEq(shimMod.shimState(d), 'ok');
});
test('shim.installShim: orphan-wrapper → orphan (não restaura sozinho)', () => {
  const d = shimTmp('in3'); mkSmall(path.join(d, 'claude.exe'));
  const wrap = path.join(d, '_wrap.exe'); mkSmall(wrap);
  assertEq(shimMod.installShim(d, wrap, NOLOG), 'orphan');
});
test('shim.installShim: wrapper inválido → no-wrapper (não mexe no claude.exe)', () => {
  const d = shimTmp('in4'); mkBig(path.join(d, 'claude.exe'));
  const wrap = path.join(d, '_tiny.exe'); fs.writeFileSync(wrap, Buffer.alloc(16));
  assertEq(shimMod.installShim(d, wrap, NOLOG), 'no-wrapper');
  assert(!fs.existsSync(path.join(d, 'claude-real.exe')), 'não deveria ter renomeado');
  assert(fs.statSync(path.join(d, 'claude.exe')).size >= shimMod.WRAPPER_MAX_BYTES, 'claude.exe alterado indevidamente');
});

test('shim.removeShim: restaura o original', () => {
  const d = shimTmp('rm1'); mkBig(path.join(d, 'claude.exe'));
  const wrap = path.join(d, '_wrap.exe'); mkSmall(wrap);
  shimMod.installShim(d, wrap, NOLOG);
  assertEq(shimMod.removeShim(d, NOLOG), 'removed');
  assert(!fs.existsSync(path.join(d, 'claude-real.exe')), 'claude-real.exe sobrou');
  assert(fs.statSync(path.join(d, 'claude.exe')).size >= shimMod.WRAPPER_MAX_BYTES, 'original não restaurado');
});
test('shim.removeShim: claude.exe já grande → cleaned (remove real duplicado)', () => {
  const d = shimTmp('rm2'); mkBig(path.join(d, 'claude.exe')); mkBig(path.join(d, 'claude-real.exe'));
  assertEq(shimMod.removeShim(d, NOLOG), 'cleaned');
  assert(!fs.existsSync(path.join(d, 'claude-real.exe')), 'real duplicado sobrou');
});
test('shim.removeShim: ausente → absent (no-op)', () => {
  const d = shimTmp('rm3'); mkBig(path.join(d, 'claude.exe'));
  assertEq(shimMod.removeShim(d, NOLOG), 'absent');
});

test('shim.findActiveClaudeDir: escolhe a versão mais nova (home fake, MSIX)', () => {
  const home = shimTmp('home');
  const base = path.join(home, 'AppData', 'Local', 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  fs.mkdirSync(path.join(base, '2.1.100'), { recursive: true }); mkSmall(path.join(base, '2.1.100', 'claude.exe'));
  fs.mkdirSync(path.join(base, '2.1.200'), { recursive: true }); mkSmall(path.join(base, '2.1.200', 'claude.exe'));
  const got = shimMod.findActiveClaudeDir(home);
  assertEq(path.basename(got), '2.1.200');
});
test('shim.findActiveClaudeDir: sem instalação → null', () => {
  const home = shimTmp('home-empty');
  assertEq(shimMod.findActiveClaudeDir(home), null);
});

// Windows-only: compilação real do wrapper via csc (.NET Framework). Guardado
// porque o CI roda em Linux (sem csc); o rename-in-use já foi provado ao vivo.
if (process.platform === 'win32') {
  test('shim.findCsc: encontra csc.exe (.NET Framework)', () => {
    const c = shimMod.findCsc(); assert(c && fs.existsSync(c), 'csc não achado: ' + c);
  });
  test('shim.buildWrapper: compila e reusa o cache no 2º call', () => {
    const dd = shimTmp('build');
    const w1 = shimMod.buildWrapper(ROOT, dd, NOLOG);
    assert(w1 && fs.existsSync(w1), 'wrapper não compilou');
    assert(fs.statSync(w1).size >= shimMod.WRAPPER_MIN_BYTES, 'wrapper pequeno demais');
    assertEq(shimMod.buildWrapper(ROOT, dd, NOLOG), w1);
  });
}

// ─── plugin-updater (pure helpers) ───────────────────────────────────────────
const pu = require('./lib/plugin-updater.js');

test('plugin-updater.parseVersion: strips v + fills missing parts', () => {
  assertEq(pu.parseVersion('v1.15.0'), [1, 15, 0]);
  assertEq(pu.parseVersion('1.15'), [1, 15, 0]);
  assertEq(pu.parseVersion(''), [0, 0, 0]);
  assertEq(pu.parseVersion('1.15.0-beta.2'), [1, 15, 0]);
});

test('plugin-updater.compareSemver: ordering across major/minor/patch', () => {
  assert(pu.compareSemver('1.15.0', '1.14.0') === 1, 'minor greater');
  assert(pu.compareSemver('1.14.0', '1.15.0') === -1, 'minor lesser');
  assert(pu.compareSemver('1.15.0', '1.15.0') === 0, 'equal');
  assert(pu.compareSemver('2.0.0', '1.99.99') === 1, 'major dominates');
  assert(pu.compareSemver('v1.15.1', '1.15.0') === 1, 'patch greater with v prefix');
});

test('plugin-updater.pickAsset: exact name → fallback zip → null', () => {
  const rel = { assets: [
    { name: 'other.txt', browser_download_url: 'u0', size: 1 },
    { name: 'claude-code-boss-1.15.0.zip', browser_download_url: 'u1', size: 2 },
    { name: 'random.zip', browser_download_url: 'u2', size: 3 },
  ] };
  assertEq(pu.pickAsset(rel, '1.15.0').name, 'claude-code-boss-1.15.0.zip');
  const rel2 = { assets: [{ name: 'random.zip', browser_download_url: 'u2', size: 3 }] };
  assertEq(pu.pickAsset(rel2, '1.15.0').name, 'random.zip');
  assertEq(pu.pickAsset({ assets: [] }, '1.15.0'), null);
  assertEq(pu.pickAsset(null, '1.15.0'), null);
});

test('plugin-updater.computeUpdateState: hasUpdate true when latest > installed', () => {
  const rel = {
    tag_name: 'v1.15.0',
    html_url: 'https://github.com/x/y/releases/v1.15.0',
    published_at: '2026-07-01T00:00:00Z',
    body: 'notes',
    assets: [{ name: 'claude-code-boss-1.15.0.zip', browser_download_url: 'u1', size: 42 }],
  };
  const s = pu.computeUpdateState('1.14.0', rel);
  assertEq(s.installed, '1.14.0');
  assertEq(s.latest, '1.15.0');
  assertEq(s.tag, 'v1.15.0');
  assert(s.hasUpdate === true, 'hasUpdate true');
  assert(s.asset && s.asset.name === 'claude-code-boss-1.15.0.zip', 'asset picked');
  assert(s.asset.url === 'u1' && s.asset.size === 42, 'asset url/size mapped');
});

test('plugin-updater.computeUpdateState: no update when equal or installed newer', () => {
  const rel = { tag_name: 'v1.15.0', assets: [] };
  assert(pu.computeUpdateState('1.15.0', rel).hasUpdate === false, 'equal → false');
  assert(pu.computeUpdateState('1.16.0', rel).hasUpdate === false, 'installed newer → false');
});

test('plugin-updater.computeUpdateState: missing tag → latest null, no update', () => {
  const s = pu.computeUpdateState('1.14.0', {});
  assertEq(s.latest, null);
  assert(s.hasUpdate === false, 'no tag → no update');
});

// ─── plugin-updater sprint 2 hardening (digest verify + redirect allowlist) ───
test('plugin-updater.isAllowedReleaseHost: only https GitHub hosts', () => {
  assert(pu.isAllowedReleaseHost('https://github.com/a/b/releases/download/v1/x.zip') === true);
  assert(pu.isAllowedReleaseHost('https://objects.githubusercontent.com/x') === true);
  assert(pu.isAllowedReleaseHost('https://release-assets.githubusercontent.com/x') === true);
  assert(pu.isAllowedReleaseHost('https://codeload.github.com/x') === true);
  assert(pu.isAllowedReleaseHost('http://github.com/x') === false, 'http rejected');
  assert(pu.isAllowedReleaseHost('https://evil.com/x') === false);
  assert(pu.isAllowedReleaseHost('https://github.com.evil.com/x') === false);
  assert(pu.isAllowedReleaseHost('https://githubusercontent.com.evil.com/x') === false);
  assert(pu.isAllowedReleaseHost('not-a-url') === false);
  assert(pu.isAllowedReleaseHost('') === false);
});

test('plugin-updater.verifyDigest: matches hex (case/space-tolerant), fail-closed', () => {
  const h = 'a'.repeat(64);
  assert(pu.verifyDigest(h, h) === true);
  assert(pu.verifyDigest(h.toUpperCase(), h) === true);
  assert(pu.verifyDigest(h, `${h}  claude-code-boss-2.0.0.zip\n`) === true, 'sha256sum format');
  assert(pu.verifyDigest(h, 'b'.repeat(64)) === false);
  assert(pu.verifyDigest(h, '') === false, 'empty expected → fail-closed');
  assert(pu.verifyDigest('', h) === false);
  assert(pu.verifyDigest('xyz', h) === false, 'non-hex → false');
  assert(pu.verifyDigest(h, 'deadbeef') === false, 'short → false');
});

test('plugin-updater.pickDigestAsset + computeUpdateState.digestUrl', () => {
  const rel = { tag_name: 'v2.0.0', assets: [
    { name: 'claude-code-boss-2.0.0.zip', browser_download_url: 'https://github.com/a/b/releases/download/v2.0.0/claude-code-boss-2.0.0.zip', size: 10 },
    { name: 'claude-code-boss-2.0.0.zip.sha256', browser_download_url: 'https://github.com/a/b/releases/download/v2.0.0/claude-code-boss-2.0.0.zip.sha256' },
  ] };
  assertEq(pu.pickDigestAsset(rel, '2.0.0').name, 'claude-code-boss-2.0.0.zip.sha256');
  assertEq(pu.computeUpdateState('1.0.0', rel).digestUrl, 'https://github.com/a/b/releases/download/v2.0.0/claude-code-boss-2.0.0.zip.sha256');
  assertEq(pu.pickDigestAsset({ assets: [] }, '2.0.0'), null);
});

test('plugin-updater.planBackupPrune: keep newest N by NUMERIC ts (not lexical)', () => {
  // mixed-width ts so lexical != numeric — a lexical sort would wrongly keep bak.9 over bak.10/100
  const names = ['ip.json.bak.9', 'ip.json.bak.10', 'ip.json.bak.100', 'ip.json.bak.2', 'other.txt'];
  assertEq(pu.planBackupPrune(names, 3).sort(), ['ip.json.bak.2']); // keep 100,10,9 → drop 2
  assertEq(pu.planBackupPrune(names, 1).sort(), ['ip.json.bak.10', 'ip.json.bak.2', 'ip.json.bak.9']); // keep 100
  assertEq(pu.planBackupPrune([], 3), []);
  assertEq(pu.planBackupPrune(['x.bak.1', 'x.bak.2'], 3), []);
});

function _updRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-upd-root-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0', repository: 'github.com/foo/bar' }));
  return root;
}
const _updRel = { tag_name: 'v2.0.0', assets: [
  { name: 'claude-code-boss-2.0.0.zip', browser_download_url: 'https://github.com/foo/bar/releases/download/v2.0.0/claude-code-boss-2.0.0.zip', size: 10 },
  { name: 'claude-code-boss-2.0.0.zip.sha256', browser_download_url: 'https://github.com/foo/bar/releases/download/v2.0.0/claude-code-boss-2.0.0.zip.sha256' },
] };
const _updRelNoDigest = { tag_name: 'v2.0.0', assets: [
  { name: 'claude-code-boss-2.0.0.zip', browser_download_url: 'https://github.com/foo/bar/releases/download/v2.0.0/claude-code-boss-2.0.0.zip', size: 10 },
] };

test('plugin-updater.performUpdate: digest MISMATCH aborts before unzip/npm (integrity gate)', async () => {
  let unzipCalled = false, spawnCalled = false;
  const io = {
    fetchRelease: async () => _updRel,
    resolveSha: async () => 'abc123def456',
    download: async (url, dest) => { fs.writeFileSync(dest, url.endsWith('.sha256') ? 'b'.repeat(64) : 'fakezip'); return dest; },
    sha256File: () => 'a'.repeat(64),
    unzip: () => { unzipCalled = true; },
    spawnSync: () => { spawnCalled = true; return { status: 0 }; },
  };
  let threw = null;
  try { await pu.performUpdate(_updRoot(), { io }); } catch (e) { threw = e; }
  assert(threw && /SHA-256|confere|digest/i.test(threw.message), `expected digest-mismatch abort, got ${threw && threw.message}`);
  assert(unzipCalled === false, 'unzip must NOT run on digest mismatch');
  assert(spawnCalled === false, 'npm install must NOT run on digest mismatch');
});

test('plugin-updater.performUpdate: digest MATCH passes the gate (reaches unzip)', async () => {
  const io = {
    fetchRelease: async () => _updRel,
    resolveSha: async () => 'abc123def456',
    download: async (url, dest) => { fs.writeFileSync(dest, url.endsWith('.sha256') ? 'a'.repeat(64) : 'fakezip'); return dest; },
    sha256File: () => 'a'.repeat(64),
    unzip: () => { throw new Error('UNZIP_REACHED'); }, // stop before touching the real home
  };
  let threw = null;
  try { await pu.performUpdate(_updRoot(), { io }); } catch (e) { threw = e; }
  assert(threw && /UNZIP_REACHED/.test(threw.message), `digest match should pass gate to unzip, got ${threw && threw.message}`);
});

test('plugin-updater.performUpdate: NO digest + default opts → MANDATORY abort (F1 fail-closed)', async () => {
  let unzipCalled = false, spawnCalled = false;
  const io = {
    fetchRelease: async () => _updRelNoDigest,
    resolveSha: async () => 'abc123def456',
    download: async (url, dest) => { fs.writeFileSync(dest, 'fakezip'); return dest; },
    sha256File: () => 'a'.repeat(64),
    unzip: () => { unzipCalled = true; },
    spawnSync: () => { spawnCalled = true; return { status: 0 }; },
  };
  let threw = null;
  try { await pu.performUpdate(_updRoot(), { io }); } catch (e) { threw = e; }
  assert(threw && /sem digest|não verificável|integridade/i.test(threw.message), `expected mandatory-digest abort, got ${threw && threw.message}`);
  assert(unzipCalled === false && spawnCalled === false, 'no-digest default must NOT reach unzip/npm');
});

test('plugin-updater.performUpdate: NO digest + allowUnsignedLegacy → escape hatch passes gate', async () => {
  const io = {
    fetchRelease: async () => _updRelNoDigest,
    resolveSha: async () => 'abc123def456',
    download: async (url, dest) => { fs.writeFileSync(dest, 'fakezip'); return dest; },
    sha256File: () => 'a'.repeat(64),
    unzip: () => { throw new Error('UNZIP_REACHED'); },
  };
  let threw = null;
  try { await pu.performUpdate(_updRoot(), { io, allowUnsignedLegacy: true }); } catch (e) { threw = e; }
  assert(threw && /UNZIP_REACHED/.test(threw.message), `escape hatch should pass gate to unzip, got ${threw && threw.message}`);
});

// ─── Sprint 3 — correctness fixes (recall/state that failed silently) ─────────
const arDetectS3 = require('./active-research-detect.js');
test('C4 active-research: buildLibRegex([]) never matches (no fail-open noise)', () => {
  const empty = arDetectS3.buildLibRegex([]);
  assert(empty.test('please fix the bug.') === false, 'empty lib list must not match a plain prompt');
  assert(empty.test('use react and stripe') === false, 'empty lib list matches nothing');
  const withLibs = arDetectS3.buildLibRegex(['react', 'stripe']);
  assert(withLibs.test('use react here') === true, 'known lib still matches');
  assert(withLibs.test('rename a function') === false, 'unrelated prompt does not match');
});

test('C3 skill-success-detect: reads the REAL event (nudge.emitted{kind:failure}), not a phantom', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'skill-success-detect.js'), 'utf-8');
  assert(!/eventName:\s*'failure\.retro\.fired'/.test(src), 'must not READ the never-emitted failure.retro.fired');
  assert(/eventName:\s*'nudge\.emitted'/.test(src) && /payload\.kind === 'failure'/.test(src), 'must read nudge.emitted filtered by kind=failure');
  // and the pure scorer still turns a post-invocation failure into success:0
  const out = ssd.computeOutcomes([{ id: 1, ts: 100, payload: { skillName: 'x' } }], [{ ts: 200 }], []);
  assertEq(out, [{ eventId: 1, skillName: 'x', success: 0 }]);
});

test('SP6 dashboard: no phantom `failure.retro.fired` UI (never-emitted event)', () => {
  // SP3 follow-up: the dashboard showed a "Failure retros fired" stat card + an
  // event-log dropdown option for `failure.retro.fired`, which NO code emits — so
  // the card was permanently 0 and the filter returned nothing. Remove both.
  const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
  assert(!html.includes('failure.retro.fired'),
    'dashboard must not reference the never-emitted failure.retro.fired event');
  assert(!/Failure retros fired/i.test(html),
    'dashboard must not render the phantom "Failure retros fired" stat card');
});

// ─── SP6 — dashboard decomposition: extracted, now-testable auth predicates ───
const dashAuth = require('./lib/dashboard-auth.js');

test('dashboard-auth.isValidHost: accepts only loopback names on the bound port', () => {
  assert(dashAuth.isValidHost('localhost:8123', 8123), 'localhost:<port> ok');
  assert(dashAuth.isValidHost('127.0.0.1:8123', 8123), '127.0.0.1:<port> ok');
  assert(!dashAuth.isValidHost('evil.example.com:8123', 8123), 'reject foreign host (DNS-rebinding)');
  assert(!dashAuth.isValidHost('localhost:9999', 8123), 'reject wrong port');
  assert(!dashAuth.isValidHost('localhost', 8123), 'reject host with no port');
  assert(!dashAuth.isValidHost('', 8123), 'reject empty host');
  assert(!dashAuth.isValidHost(undefined, 8123), 'reject missing host');
});

test('dashboard-auth.tokenMatches: length-guarded constant-time compare', () => {
  assert(dashAuth.tokenMatches('a1b2c3', 'a1b2c3'), 'equal tokens match');
  assert(!dashAuth.tokenMatches('a1b2c3', 'a1b2c4'), 'reject wrong token of equal length');
  // TEETH: timingSafeEqual THROWS on a length mismatch; the guard must prevent it.
  let threw = false;
  try { assert(!dashAuth.tokenMatches('abc', 'a1b2c3'), 'reject shorter token'); } catch { threw = true; }
  assert(!threw, 'length mismatch must return false, never throw');
  assert(!dashAuth.tokenMatches('', 'a1b2c3'), 'reject empty given');
  assert(!dashAuth.tokenMatches('x', ''), 'reject empty expected');
  assert(!dashAuth.tokenMatches(null, null), 'reject null/null (both empty → no match on empty secret)');
});

test('SP6 dashboard.js: HTTP server does not start on require (bootstrap behind require.main)', () => {
  // Honest scope: this guard stops the listener from binding on `require` (so the
  // module is safe to import); it does NOT make dashboard.js side-effect-free — a
  // full application-factory seam (createRequestHandler(context)) is a follow-up.
  const src = fs.readFileSync(path.join(SCRIPTS, 'dashboard.js'), 'utf-8');
  assert(/require\.main === module/.test(src),
    'the server must only start when run directly, not on require');
  assert(/require\(['"]\.\/lib\/dashboard-auth\.js['"]\)/.test(src),
    'dashboard.js must use the extracted lib/dashboard-auth.js');
  assert(!/function isValidHost\(/.test(src),
    'isValidHost must live in lib/dashboard-auth.js, not inline in dashboard.js');
});

const dashStatic = require('./lib/dashboard-static.js');

test('dashboard-static.resolveStaticPath: serves inside the root, rejects traversal', () => {
  const dir = path.join(os.tmpdir(), 'ccb-dash');
  assertEq(dashStatic.resolveStaticPath(dir, '/'), path.join(dir, 'index.html'));
  assertEq(dashStatic.resolveStaticPath(dir, '/app.js'), path.join(dir, 'app.js'));
  assertEq(dashStatic.resolveStaticPath(dir, '/assets/x.css'), path.join(dir, 'assets', 'x.css'));
  assertEq(dashStatic.resolveStaticPath(dir, '/../../../etc/passwd'), null, 'reject ../ traversal escape');
  // TEETH for the path.sep suffix in the guard: a sibling dir that shares the
  // prefix (dash vs dash-evil) must be rejected — a bare startsWith would pass it.
  assertEq(dashStatic.resolveStaticPath(path.join(os.tmpdir(), 'dash'), '/../dash-evil/x'), null,
    'reject sibling-dir escape (path.sep guard is load-bearing)');
});

test('C1 brain-backend.saveLocal: embeds buildEmbedText (title+summary), single write', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'brain-backend.js'), 'utf-8');
  const fn = src.match(/async function saveLocal[\s\S]*?\n\}/);
  assert(fn, 'saveLocal not found');
  assert(/buildEmbedText\(entry\)/.test(fn[0]), 'must embed buildEmbedText(entry), not title+summary+detail');
  assert(!/content\?\.detail/.test(fn[0]), 'must not fold detail into the embed text');
  assert(!/store2\.get\(id\)/.test(fn[0]) && !/entry2/.test(fn[0]), 'must not double-write via get()+re-save');
  assert(/_store\.save\(entry, vector/.test(fn[0]), 'single save with the vector');
  assert(/try \{[\s\S]*?_embedder\.embed/.test(fn[0]) && /catch/.test(fn[0]), 'a failing embed must not lose the entry (embed in try/catch, still save)');
});

test('C2 mcp-client.close: captures the process ref before nulling (JVM kill fires)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'mcp-client.js'), 'utf-8');
  assert(/const proc = this\._process;/.test(src), 'must capture proc before nulling');
  assert(/if \(proc && !proc\.killed\)/.test(src) && /proc\.kill\(\)/.test(src), 'the timeout must kill the captured proc, not this._process (which is null by then)');
});

test('C5 brain-store.close: resets _useSqlite/_useJson (no stale-true null-deref)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'brain-store.js'), 'utf-8');
  const fn = src.match(/async function close\(\)[\s\S]*?\n\}/);
  assert(fn, 'close() not found');
  assert(/_useSqlite = false/.test(fn[0]) && /_useJson = false/.test(fn[0]), 'close() must reset both backend flags');
});

test('C6 brain-store.searchByKeywords: uses the keywords table, not a null-vector search', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'brain-store.js'), 'utf-8');
  const fn = src.match(/async function searchByKeywords\(keywords[\s\S]*?\n\}/);
  assert(fn, 'searchByKeywords not found');
  assert(!/return searchSqlite\(null/.test(fn[0]), 'must not fall into the vector-less searchSqlite(null) that ignores keywords');
  assert(/searchByKeywordsSqlite\(normalized/.test(fn[0]), 'SQLite path must use searchByKeywordsSqlite');
  // and searchByKeywordsSqlite must stay project-scoped (no cross-project leak)
  const sqliteFn = src.match(/async function searchByKeywordsSqlite[\s\S]*?\n\}/);
  assert(sqliteFn && /AND e\.project = \?/.test(sqliteFn[0]), 'searchByKeywordsSqlite must scope by project');
});

// ─── Sprint 4 — performance hot-paths ─────────────────────────────────────────
const failJournalS4 = require('./lib/failure-journal.js');
test('S4 failure-journal.sweepOld: deletes old files, keeps recent + sibling journals (disk bound)', () => {
  const dir = failJournalS4.RUNTIME_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const oldF = path.join(dir, `failure-turn-s4test${'--'}${Date.now()}-old.json`);
  const newF = path.join(dir, `failure-turn-s4test${'--'}${Date.now()}-new.json`);
  const siblingF = path.join(dir, `retrieval-turn-s4test${'--'}${Date.now()}-x.json`); // must NOT be swept
  fs.writeFileSync(oldF, '{}'); fs.writeFileSync(newF, '{}'); fs.writeFileSync(siblingF, '{}');
  // age the "old" failure file AND the sibling 48h back
  const past = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(oldF, new Date(past), new Date(past));
  fs.utimesSync(siblingF, new Date(past), new Date(past));
  const removed = failJournalS4.sweepOld(24 * 60 * 60 * 1000);
  assert(removed >= 1, 'must remove at least the aged failure file');
  assert(!fs.existsSync(oldF), 'aged failure file deleted');
  assert(fs.existsSync(newF), 'recent failure file kept');
  assert(fs.existsSync(siblingF), 'aged SIBLING journal (retrieval-turn-) must NOT be swept — prefix safety');
  try { fs.unlinkSync(newF); fs.unlinkSync(siblingF); } catch { /* cleanup */ }
});

test('S4 retrieve-core: pool-warming is fire-and-forget (no await blocking recall)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'lib', 'retrieve-core.js'), 'utf-8');
  assert(!/await warmP/.test(src), 'must not await the discarded pool-warming call on the hot path');
  assert(/fire-and-forget/.test(src), 'the fire-and-forget intent should be documented');
});

test('S4 project-snapshot: dead `git log main` spawn removed', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'project-snapshot.js'), 'utf-8');
  assert(!/_mainR/.test(src), 'the unused _mainR slot must be gone');
  assert(!/'log', '-1', '--format=%ct', 'main'/.test(src), 'the dead git log main spawn must be removed');
});

test('S4 dashboard.countEntriesInDb: caches by db+wal mtime (WAL-safe) + cache declared before DATA_DIR (no TDZ)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dashboard.js'), 'utf-8');
  const fn = src.match(/function countEntriesInDb[\s\S]*?\n\}/);
  assert(fn, 'countEntriesInDb not found');
  assert(/_countCache/.test(fn[0]) && /_dbMtime/.test(fn[0]), 'must cache the count keyed by _dbMtime');
  const mt = src.match(/function _dbMtime[\s\S]*?\n\}/);
  assert(mt && /-wal/.test(mt[0]), '_dbMtime must include the -wal sidecar so WAL commits invalidate the cache');
  // TDZ guard: the const cache must be declared BEFORE DATA_DIR = ...resolveBestDataDir()
  // (which counts at boot), else a temporal-dead-zone throw makes every count 0.
  assert(src.indexOf('const _countCache') < src.indexOf('const DATA_DIR'), '_countCache must be declared before DATA_DIR (its first boot-time use)');
});

// ─── model-router-ensure: opt-in merge (shipped ⊕ DATA_DIR user-config) ──────
const routerEnsure = require('./model-router-ensure.js');

test('mergeRouterConfig: sem override → shipped inalterado (enabled:false fica false)', () => {
  const m = routerEnsure.mergeRouterConfig({ enabled: false, port: 13456, nim: { apiKey: '' } }, null);
  assertEq(m.enabled, false);
  assertEq(m.port, 13456);
});

test('mergeRouterConfig: override {enabled:true} liga (opt-in vence o shipped)', () => {
  const m = routerEnsure.mergeRouterConfig({ enabled: false, port: 13456 }, { enabled: true });
  assertEq(m.enabled, true);
  assertEq(m.port, 13456);
});

test('mergeRouterConfig: override {enabled:false} mantém desligado', () => {
  const m = routerEnsure.mergeRouterConfig({ enabled: true }, { enabled: false });
  assertEq(m.enabled, false);
});

test('mergeRouterConfig: nim/routing merge RASO preserva chaves shipadas', () => {
  const shipped = { enabled: false, nim: { apiKey: '', endpoint: 'E' }, routing: { catalog: { enabled: true }, a: 1 } };
  const m = routerEnsure.mergeRouterConfig(shipped, { nim: { apiKey: 'K' }, routing: { a: 2 } });
  assertEq(m.nim.apiKey, 'K');
  assertEq(m.nim.endpoint, 'E');       // preservado do shipped
  assertEq(m.routing.a, 2);            // sobrescrito pelo override
  assertEq(m.routing.catalog.enabled, true); // preservado do shipped
  assertEq(m.enabled, false);          // não veio no override → shipped
});

test('mergeRouterConfig: override não-objeto (undefined) → retorna shipped', () => {
  const m = routerEnsure.mergeRouterConfig({ enabled: false }, undefined);
  assertEq(m.enabled, false);
});

test('router-config.json shipped: enabled === false (opt-in, off por padrão)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'router-config.json'), 'utf-8'));
  assertEq(cfg.enabled, false);
});

test('router-config.json shipped: fallback.enabled === false (opt-in, decoupled)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'router-config.json'), 'utf-8'));
  assertEq(cfg.fallback.enabled, false);
  // Preserva os campos que o merge do opt-in NÃO pode apagar.
  assertEq(cfg.fallback.triggerStatuses, [429]);
  assert(cfg.fallback.cooldown && cfg.fallback.cooldown.enabled === true, 'cooldown.enabled shipped');
});

test('router-config.json shipped: sticky.enabled === false + ttlMs shipado (opt-in cache-safe)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'router-config.json'), 'utf-8'));
  assert(cfg.sticky && typeof cfg.sticky === 'object', 'bloco sticky presente');
  assertEq(cfg.sticky.enabled, false);
  assertEq(cfg.sticky.ttlMs, 21600000); // 6h default
});

// ─── router-mode: resolveMode (fonte única de modo) ──────────────────────────
const { resolveMode, modeMeta, MODE_META } = require('./lib/router-mode.js');

test('resolveMode: off quando enabled!==true E fallback.enabled!==true', () => {
  assertEq(resolveMode({ enabled: false, fallback: { enabled: false } }), 'off');
  assertEq(resolveMode({}), 'off');
  assertEq(resolveMode(null), 'off');
  assertEq(resolveMode({ enabled: false }), 'off'); // sem bloco fallback
});

test('resolveMode: routing quando enabled===true (independe do fallback)', () => {
  assertEq(resolveMode({ enabled: true }), 'routing');
  assertEq(resolveMode({ enabled: true, fallback: { enabled: true } }), 'routing');
  assertEq(resolveMode({ enabled: true, fallback: { enabled: false } }), 'routing');
});

test('resolveMode: fallback-only quando enabled:false + fallback.enabled:true', () => {
  assertEq(resolveMode({ enabled: false, fallback: { enabled: true } }), 'fallback-only');
});

test('resolveMode: sticky-tier quando sticky.enabled===true (vence enabled e fallback)', () => {
  assertEq(resolveMode({ sticky: { enabled: true } }), 'sticky-tier');
  assertEq(resolveMode({ sticky: { enabled: true }, enabled: true }), 'sticky-tier');
  assertEq(resolveMode({ sticky: { enabled: true }, fallback: { enabled: true } }), 'sticky-tier');
});

test('resolveMode: precedência sticky > enabled > fallback > off', () => {
  assertEq(resolveMode({ sticky: { enabled: false }, enabled: true }), 'routing');
  assertEq(resolveMode({ sticky: { enabled: false }, enabled: false, fallback: { enabled: true } }), 'fallback-only');
  assertEq(resolveMode({ sticky: { enabled: false }, enabled: false, fallback: { enabled: false } }), 'off');
  assertEq(resolveMode({ sticky: {} }), 'off'); // bloco sticky sem enabled
});

test('mergeRouterConfig (ensure): user {fallback:{enabled:true}} preserva cooldown/triggerStatuses', () => {
  const shipped = { enabled: false, fallback: { enabled: false, triggerStatuses: [429], cooldown: { enabled: true, noHeaderMs: 15000, tripAfter: 2 } } };
  const m = routerEnsure.mergeRouterConfig(shipped, { fallback: { enabled: true } });
  assertEq(m.fallback.enabled, true);               // opt-in aplicado
  assertEq(m.fallback.triggerStatuses, [429]);      // preservado do shipped
  assertEq(m.fallback.cooldown.enabled, true);      // preservado do shipped
  assertEq(m.fallback.cooldown.noHeaderMs, 15000);  // preservado do shipped
  assertEq(m.fallback.cooldown.tripAfter, 2);       // preservado do shipped
  assertEq(resolveMode(m), 'fallback-only');         // merge → modo correto
});

test('mergeRouterConfig (ensure): user {sticky:{enabled:true}} preserva ttlMs (e outros blocos)', () => {
  const shipped = { enabled: false, sticky: { enabled: false, ttlMs: 21600000 }, fallback: { enabled: false, triggerStatuses: [429] } };
  const m = routerEnsure.mergeRouterConfig(shipped, { sticky: { enabled: true } });
  assertEq(m.sticky.enabled, true);                  // opt-in aplicado
  assertEq(m.sticky.ttlMs, 21600000);                // preservado do shipped
  assertEq(m.fallback.triggerStatuses, [429]);       // outro bloco intacto
  assertEq(resolveMode(m), 'sticky-tier');           // merge → modo correto
});

// ─── router-mode: modeMeta (rótulo/cor por modo, usado pelo dashboard) ────────
test('modeMeta: mapeia cada modo para cor/deprecado corretos', () => {
  assertEq(modeMeta('off').color, 'grey');
  assertEq(modeMeta('off').deprecated, false);
  assertEq(modeMeta('fallback-only').color, 'blue');
  assertEq(modeMeta('fallback-only').deprecated, false);
  assertEq(modeMeta('sticky-tier').color, 'green');
  assertEq(modeMeta('sticky-tier').deprecated, false);
  assertEq(modeMeta('routing').color, 'amber');
  assertEq(modeMeta('routing').deprecated, true);      // per-turn é deprecado
});

test('modeMeta: cada modo tem uma chave i18n mode.*', () => {
  for (const mode of ['off', 'fallback-only', 'sticky-tier', 'routing']) {
    assert(/^mode\./.test(modeMeta(mode).i18n), `i18n key p/ ${mode}`);
  }
});

test('modeMeta: modo desconhecido/ausente cai em off (fail-safe)', () => {
  assertEq(modeMeta('nope'), MODE_META.off);
  assertEq(modeMeta(undefined), MODE_META.off);
  assertEq(modeMeta(null), MODE_META.off);
});

test('resolveMode→modeMeta: cadeia config→modo→apresentação coerente', () => {
  assertEq(modeMeta(resolveMode({ sticky: { enabled: true } })).color, 'green');
  assertEq(modeMeta(resolveMode({ enabled: true })).color, 'amber');
  assertEq(modeMeta(resolveMode({ fallback: { enabled: true } })).color, 'blue');
  assertEq(modeMeta(resolveMode({})).color, 'grey');
});

// ─── model-router (server): merge + resolveMode reexportado ──────────────────
const routerServer = require('../servers/model-router/index.js');

test('mergeUserConfig (server): {fallback:{enabled:true}} preserva cooldown/triggerStatuses', () => {
  const shipped = { enabled: false, fallback: { enabled: false, triggerStatuses: [429], cooldown: { enabled: true, minMs: 1000, maxMs: 21600000 } } };
  const m = routerServer.mergeUserConfig(shipped, { fallback: { enabled: true } });
  assertEq(m.fallback.enabled, true);
  assertEq(m.fallback.triggerStatuses, [429]);
  assertEq(m.fallback.cooldown.enabled, true);
  assertEq(m.fallback.cooldown.minMs, 1000);
  assertEq(m.fallback.cooldown.maxMs, 21600000);
});

test('server.resolveMode === lib impl (mesma regra nos dois processos)', () => {
  assertEq(routerServer.resolveMode({ enabled: false, fallback: { enabled: true } }), 'fallback-only');
  assertEq(routerServer.resolveMode({ enabled: true }), 'routing');
  assertEq(routerServer.resolveMode({ sticky: { enabled: true }, enabled: true }), 'sticky-tier');
  assertEq(routerServer.resolveMode({}), 'off');
});

test('mergeUserConfig (server): {sticky:{enabled:true}} preserva ttlMs (deep-merge raso)', () => {
  const shipped = { enabled: false, sticky: { enabled: false, ttlMs: 21600000 } };
  const m = routerServer.mergeUserConfig(shipped, { sticky: { enabled: true } });
  assertEq(m.sticky.enabled, true);
  assertEq(m.sticky.ttlMs, 21600000);
  assertEq(m.enabled, false); // não veio no override → shipped
});

// ═══ FIX 1 — identidade na porta fixa (verify-before-trust / anti credential-leak) ═══
// Helpers herméticos: sobem um server real em porta efêmera (0) no loopback e sondam
// /health. Sem rede externa, sem daemon — determinístico.
function _listen0(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function _getHealth(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { headers: headers || {} }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch (_) { void _; } // corpo não-JSON → body null
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
  });
}

test('FIX1 routerTokenMatches: true só na igualdade exata; guarda tamanho; vazio nunca autentica', () => {
  assertEq(routerServer.routerTokenMatches('a'.repeat(64), 'a'.repeat(64)), true);
  assertEq(routerServer.routerTokenMatches('a'.repeat(64), 'a'.repeat(63)), false); // tamanhos diferentes → sem throw, false
  assertEq(routerServer.routerTokenMatches('', ''), false);                          // segredo vazio não autentica
  assertEq(routerServer.routerTokenMatches(null, 'a'.repeat(64)), false);
  assertEq(routerServer.routerTokenMatches('a'.repeat(64), null), false);
});

test('FIX1 ensureRouterToken: gera 64-hex e REUSA entre chamadas (idempotente, read-or-create)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tok-'));
  const t1 = routerServer.ensureRouterToken(dir);
  assert(/^[0-9a-f]{64}$/.test(t1), 'token deve ser 32 bytes em hex'); // NÃO checamos mode (Windows mapeia só read-only)
  const t2 = routerServer.ensureRouterToken(dir);
  assertEq(t2, t1, 'segunda chamada REUSA o token existente (não regenera entre reinícios)');
  assertEq(routerServer.readRouterToken(dir), t1, 'readRouterToken lê exatamente o valor gravado');
});

test('FIX1 server /health: authenticated:true só com x-router-token correto; 200 SEMPRE (liveness)', async () => {
  const TOKEN = 'a'.repeat(64);
  const server = await routerServer.createServer({}, 'fallback-only', TOKEN);
  const port = await _listen0(server);
  try {
    const noTok = await _getHealth(port, {});
    assertEq(noTok.status, 200, 'liveness: /health continua 200 mesmo sem token');
    assertEq(noTok.body.authenticated, false, 'sem token → authenticated:false');
    const wrong = await _getHealth(port, { 'x-router-token': 'b'.repeat(64) });
    assertEq(wrong.status, 200);
    assertEq(wrong.body.authenticated, false, 'token errado → authenticated:false');
    const right = await _getHealth(port, { 'x-router-token': TOKEN });
    assertEq(right.status, 200);
    assertEq(right.body.authenticated, true, 'token certo → authenticated:true');
  } finally {
    server.close();
  }
});

test('FIX1 healthCheck: contra o NOSSO server, true SÓ com o token certo (verify-before-trust)', async () => {
  const TOKEN = 'c'.repeat(64);
  const server = await routerServer.createServer({}, 'fallback-only', TOKEN);
  const port = await _listen0(server);
  try {
    assertEq(await routerEnsure.healthCheck(port, { token: null }), false, 'sem token → false');
    assertEq(await routerEnsure.healthCheck(port, { token: 'd'.repeat(64) }), false, 'token errado → false');
    assertEq(await routerEnsure.healthCheck(port, { token: TOKEN }), true, 'token certo → true');
  } finally {
    server.close();
  }
});

test('FIX1 healthCheck: SQUATTER (200 mas authenticated:false) → false → roteamento NÃO ativa', async () => {
  // Um squatter: responde 200 no /health, mas não prova identidade (não conhece o token).
  const squatter = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', authenticated: false }));
  });
  const port = await _listen0(squatter);
  try {
    // Mesmo mandando um token, o squatter não ecoa authenticated:true → healthCheck false.
    // É isto que impede o Claude Code de mandar a credencial real a um processo alheio.
    assertEq(await routerEnsure.healthCheck(port, { token: 'a'.repeat(64) }), false);
    // probeAlive só constata que ALGO responde 200 (usado p/ o AVISO), nunca ativa nada.
    assertEq(await routerEnsure.probeAlive(port), true);
  } finally {
    squatter.close();
  }
});

// ═══ FIX 2 — classificação NIM opt-in (privacidade: default LOCAL) ═══
// classify() aceita deps injetáveis (classifyNim/classifyLocal) p/ contarmos chamadas
// sem tocar no embedder/anchors do módulo nem bater na rede.
// Determinismo: a chave também pode vir de NVIDIA_NIM_KEY; limpamos p/ os casos "sem chave".
delete process.env.NVIDIA_NIM_KEY;

test('FIX2 classify: chave NIM setada mas classifyRemote OFF → NÃO chama NIM (fica LOCAL)', async () => {
  let nimCalls = 0, localCalls = 0;
  const deps = {
    classifyNim:   async () => { nimCalls++;   return 'opus'; },
    classifyLocal: async () => { localCalls++; return 'sonnet'; },
  };
  const tier = await routerServer.classify('oi', { nim: { apiKey: 'nvapi-x' } }, deps);
  assertEq(nimCalls, 0, 'sem opt-in, NENHUM prompt vai à NVIDIA para classificar');
  assertEq(localCalls, 1, 'classificação fica local (MiniLM)');
  assertEq(tier, 'sonnet');
});

test('FIX2 classify: classifyRemote:true + chave → TENTA NIM (opt-in explícito)', async () => {
  let nimCalls = 0, localCalls = 0;
  const deps = {
    classifyNim:   async () => { nimCalls++;   return 'opus'; },
    classifyLocal: async () => { localCalls++; return 'sonnet'; },
  };
  const tier = await routerServer.classify('oi', { nim: { apiKey: 'nvapi-x', classifyRemote: true } }, deps);
  assertEq(nimCalls, 1, 'com opt-in + chave, o caminho remoto é tentado');
  assertEq(localCalls, 0, 'remoto teve sucesso → local não é chamado (sem trabalho dobrado)');
  assertEq(tier, 'opus');
});

test('FIX2 classify: classifyRemote:true SEM chave → fica LOCAL (nada sai da máquina)', async () => {
  let nimCalls = 0, localCalls = 0;
  const deps = {
    classifyNim:   async () => { nimCalls++;   return 'opus'; },
    classifyLocal: async () => { localCalls++; return 'haiku'; },
  };
  const tier = await routerServer.classify('oi', { nim: { classifyRemote: true } }, deps);
  assertEq(nimCalls, 0, 'sem chave não há (nem deve haver) chamada à NVIDIA');
  assertEq(localCalls, 1);
  assertEq(tier, 'haiku');
});

test('FIX2 mergeUserConfig: {nim:{apiKey}} preserva classifyRemote:false; opt-in explícito vence', () => {
  const shipped = { nim: { classifyRemote: false, apiKey: '', endpoint: 'e' } };
  // Usuário setou só a chave (p/ o plano-B): o default LOCAL sobrevive ao merge raso.
  const m = routerServer.mergeUserConfig(shipped, { nim: { apiKey: 'nvapi-x' } });
  assertEq(m.nim.classifyRemote, false, 'default local preservado ao adicionar a chave');
  assertEq(m.nim.apiKey, 'nvapi-x');
  assertEq(m.nim.endpoint, 'e', 'chave shipada (endpoint) preservada no merge raso');
  // E quando o usuário OPTA explicitamente, o flag flui:
  const m2 = routerServer.mergeUserConfig(shipped, { nim: { classifyRemote: true } });
  assertEq(m2.nim.classifyRemote, true);
});


// ─── model-router (server): sticky-tier — chave de sessão + decisor puro ──────

test('computeSessionKey: mesmo system+1ª msg → MESMA chave (histórico cresce no fim)', () => {
  const t0 = { system: 'S', messages: [{ role: 'user', content: 'first' }] };
  const t1 = { system: 'S', messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second turn' },
  ] };
  assertEq(routerServer.computeSessionKey(t0), routerServer.computeSessionKey(t1));
});

test('computeSessionKey: 1ª msg diferente → chave DIFERENTE', () => {
  const a = { system: 'S', messages: [{ role: 'user', content: 'first' }] };
  const b = { system: 'S', messages: [{ role: 'user', content: 'DIFFERENT' }] };
  assert(routerServer.computeSessionKey(a) !== routerServer.computeSessionKey(b), 'chaves devem diferir');
});

test('computeSessionKey: system em array de blocos é normalizado p/ texto', () => {
  const asStr = { system: 'Hello\nWorld', messages: [{ role: 'user', content: 'q' }] };
  const asArr = { system: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }], messages: [{ role: 'user', content: 'q' }] };
  assertEq(routerServer.computeSessionKey(asStr), routerServer.computeSessionKey(asArr));
});

test('computeSessionKey: sem system/messages não quebra (sha1 hex) + content em blocos', () => {
  const k = routerServer.computeSessionKey({});
  assert(typeof k === 'string' && k.length === 40, 'sha1 hex de 40 chars');
  const kBlocks = routerServer.computeSessionKey({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hey' }] }] });
  assert(typeof kBlocks === 'string' && kBlocks.length === 40, 'content em blocos vira texto');
});

test('decideStickyModel: 1ª call classifica+fixa; 2ª REUSA sem reclassificar; TTL → re-pin', async () => {
  const config = { sticky: { enabled: true, ttlMs: 1000 }, routing: { ceiling: true, catalog: { enabled: false } } };
  const pins = new Map();
  let calls = 0;
  const classifyFn = async () => { calls += 1; return 'haiku'; };
  const body0 = { model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'hi' }] };

  const d1 = await routerServer.decideStickyModel(body0, config, { pins, now: 1000, classifyFn });
  assertEq(calls, 1);            // classificou uma vez (turno 0)
  assertEq(d1.created, true);    // pin criado
  assertEq(d1.pinned, true);
  assertEq(d1.tier, 'haiku');
  assert(d1.model.includes('haiku'), 'modelo fixado no haiku');

  // 2ª request da MESMA sessão (mais mensagens, mesmo prefixo) → mesma chave.
  const body1 = { model: 'claude-sonnet-4-6', system: 'sys', messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
    { role: 'user', content: 'again' },
  ] };
  const d2 = await routerServer.decideStickyModel(body1, config, { pins, now: 1500, classifyFn });
  assertEq(calls, 1);            // NÃO reclassificou (cache-safe)
  assertEq(d2.created, false);   // pin reusado
  assertEq(d2.tier, d1.tier);    // MESMO tier
  assertEq(d2.model, d1.model);  // MESMO modelo (cache preservado)

  // Após o TTL (now > expiresAt), re-pina (classifica de novo).
  const d3 = await routerServer.decideStickyModel(body1, config, { pins, now: 5000, classifyFn });
  assertEq(calls, 2);            // reclassificou após expiração
  assertEq(d3.created, true);
});

test('decideStickyModel: teto respeita o /model ATUAL (classificou opus, escolheu sonnet → sonnet)', async () => {
  const config = { sticky: { enabled: true, ttlMs: 1000 }, routing: { ceiling: true, catalog: { enabled: false } } };
  const pins = new Map();
  const classifyFn = async () => 'opus';
  const body = { model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'design a system' }] };
  const d = await routerServer.decideStickyModel(body, config, { pins, now: 1000, classifyFn });
  // O teto já rebaixa o classificado (opus) ao escolhido (sonnet) NA HORA de fixar,
  // então o tier fixado é sonnet e a reaplicação do teto não precisa barrar de novo.
  assertEq(d.tier, 'sonnet');    // nunca escala acima do escolhido
  assertEq(d.model, 'claude-sonnet-4-6');
  assertEq(d.blocked, false);    // pinnedTier já é sonnet → nada a barrar na reaplicação
});

test('decideStickyModel: usuário REBAIXA /model no meio (pin haiku, escolhe... ) mantém <= escolhido', async () => {
  // Pin fixado em sonnet; usuário troca p/ haiku no /model → teto rebaixa p/ haiku.
  const config = { sticky: { enabled: true, ttlMs: 10000 }, routing: { ceiling: true, catalog: { enabled: false } } };
  const pins = new Map();
  const classifyFn = async () => 'sonnet';
  const first = { model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'q' }] };
  const d1 = await routerServer.decideStickyModel(first, config, { pins, now: 1000, classifyFn });
  assertEq(d1.tier, 'sonnet');
  // Mesma sessão (mesmo prefixo), mas agora o body chega com haiku escolhido.
  const second = { model: 'claude-haiku-4-5-20251001', system: 'sys', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] };
  const d2 = await routerServer.decideStickyModel(second, config, { pins, now: 1500, classifyFn });
  assertEq(d2.tier, 'haiku');    // teto rebaixa graciosamente p/ o /model atual
  assert(d2.model.includes('haiku'), 'modelo <= escolhido');
});

test('decideStickyModel: classify falha (null) + modelo desconhecido → passthrough sem rotear', async () => {
  const config = { sticky: { enabled: true, ttlMs: 1000 }, routing: { ceiling: true, catalog: { enabled: false } } };
  const pins = new Map();
  const classifyFn = async () => null;
  const body = { model: 'weird-model', system: 'sys', messages: [{ role: 'user', content: 'x' }] };
  const d = await routerServer.decideStickyModel(body, config, { pins, now: 1000, classifyFn });
  assertEq(d.pinned, false);
  assertEq(d.model, 'weird-model'); // mantém o modelo do usuário
});

// ─── verify-journal: roundtrip (D2) ──────────────────────────────────────────
test('verify-journal: append edit+cmd, read chronological, clear (D2)', () => {
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-vj-'));
  // Re-require with the fresh DATA_DIR baked into module scope.
  delete require.cache[require.resolve('./lib/verify-journal.js')];
  const vj = require('./lib/verify-journal.js');
  try {
    const sid = 'vjsid';
    vj.appendEdit(sid, 'src/a.js');
    vj.appendCommand(sid, { sig: 'npm test', curated: null });
    vj.appendEdit(sid, 'src/b.js');
    const entries = vj.readEntries(sid);
    assertEq(entries.length, 3);
    assertEq(entries.map(e => e.kind), ['edit', 'cmd', 'edit']);
    assertEq(entries[0].path, 'src/a.js');
    assertEq(entries[1].sig, 'npm test');
    vj.clearEntries(sid);
    assertEq(vj.readEntries(sid).length, 0);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = saved;
    delete require.cache[require.resolve('./lib/verify-journal.js')];
  }
});

// ─── verify-nudge: test detection + evaluate (D2) ─────────────────────────────
const verifyNudge = require('./verify-nudge.js');

test('verify-nudge.buildTestRegex: matches test/verify tokens, not lookalikes', () => {
  const re = verifyNudge.buildTestRegex([]);
  for (const cmd of ['npm test', 'vitest run', 'pytest -q', 'npm run gate', 'go test ./...', 'npm run lint', 'tsc --noEmit', 'npm run spec']) {
    assert(verifyNudge.isVerifyCommand({ kind: 'cmd', sig: cmd }, re), `should match: ${cmd}`);
  }
  for (const cmd of ['git checkout latest', 'git investigate', 'ls -la', 'git status', 'echo hi']) {
    assert(!verifyNudge.isVerifyCommand({ kind: 'cmd', sig: cmd }, re), `should NOT match: ${cmd}`);
  }
});

test('verify-nudge.buildTestRegex: config testPatterns extend defaults (escaped literal)', () => {
  const re = verifyNudge.buildTestRegex(['smoke', 'make verify']);
  assert(verifyNudge.isVerifyCommand({ kind: 'cmd', sig: 'npm run smoke' }, re), 'custom token smoke');
  assert(verifyNudge.isVerifyCommand({ kind: 'cmd', sig: 'make verify' }, re), 'custom phrase');
  assert(!verifyNudge.isVerifyCommand({ kind: 'cmd', sig: 'npm run build' }, re), 'unrelated stays unmatched');
});

test('verify-nudge.isVerifyCommand: curated id/script counts as verify', () => {
  const re = verifyNudge.buildTestRegex([]);
  assert(verifyNudge.isVerifyCommand({ kind: 'cmd', sig: 'powershell -File x.ps1', curated: 'vitest' }, re),
    'curated id vitest');
  assert(!verifyNudge.isVerifyCommand({ kind: 'edit', path: 'a.js' }, re), 'edit entry is never a verify command');
});

test('verify-nudge.evaluate: edits + no verify → nudge', () => {
  const re = verifyNudge.buildTestRegex([]);
  const s = verifyNudge.evaluate([{ kind: 'edit', path: 'a.js' }, { kind: 'edit', path: 'b.js' }, { kind: 'cmd', sig: 'ls' }], re);
  assertEq(s, { edits: 2, ranVerify: false, shouldNudge: true });
});

test('verify-nudge.evaluate: edits + verify ran → suppressed', () => {
  const re = verifyNudge.buildTestRegex([]);
  const s = verifyNudge.evaluate([{ kind: 'edit', path: 'a.js' }, { kind: 'cmd', sig: 'npm test' }], re);
  assertEq(s.shouldNudge, false);
  assertEq(s.ranVerify, true);
});

test('verify-nudge.evaluate: no edits → no nudge (even with no verify)', () => {
  const re = verifyNudge.buildTestRegex([]);
  assertEq(verifyNudge.evaluate([{ kind: 'cmd', sig: 'ls' }], re).shouldNudge, false);
  assertEq(verifyNudge.evaluate([], re).shouldNudge, false);
});

test('verify-nudge.buildReason: singular/plural + agent-facing tag', () => {
  assert(verifyNudge.buildReason(1).includes('1 file edited'), 'singular');
  assert(verifyNudge.buildReason(3).includes('3 files edited'), 'plural');
  assert(verifyNudge.buildReason(2).startsWith('[verify]'), 'tag');
});

// ─── D1 self-review: retrieval (no embedder) + detector helpers ──────────────
const srRetrieve = require('./lib/self-review-retrieve.js');
const selfReview = require('./self-review.js');
const verifyJournalTop = require('./lib/verify-journal.js');
const retrievalJournalTop = require('./lib/retrieval-journal.js');

test('self-review-retrieve.parseSearchResult: unwraps results, tolerant of junk', () => {
  const good = srRetrieve.parseSearchResult({ content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'a', title: 'T' }] }) }] });
  assertEq(good.length, 1);
  assertEq(good[0].id, 'a');
  assertEq(srRetrieve.parseSearchResult({}).length, 0);
  assertEq(srRetrieve.parseSearchResult({ content: [{ text: 'not json' }] }).length, 0);
});

test('self-review-retrieve.filterByType: keeps only requested types (case-insensitive)', () => {
  const es = [{ id: '1', type: 'Lesson' }, { id: '2', type: 'reference' }, { id: '3', type: 'failure' }];
  assertEq(srRetrieve.filterByType(es, ['lesson', 'failure']).map(e => e.id), ['1', '3']);
  assertEq(srRetrieve.filterByType(es, []).length, 3); // empty types keeps all
});

test('self-review-retrieve.applyGate: minScore gate + score sort + topK', () => {
  const es = [{ id: 'lo', score: 0.1 }, { id: 'hi', score: 0.9 }, { id: 'mid', score: 0.5 }];
  const g = srRetrieve.applyGate(es, { minScore: 0.2, topK: 2 });
  assertEq(g.map(e => e.id), ['hi', 'mid']); // 'lo' gated out, sorted desc, capped 2
});

test('self-review-retrieve.applyGate: entries without score pass (keyword fallback)', () => {
  const es = [{ id: 'a' }, { id: 'b' }];
  assertEq(srRetrieve.applyGate(es, { minScore: 0.5, topK: 5 }).length, 2);
});

test('self-review-retrieve.readDaemonPort/Token: absent → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-nolock-'));
  assertEq(srRetrieve.readDaemonPort(dir), null);
  const savedTok = process.env.BRAIN_HTTP_TOKEN; delete process.env.BRAIN_HTTP_TOKEN;
  assertEq(srRetrieve.readDaemonToken(dir), null);
  if (savedTok !== undefined) process.env.BRAIN_HTTP_TOKEN = savedTok;
});

/** Fake warm brain-server HTTP daemon: token-gated /mcp with initialize→tools/call. */
function startFakeBrainHttp({ results = [], toolError = false } = {}) {
  const seen = { auth: null, calledTool: null, callArgs: null };
  const server = http.createServer((req, res) => {
    seen.auth = req.headers['authorization'] || null;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let msg = {}; try { msg = JSON.parse(body); } catch (err) { void err; }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/call') {
        seen.calledTool = msg.params && msg.params.name;
        seen.callArgs = msg.params && msg.params.arguments;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Tool-level failure: a SUCCESSFUL JSON-RPC response with result.isError.
        const result = toolError
          ? { isError: true, content: [{ type: 'text', text: 'brain_search failed: boom' }] }
          : { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      }
      res.writeHead(400); res.end('bad');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, seen, close: () => new Promise(r => server.close(r)),
    }));
  });
}

test('self-review-retrieve.retrieveViaDaemon: token handshake + brain_search parse', async () => {
  const daemon = await startFakeBrainHttp({ results: [{ id: 'x', title: 'past bug', type: 'lesson', score: 0.8, recurrence: 2 }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-daemon-'));
  fs.writeFileSync(path.join(dir, 'brain-http.lock.json'), JSON.stringify({ port: daemon.port }));
  fs.writeFileSync(path.join(dir, 'brain-http.token'), 'tok');
  const savedTok = process.env.BRAIN_HTTP_TOKEN; delete process.env.BRAIN_HTTP_TOKEN;
  try {
    const entries = await srRetrieve.retrieveViaDaemon('hooks config', { dataDir: dir, project: 'p1', topK: 2, minScore: 0.2, timeoutMs: 3000 });
    assert(Array.isArray(entries), 'entries array');
    assertEq(entries[0].id, 'x');
    assert(String(daemon.seen.auth || '').includes('tok'), 'daemon received bearer token');
    assertEq(daemon.seen.calledTool, 'brain_search');
  } finally {
    if (savedTok !== undefined) process.env.BRAIN_HTTP_TOKEN = savedTok;
    await daemon.close();
  }
});

test('self-review-retrieve.retrieveViaDaemon: no lock/token → null (fall back)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-nodaemon-'));
  const savedTok = process.env.BRAIN_HTTP_TOKEN; delete process.env.BRAIN_HTTP_TOKEN;
  try {
    assertEq(await srRetrieve.retrieveViaDaemon('q', { dataDir: dir, project: 'p', topK: 2 }), null);
  } finally { if (savedTok !== undefined) process.env.BRAIN_HTTP_TOKEN = savedTok; }
});

test('self-review-retrieve.retrieveViaDaemon: tool-level error (isError) → null (fall back)', async () => {
  const daemon = await startFakeBrainHttp({ toolError: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sr-toolerr-'));
  fs.writeFileSync(path.join(dir, 'brain-http.lock.json'), JSON.stringify({ port: daemon.port }));
  fs.writeFileSync(path.join(dir, 'brain-http.token'), 'tok');
  const savedTok = process.env.BRAIN_HTTP_TOKEN; delete process.env.BRAIN_HTTP_TOKEN;
  try {
    // A reachable daemon whose brain_search errors must return null (not []), so
    // retrieve() degrades to the keyword index rather than silently yielding nothing.
    assertEq(await srRetrieve.retrieveViaDaemon('q', { dataDir: dir, project: 'p1', topK: 2, minScore: 0.2, timeoutMs: 3000 }), null);
  } finally {
    if (savedTok !== undefined) process.env.BRAIN_HTTP_TOKEN = savedTok;
    await daemon.close();
  }
});

test('self-review-retrieve.retrieveViaIndex: lookup → store.get wiring + score merge', async () => {
  // In-memory fakes via DI: verifies the orchestration (index.lookup → per-hit
  // store.get → attach score) without touching the real singletons/fs, so it's
  // immune to concurrent-test races. Real brain-index/brain-store are covered
  // by their own tests.
  const fakeIndex = {
    init: async () => {},
    lookup: async (kw) => (kw.includes('profile') ? [{ id: 'les1', score: 0.9 }, { id: 'missing', score: 0.4 }] : []),
  };
  const store = {
    les1: { id: 'les1', title: 'profile deepMerge alias', type: 'lesson', recurrence: 3 },
  };
  const fakeStore = { init: async () => {}, get: async (id) => store[id] || null };
  const got = await srRetrieve.retrieveViaIndex(['profile', 'merge', 'alias'], { project: 'p1', topK: 2, _store: fakeStore, _index: fakeIndex });
  assert(got.some(x => x.id === 'les1'), 'seeded lesson retrieved');
  assertEq(got.find(x => x.id === 'les1').recurrence, 3);
  assertEq(got.find(x => x.id === 'les1').score, 0.9); // score attached from the hit
  assert(!got.some(x => x.id === 'missing'), 'hits with no store entry are dropped');
});

test('self-review.buildQuery: basenames + non-generic dirs, split keywords', () => {
  const q = selfReview.buildQuery(['scripts/lib/hooks-config.js', 'C:\\x\\verify-nudge.js', 'src/index.js']);
  assert(q.query.includes('hooks-config.js'), 'basename kept');
  assert(q.query.includes('verify-nudge.js'), 'windows path basename kept');
  assert(!q.query.split(' ').includes('src'), 'generic dir dropped');
  assert(q.keywords.includes('hooks') && q.keywords.includes('config'), 'keywords split on punctuation');
});

test('self-review.buildAdvisory: [SELF-REVIEW] header + recurrence + type', () => {
  const a = selfReview.buildAdvisory([{ title: 'Broke the build', type: 'lesson', recurrence: 4 }, { title: 'Flaky test', type: 'failure' }]);
  assert(a.startsWith('[SELF-REVIEW]'), 'tag');
  assert(a.includes('"Broke the build"') && a.includes('recurrence 4') && a.includes('[lesson]'), 'first entry');
  assert(a.includes('"Flaky test"') && a.includes('[failure]'), 'second entry (no recurrence)');
  assert(!a.includes('recurrence 1'), 'recurrence<=1 omitted');
});

test('self-review.run: edits + retrieved lesson → block, journals, dedups next turn', async () => {
  // Uses the top-level journal singletons (bound to the units temp data dir) with
  // a UNIQUE sid + a STUB retrieve (DI) → no cache/env swapping, no store race.
  const sid = 'srsession-' + Date.now();
  const cwd = path.join(os.tmpdir(), 'srproj');
  const dir = process.env.CLAUDE_PLUGIN_DATA; // where the top-level journals live
  const stubRetrieve = async () => ({ entries: [{ id: 'lesX', title: 'widget parser off-by-one', type: 'lesson', recurrence: 2, score: 0.8 }], source: 'index' });
  const noopMetrics = { fire: () => {} }; // don't touch the shared brain-store singleton in-process
  const srCfg = { enabled: true, topK: 2, minScore: 0.2, types: ['lesson', 'failure'] }; // shipped default is now 'standard' (self-review off) → force dev config via DI

  verifyJournalTop.appendEdit(sid, 'scripts/lib/widget-parser.js');
  const first = await selfReview.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { retrieve: stubRetrieve, dataDir: dir, metrics: noopMetrics, cfg: srCfg });
  assertEq(first.block, true);
  assert(String(first.reason).includes('[SELF-REVIEW]') && first.reason.includes('widget parser off-by-one'), 'advisory content');

  // Injection journaled with the self-review tool tag (F3 precision signal).
  assert(retrievalJournalTop.readEntries(sid).some(j => j.tool === 'Stop/self-review' && (j.returnedIds || []).includes('lesX')), 'retrieval-journal entry written');

  // Second turn, same lesson → deduped (already surfaced) → no block.
  verifyJournalTop.appendEdit(sid, 'scripts/lib/widget-parser.js');
  const second = await selfReview.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { retrieve: stubRetrieve, dataDir: dir, metrics: noopMetrics, cfg: srCfg });
  assertEq(Object.keys(second).length, 0);
});

// ─── U2 value-summary (aggregation) + session-summary detector ───────────────
const valueSummary = require('./lib/value-summary.js');
const sessionSummary = require('./session-summary.js');

test('value-summary.summarize: context saved (chars→tokens), learned, cited', () => {
  const now = Date.UTC(2026, 6, 3);
  const rows = [
    { eventName: 'curation.flagged', ts: now, payload: { chars: 4000, lines: 100 }, project: 'a' },
    { eventName: 'curation.flagged', ts: now, payload: { chars: 2000 }, project: 'a' },
    { eventName: 'lesson.captured', ts: now, payload: { type: 'lesson', decision: 'admit' }, project: 'a' },
    { eventName: 'lesson.captured', ts: now, payload: { type: 'pattern', decision: 'merge', recurrence: 3 }, project: 'a' },
    { eventName: 'retrieve.cited', ts: now, payload: { entryId: 'x' }, project: 'a' },
  ];
  const s = valueSummary.summarize(rows);
  assertEq(s.contextSaved.chars, 6000);
  assertEq(s.contextSaved.tokens, 1500);
  assertEq(s.contextSaved.events, 2);
  assertEq(s.learned.total, 2);
  assertEq(s.learned.byType, { lesson: 1, pattern: 1 });
  assertEq(s.memoryCited, 1);
});

test('value-summary.summarize: learning loop (D4) captured vs merged + byWeek', () => {
  const now = Date.UTC(2026, 6, 3);
  const rows = [
    { eventName: 'lesson.captured', ts: now, payload: { decision: 'admit' }, project: 'a' },
    { eventName: 'lesson.captured', ts: now, payload: { decision: 'merge' }, project: 'a' },
    { eventName: 'lesson.captured', ts: now - 8 * 86400000, payload: { decision: 'merge' }, project: 'a' },
  ];
  const s = valueSummary.summarize(rows);
  assertEq(s.learningLoop.captured, 3);
  assertEq(s.learningLoop.merged, 2);
  assertEq(s.learningLoop.admitted, 1);
  assert(Math.abs(s.learningLoop.mergeRate - 0.67) < 0.01, 'mergeRate ~0.67');
  assertEq(s.learningLoop.byWeek.length, 2);
});

test('value-summary.summarize: project filter isolates a project', () => {
  const now = Date.UTC(2026, 6, 3);
  const rows = [
    { eventName: 'lesson.captured', ts: now, payload: { decision: 'admit' }, project: 'a' },
    { eventName: 'lesson.captured', ts: now, payload: { decision: 'admit' }, project: 'b' },
  ];
  assertEq(valueSummary.summarize(rows, { project: 'a' }).learned.total, 1);
});

test('value-summary.countLessonsSince: ts window + project match', () => {
  const now = Date.UTC(2026, 6, 3);
  const rows = [
    { eventName: 'lesson.captured', ts: now, project: 'a' },
    { eventName: 'lesson.captured', ts: now - 1000, project: 'a' },
    { eventName: 'lesson.captured', ts: now, project: 'b' },
    { eventName: 'retrieve.cited', ts: now, project: 'a' },
  ];
  assertEq(valueSummary.countLessonsSince(rows, { sinceTs: now - 500, project: 'a' }), 1);
  assertEq(valueSummary.countLessonsSince(rows, { sinceTs: 0, project: 'a' }), 2);
});

test('session-summary.buildReason: [SESSION] header + singular/plural', () => {
  assert(sessionSummary.buildReason(1).startsWith('[SESSION]') && sessionSummary.buildReason(1).includes('1 lesson '), 'singular');
  assert(sessionSummary.buildReason(4).includes('4 lessons'), 'plural');
});

test('session-summary.run: counts lessons since stamp, fires once (cap), disabled→{}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ss-'));
  fs.mkdirSync(path.join(dir, '.runtime'), { recursive: true });
  const sid = 'sssid';
  const cwd = path.join(os.tmpdir(), 'ssproj');
  const start = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, '.runtime', `session-start-${sid}.json`), JSON.stringify({ ts: start, project: 'ssproj' }));
  // Scope-aware fake store: project DB has 2 in-session lessons (+1 before start),
  // the __user__ DB has 1 more (user-scoped capture) → total 3.
  let inited = null;
  const fakeMetricsStore = {
    init: ({ project }) => { inited = project; return true; },
    getEventLog: () => {
      if (inited === 'ssproj') return [
        { eventName: 'lesson.captured', ts: start + 10, project: 'ssproj' },
        { eventName: 'lesson.captured', ts: start + 20, project: 'ssproj' },
        { eventName: 'lesson.captured', ts: start - 50, project: 'ssproj' },
      ];
      if (inited === '__user__') return [
        { eventName: 'lesson.captured', ts: start + 30, project: '__user__' },
      ];
      return [];
    },
  };
  const first = await sessionSummary.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { dataDir: dir, metricsStore: fakeMetricsStore });
  assertEq(first.block, true);
  assert(first.reason.includes('Captured 3 lesson'), 'counts 2 project + 1 user-scoped in-session lessons');
  // Cap: second call returns {} (counter written).
  const second = await sessionSummary.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { dataDir: dir, metricsStore: fakeMetricsStore });
  assertEq(Object.keys(second).length, 0);
});

test('session-summary.run: missing start stamp → counts nothing (no all-time report)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ss-nostamp-'));
  fs.mkdirSync(path.join(dir, '.runtime'), { recursive: true });
  const fakeMetricsStore = {
    init: () => true,
    // Old lessons exist, but with no stamp sinceTs=now → none counted.
    getEventLog: () => ([{ eventName: 'lesson.captured', ts: Date.now() - 999999, project: 'p' }]),
  };
  const r = await sessionSummary.run({ hook_event_name: 'Stop', session_id: 'nostamp', cwd: path.join(os.tmpdir(), 'p') }, { dataDir: dir, metricsStore: fakeMetricsStore });
  assertEq(Object.keys(r).length, 0);
});

// ─── U3 doctor (pure checks) ─────────────────────────────────────────────────
const doctor = require('./doctor.js');

test('doctor.checkNode: old → fail, current → ok', () => {
  assertEq(doctor.checkNode({ nodeVersion: 'v20.10.0' }).status, 'fail');
  assertEq(doctor.checkNode({ nodeVersion: 'v22.13.0' }).status, 'ok');
  assertEq(doctor.checkNode({ nodeVersion: 'v24.0.0' }).status, 'ok');
  assert(doctor.checkNode({ nodeVersion: 'v20.0.0' }).critical, 'node is critical');
});

test('doctor.checkEnv: literal ${...} or missing → fail', () => {
  assertEq(doctor.checkEnv({ env: { root: '/plug', data: '/data' } }).status, 'ok');
  assertEq(doctor.checkEnv({ env: { root: '${CLAUDE_PLUGIN_ROOT}', data: '/data' } }).status, 'fail');
  assertEq(doctor.checkEnv({ env: { root: '/plug', data: '' } }).status, 'fail');
  assert(doctor.checkEnv({ env: {} }).critical, 'env is critical');
});

test('doctor.checkDataDirs: >1 populated → warn (fragmentation)', () => {
  assertEq(doctor.checkDataDirs({ dataDirCandidates: [{ path: '/a', populated: true }] }).status, 'ok');
  assertEq(doctor.checkDataDirs({ dataDirCandidates: [{ path: '/a', populated: false }] }).status, 'ok');
  const w = doctor.checkDataDirs({ env: { data: '/a' }, dataDirCandidates: [{ path: '/a', populated: true }, { path: '/b', populated: true }] });
  assertEq(w.status, 'warn');
  assert(w.detail.includes('/b'), 'lists the fragmented dir');
});

test('doctor.findDataDirCandidates: real fragmentation shape (sibling dirs by prefix)', () => {
  // Regression: install modes produce SIBLING dirs directly under
  // .../plugins/data/ named by prefix (claude-code-boss-inline,
  // claude-code-boss-<marketplace>) — NOT nested under a marketplace folder.
  // A prior version scanned .../plugins/<mkt>/claude-code-boss and NEVER found
  // the real fragmentation (caught live by smoke/doctor.mjs).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-doctor-frag-'));
  const dataBase = path.join(home, '.claude', 'plugins', 'data');
  const dirs = ['claude-code-boss', 'claude-code-boss-inline', 'claude-code-boss-allansantos-plugins'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(dataBase, d, 'brain', 'someproj'), { recursive: true });
    fs.writeFileSync(path.join(dataBase, d, 'brain', 'someproj', 'brain.db'), '');
  }
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const prevHome = process.env[homeVar];
  process.env[homeVar] = home;
  try {
    const active = path.join(dataBase, 'claude-code-boss-inline');
    const candidates = doctor.findDataDirCandidates(active);
    const populatedPaths = candidates.filter(c => c.populated).map(c => c.path).sort();
    assertEq(populatedPaths.length, 3);
    for (const d of dirs) assert(populatedPaths.includes(path.join(dataBase, d)), `missing ${d}`);
  } finally {
    if (prevHome === undefined) delete process.env[homeVar]; else process.env[homeVar] = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor.checkModel: present → ok, absent → warn', () => {
  assertEq(doctor.checkModel({ modelPresent: true, modelCacheDir: '/m' }).status, 'ok');
  assertEq(doctor.checkModel({ modelPresent: false }).status, 'warn');
});

test('doctor.checkDaemon: no lock → ok, unhealthy lock → warn, healthy → ok', () => {
  assertEq(doctor.checkDaemon({ daemon: { lockPresent: false } }).status, 'ok');
  assertEq(doctor.checkDaemon({ daemon: { lockPresent: true, healthy: true, tokenReadable: true, port: 5 } }).status, 'ok');
  assertEq(doctor.checkDaemon({ daemon: { lockPresent: true, healthy: false } }).status, 'warn');
  assertEq(doctor.checkDaemon({ daemon: { lockPresent: true, healthy: true, tokenReadable: false } }).status, 'warn');
});

test('doctor.checkHooksEvents: standard ok, runtime-dependent warn, unknown fail', () => {
  assertEq(doctor.checkHooksEvents({ hooksEvents: ['SessionStart', 'Stop', 'PreToolUse'] }).status, 'ok');
  assertEq(doctor.checkHooksEvents({ hooksEvents: ['Stop', 'UserPromptExpansion', 'PostToolUseFailure'] }).status, 'warn');
  assertEq(doctor.checkHooksEvents({ hooksEvents: ['Stop', 'BogusEvent'] }).status, 'fail');
});

test('doctor.runChecks + summarize: criticalFail flagged, counts add up', () => {
  const ctx = {
    nodeVersion: 'v20.0.0', // critical fail
    env: { root: '/p', data: '/d' },
    dataDirCandidates: [{ path: '/d', populated: true }],
    modelPresent: true, modelCacheDir: '/m',
    daemon: { lockPresent: false },
    hooksEvents: ['Stop'],
  };
  const results = doctor.runChecks(ctx);
  assertEq(results.length, 6);
  const s = doctor.summarize(results);
  assert(s.criticalFail, 'old node → criticalFail');
  assertEq(s.ok, false);
  assertEq(s.counts.ok + s.counts.warn + s.counts.fail, 6);
});

test('doctor.runChecks: all-healthy ctx → ok summary', () => {
  const ctx = {
    nodeVersion: 'v22.13.0', env: { root: '/p', data: '/d' },
    dataDirCandidates: [{ path: '/d', populated: true }],
    modelPresent: true, modelCacheDir: '/m',
    daemon: { lockPresent: true, healthy: true, tokenReadable: true, port: 9 },
    hooksEvents: ['SessionStart', 'Stop'],
  };
  const s = doctor.summarize(doctor.runChecks(ctx));
  assertEq(s.ok, true);
  assertEq(s.criticalFail, false);
});

test('doctor-advisory.stampPath: absolute + literal-env-safe (no ${} in path)', () => {
  const advisory = require('./doctor-advisory.js');
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = '${CLAUDE_PLUGIN_DATA}'; // the broken-env case it warns about
  try {
    const p = advisory.stampPath();
    assert(path.isAbsolute(p), 'stamp path must be absolute (falls back to homedir), not a CWD-relative literal');
    assert(!p.includes('${'), 'stamp path must not contain the unresolved literal');
  } finally { if (saved !== undefined) process.env.CLAUDE_PLUGIN_DATA = saved; else delete process.env.CLAUDE_PLUGIN_DATA; }
});

// ─── D3 review checklist ─────────────────────────────────────────────────────
const reviewChecklist = require('./lib/review-checklist.js');

test('review-checklist.selectCodeLessons: code tags + recurrence gate, sorted', () => {
  const entries = [
    { id: 'l1', type: 'lesson', title: 'Empty catch', recurrence: 5, tags: ['code', 'error-handling'] },
    { id: 'l2', type: 'lesson', title: 'Prose pref', recurrence: 9, tags: ['style', 'writing'] },
    { id: 'l3', type: 'pattern', title: 'Race', recurrence: 3, tags: ['race'] },
    { id: 'l4', type: 'lesson', title: 'Low rec', recurrence: 1, tags: ['bug'] },
    { id: 'l5', type: 'reference', title: 'Ref w/ code tag', recurrence: 8, tags: ['api'] },
  ];
  const sel = reviewChecklist.selectCodeLessons(entries, { minRecurrence: 3 });
  assertEq(sel.map(e => e.id), ['l1', 'l3']); // l2 no code tag, l4 low rec, l5 wrong type
});

test('review-checklist.selectCodeLessons: limit caps output', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, type: 'lesson', title: 't' + i, recurrence: 5, tags: ['bug'] }));
  assertEq(reviewChecklist.selectCodeLessons(many, { minRecurrence: 3, limit: 10 }).length, 10);
});

test('review-checklist.renderChecklist: header, checkboxes, kb ids, deterministic', () => {
  const md = reviewChecklist.renderChecklist([{ id: 'l1', title: 'Empty catch masks errors', recurrence: 5 }], { project: 'demo' });
  assert(md.includes('# Brain review checklist — demo'), 'header');
  assert(md.includes('- [ ] **Empty catch masks errors** (recurred 5×)'), 'item');
  assert(md.includes('<!-- kb:l1 -->'), 'kb id link');
  assert(md.includes(reviewChecklist.CHECKLIST_MARKER), 'auto-generated marker present (delete-guard relies on it)');
  assert(!/\d{4}-\d\d-\d\dT/.test(md), 'no timestamp (deterministic body)');
  assertEq(reviewChecklist.renderChecklist([], {}).includes('No recurring code lessons yet.'), true);
});

test('review-checklist.selectCodeLessons: equal recurrence → deterministic id order', () => {
  const entries = [
    { id: 'zeta', type: 'lesson', title: 'z', recurrence: 4, tags: ['bug'] },
    { id: 'alpha', type: 'lesson', title: 'a', recurrence: 4, tags: ['bug'] },
    { id: 'mid', type: 'lesson', title: 'm', recurrence: 4, tags: ['bug'] },
  ];
  const a = reviewChecklist.selectCodeLessons(entries, { minRecurrence: 3 }).map(e => e.id);
  const b = reviewChecklist.selectCodeLessons([...entries].reverse(), { minRecurrence: 3 }).map(e => e.id);
  assertEq(a, ['alpha', 'mid', 'zeta']);
  assertEq(a, b); // order independent of input order
});

test('review-checklist-advisory.countItems: counts unchecked boxes', () => {
  const advisory = require('./review-checklist-advisory.js');
  assertEq(advisory.countItems('- [ ] a\n- [ ] b\n- [x] done\ntext'), 2);
  assertEq(advisory.countItems(''), 0);
});

// ─── F3 #5 KB consolidation planner + runner ─────────────────────────────────
const consolidatePlan = require('./lib/consolidate-plan.js');
const brainConsolidate = require('./brain-consolidate.js');

const _fakeEntries = () => ([
  { id: 'a', type: 'lesson', recurrence: 2, confidence: 0.9, createdAt: '2026-01-01', vector: [1] },
  { id: 'b', type: 'lesson', recurrence: 5, confidence: 0.8, createdAt: '2026-01-02', vector: [1] },
  { id: 'c', type: 'lesson', recurrence: 1, confidence: 0.5, createdAt: '2026-01-03', vector: [2] },
  { id: 'd', type: 'pattern', recurrence: 9, confidence: 0.9, createdAt: '2026-01-01', vector: [1] },
  { id: 'e', type: 'lesson', recurrence: 3, confidence: 0.5, createdAt: '2026-01-04', vector: null },
]);
const _clusterSim = (a, b) => (a[0] === b[0] ? 0.8 : 0.2);

test('consolidate-plan.planMerges: groups same-type near-dupes, sums recurrence', () => {
  const plans = consolidatePlan.planMerges(_fakeEntries(), _clusterSim, { minSim: 0.7, maxSim: 0.9 });
  assertEq(plans.length, 1);
  assertEq(plans[0].survivorId, 'b'); // highest recurrence
  assertEq(plans[0].absorbedIds, ['a']);
  assertEq(plans[0].newRecurrence, 7); // 2 + 5
  assertEq(plans[0].type, 'lesson');
});

test('consolidate-plan.planMerges: respects type boundary + similarity band + null vectors', () => {
  const plans = consolidatePlan.planMerges(_fakeEntries(), _clusterSim, { minSim: 0.7, maxSim: 0.9 });
  const touched = new Set([plans[0].survivorId, ...plans[0].absorbedIds]);
  assert(!touched.has('d'), 'pattern d not merged with lessons');
  assert(!touched.has('c'), 'different-cluster c not merged');
  assert(!touched.has('e'), 'null-vector e excluded');
});

test('consolidate-plan.planMerges: sim above maxSim (exact dup) is NOT merged here', () => {
  // maxSim gate: identical (sim=1.0) entries are out of the [0.7,0.9] band.
  const sim = () => 1.0;
  const es = [
    { id: 'x', type: 'lesson', recurrence: 1, vector: [1] },
    { id: 'y', type: 'lesson', recurrence: 1, vector: [1] },
  ];
  assertEq(consolidatePlan.planMerges(es, sim, { minSim: 0.7, maxSim: 0.9 }).length, 0);
});

test('consolidate-plan.planMerges: survivor-anchored — chained-but-dissimilar entry is NOT absorbed', () => {
  // A~B and B~C in band, but A~C below minSim. Single-linkage would group all
  // three; survivor-anchored must NOT absorb the entry dissimilar to the survivor.
  const sim = (a, b) => {
    const k = a[0] + '-' + b[0], k2 = b[0] + '-' + a[0];
    const band = { 'A-B': 0.85, 'B-A': 0.85, 'B-C': 0.85, 'C-B': 0.85 };
    return band[k] || band[k2] || 0.4; // A-C = 0.4 (below minSim)
  };
  const es = [
    { id: 'A', type: 'lesson', recurrence: 9, confidence: 0.9, createdAt: '2026-01-01', vector: ['A'] },
    { id: 'B', type: 'lesson', recurrence: 2, confidence: 0.5, createdAt: '2026-01-02', vector: ['B'] },
    { id: 'C', type: 'lesson', recurrence: 1, confidence: 0.5, createdAt: '2026-01-03', vector: ['C'] },
  ];
  const plans = consolidatePlan.planMerges(es, sim, { minSim: 0.7, maxSim: 0.9 });
  assertEq(plans.length, 1);
  assertEq(plans[0].survivorId, 'A'); // highest recurrence
  assertEq(plans[0].absorbedIds, ['B']); // B is in-band with A; C (0.4 to A) is NOT
  assert(!plans[0].absorbedIds.includes('C'), 'dissimilar C must not be deleted');
  assertEq(plans[0].newRecurrence, 11); // 9 + 2 (C excluded)
});

test('brain-consolidate.consolidate: dry-run plans, --apply merges atomically (fake store)', async () => {
  const state = { entries: _fakeEntries(), applied: [] };
  const fakeStore = {
    init: async () => {}, getStorageType: () => 'sqlite',
    cosineSimilarity: _clusterSim,
    listWithVectors: () => state.entries,
    applyConsolidation: (survivorId, newRecurrence, absorbedIds) => {
      state.applied.push({ survivorId, newRecurrence, absorbedIds });
      return { ok: true, deleted: absorbedIds.length };
    },
  };
  const dry = await brainConsolidate.consolidate({ project: 'p', apply: false, _store: fakeStore });
  assertEq(dry.groups, 1);
  assertEq(dry.merged, 0);
  assertEq(state.applied.length, 0); // dry run mutates nothing
  const applied = await brainConsolidate.consolidate({ project: 'p', apply: true, _store: fakeStore });
  assertEq(applied.merged, 1);
  assertEq(applied.deleted, 1);
  assertEq(state.applied[0].survivorId, 'b');
  assertEq(state.applied[0].newRecurrence, 7);
  assertEq(state.applied[0].absorbedIds, ['a']);
});

test('brain-consolidate.consolidate: non-sqlite store → no-op', async () => {
  const fakeStore = { init: async () => {}, getStorageType: () => 'json' };
  const r = await brainConsolidate.consolidate({ project: 'p', apply: true, _store: fakeStore });
  assertEq(r.reason, 'not-sqlite');
  assertEq(r.groups, 0);
});

test('value-summary.summarize: retrieval precision (cited / injected)', () => {
  const s = valueSummary.summarize([
    { eventName: 'retrieve.injected', ts: 1, payload: { count: 10 } },
    { eventName: 'retrieve.injected', ts: 2, payload: { count: 10 } },
    { eventName: 'retrieve.cited', ts: 1, payload: { entryId: 'x' } },
    { eventName: 'retrieve.cited', ts: 2, payload: { entryId: 'y' } },
  ]);
  assertEq(s.retrievalPrecision.injected, 20);
  assertEq(s.retrievalPrecision.cited, 2);
  assertEq(s.retrievalPrecision.rate, 0.1);
  assertEq(valueSummary.summarize([]).retrievalPrecision.rate, 0); // no injections → 0, no div-by-zero
});

// ─── stop-dispatcher: merge + priority ───────────────────────────────────────
const dispatcher = require('./stop-dispatcher.js');
test('stop-dispatcher.mergeBlocks: no blocks → {}', () => {
  assertEq(dispatcher.mergeBlocks([]), {});
  assertEq(dispatcher.mergeBlocks(null), {});
});

test('stop-dispatcher.mergeBlocks: single block → {decision:block, reason}', () => {
  assertEq(dispatcher.mergeBlocks([{ name: 'auto-continue-stop', reason: 'go' }]),
    { decision: 'block', reason: 'go' });
});

test('stop-dispatcher.mergeBlocks: 2 blocks concatenate with the separator', () => {
  const out = dispatcher.mergeBlocks([
    { name: 'pattern-detect', reason: 'A' },
    { name: 'auto-continue-stop', reason: 'B' },
  ]);
  assertEq(out.decision, 'block');
  assertEq(out.reason, 'A' + dispatcher.SEP + 'B');
});

test('stop-dispatcher.mergeBlocks: priority curation > failure-retro > rest', () => {
  const out = dispatcher.mergeBlocks([
    { name: 'pattern-detect', reason: 'rest' },
    { name: 'failure-retro', reason: 'retro' },
    { name: 'curation-stop', reason: 'curation' },
  ]);
  assertEq(out.reason, ['curation', 'retro', 'rest'].join(dispatcher.SEP));
});

test('stop-dispatcher.mergeBlocks: stable within same rank (exec order kept)', () => {
  const out = dispatcher.mergeBlocks([
    { name: 'pattern-detect', reason: '1' },
    { name: 'refine-research', reason: '2' },
    { name: 'auto-continue-stop', reason: '3' },
  ]);
  assertEq(out.reason, ['1', '2', '3'].join(dispatcher.SEP));
});

test('stop-dispatcher.rank: known priorities + default', () => {
  assertEq(dispatcher.rank('curation-stop'), 0);
  assertEq(dispatcher.rank('failure-retro'), 1);
  assertEq(dispatcher.rank('pattern-detect'), 2);
  assertEq(dispatcher.rank('anything'), 2);
});

test('stop-dispatcher.DETECTORS: 16 detectors, ordering invariants hold', () => {
  const names = dispatcher.DETECTORS.map(d => d.name);
  assertEq(names.length, 16);
  assert(names.includes('verify-nudge'), 'verify-nudge (D2) registered');
  assert(names.includes('self-review'), 'self-review (D1) registered');
  assert(names.includes('session-summary'), 'session-summary (U2) registered');
  assert(names.includes('conversation-ingest'), 'conversation-ingest (GAP1) registered');
  assert(names.includes('capture-dispatch'), 'capture-dispatch (Phase 1 capture) registered');
  assert(names.indexOf('self-review') < names.indexOf('verify-nudge'),
    'self-review must read verify-journal before verify-nudge clears it');
  assert(names.indexOf('failure-retro') < names.indexOf('curation-stop'),
    'failure-retro must run before curation-stop (defer-before-clear)');
  assert(names.indexOf('decision-scan-response') < names.indexOf('decision-promote'),
    'decision-scan-response must stage before decision-promote reads');
  assert(dispatcher.DETECTORS.every(d => typeof d.mod.run === 'function'),
    'every detector exposes run()');
});

// ─── stop-telemetry + dispatcher gate model (Phase 1 observability) ──────────
const telem = require('./lib/stop-telemetry.js');

test('stop-telemetry.gateState: dev enables flagged; free gates everything', () => {
  const on = { getRefineResearch: () => ({ enabled: true }) };
  const off = { getRefineResearch: () => ({ enabled: false }) };
  assertEq(telem.gateState('refine-research', 'dev', on).enabled, true);
  assertEq(telem.gateState('refine-research', 'standard', off).enabled, false);
  const g = telem.gateState('decision-promote', 'free', {});
  assertEq(g.enabled, false);
  assertEq(g.reason, 'free_passthrough');
  assertEq(telem.gateState('decision-promote', 'dev', {}).enabled, true); // non-gated always on
});

test('stop-telemetry.shouldShadow: bounds + deterministic per (runId,name)', () => {
  assertEq(telem.shouldShadow('r', 'n', 0), false);
  assertEq(telem.shouldShadow('r', 'n', 1), true);
  assertEq(telem.shouldShadow('run-x', 'refine-research', 0.5), telem.shouldShadow('run-x', 'refine-research', 0.5));
});

test('stop-telemetry.estChars: length or 0 (privacy — count not text)', () => {
  assertEq(telem.estChars('abcd'), 4);
  assertEq(telem.estChars(null), 0);
  assertEq(telem.estChars(undefined), 0);
});

test('stop-telemetry.summarize: folds ran/gated/shadow + char sums', () => {
  const s = telem.summarize('standard', 'run1', [
    { name: 'a', gated: false, blocked: true, would_block: null, chars: 10, ms: 1 },
    { name: 'b', gated: false, blocked: false, would_block: null, chars: 0, ms: 1 },
    { name: 'c', gated: true, blocked: false, would_block: null, chars: 0, ms: 0 },
    { name: 'd', gated: true, blocked: false, would_block: true, chars: 20, ms: 2 },
    { name: 'e', gated: true, blocked: false, would_block: false, chars: 0, ms: 2 },
  ]);
  assertEq(s.profile, 'standard');
  assertEq(s.run_id, 'run1');
  assertEq(s.schema, telem.SCHEMA_VERSION);
  assertEq(s.evaluated, 5);
  assertEq(s.blocked, 1);
  assertEq(s.gated, 3);
  assertEq(s.shadow, 2);
  assertEq(s.enforcedChars, 10);
  assertEq(s.avoidedChars, 20);
  assertEq(s.detectors.find(x => x.name === 'a').s, 'block');
  assertEq(s.detectors.find(x => x.name === 'c').s, 'gated');
  assertEq(s.detectors.find(x => x.name === 'd').s, 'shadow_block');
  assertEq(s.detectors.find(x => x.name === 'e').s, 'shadow_quiet');
});

test('stop-dispatcher.dispatch: enabled detector runs + blocks (injected)', async () => {
  const fake = { name: 'decision-promote', mod: { run: async () => ({ block: true, reason: 'HELLO' }) } };
  const r = await dispatcher.dispatch({}, { profile: 'dev', runId: 'r', detectors: [fake] });
  assertEq(r.blocks.length, 1);
  assertEq(r.blocks[0].reason, 'HELLO');
  assertEq(r.detectors[0].blocked, true);
  assertEq(r.detectors[0].chars, 5);
});

test('stop-dispatcher.dispatch: free gates everything — no run, no block', async () => {
  let ran = false;
  const fake = { name: 'decision-promote', mod: { run: async () => { ran = true; return { block: true, reason: 'X' }; } } };
  const r = await dispatcher.dispatch({}, { profile: 'free', runId: 'r', detectors: [fake] });
  assertEq(ran, false);
  assertEq(r.blocks.length, 0);
  assertEq(r.detectors[0].gated, true);
});

test('stop-dispatcher.dispatch: gated + detect + sampled → shadow would_block, NEVER enforced', async () => {
  let detectRan = false;
  const fake = { name: 'refine-research', mod: {
    run: async () => ({ block: true, reason: 'R' }),
    detect: async () => { detectRan = true; return { block: true, reason: 'WOULD' }; },
  } };
  const r = await dispatcher.dispatch({}, { profile: 'free', runId: 'r', shadowRate: 1, detectors: [fake] });
  assertEq(detectRan, true);
  assertEq(r.blocks.length, 0);
  assertEq(r.detectors[0].would_block, true);
  assertEq(r.detectors[0].chars, 5);
});

test('stop-dispatcher.dispatch: detector error → onError called, no block', async () => {
  const errs = [];
  const fake = { name: 'decision-promote', mod: { run: async () => { throw new Error('boom'); } } };
  const r = await dispatcher.dispatch({}, { profile: 'dev', runId: 'r', detectors: [fake], onError: (n, m) => errs.push([n, m]) });
  assertEq(r.blocks.length, 0);
  assertEq(errs.length, 1);
  assertEq(errs[0][0], 'decision-promote');
});

// ─── profile-impact aggregator (Phase 2 Insights) ────────────────────────────
const profileImpact = require('./lib/profile-impact.js');

test('profile-impact.aggregate: folds stop.dispatch per profile', () => {
  const evs = [
    { payload: { profile: 'standard', blocked: 1, gated: 3, shadow: 1, enforcedChars: 100, avoidedChars: 50,
      detectors: [
        { name: 'refine-research', s: 'gated', ms: 0 },
        { name: 'failure-retro', s: 'shadow_block', ms: 2 },
        { name: 'auto-continue-stop', s: 'gated', ms: 0 },
        { name: 'curation-stop', s: 'block', ms: 1 },
      ] } },
    { payload: { profile: 'standard', blocked: 0, gated: 2, shadow: 0, enforcedChars: 0, avoidedChars: 0,
      detectors: [
        { name: 'refine-research', s: 'gated', ms: 0 },
        { name: 'failure-retro', s: 'gated', ms: 0 },
      ] } },
    { payload: { profile: 'free', blocked: 0, gated: 5, shadow: 0, enforcedChars: 0, avoidedChars: 0, detectors: [] } },
  ];
  const r = profileImpact.aggregateProfileImpact(evs);
  const std = r.profiles.find(p => p.profile === 'standard');
  assertEq(std.stops, 2);
  assertEq(std.blocked, 1);
  assertEq(std.gated, 5);
  assertEq(std.wouldBlock, 1);
  assertEq(std.avoidedChars, 50);
  assertEq(std.topGated[0].name, 'refine-research'); // gated twice → top
  assertEq(std.topGated[0].count, 2);
  assertEq(r.profiles[0].profile, 'standard'); // sorted by stops desc
  assertEq(r.profiles.find(p => p.profile === 'free').gated, 5);
});

test('profile-impact.aggregate: empty/garbage tolerated', () => {
  assertEq(profileImpact.aggregateProfileImpact([]).profiles.length, 0);
  assertEq(profileImpact.aggregateProfileImpact(null).profiles.length, 0);
});

// ─── tuning-advisor (mechanical, zero-quota recommendations) ─────────────────
const tuningAdvisor = require('./lib/tuning-advisor.js');

test('tuning-advisor: free with blocks → warn (leak)', () => {
  const r = tuningAdvisor.analyze({ activeProfile: 'free',
    impact: { profiles: [{ profile: 'free', stops: 50, blocked: 3, gated: 100, wouldBlock: 0, shadowSamples: 0 }] } });
  assert(r.recommendations.some(x => x.id === 'free-leak' && x.level === 'warn'), 'expected free-leak warn');
});

test('tuning-advisor: dev with zero blocks → suggest standard', () => {
  const r = tuningAdvisor.analyze({ activeProfile: 'dev',
    impact: { profiles: [{ profile: 'dev', stops: 40, blocked: 0, gated: 0, wouldBlock: 0, shadowSamples: 0 }] } });
  assert(r.recommendations.some(x => x.id === 'dev-quiet' && x.level === 'suggest'));
});

test('tuning-advisor: standard high would-block → suggest dev; low → info good', () => {
  const hi = tuningAdvisor.analyze({ activeProfile: 'standard',
    impact: { profiles: [{ profile: 'standard', stops: 30, blocked: 1, gated: 60, wouldBlock: 8, shadowSamples: 10 }] } });
  assert(hi.recommendations.some(x => x.id === 'standard-costly' && x.level === 'suggest'));
  const lo = tuningAdvisor.analyze({ activeProfile: 'standard',
    impact: { profiles: [{ profile: 'standard', stops: 30, blocked: 1, gated: 60, wouldBlock: 1, shadowSamples: 10 }] } });
  assert(lo.recommendations.some(x => x.id === 'standard-good' && x.level === 'info'));
});

test('tuning-advisor: recall precision low → suggest raise minScore', () => {
  const r = tuningAdvisor.analyze({ retrieval: { fired: 40, cited: 8 } });
  assert(r.recommendations.some(x => x.id === 'recall-noisy' && x.level === 'suggest'));
});



test('F1: tuning-advisor NEVER recommends disabling a learning nudge (no nudge-weak)', () => {
  // Anti-pattern that caused the regression: advising "the profile could disable it
  // without loss" for a low-conversion capture nudge. Low conversion means aim/
  // surface it better, NOT kill learning. The nudge-weak rule is gone.
  const r = tuningAdvisor.analyze({ captureRate: { byKind: {
    correction: { nudges: 50, captures: 0, rate: 0 },
    pattern: { nudges: 20, captures: 1, rate: 0.05 },
  } } });
  assert(!r.recommendations.some(x => String(x.id).startsWith('nudge-weak')),
    `must not recommend disabling a learning nudge; got ${JSON.stringify(r.recommendations.map(x => x.id))}`);
});

test('tuning-advisor: below sample size → silent (no advice on noise)', () => {
  const r = tuningAdvisor.analyze({ activeProfile: 'dev',
    impact: { profiles: [{ profile: 'dev', stops: 5, blocked: 0, gated: 0, wouldBlock: 0, shadowSamples: 0 }] },
    retrieval: { fired: 3, cited: 0 },
    captureRate: { byKind: { pattern: { nudges: 2, captures: 0, rate: 0 } } } });
  assertEq(r.recommendations.length, 0);
});

test('tuning-advisor: warn sorts before suggest', () => {
  const r = tuningAdvisor.analyze({ activeProfile: 'free',
    impact: { profiles: [{ profile: 'free', stops: 50, blocked: 2, gated: 10, wouldBlock: 0, shadowSamples: 0 }] },
    retrieval: { fired: 40, cited: 8 } });
  assertEq(r.recommendations[0].level, 'warn');
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 5 — atomicity + de-duplication (state-write corruption & data-dir split-brain)
// ═══════════════════════════════════════════════════════════════════════════

// ─── lib/data-dir.js — one guarded resolver (kills the ${...} split-brain) ────
const dataDirLib = require('./lib/data-dir.js');

test('data-dir: honors a real CLAUDE_PLUGIN_DATA value AND publishes the active pointer', () => {
  // (a) env wins — and dataDir() PUBLISHES it to the global pointer so env-less
  // hooks (SessionStart etc.) can follow the SAME live folder instead of forking.
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-dd-real-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = real;
      assertEq(dataDirLib.dataDir(), real);
      assertEq(dataDirLib.readActivePointer(), real);
      assert(fs.existsSync(path.join(home, '.claude', 'claude-code-boss', 'active-data-dir.json')),
        'dataDir() with a real env must publish the active-data-dir pointer');
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: FOLLOWS the published pointer when env is absent', () => {
  // (b) no env → resolve the app's live folder from the global pointer that an
  // env-aware process (brain-server / a guarded hook) previously published.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-dd-live-'));
    try {
      delete process.env.CLAUDE_PLUGIN_DATA;
      dataDirLib.writeActivePointer(live);
      assertEq(dataDirLib.dataDir(), live);
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: bootstraps the most-recently-written claude-code-boss* sibling (excludes other plugins)', () => {
  // (c) no env, no pointer → pick the live install by brain/ mtime, and NEVER a
  // non-claude-code-boss sibling (codex-inline, rf-reviewer-*) even if it is newer.
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    try {
      delete process.env.CLAUDE_PLUGIN_DATA;
      const base = path.join(home, '.claude', 'plugins', 'data');
      const mk = (name, mtimeSec) => {
        const b = path.join(base, name, 'brain');
        fs.mkdirSync(b, { recursive: true });
        fs.utimesSync(b, mtimeSec, mtimeSec);
      };
      const now = Date.now() / 1000;
      mk('claude-code-boss', now - 100);
      mk('claude-code-boss-abcd1234', now - 10);   // most-recent claude-code-boss
      mk('claude-code-boss-old', now - 500);
      mk('codex-inline', now + 1000);              // newer, but a DIFFERENT plugin
      mk('rf-reviewer-xyz', now + 2000);           // newer, but a DIFFERENT plugin
      const want = path.join(base, 'claude-code-boss-abcd1234');
      assertEq(dataDirLib.bootstrapMostRecent(), want);
      assertEq(dataDirLib.dataDir(), want);
      // and bootstrapping self-publishes the pick so the next env-less call is O(1)
      assertEq(dataDirLib.readActivePointer(), want);
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: falls back to the stable home path when nothing exists', () => {
  // (d) no env, no pointer, no siblings → the bare, stable home fallback.
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    try {
      delete process.env.CLAUDE_PLUGIN_DATA;
      assertEq(dataDirLib.dataDir(),
        path.join(home, '.claude', 'plugins', 'data', 'claude-code-boss'));
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: REJECTS an unexpanded ${...} placeholder (no literal-dir split-brain)', () => {
  // TEETH: some hook contexts don't substitute ${CLAUDE_PLUGIN_DATA}; a naive
  // `env || fallback` would return the literal "${CLAUDE_PLUGIN_DATA}" as a dir,
  // splitting state away from the guarded scripts. dataDir() must fall back.
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    try {
      process.env.CLAUDE_PLUGIN_DATA = '${CLAUDE_PLUGIN_DATA}';
      const d = dataDirLib.dataDir();
      assert(!d.includes('${'), `must not resolve to a placeholder dir, got ${d}`);
      assertEq(d, path.join(home, '.claude', 'plugins', 'data', 'claude-code-boss'));
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: REJECTS an empty-string env (falls back)', () => {
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    try {
      process.env.CLAUDE_PLUGIN_DATA = '';
      assertEq(dataDirLib.dataDir(),
        path.join(home, '.claude', 'plugins', 'data', 'claude-code-boss'));
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: validEnvDir mirrors the guard (unit)', () => {
  assertEq(dataDirLib.validEnvDir('/real/dir'), '/real/dir');
  assertEq(dataDirLib.validEnvDir('${X}'), null);
  assertEq(dataDirLib.validEnvDir(''), null);
  assertEq(dataDirLib.validEnvDir(undefined), null);
});

test('data-dir: pointer helpers round-trip; readActivePointer null for missing/corrupt/stale', () => {
  withTempHome((home) => {
    // globalDir() is the stable, cross-folder-invariant home; the pointer lives there.
    assertEq(dataDirLib.globalDir(), path.join(home, '.claude', 'claude-code-boss'));
    assertEq(path.dirname(dataDirLib.activePointerPath()), dataDirLib.globalDir());
    // missing pointer file → null
    assertEq(dataDirLib.readActivePointer(), null);
    // round-trip a real, existing dir
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ptr-'));
    dataDirLib.writeActivePointer(real);
    assertEq(dataDirLib.readActivePointer(), real);
    // stale dir (recorded but since deleted) self-heals → null
    const gone = path.join(os.tmpdir(), `ccb-ptr-gone-${Date.now()}`);
    dataDirLib.writeActivePointer(gone);
    assertEq(dataDirLib.readActivePointer(), null);
    // corrupt JSON → null (tolerated, not thrown)
    fs.writeFileSync(dataDirLib.activePointerPath(), '{not json');
    assertEq(dataDirLib.readActivePointer(), null);
  });
});

test('brain-config: reads the per-user override from the GLOBAL path (not per-data-dir)', () => {
  // The backend choice must be visible to every writer regardless of which data
  // dir it resolved — so the override lives at globalDir()/user-config.json.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ucp-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const gp = path.join(dataDirLib.globalDir(), 'user-config.json');
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.writeFileSync(gp, JSON.stringify({ backend: { type: 'mcp-memory' } }));
      brainConfig._resetCache();
      assertEq(brainConfig.getBackendType(), 'mcp-memory');
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; brainConfig._resetCache(); }
  });
});

test('brain-config: backfills a legacy per-data-dir user-config up to the global path', () => {
  // Migration: an existing user's choice under DATA_DIR/brain/user-config.json is
  // copied up to globalDir() the first time load() runs with no global override.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bf-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const legacy = path.join(dir, 'brain', 'user-config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ backend: { type: 'mcp-memory' } }));
      const gp = path.join(dataDirLib.globalDir(), 'user-config.json');
      assert(!fs.existsSync(gp), 'precondition: global override absent');
      brainConfig._resetCache();
      assertEq(brainConfig.getBackendType(), 'mcp-memory');       // honored via backfill
      assert(fs.existsSync(gp), 'legacy override must be copied up to the global path');
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { backend: { type: 'mcp-memory' } });
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; brainConfig._resetCache(); }
  });
});

test('brain-config: backfill NEVER overwrites an existing global override', () => {
  // An already-migrated global choice must win; a stale legacy file cannot clobber it.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bf2-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const gp = path.join(dataDirLib.globalDir(), 'user-config.json');
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.writeFileSync(gp, JSON.stringify({ backend: { type: 'local' } }));          // existing global
      const legacy = path.join(dir, 'brain', 'user-config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ backend: { type: 'mcp-memory' } })); // conflicting legacy
      brainConfig._resetCache();
      assertEq(brainConfig.getBackendType(), 'local');            // global wins
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { backend: { type: 'local' } });
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; brainConfig._resetCache(); }
  });
});

// ─── Phase 1.5: hooks + router per-user configs moved to the stable GLOBAL path ───
const routerCfgPath = require('./lib/router-config-path.js');

test('hooks-config: userConfigPath is under globalDir()/hooks (stable, not the data dir)', () => {
  withTempHome(() => {
    assertEq(hooksConfig.userConfigPath(),
      path.join(dataDirLib.globalDir(), 'hooks', 'user-config.json'));
  });
});

test('hooks-config: backfills a legacy per-data-dir user-config up to the global path', () => {
  // Migration: an existing user's profile under DATA_DIR/hooks/user-config.json is
  // copied up to globalDir()/hooks the first time load() runs with no global override.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hbf-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const legacy = path.join(dir, 'hooks', 'user-config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ profile: 'free' }));
      const gp = path.join(dataDirLib.globalDir(), 'hooks', 'user-config.json');
      assert(!fs.existsSync(gp), 'precondition: global override absent');
      hooksConfig._resetCache();
      assertEq(hooksConfig.getProfile(), 'free');                 // honored via backfill
      assert(fs.existsSync(gp), 'legacy override must be copied up to the global path');
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { profile: 'free' });
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; hooksConfig._resetCache(); }
  });
});

test('hooks-config: backfill NEVER overwrites an existing global override', () => {
  // An already-migrated global choice must win; a stale legacy file cannot clobber it.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hbf2-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const gp = path.join(dataDirLib.globalDir(), 'hooks', 'user-config.json');
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.writeFileSync(gp, JSON.stringify({ profile: 'standard' }));   // existing global
      const legacy = path.join(dir, 'hooks', 'user-config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ profile: 'free' }));   // conflicting legacy
      hooksConfig._resetCache();
      assertEq(hooksConfig.getProfile(), 'standard');            // global wins
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { profile: 'standard' });
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; hooksConfig._resetCache(); }
  });
});

test('router-config-path: routerUserConfigPath is under globalDir()/model-router (stable)', () => {
  withTempHome(() => {
    assertEq(routerCfgPath.routerUserConfigPath(),
      path.join(dataDirLib.globalDir(), 'model-router', 'user-config.json'));
    // runtime state stays per-folder — legacy path is under the resolved data dir.
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rlegacy-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      assertEq(routerCfgPath.legacyRouterUserConfigPath(),
        path.join(dir, 'model-router', 'user-config.json'));
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('router-config-path: backfills a legacy user-config up to the global path once (+0600 on POSIX)', () => {
  // The NVIDIA key + toggles under DATA_DIR/model-router/user-config.json migrate up
  // to globalDir()/model-router exactly once, and the global key file is owner-only.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rbf-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const legacy = path.join(dir, 'model-router', 'user-config.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ nim: { apiKey: 'nvapi-secret' } }));
      const gp = path.join(dataDirLib.globalDir(), 'model-router', 'user-config.json');
      assert(!fs.existsSync(gp), 'precondition: global router config absent');
      routerCfgPath.backfillRouterUserConfig();
      assert(fs.existsSync(gp), 'legacy router config must be copied up to the global path');
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { nim: { apiKey: 'nvapi-secret' } });
      if (process.platform !== 'win32') {
        assertEq(fs.statSync(gp).mode & 0o777, 0o600);   // owner-only (holds the NVIDIA key)
      }
      // Idempotent: a second call with a DIFFERENT legacy must NOT overwrite the global.
      fs.writeFileSync(legacy, JSON.stringify({ nim: { apiKey: 'nvapi-CHANGED' } }));
      routerCfgPath.backfillRouterUserConfig();
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')), { nim: { apiKey: 'nvapi-secret' } });
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('dashboard.writeRouterOverride writes the GLOBAL router config and preserves an untouched key', () => {
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-dash-rw-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const gp = path.join(dataDirLib.globalDir(), 'model-router', 'user-config.json');
      delete require.cache[require.resolve('./dashboard.js')];
      const dash = require('./dashboard.js'); // resolves ROUTER_USER_CONFIG at load → global path
      // Seed a key, then toggle `enabled` WITHOUT resending the key → key must survive.
      dash.writeRouterOverride({ nimApiKey: 'nvapi-keep-me' });
      assert(fs.existsSync(gp), 'router override must be written to the global path');
      assertEq(JSON.parse(fs.readFileSync(gp, 'utf-8')).nim.apiKey, 'nvapi-keep-me');
      dash.writeRouterOverride({ enabled: true }); // no nimApiKey → existing key untouched
      const out = JSON.parse(fs.readFileSync(gp, 'utf-8'));
      assertEq(out.nim.apiKey, 'nvapi-keep-me');   // preserved
      assertEq(out.enabled, true);
      if (process.platform !== 'win32') {
        assertEq(fs.statSync(gp).mode & 0o777, 0o600);   // hardened after each write
      }
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = saved;
      delete require.cache[require.resolve('./dashboard.js')];
    }
  });
});

test('capture-dispatch: _captureConfig honors the GLOBAL brain kb.capture override', () => {
  // Phase-1 gap closed: capture now reads brain-config.load() (shipped ⊕ global
  // override), not a stale legacy DATA_DIR/brain/user-config.json.
  withTempHome(() => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-capcfg-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = dir;
      const gp = path.join(dataDirLib.globalDir(), 'user-config.json');
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.writeFileSync(gp, JSON.stringify({ kb: { capture: { enabled: false, maxBlockAttempts: 9 } } }));
      brainConfig._resetCache();
      const cd = require('./capture-dispatch.js');
      const cfg = cd._captureConfig();
      assertEq(cfg.enabled, false);
      assertEq(cfg.maxBlockAttempts, 9);
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; brainConfig._resetCache(); }
  });
});

// ─── lib/atomic-write.js — temp+rename so readers never see a partial file ───
const atomicLib = require('./lib/atomic-write.js');

test('atomic-write: writeJsonAtomic roundtrips through a real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'state.json');
  atomicLib.writeJsonAtomic(f, { a: 1, b: [2, 3] });
  assertEq(JSON.parse(fs.readFileSync(f, 'utf-8')), { a: 1, b: [2, 3] });
});

test('atomic-write: creates missing parent dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'nested', 'deep', 'state.json');
  atomicLib.writeJsonAtomic(f, { ok: true });
  assert(fs.existsSync(f), 'nested file must exist');
});

test('atomic-write: leaves the destination UNTOUCHED when rename fails (no truncation)', () => {
  // TEETH: the whole point of temp+rename. If the write is interrupted at the
  // commit step, a concurrent reader must still see the OLD content — never a
  // half-written destination. A naive writeFileSync(dest) would truncate it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ version: 'OLD' }));
  const io = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: () => { throw new Error('simulated crash at commit'); },
    unlinkSync: fs.unlinkSync,
  };
  let threw = false;
  try { atomicLib.writeFileAtomic(f, JSON.stringify({ version: 'NEW' }), io); }
  catch { threw = true; }
  assert(threw, 'a failed commit must surface as a throw');
  // Destination still holds the OLD, complete content.
  assertEq(JSON.parse(fs.readFileSync(f, 'utf-8')), { version: 'OLD' });
  // No temp litter left behind.
  const litter = fs.readdirSync(dir).filter(n => n.includes('.tmp-'));
  assertEq(litter.length, 0, `temp files must be cleaned up, found ${JSON.stringify(litter)}`);
});

test('atomic-write: temp path is unique per call (concurrent writers do not collide)', () => {
  const f = path.join(os.tmpdir(), 'x', 'state.json');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(atomicLib.tempPathFor(f));
  assertEq(seen.size, 200, 'every temp path must be distinct');
  for (const p of seen) assert(p.startsWith(f + '.tmp-'), `temp must be a sibling of dest: ${p}`);
});

test('atomic-write: success leaves no temp sibling behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'state.json');
  atomicLib.writeJsonAtomic(f, { n: 1 });
  atomicLib.writeJsonAtomic(f, { n: 2 });
  const litter = fs.readdirSync(dir).filter(n => n.includes('.tmp-'));
  assertEq(litter.length, 0, `no temp litter, found ${JSON.stringify(litter)}`);
  assertEq(JSON.parse(fs.readFileSync(f, 'utf-8')), { n: 2 });
});

// ─── consumers actually route state writes through atomic-write (structural) ──
test('atomic-write: hot state stores route writes through writeJsonAtomic (no raw writeFileSync)', () => {
  const stores = [
    'lib/oneoff-store.js', 'lib/cooldown-store.js',
    'lib/recall-health.js', 'lib/active-research-state.js',
    'lib/failure-journal.js', 'lib/turn-journal.js',
    'lib/retrieval-journal.js', 'lib/verify-journal.js',
  ];
  for (const rel of stores) {
    const src = fs.readFileSync(path.join(SCRIPTS, rel), 'utf-8');
    assert(/require\(['"]\.\/atomic-write\.js['"]\)/.test(src),
      `${rel} must require lib/atomic-write.js`);
    // No direct fs.writeFileSync of a state payload left in these stores.
    assert(!/fs\.writeFileSync\(/.test(src),
      `${rel} must not call fs.writeFileSync directly (use writeJsonAtomic)`);
  }
});

test('data-dir: NO script keeps a bare unguarded `env || fallback` resolver (EXHAUSTIVE)', () => {
  // Rubber-duck gate finding: a representative sample can't lock the invariant.
  // Walk EVERY script and fail on any bare `process.env.CLAUDE_PLUGIN_DATA ||`
  // (the split-brain form that accepts an unexpanded `${...}` literal). Guarded
  // forms — validEnvDir(...)/valid(...)/an `env` var checked with !includes('${')
  // — never place `||` immediately after the env read, so they don't match.
  const offenders = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!n.endsWith('.js') || /^(test-|smoke-)/.test(n) || n === 'data-dir.js') continue;
      const src = fs.readFileSync(p, 'utf-8');
      // Genuine split-brain form: env falls back to a real directory expression
      // (`path.join(...)` / `require('os').homedir()`). Benign `|| ''` display
      // defaults in diagnostic reports are not resolvers and don't match.
      if (/process\.env\.CLAUDE_PLUGIN_DATA\s*\|\|\s*(path\.join|require\()/.test(src)) {
        offenders.push(path.relative(SCRIPTS, p));
      }
    }
  };
  walk(SCRIPTS);
  assertEq(offenders, [], `unguarded CLAUDE_PLUGIN_DATA resolvers remain: ${offenders.join(', ')}`);
});

test('test/smoke harnesses that spawn a hook with a temp CLAUDE_PLUGIN_DATA must isolate HOME/USERPROFILE (EXHAUSTIVE)', () => {
  // Root cause (found live, this repo, this machine): a hermetic test/smoke
  // script spawns a hook CHILD process with its OWN temp CLAUDE_PLUGIN_DATA,
  // but never overrides HOME/USERPROFILE for that child — so data-dir.js's
  // dataDir() in the child resolves os.homedir() to the REAL developer home,
  // and since the env value is valid, dataDir() PUBLISHES the throwaway temp
  // path into the REAL, cross-project ~/.claude/claude-code-boss/
  // active-data-dir.json (test-units.js already isolates HOME for its OWN
  // in-process run — see the top of this file — but that only protects
  // in-process require() calls, not a harness that spawns children). Confirmed
  // live: running test-hooks.js's skill-metric test corrupted the real pointer
  // on this machine before this was fixed.
  //
  // Fix pattern (either satisfies this guard): isolate HOME/USERPROFILE ONCE
  // per file via `process.env.HOME = process.env.USERPROFILE = <temp dir>`
  // before any `...process.env` spread (whole-run isolation), OR pass an
  // explicit `HOME`/`USERPROFILE` key in the specific spawn call's env object
  // (per-call isolation). A representative sample can't lock this invariant —
  // walk every test/smoke harness that could spawn a hook.
  const offenders = [];
  const candidates = [path.join(SCRIPTS, 'test-hooks.js')];
  const smokeDir = path.join(ROOT, 'smoke');
  if (fs.existsSync(smokeDir)) {
    for (const n of fs.readdirSync(smokeDir)) {
      if (/\.(m?js)$/.test(n)) candidates.push(path.join(smokeDir, n));
    }
  }
  const SPAWNS_CHILD = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/;
  const SETS_DATA_ENV = /CLAUDE_PLUGIN_DATA\s*:/;
  const ISOLATES_HOME = /process\.env\.(?:HOME|USERPROFILE)\s*=|\b(?:HOME|USERPROFILE)\s*:/;
  for (const p of candidates) {
    const src = fs.readFileSync(p, 'utf-8');
    if (SPAWNS_CHILD.test(src) && SETS_DATA_ENV.test(src) && !ISOLATES_HOME.test(src)) {
      offenders.push(path.relative(ROOT, p));
    }
  }
  assertEq(offenders, [],
    `test/smoke harnesses spawning hooks with a temp CLAUDE_PLUGIN_DATA but no HOME/USERPROFILE isolation: ${offenders.join(', ')}`);
});

test('data-dir: migrated consumers import the shared resolver', () => {
  const consumers = [
    'lib/cooldown-store.js', 'lib/verify-journal.js', 'lib/failure-journal.js',
    'lib/recall-health.js', 'lib/scope-search.js', 'conversation-ingest.js',
    'curation-session.js', 'curation-detect.js', 'decision-detect.js',
    'brain-index-native.js', 'brain-promote.js', 'dashboard.js',
    // Phase-1 inliners repointed off the bare fallback onto the shared resolver.
    'brain-embedder.js', 'doctor-advisory.js', 'project-identity-advisory.js',
    'research-followup-detect.js', 'skill-promote-trigger.js', 'tuning-advisory.js',
    'review-checklist-advisory.js',
  ];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(SCRIPTS, rel), 'utf-8');
    assert(/require\(['"](\.\/|\.\/lib\/)data-dir\.js['"]\)/.test(src),
      `${rel} must resolve its data dir via lib/data-dir.js`);
  }
});

test('atomic-write: broadened shared-snapshot writers route through atomic-write.js', () => {
  // Gate finding (scope): the same torn-write class covered more than the first 8
  // stores. These hook-writable shared-snapshot writers were migrated too.
  const writers = [
    'auto-continue-stop.js', 'brain-graph.js', 'brain-index.js', 'brain-index-native.js',
    'brain-health.js', 'session-whitelist.js', 'decision-detect.js', 'decision-promote.js',
    'decision-scan-response.js', 'model-router-ensure.js', 'pattern-detect.js', 'refine-research.js',
    'self-review.js', 'session-summary.js', 'skill-success-detect.js', 'verify-nudge.js',
    'research-followup-detect.js', 'curation-stop.js', 'hook-logger.js', 'project-snapshot.js',
    'doctor-advisory.js', 'review-checklist-advisory.js', 'tuning-advisory.js',
    'conversation-ingest.js', 'curation-session.js', 'lib/hooks-config.js', 'dashboard.js',
  ];
  for (const rel of writers) {
    const src = fs.readFileSync(path.join(SCRIPTS, rel), 'utf-8');
    assert(/require\(['"](\.\/|\.\/lib\/)atomic-write\.js['"]\)/.test(src),
      `${rel} must import lib/atomic-write.js`);
  }
});

// ─── Sprint 5 fix-loop — gate findings (Windows rename retry, whitespace, dashboard) ──
test('atomic-write: retries a transient rename failure (EPERM) instead of dropping the write', () => {
  // TEETH (Windows liveness): fs.renameSync throws EPERM/EACCES/EBUSY when a
  // concurrent writer/reader holds the destination (MoveFileEx sharing violation).
  // Without a retry, swallow-catch stores silently DROP the update. writeFileAtomic
  // must retry transient rename errors and eventually commit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'state.json');
  let calls = 0;
  const io = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: (tmp, dest) => {
      calls += 1;
      if (calls <= 2) { const e = new Error('EPERM: contention'); e.code = 'EPERM'; throw e; }
      fs.renameSync(tmp, dest);
    },
    unlinkSync: fs.unlinkSync,
  };
  atomicLib.writeFileAtomic(f, JSON.stringify({ v: 'committed' }), io);
  assert(calls === 3, `expected 3 rename attempts (2 EPERM + 1 ok), got ${calls}`);
  assertEq(JSON.parse(fs.readFileSync(f, 'utf-8')), { v: 'committed' });
});

test('atomic-write: a NON-transient rename error is NOT retried (fails fast, dest untouched)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-atomic-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ v: 'OLD' }));
  let calls = 0;
  const io = {
    mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync,
    renameSync: () => { calls += 1; throw new Error('ENOSPC: no space'); },
  };
  let threw = false;
  try { atomicLib.writeFileAtomic(f, JSON.stringify({ v: 'NEW' }), io); } catch { threw = true; }
  assert(threw, 'a non-transient error must surface');
  assert(calls === 1, `non-transient must not retry, got ${calls} attempts`);
  assertEq(JSON.parse(fs.readFileSync(f, 'utf-8')), { v: 'OLD' });
});

test('data-dir: REJECTS a whitespace-only env value (falls back)', () => {
  withTempHome((home) => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    try {
      for (const ws of ['   ', '\t', '\n']) {
        process.env.CLAUDE_PLUGIN_DATA = ws;
        assertEq(dataDirLib.dataDir(),
          path.join(home, '.claude', 'plugins', 'data', 'claude-code-boss'),
          `whitespace ${JSON.stringify(ws)} must fall back`);
      }
      assertEq(dataDirLib.validEnvDir('   '), null);
      assertEq(dataDirLib.validEnvDir('\t'), null);
    } finally { process.env.CLAUDE_PLUGIN_DATA = saved; }
  });
});

test('data-dir: dashboard.js resolvers are guarded (no bare `env || fallback` split-brain)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'dashboard.js'), 'utf-8');
  // Every CLAUDE_PLUGIN_DATA read must be wrapped by the guard (validEnvDir/dataDir),
  // never the naive `process.env.CLAUDE_PLUGIN_DATA ||` that accepts a ${...} literal.
  assert(!/process\.env\.CLAUDE_PLUGIN_DATA\s*\|\|/.test(src),
    'dashboard.js must not keep an unguarded `process.env.CLAUDE_PLUGIN_DATA ||` resolver');
  assert(/require\(['"]\.\/lib\/data-dir\.js['"]\)/.test(src),
    'dashboard.js must resolve its data dir via lib/data-dir.js');
});

// ─── session-marker (capture-window cursor state machine — Phase 1 task 1) ───
// Failing-first: lazy require so only these RED until lib/session-marker.js exists.
test('session-marker: initIfAbsent baselines committed at START (offset 0); idempotent', () => {
  const sm = require('./lib/session-marker.js');
  const project = 'sm-init-' + Date.now();
  const sid = 's1-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `t1-${sid}.jsonl`);
  fs.writeFileSync(tp, 'line1\nline2\n');
  const st1 = sm.initIfAbsent(project, sid, tp);
  assert(st1.committed, 'committed set');
  assertEq(st1.committed.offset, 0, 'committed at transcript start (nothing before first Stop is skipped)');
  assertEq(st1.pending, null, 'no pending initially');
  fs.appendFileSync(tp, 'line3\n');
  const st2 = sm.initIfAbsent(project, sid, tp);
  assertEq(st2.committed.offset, 0, 'init idempotent (committed unchanged)');
  sm.resetAll(project, sid);
});

test('session-marker: beginPending keeps committed; commit advances + clears pending', () => {
  const sm = require('./lib/session-marker.js');
  const project = 'sm-commit-' + Date.now();
  const sid = 's2-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `t2-${sid}.jsonl`);
  fs.writeFileSync(tp, 'a\nb\n');
  sm.initIfAbsent(project, sid, tp);
  fs.appendFileSync(tp, 'c\nd\n');
  const size = fs.statSync(tp).size;
  sm.beginPending(project, sid, 4, size, 'win1');
  let st = sm.getState(project, sid);
  assertEq(st.committed.offset, 0, 'committed unchanged during pending');
  assert(st.pending && st.pending.to === size, 'pending open at window end');
  sm.commit(project, sid, size, sm.anchorAt(tp, size), size);
  st = sm.getState(project, sid);
  assertEq(st.committed.offset, size, 'committed advanced to window end');
  assertEq(st.pending, null, 'pending cleared on commit');
  sm.resetAll(project, sid);
});

test('session-marker: clearPending aborts window; committed stays', () => {
  const sm = require('./lib/session-marker.js');
  const project = 'sm-abort-' + Date.now();
  const sid = 's3-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `t3-${sid}.jsonl`);
  fs.writeFileSync(tp, 'x\n');
  sm.initIfAbsent(project, sid, tp);
  fs.appendFileSync(tp, 'y\n');
  const size = fs.statSync(tp).size;
  sm.beginPending(project, sid, 2, size, 'w');
  sm.clearPending(project, sid);
  const st = sm.getState(project, sid);
  assertEq(st.committed.offset, 0, 'committed unchanged after abort');
  assertEq(st.pending, null, 'pending cleared');
  sm.resetAll(project, sid);
});

test('session-marker: validateAnchor matches unchanged file, detects truncation', () => {
  const sm = require('./lib/session-marker.js');
  const project = 'sm-anchor-' + Date.now();
  const sid = 's4-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `t4-${sid}.jsonl`);
  fs.writeFileSync(tp, 'aaaa\nbbbb\n');
  const size = fs.statSync(tp).size;
  sm.initIfAbsent(project, sid, tp);
  sm.commit(project, sid, size, sm.anchorAt(tp, size), size);
  let v = sm.validateAnchor(tp, sm.getState(project, sid).committed);
  assert(v.ok, 'anchor matches on unchanged file');
  fs.writeFileSync(tp, 'zz\n'); // compaction rewrites the file shorter
  v = sm.validateAnchor(tp, sm.getState(project, sid).committed);
  assert(!v.ok, 'anchor mismatch detected after truncation');
  sm.resetAll(project, sid);
});

test('session-marker: append-only transitions — latest pending wins (race-free)', () => {
  const sm = require('./lib/session-marker.js');
  const project = 'sm-race-' + Date.now();
  const sid = 's5-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `t5-${sid}.jsonl`);
  fs.writeFileSync(tp, 'a\n');
  sm.initIfAbsent(project, sid, tp);
  sm.beginPending(project, sid, 2, 4, 'w1');
  sm.beginPending(project, sid, 2, 6, 'w2');
  const st = sm.getState(project, sid);
  assertEq(st.pending.windowHash, 'w2', 'latest pending wins');
  sm.resetAll(project, sid);
});

// ─── transcript-block (deterministic JSONL clean — Phase 1 task 2) ───────────
// Failing-first: lazy require until lib/transcript-block.js exists.
test('transcript-block: extractCycles keeps human cycles, drops tool/meta/sidechain, assistant text-only', () => {
  const tb = require('./lib/transcript-block.js');
  const lines = [
    JSON.stringify({ type: 'user', promptId: 'p1', isSidechain: false, message: { role: 'user', content: 'How do I center a div?' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-sonnet-5', content: [
      { type: 'thinking', thinking: 'hmm let me think' },
      { type: 'text', text: 'Use flexbox.' },
      { type: 'tool_use', name: 'edit', input: {} },
    ] } }),
    JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
    JSON.stringify({ type: 'user', isMeta: true, promptId: 'meta1', message: { role: 'user', content: '[hook feedback] capture the lesson' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } }),
    JSON.stringify({ type: 'user', promptId: 'p2', isSidechain: false, message: { role: 'user', content: 'no, use grid instead' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Okay, grid works too.' }] } }),
    JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary of prior context' } }),
  ];
  const cycles = tb.extractCycles(lines);
  assertEq(cycles.length, 2, 'two human cycles');
  assertEq(cycles[0].promptId, 'p1');
  assert(cycles[0].user.includes('center a div'), 'user text kept');
  assert(cycles[0].assistant.includes('Use flexbox'), 'assistant text kept');
  assert(!cycles[0].assistant.includes('hmm'), 'thinking dropped');
  assert(!cycles[0].assistant.includes('edit'), 'tool_use dropped');
  assertEq(cycles[1].promptId, 'p2');
  assert(cycles.every(c => !c.user.includes('hook feedback')), 'isMeta excluded');
  assert(cycles.every(c => !c.assistant.includes('subagent')), 'sidechain excluded');
});

test('transcript-block: extractCycles dedupes multi-envelope human turn by promptId', () => {
  const tb = require('./lib/transcript-block.js');
  const lines = [
    JSON.stringify({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'part one' } }),
    JSON.stringify({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'part two' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
  ];
  assertEq(tb.extractCycles(lines).length, 1, 'same promptId = one cycle');
});

test('transcript-block: renderBlock marks roles and respects hard char cap', () => {
  const tb = require('./lib/transcript-block.js');
  const cycles = [{ promptId: 'p1', user: 'Q1', assistant: 'A1' }, { promptId: 'p2', user: 'Q2', assistant: 'A2' }];
  const full = tb.renderBlock(cycles, 10000);
  assert(/USER/.test(full) && /ASSISTANT/.test(full), 'role markers present');
  assert(full.includes('Q1') && full.includes('A2'), 'content present');
  assert(full.length <= 10000, 'within cap');
  const capped = tb.renderBlock(cycles, 40);
  assert(capped.length <= 40, `hard cap respected: got ${capped.length}`);
});

// ─── turn-budget (per-model cadence + fire condition — Phase 1 task 3) ────────
test('turn-budget: budgetForModel scales by family; maxChars hard-capped; unknown→smallest', () => {
  const tbud = require('./lib/turn-budget.js');
  const opus = tbud.budgetForModel('claude-opus-4-8');
  const son = tbud.budgetForModel('claude-sonnet-5');
  const hai = tbud.budgetForModel('claude-haiku-4-5');
  const unk = tbud.budgetForModel('');
  assert(opus.maxTurns >= son.maxTurns && son.maxTurns >= hai.maxTurns, 'opus>=sonnet>=haiku turns');
  assert(opus.maxChars <= 9000 && son.maxChars <= 9000 && hai.maxChars <= 9000, 'hook-safe hard cap');
  assertEq(unk.maxTurns, hai.maxTurns, 'unknown model uses smallest budget');
  assert(unk.minTurns >= 3, 'smallest keeps a floor');
});

test('turn-budget: shouldFire respects floor, ceilings, session-cap and cooldown', () => {
  const tbud = require('./lib/turn-budget.js');
  const m = 'claude-sonnet-5';
  assertEq(tbud.shouldFire({ cycles: 3, chars: 100, model: m }).fire, false, 'below min turns');
  assertEq(tbud.shouldFire({ cycles: 6, chars: 100, model: m }).fire, true, 'hit max turns');
  assertEq(tbud.shouldFire({ cycles: 4, chars: 8000, model: m }).fire, true, 'hit max chars');
  assertEq(tbud.shouldFire({ cycles: 5, chars: 100, model: m }).fire, false, 'accumulating between floor and ceilings');
  assertEq(tbud.shouldFire({ cycles: 9, chars: 9999, model: m, capturesThisSession: 8 }).fire, false, 'session cap blocks');
  assertEq(tbud.shouldFire({ cycles: 9, chars: 9999, model: m, lastCaptureTs: 1000, now: 1500 }, { cooldownMs: 10000 }).fire, false, 'cooldown blocks');
});

// ─── redact (secret/PII redaction before injection — Phase 1 task 5) ─────────
test('redact: masks common secrets and PII, preserves auth scheme, spares prose', () => {
  const { redact } = require('./lib/redact.js');
  const jwt = redact('x eyJhbGciOiJI.eyJzdWIiOiI.SflKxwRJSMkey y').text;
  assert(jwt.includes('[JWT]') && !jwt.includes('eyJhbGciOiJI'), 'JWT masked');
  const gh = redact('use ghp_ABCDEFGHIJKLMNOPQRSTUVWX now').text;
  assert(gh.includes('[GH_TOKEN]') && !gh.includes('ghp_ABCDEF'), 'GH token masked');
  const aws = redact('key AKIAIOSFODNN7EXAMPLE end').text;
  assert(aws.includes('[AWS_KEY]') && !aws.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS masked');
  const pem = redact('-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----').text;
  assert(pem.includes('[PRIVATE_KEY]') && !pem.includes('abc123'), 'PEM masked');
  const bearer = redact('Authorization: Bearer abcdef1234567890ABCDEF').text;
  assert(bearer.includes('[REDACTED]') && /Bearer/i.test(bearer) && !bearer.includes('abcdef1234567890ABCDEF'), 'bearer value masked, scheme kept');
  const url = redact('db postgres://user:secretpass@host/db').text;
  assert(url.includes('[CRED]@') && !url.includes('secretpass'), 'url cred masked');
  const env = redact('DB_PASSWORD=hunter2secret').text;
  assert(env.includes('[REDACTED]') && !env.includes('hunter2secret'), 'env assignment masked');
  const email = redact('ping a.user@example.com ok').text;
  assert(email.includes('[EMAIL]') && !email.includes('a.user@example.com'), 'email masked');
  // Modern key formats carry '-'/'_' in the body (Anthropic sk-ant-api03-…, OpenAI sk-proj-…).
  const antKey = 'sk-ant-api03-' + 'AbCd12-_'.repeat(6) + 'ZZ';
  const ant = redact('key ' + antKey + ' end').text;
  assert(ant.includes('[API_KEY]') && !ant.includes(antKey), 'modern Anthropic key masked');
  const projKey = 'sk-proj-' + 'Ab12Cd34'.repeat(5);
  const proj = redact('use ' + projKey + ' now').text;
  assert(proj.includes('[API_KEY]') && !proj.includes(projKey), 'modern OpenAI project key masked');
  assertEq(redact('the token expired and I fixed the bug').text, 'the token expired and I fixed the bug', 'prose not over-redacted');
  assert(redact('x ghp_ABCDEFGHIJKLMNOPQRSTUVWX y').count >= 1, 'count reflects redactions');
});

// ─── capture-dispatch (Stop detector: offer clean block to agent — Phase 1 task 4) ─
test('capture-dispatch: buildInstruction names capture_lesson, types, tags, windowId, delimits untrusted block', () => {
  const cd = require('./capture-dispatch.js');
  const r = cd.buildInstruction('SOME BLOCK TEXT', 'win-123');
  assert(/capture_lesson/.test(r), 'names the tool');
  assert(/capture_ack/.test(r), 'names the no-lesson ack tool');
  assert(/win-123/.test(r), 'carries the windowId to ack');
  assert(/lesson/.test(r) && /pattern/.test(r) && /decision/.test(r) && /research/.test(r), 'lists lesson types');
  assert(/tags/i.test(r), 'mentions tags');
  assert(r.includes('SOME BLOCK TEXT'), 'includes the block');
  assert(/UNTRUSTED|do not follow/i.test(r), 'delimits block as untrusted');
});

test('capture-dispatch: run offers from the queue, then acks when capture_lesson appears', () => {
  const cd = require('./capture-dispatch.js');
  const queue = require('./lib/capture-queue.js');
  const sid = 'cap-fire-' + Date.now();
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cap-${sid}.jsonl`);
  queue.reset(project, sid);
  const lines = [];
  for (let i = 1; i <= 6; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'question ' + i } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'answer ' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const res = cd.run({ session_id: sid, cwd, transcript_path: tp });
  assert(res && res.block === true, 'offers a block');
  assert(/capture_lesson/.test(res.reason), 'instruction present');
  assert(res.reason.includes('answer 6'), 'carries recent content');
  assert(queue.getState(project, sid).offer, 'offer opened on the queue');
  // agent acks via the tool (capture_lesson(windowId) or capture_ack) → next Stop drains, no re-offer.
  const wid = queue.getState(project, sid).offer.windowId;
  queue.recordAck(wid, 'captured');
  const res2 = cd.run({ session_id: sid, cwd, transcript_path: tp });
  assert(!res2.block, 'after ack, no re-offer this Stop');
  assert(!queue.getState(project, sid).offer, 'offer acked/cleared');
  assertEq(queue.getState(project, sid).queue.length, 0, 'captured cycles drained from the queue');
  queue.reset(project, sid);
});

test('capture-dispatch: an OPEN offer re-blocks even on stop_hook_active until the agent acks (real block-until-ack)', () => {
  const cd = require('./capture-dispatch.js');
  const queue = require('./lib/capture-queue.js');
  const sid = 'cap-block-' + Date.now();
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const tp = path.join(cwd, `capbl-${sid}.jsonl`);
  queue.reset(project, sid);
  const lines = [];
  for (let i = 1; i <= 6; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'question ' + i } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'answer ' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const first = cd.run({ session_id: sid, cwd, transcript_path: tp });
  assert(first && first.block, 'first Stop opens an offer and blocks');
  const wid = queue.getState(project, sid).offer.windowId;
  // The agent CONTINUED (stop_hook_active) but did NOT ack — the turn must NOT be
  // allowed to end: the dispatcher re-blocks. (The old bug returned {} here, letting
  // the agent ignore the instruction and stop.)
  const cont = cd.run({ session_id: sid, cwd, transcript_path: tp, stop_hook_active: true });
  assert(cont && cont.block, 're-blocks on the continuation while unacked');
  assert(cont.reason.includes(wid) || /capture_ack/.test(cont.reason), 're-inject carries the same window instruction');
  // Now the agent acks → the continuation Stop drains and lets the turn end.
  queue.recordAck(wid, 'none');
  const done = cd.run({ session_id: sid, cwd, transcript_path: tp, stop_hook_active: true });
  assert(!done.block, 'after the explicit ack, the turn is released');
  assert(!queue.getState(project, sid).offer, 'offer cleared on ack');
  queue.reset(project, sid);
});

test('capture-dispatch: run stays silent below budget and when stop_hook_active', () => {
  const cd = require('./capture-dispatch.js');
  const marker = require('./lib/session-marker.js');
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const sid = 'cap-quiet-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `capq-${sid}.jsonl`);
  marker.resetAll(project, sid);
  fs.writeFileSync(tp, '');
  marker.initIfAbsent(project, sid, tp);
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n') + '\n');
  assert(!(cd.run({ session_id: sid, cwd, transcript_path: tp })).block, 'below min turns → silent');
  marker.resetAll(project, sid);

  const sid2 = 'cap-active-' + Date.now();
  const tp2 = path.join(process.env.CLAUDE_PLUGIN_DATA, `capa-${sid2}.jsonl`);
  marker.resetAll(project, sid2);
  fs.writeFileSync(tp2, '');
  marker.initIfAbsent(project, sid2, tp2);
  const many = [];
  for (let i = 1; i <= 6; i++) {
    many.push(JSON.stringify({ type: 'user', promptId: 'q' + i, message: { role: 'user', content: 'q' + i } }));
    many.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' + i }] } }));
  }
  fs.writeFileSync(tp2, many.join('\n') + '\n');
  assert(!(cd.run({ session_id: sid2, cwd, transcript_path: tp2, stop_hook_active: true })).block, 'stop_hook_active → silent');
  marker.resetAll(project, sid2);
});

test('capture-dispatch: emits capture.offered metric on fire', () => {
  const cd = require('./capture-dispatch.js');
  const marker = require('./lib/session-marker.js');
  const metrics = require('./lib/metrics.js');
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const sid = 'cap-metric-' + Date.now();
  const tp = path.join(cwd, `capm-${sid}.jsonl`);
  marker.resetAll(project, sid);
  fs.writeFileSync(tp, '');
  marker.initIfAbsent(project, sid, tp);
  const lines = [];
  for (let i = 1; i <= 6; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'q' + i } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const calls = [];
  const orig = metrics.fire;
  metrics.fire = (n, p) => calls.push({ n, p });
  try {
    const res = cd.run({ session_id: sid, cwd, transcript_path: tp });
    assert(res.block === true, 'fired');
  } finally {
    metrics.fire = orig;
  }
  const offered = calls.find(c => c.n === 'capture.offered');
  assert(offered, 'capture.offered emitted');
  assertEq(offered.p.cycles, 6, 'cycles in payload');
  assert(typeof offered.p.model === 'string', 'model in payload');
  marker.resetAll(project, sid);
});

test('capture-dispatch: over-budget window is offered in chunks, never skipping cycles (regression)', () => {
  const cd = require('./capture-dispatch.js');
  const marker = require('./lib/session-marker.js');
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const sid = 'cap-budget-' + Date.now();
  const tp = path.join(cwd, `capb-${sid}.jsonl`);
  marker.resetAll(project, sid);
  fs.writeFileSync(tp, '');
  marker.initIfAbsent(project, sid, tp);
  // 12 cycles, each ~1.8KB → window >> sonnet 8KB cap, so it MUST be offered in
  // contiguous chunks (4/chunk). 12 = 3 full chunks (last chunk >= minTurns), so it
  // drains fully — proving no cycle is skipped past the cursor.
  const big = 'x'.repeat(1800);
  const lines = [];
  for (let i = 1; i <= 12; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'MARK' + i + '_ ' + big } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ans' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const seen = new Set();
  const cq = require('./lib/capture-queue.js');
  const deps = { config: { cooldownMs: 0, maxCapturesPerSession: 50 } }; // isolate chunking from cadence bounds
  // Progress by ACKING each offered chunk (the agent's tool call) — NOT by parking.
  // A drop/park would lose cycles; an ack advances to the next contiguous chunk.
  for (let stop = 0; stop < 30; stop++) {
    const res = cd.run({ session_id: sid, cwd, transcript_path: tp }, deps);
    if (!(res && res.block)) break;
    for (let i = 1; i <= 12; i++) if (res.reason.includes('MARK' + i + '_')) seen.add(i);
    const off = cq.getState(project, sid).offer;
    if (off) cq.recordAck(off.windowId, 'captured');
  }
  // No-skip invariant: offers start at the OLDEST cycle and are a CONTIGUOUS prefix
  // {1,2,...,K} — the old (keep-newest) bug offered recent cycles and advanced past
  // the older ones, yielding a set that does NOT start at 1.
  const arr = [...seen].sort((a, b) => a - b);
  assert(arr.length >= 8, `multiple chunks drained, got ${arr.join(',')}`);
  assertEq(arr[0], 1, 'offers start at the oldest uncaptured cycle');
  assert(arr.every((v, i) => v === i + 1), `offered cycles are a contiguous prefix (no skip), got ${arr.join(',')}`);
  marker.resetAll(project, sid);
});

// ── FIX #6: capture-dispatch anti-deadlock SAFETY RELENT (mirrors curation-stop) ──
// Below the cap the open offer still re-blocks (Allan's block-until-ack is intact);
// at the cap it RELENTS (allows the Stop) so a down brain-server / stuck model can't
// hard-deadlock the turn — and the un-captured cycle is NEVER dropped. An ack drains
// the offer so a LATER offer starts the counter fresh (structural per-offer reset).
function _capRelentSeed(nCycles, big) {
  const cd = require('./capture-dispatch.js');
  const cq = require('./lib/capture-queue.js');
  const marker = require('./lib/session-marker.js');
  const cwd = process.env.CLAUDE_PLUGIN_DATA;
  const project = require('./lib/project-id.js').resolveProjectId({ cwd });
  const sid = 'cap-relent-' + Math.random().toString(16).slice(2) + '-' + Date.now();
  const tp = path.join(cwd, `capr-${sid}.jsonl`);
  marker.resetAll(project, sid);
  fs.writeFileSync(tp, '');
  marker.initIfAbsent(project, sid, tp);
  const pad = big ? ('x'.repeat(1800)) : '';
  const lines = [];
  for (let i = 1; i <= nCycles; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'q' + i + '_ ' + pad } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  return { cd, cq, marker, project, sid, evt: { session_id: sid, cwd, transcript_path: tp } };
}

test('capture-dispatch (FIX #6): below the cap an open un-acked offer keeps re-blocking (block-until-ack preserved)', () => {
  const t = _capRelentSeed(6, false);
  const deps = { config: { maxBlockAttempts: 5, cooldownMs: 0, maxCapturesPerSession: 50 } };
  const r1 = t.cd.run(t.evt, deps);
  assert(r1 && r1.block === true, 'first Stop opens the offer and blocks');
  assertEq(t.cq.getState(t.project, t.sid).offer.blockCount, 0, 'a fresh offer starts at blockCount 0');
  // Re-Stop WITHOUT acking, still well below the cap → must RE-BLOCK (the normal flow).
  const r2 = t.cd.run(t.evt, deps);
  assert(r2 && r2.block === true, 'below the cap an un-acked offer re-blocks');
  assert(/capture_lesson|capture_ack/.test(r2.reason || ''), 're-block carries the capture instruction');
  assert(t.cq.getState(t.project, t.sid).offer.blockCount >= 1, 'each re-block advances the per-offer counter');
  t.marker.resetAll(t.project, t.sid);
});

test('capture-dispatch (FIX #6): after maxBlockAttempts un-acked blocks it RELENTS (allows stop) and never drops the cycle', () => {
  const t = _capRelentSeed(6, false);
  const deps = { config: { maxBlockAttempts: 2, cooldownMs: 0, maxCapturesPerSession: 50 } };
  const r1 = t.cd.run(t.evt, deps); assert(r1 && r1.block === true, 'Stop 1: opens offer + blocks (blockCount 0)');
  const r2 = t.cd.run(t.evt, deps); assert(r2 && r2.block === true, 'Stop 2: re-block below cap (blockCount 1 < 2)');
  const r3 = t.cd.run(t.evt, deps);
  assert(!(r3 && r3.block), 'Stop 3: at the cap it RELENTS — returns {} so the turn can end');
  // No-loss invariant: the offer + queued cycles are PRESERVED — only the block yielded.
  const st = t.cq.getState(t.project, t.sid);
  assert(st.offer, 'the offer stays OPEN after relenting (not cleared)');
  assertEq(st.queue.length, 6, 'the un-captured cycles are NEVER dropped by the relent');
  assert(st.offer.blockCount >= 2, 'the per-offer block counter reached the cap');
  // A further Stop keeps relenting (no re-nag, still no drop) — the cycle waits for a future session.
  const r4 = t.cd.run(t.evt, deps);
  assert(!(r4 && r4.block), 'past the cap it keeps allowing the stop');
  assertEq(t.cq.getState(t.project, t.sid).queue.length, 6, 'cycle still queued after repeated relents');
  t.marker.resetAll(t.project, t.sid);
});

test('capture-dispatch (FIX #6): an ack drains the offer so a LATER offer starts the block counter fresh', () => {
  // 12 big cycles → offer1 packs a prefix; after acking it, the remainder (>= maxTurns)
  // opens a NEW offer whose blockCount must be 0 (the counter is per-offer, not global).
  const t = _capRelentSeed(12, true);
  const deps = { config: { maxBlockAttempts: 5, cooldownMs: 0, maxCapturesPerSession: 50 } };
  const r1 = t.cd.run(t.evt, deps); assert(r1 && r1.block === true, 'offer1 opens + blocks');
  const off1 = t.cq.getState(t.project, t.sid).offer.windowId;
  const r2 = t.cd.run(t.evt, deps); assert(r2 && r2.block === true, 're-block bumps offer1 blockCount below cap');
  assert(t.cq.getState(t.project, t.sid).offer.blockCount >= 1, 'offer1 counter advanced before the ack');
  // Ack offer1 (the agent's capture_lesson/capture_ack) → reconcile drains it next Stop.
  t.cq.recordAck(off1, 'captured');
  const r3 = t.cd.run(t.evt, deps);
  assert(r3 && r3.block === true, 'a LATER offer opens over the remaining cycles');
  const off2 = t.cq.getState(t.project, t.sid).offer;
  assert(off2 && off2.windowId !== off1, 'a genuinely NEW offer window opened');
  assertEq(off2.blockCount, 0, 'the ack reset the counter — the later offer starts fresh (no cross-offer carryover)');
  t.marker.resetAll(t.project, t.sid);
});

// ─── capture-queue (Phase 1.5a: durable redacted cycle queue) ────────────────
test('capture-queue: ingest extracts + redacts cycles into a durable queue and advances the scan cursor', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-ing-' + Date.now();
  const sid = 'cq-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cq-${sid}.jsonl`);
  q.reset(project, sid);
  const lines = [];
  for (let i = 1; i <= 3; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'question ' + i } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'answer ' + i + ' token ghp_ABCDEFGHIJKLMNOPQRSTUVWX end' }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const r = q.ingest(project, sid, tp, s => redact(s).text);
  assertEq(r.added, 3, 'three cycles queued');
  const st = q.getState(project, sid);
  assertEq(st.queue.length, 3);
  assertEq(st.queue[0].promptId, 'p1');
  assert(st.queue.every(c => !c.assistant.includes('ghp_ABCDEF')), 'secret redacted at rest');
  assert(st.scan.offset > 0, 'scan cursor advanced');
  q.reset(project, sid);
});

test('capture-queue: re-ingest is idempotent and dedups across a compaction rewrite (content-hash)', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-comp-' + Date.now();
  const sid = 'cq2-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cq2-${sid}.jsonl`);
  q.reset(project, sid);
  const cyc = (i) => [
    JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'q' + i } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' + i }] } }),
  ];
  fs.writeFileSync(tp, [cyc(1), cyc(2), cyc(3)].flat().join('\n') + '\n');
  assertEq(q.ingest(project, sid, tp, s => redact(s).text).added, 3);
  assertEq(q.ingest(project, sid, tp, s => redact(s).text).added, 0, 'idempotent on unchanged file');
  // compaction: rewrite SHORTER with a summary event + the SAME 3 cycles at new offsets
  const summary = JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary of prior context' } });
  fs.writeFileSync(tp, [summary, cyc(1), cyc(2), cyc(3)].flat().join('\n') + '\n');
  assertEq(q.ingest(project, sid, tp, s => redact(s).text).added, 0, 'compaction rebase re-scans but content-hash dedups');
  assertEq(q.getState(project, sid).queue.length, 3, 'still exactly 3, no duplicates');
  q.reset(project, sid);
});

// ─── capture-queue offer/ACK (Phase 1.5b) ────────────────────────────────────
function _cqSeed(q, redact, project, sid, tp, n) {
  q.reset(project, sid);
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'q' + i } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' + i }] } }));
  }
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  q.ingest(project, sid, tp, s => redact(s).text);
}

test('capture-queue: offer packs oldest queued cycles under a windowId; ack drains them', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-off-' + Date.now(); const sid = 'cqo-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqo-${sid}.jsonl`);
  _cqSeed(q, redact, project, sid, tp, 3);
  const off = q.offer(project, sid, 100000);
  assert(off && off.windowId, 'offer created');
  assert(off.text.includes('q1') && off.text.includes('a3'), 'packs the queued cycles');
  assertEq(q.getState(project, sid).queue.length, 3, 'offer does not remove from queue yet');
  assert(q.ack(project, sid, off.windowId, 'captured'), 'ack matches windowId');
  assertEq(q.getState(project, sid).queue.length, 0, 'ack drains the offered cycles');
  assert(!q.getState(project, sid).offer, 'offer cleared');
  assert(!q.ack(project, sid, 'bogus', 'captured'), 'ack rejects a non-matching windowId');
  q.reset(project, sid);
});

test('capture-queue: recordAck/readAck/clearAck round-trip by windowId', () => {
  const q = require('./lib/capture-queue.js');
  const wid = 'w-rt-' + Date.now();
  q.clearAck(wid);
  assert(!q.readAck(wid), 'no ack initially');
  q.recordAck(wid, 'none');
  assertEq(q.readAck(wid).outcome, 'none', 'ack read back');
  q.clearAck(wid);
  assert(!q.readAck(wid), 'ack cleared');
});

test('capture-queue: reconcile drains on an explicit ack marker (no transcript guessing)', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-ack-' + Date.now(); const sid = 'cqa-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqa-${sid}.jsonl`);
  _cqSeed(q, redact, project, sid, tp, 3);
  const off = q.offer(project, sid, 100000);
  q.recordAck(off.windowId, 'captured'); // the agent's capture_lesson/capture_ack tool wrote this
  const r = q.reconcile(project, sid, 6);
  assert(r.acked && r.outcome === 'captured', 'reconcile drains on the explicit ack');
  assertEq(q.getState(project, sid).queue.length, 0, 'captured cycles drained');
  assert(!q.readAck(off.windowId), 'ack marker consumed');
  q.reset(project, sid);
});

test('capture-queue: reconcile re-blocks indefinitely until acked — NEVER parks/deletes (no-loss)', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-nopark-' + Date.now(); const sid = 'cqp-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqp-${sid}.jsonl`);
  _cqSeed(q, redact, project, sid, tp, 3);
  q.offer(project, sid, 100000);
  // Many un-acked reconciles: the offer STAYS OPEN (re-block) and cycles STAY in
  // the durable queue. Allan's design: the turn never proceeds until the agent
  // acks; a stuck window is re-offered on the next Stop, never lost to a terminal
  // `deferred` collection that nothing re-offers.
  for (let i = 0; i < 12; i++) {
    const r = q.reconcile(project, sid);
    assert(!r.acked && r.retry && !r.parked, `reconcile ${i} re-blocks (no ack, no park)`);
  }
  const st = q.getState(project, sid);
  assert(st.offer, 'offer stays open to keep re-blocking');
  assertEq(st.queue.length, 3, 'cycles stay in the durable queue — never parked/deleted');
  assert(!st.deferred || st.deferred.length === 0, 'no terminal deferred collection');
  q.reset(project, sid);
});

test('capture-queue: reconcile counts captured separately from offers; "none" does not', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-cap-' + Date.now(); const sid = 'cqc-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqcap-${sid}.jsonl`);
  q.reset(project, sid);
  const cyc = (i) => [
    JSON.stringify({ type: 'user', promptId: 'p' + i, message: { role: 'user', content: 'question ' + i } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'answer ' + i }] } }),
  ].join('\n');
  fs.writeFileSync(tp, cyc(1) + '\n' + cyc(2) + '\n' + cyc(3) + '\n');
  q.ingest(project, sid, tp, s => redact(s).text);
  const off1 = q.offer(project, sid, 100000);
  q.recordAck(off1.windowId, 'captured');
  q.reconcile(project, sid);
  assertEq(q.getState(project, sid).captured, 1, 'captured incremented on a real capture');
  fs.appendFileSync(tp, cyc(4) + '\n' + cyc(5) + '\n' + cyc(6) + '\n');
  q.ingest(project, sid, tp, s => redact(s).text);
  const off2 = q.offer(project, sid, 100000);
  q.recordAck(off2.windowId, 'none');
  q.reconcile(project, sid);
  assertEq(q.getState(project, sid).captured, 1, '"none" ack does NOT count as a capture');
  assert(q.getState(project, sid).offers >= 2, 'offers counts review interruptions (both windows)');
  q.reset(project, sid);
});

test('capture-queue: reconcile keeps the ack marker if the drain _save FAILS (no ack loss)', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const project = 'cq-saveguard-' + Date.now(); const sid = 'cqsg-' + Date.now();
  const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqsg-${sid}.jsonl`);
  _cqSeed(q, redact, project, sid, tp, 3);
  const off = q.offer(project, sid, 100000);
  q.recordAck(off.windowId, 'captured');
  // Inject a failing save (CAS/disk failure) into the drain via the seam.
  const r = q.reconcile(project, sid, { save: () => false });
  assert(!r.acked, 'drain reports not-acked when the commit fails');
  assert(q.readAck(off.windowId), 'ack marker PRESERVED for retry (not cleared on a failed save)');
  assert(q.getState(project, sid).offer, 'offer still open (drain rolled back)');
  // a subsequent NORMAL reconcile still drains it
  const r2 = q.reconcile(project, sid);
  assert(r2.acked, 'retry drains once the save succeeds');
  assert(!q.readAck(off.windowId), 'marker consumed after the successful drain');
  q.reset(project, sid);
});

test('capture-queue: offer windowId is a random nonce — identical content across sessions never collides', () => {
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  const ts = Date.now();
  const mk = (tag) => {
    const project = 'cq-nonce-' + tag + '-' + ts; const sid = 'cqn-' + tag + '-' + ts;
    const tp = path.join(process.env.CLAUDE_PLUGIN_DATA, `cqn-${tag}-${ts}.jsonl`);
    _cqSeed(q, redact, project, sid, tp, 3); // IDENTICAL seeded content in both
    const off = q.offer(project, sid, 100000);
    return { project, sid, wid: off.windowId };
  };
  const a = mk('a'); const b = mk('b');
  assert(a.wid && b.wid, 'both offers created');
  assert(a.wid !== b.wid, 'identical content in two sessions yields DISTINCT nonce windowIds (no cross-session collision)');
  // re-offering the same window after a reset also yields a fresh nonce
  q.reset(a.project, a.sid);
  q.reset(b.project, b.sid);
});

test('capture bridge: the REAL capture_ack MCP tool writes the marker the queue drains (no fiction)', async () => {
  const url = require('url');
  const q = require('./lib/capture-queue.js');
  const { redact } = require('./lib/redact.js');
  // Import the ESM server FIRST — this is the only real await. Everything that
  // touches the shared process.env.CLAUDE_PLUGIN_DATA runs synchronously AFTER it,
  // so interleaved async tests can't swap the data dir mid-flight.
  const mod = await import(url.pathToFileURL(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
  const server = mod.createBrainServer({ pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, mode: 'stdio' });
  assert(typeof server.handleTool === 'function', 'server exposes the tool dispatcher seam');
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const myData = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-bridge-'));
  process.env.CLAUDE_PLUGIN_DATA = myData;
  try {
    const project = 'cq-bridge-' + Date.now(); const sid = 'cqbr-' + Date.now();
    const tp = path.join(myData, `cqbr-${sid}.jsonl`);
    _cqSeed(q, redact, project, sid, tp, 3);
    const off = q.offer(project, sid, 100000);
    // capture_ack's handler is synchronous (recordCaptureAck → capture-queue.recordAck)
    // and writes the marker before returning, so no await is needed here — keeping the
    // whole env-sensitive section atomic against interleaving async tests.
    server.handleTool('capture_ack', { windowId: off.windowId, outcome: 'none' });
    assert(q.readAck(off.windowId), 'the REAL MCP tool wrote the ack marker (tool→recordCaptureAck→queue bridge)');
    // The deterministic Stop-side reconcile drains PURELY from what the tool wrote.
    const r = q.reconcile(project, sid);
    assert(r.acked && r.outcome === 'none', 'reconcile drains from the tool-written marker (real bridge, not a stubbed name)');
    assertEq(q.getState(project, sid).queue.length, 0, 'offered cycles drained via the real tool path');
    q.reset(project, sid);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = prevData;
    try { fs.rmSync(myData, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('capture_lesson local: a null merge (vanished dedup hit) does NOT phantom-ack — it admits (stores) instead', async () => {
  const url = require('url');
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  const saved = [];
  // Injected KB where a dedup hit is returned by search but merge() finds nothing
  // (the entry vanished — e.g. a concurrent consolidation deleted it) → returns null.
  // This is the exact race the guard defends against. Stubs are passed via a test
  // seam (no require.cache mutation), so assertions depend only on the return value
  // and the in-memory `saved` array — never on shared process env.
  const mod = await import(url.pathToFileURL(path.join(R, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
  const server = mod.createBrainServer({ pluginRoot: R, mode: 'stdio', _testHooks: {
    getKB: async () => ({
      store: { search: async () => [{ id: 'vanished-id', title: 'Ghost' }], merge: async () => null, save: async (e) => { saved.push(e); } },
      index: { index: async () => {} },
      graph: { registerNode: async () => {} },
    }),
    embedder: { init: async () => {}, getStatus: () => ({ ready: true }), embed: async () => [0.1, 0.2, 0.3] },
  } });
  // The injected _testHooks.getKB forces handleTool onto the LOCAL path, so this test
  // never reads or mutates the shared brain-backend singleton mode (no cross-test race).
  const res = await server.handleTool('capture_lesson', { title: 'T', summary: 'S', detail: 'D', type: 'decision', scope: 'project', project: 'pMergeNull', windowId: 'w-mergenull-' + Date.now() });
  const out = JSON.parse(res.content[0].text);
  // With the pre-fix bug (ack on a null merge), decision would be 'merge' and nothing saved.
  assertEq(out.decision, 'admit', 'a vanished merge target falls through to admit (stores the lesson), never a phantom merge');
  assertEq(saved.length, 1, 'the lesson was actually persisted before the ack (no silent loss)');
});

test('capture_ack: a forged outcome:"captured" is neutralized to "none" (only capture_lesson can mark captured)', async () => {
  const url = require('url');
  const q = require('./lib/capture-queue.js');
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  const wid = 'w-forge-' + Date.now();
  q.clearAck(wid);
  const mod = await import(url.pathToFileURL(path.join(R, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
  const server = mod.createBrainServer({ pluginRoot: R, mode: 'stdio' });
  // capture_ack's handler is synchronous (records the marker before returning), so no
  // await is needed — the read below is atomic against env-swapping async tests.
  // A forged/injected capture_ack claiming 'captured' must NOT write a captured marker:
  // that would inflate the captured metric and mark a window captured with no persisted
  // lesson. The handler hard-codes 'none' regardless of the passed outcome.
  server.handleTool('capture_ack', { windowId: wid, outcome: 'captured' });
  const rec = q.readAck(wid);
  assert(rec && rec.outcome === 'none', `capture_ack always records 'none' regardless of a passed outcome, got: ${rec && rec.outcome}`);
  q.clearAck(wid);
});

test('capture-queue: _save CAS refuses a stale write (cross-Stop concurrency safety)', () => {
  const q = require('./lib/capture-queue.js');
  const project = 'cq-cas-' + Date.now(); const sid = 'cqc-' + Date.now();
  q.reset(project, sid);
  q._save(project, sid, { rev: 0, scan: { offset: 0, anchorHash: '' }, seen: [], queue: [{ id: 'a', promptId: 'p', user: 'u', assistant: 'x' }], offer: null });
  assert(q._save(project, sid, { rev: 1, scan: { offset: 0, anchorHash: '' }, seen: [], queue: [], offer: null }, 0), 'writer with matching expectRev 0 wins');
  assert(!q._save(project, sid, { rev: 1, scan: { offset: 0, anchorHash: '' }, seen: ['stale'], queue: [{ id: 'a' }], offer: null }, 0), 'stale writer (expectRev 0) refused after rev moved to 1');
  assertEq(q.getState(project, sid).queue.length, 0, 'the winning committed state stands');
  q.reset(project, sid);
});

// ─── Policy adjudication (Fase 3 micro-B0) — the JUDGE loop ───────────────────
// Shared helpers: unique project ids + isolated temp workspaces let these tests run
// against the ONE global CLAUDE_PLUGIN_DATA (set at file top) without swapping env —
// the adjudication tools + store scope everything by project, and the handlers run
// synchronously (no await before the switch for these tools), so concurrent async
// tests can't cross-contaminate.
async function _adjImportServer() {
  const url = require('url');
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  const mod = await import(url.pathToFileURL(path.join(R, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
  return mod.createBrainServer({ pluginRoot: R, mode: 'stdio' });
}
function _adjText(res) { return res.content[0].text; }
function _adjMakeFiles(work, n, ext, body) {
  fs.mkdirSync(work, { recursive: true });
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(work, `f${String(i).padStart(2, '0')}.${ext}`), body(i));
  }
}

test('adjudication-store: save + list roundtrip, newest first, project-scoped + policyId filter', () => {
  const adj = require('./lib/adjudication-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjs-'));
  const mkRec = (policyId, ts, problem) => ({ policyId, manifestHash: 'abcdef01', ts, counts: { legit: 1, problem, uncertain: 0, injectionSuspected: 0, total: 1 + problem }, coverage: { sampled: 1 + problem, eligible: 10 }, provenance: { scannerVersion: 'sv', promptVersion: 'pv' } });
  assert(adj.saveDisposition(dd, 'projA', mkRec('p1', 1000, 0)), 'save 1 ok');
  assert(adj.saveDisposition(dd, 'projA', mkRec('p1', 2000, 1)), 'save 2 ok');
  assert(adj.saveDisposition(dd, 'projA', mkRec('p2', 1500, 2)), 'save 3 ok');
  const all = adj.listDispositions(dd, 'projA');
  assertEq(all.length, 3, 'three dispositions listed');
  assert(all[0].ts >= all[1].ts && all[1].ts >= all[2].ts, 'newest first');
  assertEq(adj.listDispositions(dd, 'projA', { policyId: 'p1' }).length, 2, 'policyId filter narrows to p1');
  assertEq(adj.listDispositions(dd, 'projB').length, 0, 'project scoping isolates projB');
});

test('adjudication-store: normalizeRecord drops snippets/unknown keys (only tally/coverage/provenance persisted)', () => {
  const adj = require('./lib/adjudication-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjs-'));
  adj.saveDisposition(dd, 'projX', { policyId: 'p', manifestHash: 'deadbe', ts: 5, counts: { legit: 0, problem: 1, uncertain: 0, injectionSuspected: 0, total: 1 }, coverage: { sampled: 1, eligible: 1 }, provenance: { scannerVersion: 's', promptVersion: 'p' }, occurrences: [{ context: 'SECRET_CODE()' }], snippet: 'SECRET_CODE()', activationId: 'act1' });
  const [rec] = adj.listDispositions(dd, 'projX');
  assert(!JSON.stringify(rec).includes('SECRET_CODE'), 'no snippet/context survives persistence');
  assert(rec.occurrences === undefined && rec.snippet === undefined, 'unknown keys stripped');
  assertEq(rec.activationId, 'act1', 'activationId (when present) is kept');
  assert(rec.counts && rec.coverage && rec.provenance, 'tally/coverage/provenance kept');
});

test('adjudication-store: load returns empty shape on a corrupt registry (never throws)', () => {
  const adj = require('./lib/adjudication-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjs-'));
  const p = adj.dispositionsPath(dd, 'projC');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not json');
  assertEq(adj.listDispositions(dd, 'projC'), [], 'corrupt registry → empty list, no throw');
});

test('policy_adjudication_prepare: deterministic sampling capped at 25 (+ honest note)', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-det-' + Date.now();
  try {
    _adjMakeFiles(work, 30, 'ts', (i) => `// f${i}\nfunction g${i}(){\n  console.log('x${i}');\n}\n`);
    const act = policyStore.activate(dataDir(), { text: 'no console.log in prod', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    assert(act.activated, 'shadow glob policy activated');
    const r1 = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const r2 = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    assertEq(r1.occurrenceCount, 25, 'sample capped at 25');
    assertEq(r1.manifestHash, r2.manifestHash, 'manifestHash deterministic across runs');
    const b1 = JSON.parse(fs.readFileSync(r1.bundlePath, 'utf-8'));
    const b2 = JSON.parse(fs.readFileSync(r2.bundlePath, 'utf-8'));
    assertEq(b1.occurrences.map((o) => o.id), b2.occurrences.map((o) => o.id), 'sampled ids identical across runs (deterministic)');
    assertEq(b1.eligible, 30, 'eligible reflects the true total (30), not the sample');
    assertEq(b1.occurrences.length, 25, 'bundle holds exactly 25 occurrences');
    assert(r1.note.includes('model provider') && r1.note.includes('not a measured false-positive rate'), 'note discloses provider send + not-an-FP-rate');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('policy_adjudication_prepare: glob-only policy (no literal) samples one occurrence per matching file', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-file-' + Date.now();
  try {
    _adjMakeFiles(work, 4, 'md', (i) => `# doc ${i}\n\nbody ${i}\n`);
    const act = policyStore.activate(dataDir(), { text: 'keep docs tidy', scope: 'project', projectId: project, globs: ['**/*.md'] });
    assert(act.activated && act.mode === 'glob', 'plain glob policy activated');
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
    assertEq(prep.occurrenceCount, 4, 'one occurrence per matching file');
    assertEq(bundle.eligible, 4, 'eligible = matching file count');
    const files = bundle.occurrences.map((o) => o.file);
    assertEq(files.length, new Set(files).size, 'occurrences are distinct files');
    assert(bundle.literal === null, 'file-mode bundle has literal:null');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('policy_adjudication_prepare: refuses an ALWAYS-mode (globless) policy; unknown id errors', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'adj-always-' + Date.now();
  const act = policyStore.activate(dataDir(), { text: 'always: never let errors pass', scope: 'project', projectId: project });
  assert(act.activated, 'always policy activated');
  const res = await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: process.cwd() });
  assert(res.isError, 'always-mode policy cannot be adjudicated (no globs)');
  const unk = await server.handleTool('policy_adjudication_prepare', { policyId: 'no-such-policy', project, cwd: process.cwd() });
  assert(unk.isError, 'unknown policyId is rejected');
});

test('policy_adjudication_record: honest disposition (kind/disclaimer, no FP-rate field, no snippet persisted)', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-rec-' + Date.now();
  try {
    _adjMakeFiles(work, 3, 'ts', (i) => `// f${i}\nconsole.log('secretword${i}');\n`);
    const act = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
    const verdicts = { schema: 1, verdicts: bundle.occurrences.map((o, k) => ({ id: o.id, label: k === 0 ? 'likely_problem' : 'uncertain', promptInjectionSuspected: false, reason: 'r' })) };
    const rr = JSON.parse(_adjText(await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), project, cwd: work })));
    assertEq(rr.kind, 'llm-current-snapshot-occurrence-disposition', 'honest kind, not a false-positive rate');
    assert(rr.falsePositiveRate === undefined, 'no falsePositiveRate value is claimed');
    assert(typeof rr.disclaimer === 'string' && rr.disclaimer.includes('NOT a measured false-positive rate'), 'disclaimer states it is NOT a false-positive rate');
    assert(rr.disclaimer.includes('model provider'), 'disclaimer discloses provider send');
    assertEq(rr.counts.total, 3, 'counts total = sampled');
    assertEq(rr.counts.problem, 1, 'one likely_problem tallied');
    const stored = adjStore.listDispositions(dataDir(), project);
    assert(stored.length >= 1, 'a disposition was persisted');
    const recJson = JSON.stringify(stored[0]);
    assert(!recJson.includes('secretword') && !recJson.includes('console.log'), 'no code snippet stored in the disposition');
    assert(stored[0].occurrences === undefined && stored[0].context === undefined && stored[0].snippet === undefined, 'disposition has no occurrence/context/snippet keys');
    assert(stored[0].counts && stored[0].coverage && stored[0].provenance, 'disposition keeps only tally/coverage/provenance');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

// — finding #7 (bundles never purged): consume-then-delete on record + orphan sweep —
test('policy_adjudication_record: CONSUMES the bundle (deleted after record); a re-run errors with re-prepare guidance', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-consume-' + Date.now();
  try {
    _adjMakeFiles(work, 2, 'ts', (i) => `console.log('c${i}');\n`);
    const act = policyStore.activate(dataDir(), { text: 't', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    assert(fs.existsSync(prep.bundlePath), 'the bundle exists after prepare');
    const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
    const verdicts = { schema: 1, verdicts: bundle.occurrences.map((o) => ({ id: o.id, label: 'likely_problem', promptInjectionSuspected: false, reason: 'r' })) };
    const rr = JSON.parse(_adjText(await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), project, cwd: work })));
    assertEq(rr.counts.total, 2, 'record succeeded');
    assert(!fs.existsSync(prep.bundlePath), 'the ephemeral bundle is DELETED once its disposition is recorded (consume-then-delete)');
    // The disposition IS persisted (delete only cleans the read-once bundle, not the record).
    const { dataDir: dd2 } = require('./lib/data-dir.js');
    assert(require('./lib/adjudication-store.js').listDispositions(dd2(), project).length === 1, 'the disposition survives the bundle delete');
    // A re-run cannot find the consumed bundle → clear, actionable error (not a silent success).
    const again = await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), project, cwd: work });
    assert(again.isError, 're-running record after the bundle is consumed is an error');
    assert(_adjText(again).includes('policy_adjudication_prepare'), 'the error tells the user to re-run prepare');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('policy_adjudication_record: rejects unknown, duplicate, missing, and bad-label verdicts (nothing persisted)', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-val-' + Date.now();
  try {
    _adjMakeFiles(work, 3, 'ts', (i) => `console.log('a${i}');\n`);
    const act = policyStore.activate(dataDir(), { text: 't', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const ids = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8')).occurrences.map((o) => o.id);
    const mk = (verds) => ({ policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify({ schema: 1, verdicts: verds }), project, cwd: work });
    const v = (id, label) => ({ id, label: label || 'uncertain', promptInjectionSuspected: false, reason: 'r' });
    const unk = await server.handleTool('policy_adjudication_record', mk([...ids.map((id) => v(id)), v('occ-000000000000')]));
    assert(unk.isError, 'unknown id rejected');
    const dup = await server.handleTool('policy_adjudication_record', mk([v(ids[0]), v(ids[0]), v(ids[1]), v(ids[2])]));
    assert(dup.isError, 'duplicate id rejected');
    const miss = await server.handleTool('policy_adjudication_record', mk(ids.slice(1).map((id) => v(id))));
    assert(miss.isError, 'missing id rejected');
    const bad = await server.handleTool('policy_adjudication_record', mk(ids.map((id, k) => v(id, k === 0 ? 'legit' : 'uncertain'))));
    assert(bad.isError, 'invalid label rejected');
    assertEq(adjStore.listDispositions(dataDir(), project).length, 0, 'no malformed disposition persisted');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('policy_adjudication_prepare/record: never mutate the policy (no activate/deactivate; policy byte-identical)', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'adj-nomut-' + Date.now();
  try {
    _adjMakeFiles(work, 2, 'ts', (i) => `console.log('z${i}');\n`);
    const act = policyStore.activate(dataDir(), { text: 't', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    const before = JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project }));
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
    // all-legit → low problem-share → an INFORMATIONAL tuning suggestion that must change NOTHING.
    const verdicts = { schema: 1, verdicts: bundle.occurrences.map((o) => ({ id: o.id, label: 'likely_legitimate', promptInjectionSuspected: false, reason: 'r' })) };
    const rr = JSON.parse(_adjText(await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), project, cwd: work })));
    assert(typeof rr.tuningRecommendation === 'string', 'low problem-share yields an INFORMATIONAL tuning suggestion');
    assertEq(JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project })), before, 'policy record byte-identical after adjudication (no mutation, no deactivate)');
    // Static proof: the adjudication handler block calls no activate/deactivate.
    const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
    const start = src.indexOf("case 'policy_adjudication_prepare'");
    const end = src.indexOf('default:', start);
    assert(start > 0 && end > start, 'located the adjudication handler block');
    const slice = src.slice(start, end);
    assert(!slice.includes('.activate(') && !slice.includes('.deactivate('), 'adjudication handlers contain no activate/deactivate calls (no auto-mutation)');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('adjudication assets: agent + command markdown have valid frontmatter', () => {
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  const parseFm = (p) => {
    const raw = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
    assert(raw.startsWith('---\n'), `${p}: starts with a frontmatter fence`);
    const end = raw.indexOf('\n---', 4);
    assert(end > 0, `${p}: has a closing frontmatter fence`);
    assert(raw.slice(end + 4).trim().length > 50, `${p}: has a non-trivial body`);
    return raw.slice(4, end);
  };
  const agentFm = parseFm(path.join(R, 'agents', 'policy-auditor.md'));
  assert(/^name:\s*policy-auditor\s*$/m.test(agentFm), 'agent declares name: policy-auditor');
  assert(/^tools:\s*Read\s*$/m.test(agentFm), 'agent restricts tools to Read only');
  assert(/^description:\s*\S/m.test(agentFm), 'agent has a description');
  const cmdFm = parseFm(path.join(R, 'commands', 'policy-adjudicate.md'));
  assert(/^description:\s*\S/m.test(cmdFm), 'command has a description');
  assert(/^argument-hint:\s*\S/m.test(cmdFm), 'command has an argument-hint');
});

// ─── Trigger-evidence capture (Fase 3 micro-B1) — OPT-IN prospective evidence ─
// Mirrors the adjudication block: unique flat project ids + a shared temp dataDir
// isolate each test against the global CLAUDE_PLUGIN_DATA. The store + tools scope
// everything by (sanitized) project id.

test('trigger-evidence-store: append/list/purge roundtrip — newest first, project-scoped, activationId filter', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-te-'));
  const mk = (eventId, activationId, ts) => ({ eventId, activationId, sourceHash: 'sh', file: 'src/a.ts', addedSnippet: 'x', ts });
  assert(te.appendEvidence(dd, 'teA', mk('e1', 'act1', 1000), { ttlDays: 0 }), 'append 1 ok');
  assert(te.appendEvidence(dd, 'teA', mk('e2', 'act1', 3000), { ttlDays: 0 }), 'append 2 ok');
  assert(te.appendEvidence(dd, 'teA', mk('e3', 'act2', 2000), { ttlDays: 0 }), 'append 3 ok');
  const all = te.listEvidence(dd, 'teA', {});
  assertEq(all.length, 3, 'three evidence records');
  assert(all[0].ts >= all[1].ts && all[1].ts >= all[2].ts, 'newest first');
  assertEq(te.listEvidence(dd, 'teA', { activationId: 'act1' }).length, 2, 'activationId filter narrows to act1');
  assertEq(te.listEvidence(dd, 'teA', { sinceTs: 2500 }).length, 1, 'sinceTs filter keeps only newer');
  assertEq(te.listEvidence(dd, 'teB', {}).length, 0, 'project scoping isolates teB');
  assertEq(te.purgeEvidence(dd, 'teA', { activationId: 'act1' }), 2, 'purge by activationId removes 2');
  assertEq(te.listEvidence(dd, 'teA', {}).length, 1, 'one record remains after scoped purge');
  assertEq(te.purgeEvidence(dd, 'teA', {}), 1, 'purge-all removes the rest');
  assertEq(te.listEvidence(dd, 'teA', {}).length, 0, 'queue empty after purge-all');
});

test('trigger-evidence-store: TTL purge-on-write drops records older than ttlDays', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-te-'));
  const now = Date.now();
  const DAY = 86400000;
  // Seed an OLD record (10 days ago); it is written as-is on its own append…
  assert(te.appendEvidence(dd, 'teTTL', { eventId: 'old', activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: now - 10 * DAY }, { ttlDays: 7 }), 'old append ok');
  assertEq(te.listEvidence(dd, 'teTTL', {}).length, 1, 'old record present before the next write');
  // …then the NEXT write (fresh) purges anything older than the 7-day cutoff.
  assert(te.appendEvidence(dd, 'teTTL', { eventId: 'fresh', activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: now }, { ttlDays: 7 }), 'fresh append ok');
  const after = te.listEvidence(dd, 'teTTL', {});
  assertEq(after.length, 1, 'TTL purge-on-write dropped the expired record');
  assertEq(after[0].eventId, 'fresh', 'only the fresh record survives');
});

test('trigger-evidence-store: caps the queue to the newest maxPerProject on write', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-te-'));
  for (let i = 1; i <= 6; i++) {
    te.appendEvidence(dd, 'teCap', { eventId: 'e' + i, activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: 1000 + i }, { maxPerProject: 3, ttlDays: 0 });
  }
  const list = te.listEvidence(dd, 'teCap', {});
  assertEq(list.length, 3, 'queue capped to maxPerProject (3)');
  assertEq(list.map((e) => e.eventId), ['e6', 'e5', 'e4'], 'the newest 3 are kept (oldest evicted)');
});

test('trigger-evidence-store: normalizeRecord redacts+caps the snippet and strips unknown/un-relative fields', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const secret = "const k='sk-abcdefghijklmnopqrstuvwxyz012345';";
  const rec = te.normalizeRecord({
    eventId: 'e1', activationId: 'a', sourceHash: 's',
    file: 'C:\\\\Users\\\\me\\\\secret\\\\path\\\\app.ts', // absolute → collapsed to basename
    addedSnippet: secret + 'a'.repeat(5000),               // secret + overlong → redacted + capped
    ts: 123,
    tool: 'Edit', new_string: secret, extra: { nope: true }, // unknown keys must not survive
  });
  assertEq(Object.keys(rec).sort().join(','), 'activationId,addedSnippet,eventId,file,sourceHash,ts', 'only the 6 honest fields survive');
  assert(!rec.addedSnippet.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'the API key is redacted out of the stored snippet');
  assert(rec.addedSnippet.length <= te.MAX_SNIPPET_CHARS, 'snippet capped to MAX_SNIPPET_CHARS');
  assertEq(rec.file, 'app.ts', 'absolute path collapsed to a bare basename (no path leak)');
  assert(!JSON.stringify(rec).includes('nope') && rec.tool === undefined && rec.new_string === undefined, 'unknown keys stripped');
});

test('trigger-evidence-store: load returns empty shape on a corrupt queue (never throws)', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-te-'));
  const p = te.queuePath(dd, 'teCorrupt');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ not valid json');
  assertEq(te.listEvidence(dd, 'teCorrupt', {}), [], 'corrupt queue → empty list, no throw');
  assert(te.appendEvidence(dd, 'teCorrupt', { eventId: 'e', activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: 1 }), 'append recovers over a corrupt queue');
  assertEq(te.listEvidence(dd, 'teCorrupt', {}).length, 1, 'one record after recovery');
});

test('trigger-evidence-store: purge by olderThanTs removes only strictly-older records', () => {
  const te = require('./lib/trigger-evidence-store.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-te-'));
  te.appendEvidence(dd, 'teAge', { eventId: 'old', activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: 1000 }, { ttlDays: 0 });
  te.appendEvidence(dd, 'teAge', { eventId: 'new', activationId: 'a', sourceHash: 's', file: 'f.ts', addedSnippet: 'x', ts: 5000 }, { ttlDays: 0 });
  assertEq(te.purgeEvidence(dd, 'teAge', { olderThanTs: 3000 }), 1, 'one record older than the cutoff removed');
  const rest = te.listEvidence(dd, 'teAge', {});
  assertEq(rest.map((e) => e.eventId), ['new'], 'only the newer record remains');
});

test('hooks-config getCaptureTriggerEvidence: DEFAULT OFF; enabled ONLY when === true; validates bounds', () => {
  // Absent block → the privacy default: OFF, with the documented fallbacks.
  withHooksConfigFile({ profile: 'dev' }, (hc) => {
    const c = hc.getCaptureTriggerEvidence();
    assertEq(c.enabled, false, 'absent → capture OFF by default');
    assertEq(c.ttlDays, 7, 'default ttlDays');
    assertEq(c.maxPerProject, 500, 'default maxPerProject');
    assertEq(c.maxSnippetChars, 2000, 'default maxSnippetChars');
  });
  // A truthy-but-not-true value must NOT enable capture (strict === true gate).
  withHooksConfigFile({ captureTriggerEvidence: { enabled: 'yes', ttlDays: 0, maxPerProject: -5, maxSnippetChars: 'x' } }, (hc) => {
    const c = hc.getCaptureTriggerEvidence();
    assertEq(c.enabled, false, 'non-boolean truthy enabled stays OFF (=== true only)');
    assertEq(c.ttlDays, 7, 'invalid ttlDays falls back to default');
    assertEq(c.maxPerProject, 500, 'invalid maxPerProject falls back to default');
    assertEq(c.maxSnippetChars, 2000, 'invalid maxSnippetChars falls back to default');
  });
  // Explicit opt-in with valid overrides is honored.
  withHooksConfigFile({ captureTriggerEvidence: { enabled: true, ttlDays: 3, maxPerProject: 10, maxSnippetChars: 50 } }, (hc) => {
    const c = hc.getCaptureTriggerEvidence();
    assertEq(c.enabled, true, 'explicit enabled:true opts in');
    assertEq(c.ttlDays, 3, 'valid ttlDays override honored');
    assertEq(c.maxPerProject, 10, 'valid maxPerProject override honored');
    assertEq(c.maxSnippetChars, 50, 'valid maxSnippetChars override honored');
  });
});

// Seed captured trigger evidence under the SAME project key the prepare tool reads:
// both call the store with the resolved project id (sanitizeProjectId), so a flat id
// like 'tev-…' agrees on both sides — this IS the hook-write ↔ prepare-read agreement.
function _teSeed(project, activationId, n, snippet) {
  const te = require('./lib/trigger-evidence-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  for (let i = 1; i <= n; i++) {
    te.appendEvidence(dataDir(), project, {
      eventId: 'ev' + String(i).padStart(2, '0'),
      activationId, sourceHash: 'sh',
      file: 'src/f' + i + '.ts',
      addedSnippet: typeof snippet === 'function' ? snippet(i) : (snippet || ('console.log("x' + i + '")')),
      ts: 1000 + i,
    }, { maxPerProject: 500, ttlDays: 0 });
  }
}

test('policy_adjudication_prepare source:triggers — builds bundle from CAPTURED evidence, capped at 25, honest note', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'tev-prep-' + Date.now();
  const act = policyStore.activate(dataDir(), { text: 'no console.log in prod', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  assert(act.activated && act.activationId, 'shadow policy activated with an activationId');
  _teSeed(project, act.activationId, 30);
  const r1 = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, source: 'triggers', project })));
  const r2 = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, source: 'triggers', project })));
  assertEq(r1.source, 'triggers', 'result marks the triggers source');
  assertEq(r1.occurrenceCount, 25, 'sample capped at 25');
  assertEq(r1.manifestHash, r2.manifestHash, 'manifestHash deterministic across runs');
  const b1 = JSON.parse(fs.readFileSync(r1.bundlePath, 'utf-8'));
  assertEq(b1.source, 'triggers', 'bundle records source:triggers');
  assertEq(b1.eligible, 30, 'eligible reflects the true captured total (30)');
  assertEq(b1.occurrences.length, 25, 'bundle holds exactly 25 occurrences');
  assert(b1.occurrences.every((o) => o.line === null), 'a captured proposal has no current-code line');
  assertEq(b1.occurrences[0].id, 'ev30', 'newest captured evidence is sampled first (deterministic)');
  assert(r1.note.includes('CAPTURED TRIGGER PROPOSALS') && r1.note.toLowerCase().includes('judged') && r1.note.includes('NOT a measured false-positive rate'), 'note is the honest triggers framing');
});

test('policy_adjudication_prepare source:triggers — no captured evidence → occurrenceCount 0 with guidance', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'tev-empty-' + Date.now();
  const act = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  const res = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, source: 'triggers', project })));
  assertEq(res.occurrenceCount, 0, 'no captured evidence → occurrenceCount 0');
  assertEq(res.source, 'triggers', 'still marked triggers');
  assert(res.bundlePath === undefined, 'no bundle written when there is nothing to adjudicate');
  assert(res.note.includes('no captured trigger evidence') && res.note.includes('captureTriggerEvidence'), 'note guides the user to opt in first');
});

test('policy_adjudication_record source:triggers — JUDGED estimate: trigger kind, judged share, disclaimer, NO measured-FP', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'tev-rec-' + Date.now();
  const act = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  _teSeed(project, act.activationId, 3, (i) => "console.log('sekret-tok" + i + "')");
  const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, source: 'triggers', project })));
  const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
  // 2 likely_legitimate + 1 likely_problem → judged FP share = 2/3.
  const verdicts = { schema: 1, verdicts: bundle.occurrences.map((o, k) => ({ id: o.id, label: k === 0 ? 'likely_problem' : 'likely_legitimate', promptInjectionSuspected: false, reason: 'r' })) };
  const rr = JSON.parse(_adjText(await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), project })));
  assertEq(rr.kind, 'llm-trigger-proposal-disposition', 'triggers-sourced disposition kind');
  assert(rr.falsePositiveRate === undefined, 'NO measured falsePositiveRate is exposed');
  assert(typeof rr.judgedLikelyFpShare === 'number' && Math.abs(rr.judgedLikelyFpShare - 2 / 3) < 1e-9, 'judgedLikelyFpShare = legit/(legit+problem) = 2/3');
  assert(rr.judgedLikelyFpShareNote.includes('NOT a measured false-positive rate') && rr.judgedLikelyFpShareNote.includes('N/A'), 'the share note keeps the shadow FP N/A and disclaims measurement');
  assert(typeof rr.disclaimer === 'string' && rr.disclaimer.includes('JUDGED likely-FP estimate') && rr.disclaimer.includes('NOT a measured false-positive rate'), 'disclaimer frames it as a JUDGED estimate, not a measured rate');
  assert(rr.tuningRecommendation === undefined, 'no snapshot tuning nudge on a triggers disposition');
  // Persisted distinctly + no snippet leaks into the disposition.
  const stored = adjStore.listDispositions(dataDir(), project).filter((d) => String(d.policyId) === String(act.id));
  assert(stored.length >= 1, 'a disposition was persisted');
  assertEq(stored[0].kind, 'llm-trigger-proposal-disposition', 'stored disposition carries the triggers kind');
  assertEq(stored[0].provenance.source, 'triggers', 'stored provenance records source:triggers');
  assert(!JSON.stringify(stored[0]).includes('sekret-tok'), 'no captured snippet leaks into the persisted disposition');
});

test('policy_adjudication_record: dispositionKind override forces the triggers kind on a snapshot bundle', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-adjw-'));
  const project = 'tev-ovr-' + Date.now();
  try {
    _adjMakeFiles(work, 2, 'ts', (i) => `console.log('o${i}');\n`);
    const act = policyStore.activate(dataDir(), { text: 't', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
    const prep = JSON.parse(_adjText(await server.handleTool('policy_adjudication_prepare', { policyId: act.id, project, cwd: work })));
    const bundle = JSON.parse(fs.readFileSync(prep.bundlePath, 'utf-8'));
    assertEq(bundle.source, 'current-snapshot', 'the default bundle is a current-snapshot');
    const verdicts = { schema: 1, verdicts: bundle.occurrences.map((o) => ({ id: o.id, label: 'likely_legitimate', promptInjectionSuspected: false, reason: 'r' })) };
    const rr = JSON.parse(_adjText(await server.handleTool('policy_adjudication_record', { policyId: act.id, manifestHash: prep.manifestHash, verdictsJson: JSON.stringify(verdicts), dispositionKind: 'llm-trigger-proposal-disposition', project, cwd: work })));
    assertEq(rr.kind, 'llm-trigger-proposal-disposition', 'explicit dispositionKind override honored');
    assert(typeof rr.judgedLikelyFpShare === 'number', 'override path emits the judged share, not a measured rate');
    assert(rr.falsePositiveRate === undefined, 'still no measured falsePositiveRate');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { void err; }
  }
});

test('policy_trigger_evidence_purge: removes a policy\'s captured evidence, then all; static: not a KB tool', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const te = require('./lib/trigger-evidence-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'tev-purge-' + Date.now();
  const act1 = policyStore.activate(dataDir(), { text: 'p1', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  const act2 = policyStore.activate(dataDir(), { text: 'p2', scope: 'project', projectId: project, globs: ['**/*.js'], assert: { kind: 'forbid-added-literal', literal: 'debugger' }, enforcement: 'shadow' });
  _teSeed(project, act1.activationId, 3);
  _teSeed(project, act2.activationId, 2);
  assertEq(te.listEvidence(dataDir(), project, {}).length, 5, 'five records seeded across two policies');
  const p1 = JSON.parse(_adjText(await server.handleTool('policy_trigger_evidence_purge', { policyId: act1.id, project })));
  assertEq(p1.removed, 3, 'purge by policyId removed only that policy\'s 3 records');
  assertEq(te.listEvidence(dataDir(), project, {}).length, 2, 'the other policy\'s evidence is untouched');
  const pAll = JSON.parse(_adjText(await server.handleTool('policy_trigger_evidence_purge', { project })));
  assertEq(pAll.removed, 2, 'purge-all removed the rest');
  assertEq(te.listEvidence(dataDir(), project, {}).length, 0, 'queue empty after purge-all');
  // An unknown policyId is refused (never silently purges everything).
  const bad = await server.handleTool('policy_trigger_evidence_purge', { policyId: 'no-such', project });
  assert(bad.isError, 'unknown policyId is rejected');
  // Static proof: the purge tool is NOT wired into the KB singleton sets.
  const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const kbStart = src.indexOf('const KB_TOOLS');
  const kbEnd = src.indexOf('export function createBrainServer');
  const kbSlice = src.slice(kbStart, kbEnd);
  assert(kbStart > 0 && kbEnd > kbStart, 'located the KB_TOOLS/REMOTE_KB_TOOLS declarations');
  assert(!kbSlice.includes('policy_trigger_evidence_purge'), 'purge tool is neither a KB tool nor a remote KB tool');
});

test('policy_adjudication_purge: removes ORPHAN bundle-*.json only; keeps dispositions.json + other projects; static: not a KB tool', async () => {
  const server = await _adjImportServer();
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const { writeFileAtomic } = require('./lib/atomic-write.js');
  const projA = 'adj-purge-a-' + Date.now();
  const projB = 'adj-purge-b-' + Date.now();
  const dirA = adjStore.adjudicationDir(dataDir(), projA);
  const dirB = adjStore.adjudicationDir(dataDir(), projB);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  // Two ORPHAN bundles + a durable disposition in project A; one bundle in project B.
  writeFileAtomic(path.join(dirA, 'bundle-aaaa1111.json'), JSON.stringify({ schema: 1 }));
  writeFileAtomic(path.join(dirA, 'bundle-bbbb2222.json'), JSON.stringify({ schema: 1 }));
  assert(adjStore.saveDisposition(dataDir(), projA, { policyId: 'p', manifestHash: 'aaaa1111', ts: 1, counts: { legit: 0, problem: 0, uncertain: 0, injectionSuspected: 0, total: 0 }, coverage: { sampled: 0, eligible: 0 }, provenance: {} }), 'seed a durable disposition in A');
  writeFileAtomic(path.join(dirB, 'bundle-cccc3333.json'), JSON.stringify({ schema: 1 }));

  const res = JSON.parse(_adjText(await server.handleTool('policy_adjudication_purge', { project: projA })));
  assertEq([res.kind, res.projectId, res.removed], ['adjudication-bundle-purge', res.projectId, 2], 'both orphan bundles in A removed, count returned');
  assert(!fs.existsSync(path.join(dirA, 'bundle-aaaa1111.json')) && !fs.existsSync(path.join(dirA, 'bundle-bbbb2222.json')), 'A bundles are gone');
  assert(fs.existsSync(adjStore.dispositionsPath(dataDir(), projA)), 'the durable dispositions.json is PRESERVED (never matched by BUNDLE_RE)');
  assert(fs.existsSync(path.join(dirB, 'bundle-cccc3333.json')), 'another project\'s bundle is untouched');
  // Idempotent: re-running on the now-clean project removes nothing.
  const res2 = JSON.parse(_adjText(await server.handleTool('policy_adjudication_purge', { project: projA })));
  assertEq(res2.removed, 0, 'nothing left to purge on a clean project');

  // Static proof: the purge tool is NOT wired into the KB singleton sets (no lock, like its sibling).
  const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const kbStart = src.indexOf('const KB_TOOLS');
  const kbEnd = src.indexOf('export function createBrainServer');
  const kbSlice = src.slice(kbStart, kbEnd);
  assert(kbStart > 0 && kbEnd > kbStart, 'located the KB_TOOLS/REMOTE_KB_TOOLS declarations');
  assert(!kbSlice.includes('policy_adjudication_purge'), 'purge tool is neither a KB tool nor a remote KB tool');
});

test('policy trigger-evidence tools: never mutate a policy (no activate/deactivate in the handlers)', () => {
  const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const start = src.indexOf("case 'policy_adjudication_prepare'");
  const end = src.indexOf('default:', start);
  assert(start > 0 && end > start, 'located the adjudication+purge handler block');
  const slice = src.slice(start, end);
  assert(!slice.includes('.activate(') && !slice.includes('.deactivate('), 'triggers capture/adjudicate/purge handlers contain no activate/deactivate (no auto-mutation)');
});

// ─── Self-update advisory + safe user-invoked apply (Fase 3 micro-C) ─────────
// Pure planner + append-only ledger + two MCP tools. The hard invariant: advice
// is auto-computed (read-only); APPLYING is explicit, CAS-guarded, signal-gated,
// ledgered, reversible, and demote-only. Everything framed as a JUDGED estimate.

// A minimal policy + disposition maker for the PURE planner tests.
const _suPolicy = (over) => Object.assign({ id: 'p1', activationId: 'aid-pol', mode: 'glob', globs: ['**/*.ts'], text: 't', assert: { kind: 'forbid-added-literal', literal: 'x' }, enforcement: 'shadow', sourceHash: 'sh0' }, over || {});
const _suDisp = (legit, problem, uncertain, source) => ({ policyId: 'p1', counts: { legit, problem, uncertain, injectionSuspected: 0, total: legit + problem + uncertain }, provenance: source ? { source } : {}, activationId: 'aid-disp' });

test('self-update-plan: exports named thresholds (MIN_SAMPLE/HIGH_FP/LOW_FP) + planSelfUpdate', () => {
  const su = require('./lib/self-update-plan.js');
  assertEq([su.MIN_SAMPLE, su.HIGH_FP, su.LOW_FP], [5, 0.6, 0.15]);
  assert(typeof su.planSelfUpdate === 'function', 'planSelfUpdate is exported');
});

test('self-update-plan: no disposition → insufficient-data / none (points to /policy-adjudicate)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), null);
  assertEq([p.signal, p.candidate.action, p.candidate.requiresExplicitApply], ['insufficient-data', 'none', false]);
  assertEq(p.judged.likelyFpShare, null);
  assert(/policy-adjudicate/.test(p.recommendation), 'nudges to adjudicate more first');
  assertEq(p.policyId, 'p1');
});

test('self-update-plan: small sample (total < MIN_SAMPLE) → insufficient-data / none', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(2, 1, 1)); // total=4 < 5
  assertEq([p.signal, p.candidate.action], ['insufficient-data', 'none']);
  assertEq(p.judged.total, 4);
});

test('self-update-plan: all-uncertain (decisive=0) → insufficient-data / none (no share invented)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(0, 0, 6)); // total=6 ≥ 5 but decisive=0
  assertEq([p.signal, p.candidate.action], ['insufficient-data', 'none']);
  assertEq(p.judged.likelyFpShare, null);
});

test('self-update-plan: too-broad at HIGH_FP → demote-to-advisory candidate (requiresExplicitApply)', () => {
  const { planSelfUpdate, HIGH_FP } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(6, 2, 1, 'triggers')); // 6/8 = .75 ≥ .6
  assertEq([p.signal, p.candidate.action, p.candidate.requiresExplicitApply], ['too-broad', 'demote-to-advisory', true]);
  assertEq(p.judged.likelyFpShare, 0.75);
  assertEq(p.judged.source, 'triggers');
  // Boundary: EXACTLY HIGH_FP still counts as too-broad (>=).
  const b = planSelfUpdate(_suPolicy(), _suDisp(3, 2, 0)); // 3/5 = .6
  assertEq(b.judged.likelyFpShare, HIGH_FP);
  assertEq([b.signal, b.candidate.action], ['too-broad', 'demote-to-advisory']);
});

test('self-update-plan: well-calibrated at LOW_FP (decisive ≥ MIN) → enforce-eligible (SURFACE ONLY)', () => {
  const { planSelfUpdate, LOW_FP } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(0, 8, 0, 'current-snapshot')); // 0/8 = 0 ≤ .15, decisive 8 ≥ 5
  assertEq([p.signal, p.candidate.action, p.candidate.requiresExplicitApply], ['well-calibrated', 'enforce-eligible', true]);
  assert(/recommendation only|is not implemented|never applied/i.test(p.recommendation), 'enforce is surfaced only, never applied');
  // Boundary: EXACTLY LOW_FP with enough decisive is enforce-eligible (<=).
  const b = planSelfUpdate(_suPolicy(), _suDisp(3, 17, 0)); // 3/20 = .15
  assertEq(b.judged.likelyFpShare, LOW_FP);
  assertEq([b.signal, b.candidate.action], ['well-calibrated', 'enforce-eligible']);
});

test('self-update-plan: low FP but too few decisive → NOT enforce-eligible (middling / none)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(0, 1, 5)); // share 0 but decisive=1 < MIN
  assertEq([p.signal, p.candidate.action], ['well-calibrated', 'none']);
});

test('self-update-plan: middling share → well-calibrated / none', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(4, 4, 0)); // .5, between thresholds
  assertEq([p.signal, p.candidate.action], ['well-calibrated', 'none']);
  assertEq(p.judged.likelyFpShare, 0.5);
});

test('self-update-plan: likelyFpShare is computed over DECISIVE judgments only (uncertain excluded)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const p = planSelfUpdate(_suPolicy(), _suDisp(3, 1, 100)); // decisive=4 → 3/4=.75, NOT 3/104
  assertEq(p.judged.likelyFpShare, 0.75);
  assertEq([p.judged.decisive, p.judged.uncertain, p.judged.total], [4, 100, 104]);
});

test('self-update-plan: EVERY recommendation carries the JUDGED-estimate caveat (heuristic, not proven, no change without explicit apply)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const variants = [
    planSelfUpdate(_suPolicy(), null),
    planSelfUpdate(_suPolicy(), _suDisp(2, 1, 1)),
    planSelfUpdate(_suPolicy(), _suDisp(0, 0, 6)),
    planSelfUpdate(_suPolicy(), _suDisp(6, 2, 0)),
    planSelfUpdate(_suPolicy(), _suDisp(0, 8, 0)),
    planSelfUpdate(_suPolicy(), _suDisp(4, 4, 0)),
  ];
  for (const v of variants) {
    assert(/JUDGED estimate/.test(v.recommendation), `recommendation states JUDGED estimate: ${v.signal}`);
    assert(/heuristic/i.test(v.recommendation), `recommendation says heuristic: ${v.signal}`);
    assert(/nothing changes unless you explicitly apply/i.test(v.recommendation), `recommendation says nothing changes without explicit apply: ${v.signal}`);
  }
});

test('self-update-plan: PURE — no filesystem/store side effects (frozen inputs untouched)', () => {
  const { planSelfUpdate } = require('./lib/self-update-plan.js');
  const pol = Object.freeze(_suPolicy());
  const disp = Object.freeze(_suDisp(6, 2, 0, 'triggers'));
  const out = planSelfUpdate(pol, disp); // must not throw (no mutation of frozen inputs)
  assertEq(out.candidate.action, 'demote-to-advisory');
});

test('revision-ledger: append/list roundtrip — newest first, project-scoped, policyId filter', () => {
  const led = require('./lib/revision-ledger.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-led-'));
  assertEq(led.listRevisions(dd, 'projA'), [], 'empty on a fresh project (never throws)');
  assert(led.appendRevision(dd, 'projA', { ts: 1000, policyId: 'p1', action: 'demote-to-advisory', beforeSourceHash: 'a', afterSourceHash: 'b', beforeActivationId: 'act1', afterActivationId: null, note: 'n' }), 'append 1');
  assert(led.appendRevision(dd, 'projA', { ts: 3000, policyId: 'p1', action: 'demote-to-advisory', beforeSourceHash: 'c', afterSourceHash: 'd' }), 'append 2');
  assert(led.appendRevision(dd, 'projA', { ts: 2000, policyId: 'p2', action: 'demote-to-advisory' }), 'append 3');
  const all = led.listRevisions(dd, 'projA');
  assertEq(all.length, 3, 'three revisions listed');
  assert(all[0].ts >= all[1].ts && all[1].ts >= all[2].ts, 'newest first');
  assertEq(led.listRevisions(dd, 'projA', { policyId: 'p1' }).length, 2, 'policyId filter narrows to p1');
  assertEq(led.listRevisions(dd, 'projB').length, 0, 'project scoping isolates projB');
});

test('revision-ledger: normalizeEntry keeps ONLY transition metadata (NO snippets/globs/text/unknown keys)', () => {
  const led = require('./lib/revision-ledger.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-led-'));
  led.appendRevision(dd, 'projX', { ts: 5, policyId: 'p', action: 'demote-to-advisory', beforeSourceHash: 'a', afterSourceHash: 'b', beforeActivationId: 'act', afterActivationId: null, note: 'ok', snippet: 'SECRET_CODE()', globs: ['src/**'], text: 'leaky text', extra: 1 });
  const [rec] = led.listRevisions(dd, 'projX');
  const raw = JSON.stringify(rec);
  assert(!raw.includes('SECRET_CODE') && !raw.includes('leaky text') && !raw.includes('src/**'), 'no snippet/text/globs survive persistence');
  assertEq(Object.keys(rec).sort(), ['action', 'afterActivationId', 'afterSourceHash', 'beforeActivationId', 'beforeSourceHash', 'note', 'policyId', 'ts'], 'only the 8 transition-metadata keys are stored');
  assert(rec.snippet === undefined && rec.globs === undefined && rec.text === undefined && rec.extra === undefined, 'unknown keys stripped');
});

test('revision-ledger: note is length-capped; never-throws on a corrupt ledger (empty shape)', () => {
  const led = require('./lib/revision-ledger.js');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-led-'));
  led.appendRevision(dd, 'projC', { policyId: 'p', action: 'demote-to-advisory', note: 'x'.repeat(5000) });
  assert(led.listRevisions(dd, 'projC')[0].note.length <= led.MAX_NOTE_CHARS, 'note capped to MAX_NOTE_CHARS');
  // Corrupt the file → load returns the empty shape, list never throws.
  fs.writeFileSync(led.ledgerPath(dd, 'projC'), '{ not json');
  assertEq(led.listRevisions(dd, 'projC'), [], 'corrupt ledger reads back as empty (never throws)');
});

test('policy_self_update_report: computes JUDGED advisories for active glob/shadow policies + honest top-level note', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'su-report-' + Date.now();
  // Policy A: too-broad (mostly-legit judged) → demote candidate.
  const a = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  adjStore.saveDisposition(dataDir(), project, { policyId: a.id, manifestHash: 'aa', ts: Date.now(), counts: { legit: 6, problem: 2, uncertain: 0, injectionSuspected: 0, total: 8 }, coverage: { sampled: 8, eligible: 20 }, provenance: { source: 'triggers' }, activationId: a.activationId });
  // Policy B: no disposition → insufficient-data.
  const b = policyStore.activate(dataDir(), { text: 'no eval', scope: 'project', projectId: project, globs: ['**/*.js'], assert: { kind: 'forbid-added-literal', literal: 'eval(' }, enforcement: 'shadow' });
  const rep = JSON.parse(_adjText(await server.handleTool('policy_self_update_report', { project })));
  assertEq(rep.kind, 'policy-self-update-report');
  assertEq(rep.count, 2, 'both active shadow policies advised');
  const advA = rep.advisories.find((x) => x.policyId === a.id);
  const advB = rep.advisories.find((x) => x.policyId === b.id);
  assertEq([advA.signal, advA.candidate.action], ['too-broad', 'demote-to-advisory']);
  assertEq([advB.signal, advB.candidate.action], ['insufficient-data', 'none']);
  // The report surfaces the EXACT current sourceHash (so an explicit apply can CAS
  // on it) and flags shadow-assertion policies (the only demotable kind).
  const liveA = policyStore.listVisible(dataDir(), { projectId: project }).find((r) => r.id === a.id);
  assertEq(advA.sourceHash, liveA.sourceHash);
  assertEq([advA.isShadowAssertion, advB.isShadowAssertion], [true, true]);
  assert(/JUDGED|judged/.test(rep.note) && /NOTHING here changes|apply a candidate explicitly/.test(rep.note), 'note is honest: judged + nothing changes without explicit apply');
  assert(/enforce/i.test(rep.note), 'note discloses enforce-eligibility is a recommendation only');
});

test('policy_self_update_report: MUTATES NOTHING (listVisible byte-identical) + static: handler has no activate/deactivate', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'su-report-nomut-' + Date.now();
  const a = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  adjStore.saveDisposition(dataDir(), project, { policyId: a.id, manifestHash: 'aa', ts: Date.now(), counts: { legit: 6, problem: 2, uncertain: 0, injectionSuspected: 0, total: 8 }, coverage: { sampled: 8, eligible: 20 }, provenance: { source: 'triggers' }, activationId: a.activationId });
  const before = JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project }));
  await server.handleTool('policy_self_update_report', { project });
  await server.handleTool('policy_self_update_report', { project }); // idempotent, still read-only
  assertEq(JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project })), before, 'report leaves every policy byte-identical (no activate/deactivate)');
  // Static proof: the REPORT handler slice calls no activate/deactivate.
  const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const start = src.indexOf("case 'policy_self_update_report'");
  const end = src.indexOf("case 'policy_apply_candidate'", start);
  assert(start > 0 && end > start, 'located the report handler block');
  const slice = src.slice(start, end);
  assert(!slice.includes('.activate(') && !slice.includes('.deactivate('), 'policy_self_update_report handler contains no activate/deactivate (read-only)');
});

test('policy_apply_candidate: CAS mismatch REFUSES and changes nothing', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const ledger = require('./lib/revision-ledger.js');
  const project = 'su-cas-' + Date.now();
  const a = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  adjStore.saveDisposition(dataDir(), project, { policyId: a.id, manifestHash: 'aa', ts: Date.now(), counts: { legit: 6, problem: 2, uncertain: 0, injectionSuspected: 0, total: 8 }, coverage: { sampled: 8, eligible: 20 }, provenance: { source: 'triggers' }, activationId: a.activationId });
  const before = JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project }));
  const res = await server.handleTool('policy_apply_candidate', { policyId: a.id, expectedSourceHash: 'deadbeefstale', project });
  assert(res.isError, 'stale sourceHash is refused');
  assert(/CAS|mismatch|changed since/i.test(_adjText(res)), 'message explains the CAS refusal');
  assertEq(JSON.stringify(policyStore.listVisible(dataDir(), { projectId: project })), before, 'nothing mutated on CAS refuse');
  assertEq(ledger.listRevisions(dataDir(), project).length, 0, 'no ledger entry written on CAS refuse');
});

test('policy_apply_candidate: signal-gate — a well-calibrated policy CANNOT be force-demoted', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'su-gate-' + Date.now();
  const a = policyStore.activate(dataDir(), { text: 'no eval', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'eval(' }, enforcement: 'shadow' });
  const pol = policyStore.listVisible(dataDir(), { projectId: project }).find((r) => r.id === a.id);
  adjStore.saveDisposition(dataDir(), project, { policyId: a.id, manifestHash: 'bb', ts: Date.now(), counts: { legit: 0, problem: 8, uncertain: 0, injectionSuspected: 0, total: 8 }, coverage: { sampled: 8, eligible: 8 }, provenance: { source: 'current-snapshot' }, activationId: a.activationId });
  const res = await server.handleTool('policy_apply_candidate', { policyId: a.id, expectedSourceHash: pol.sourceHash, project });
  assert(res.isError, 'a well-calibrated (non-demote) policy is refused even with the correct hash');
  assert(/not a demote candidate/i.test(_adjText(res)), 'message explains the signal-gate refusal');
  const after = policyStore.listVisible(dataDir(), { projectId: project }).find((r) => r.id === a.id);
  assert(!!after.assert && after.enforcement === 'shadow', 'the policy is untouched — still a shadow assertion');
});

test('policy_apply_candidate: valid demote drops assert/enforcement, KEEPS globs/text, writes a ledger entry, mints a new sourceHash', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const adjStore = require('./lib/adjudication-store.js');
  const ledger = require('./lib/revision-ledger.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'su-apply-' + Date.now();
  const a = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  const pol0 = policyStore.listVisible(dataDir(), { projectId: project }).find((r) => r.id === a.id);
  adjStore.saveDisposition(dataDir(), project, { policyId: a.id, manifestHash: 'aa', ts: Date.now(), counts: { legit: 6, problem: 2, uncertain: 0, injectionSuspected: 0, total: 8 }, coverage: { sampled: 8, eligible: 20 }, provenance: { source: 'triggers' }, activationId: a.activationId });
  const res = JSON.parse(_adjText(await server.handleTool('policy_apply_candidate', { policyId: a.id, expectedSourceHash: pol0.sourceHash, project })));
  assertEq([res.kind, res.applied], ['policy-self-update-apply', 'demote-to-advisory']);
  assert(/REVERSIBLE|reversible/.test(res.note) && /JUDGED/.test(res.note), 'result note is honest: reversible + judged');
  // The record is now a plain glob advisory: assert/enforcement/activationId gone, globs+text kept, SAME id (no dup).
  const rows = policyStore.listVisible(dataDir(), { projectId: project }).filter((r) => r.id === a.id);
  assertEq(rows.length, 1, 'exactly one record for the id (clean UPSERT, no duplicate)');
  const pol1 = rows[0];
  assert(pol1.assert === undefined && pol1.enforcement === undefined && pol1.activationId === undefined, 'shadow assert + enforcement + activationId removed');
  assertEq(pol1.mode, 'glob');
  assertEq(pol1.globs, pol0.globs);
  assertEq(pol1.text, pol0.text);
  assert(pol1.sourceHash && pol1.sourceHash !== pol0.sourceHash, 'a NEW sourceHash was minted for the demoted advisory');
  // Ledger records the transition (before/after hash + activationId; no snippets).
  const led = ledger.listRevisions(dataDir(), project, { policyId: a.id });
  assertEq(led.length, 1, 'one ledger entry written');
  assertEq([led[0].action, led[0].beforeSourceHash, led[0].afterSourceHash, led[0].beforeActivationId, led[0].afterActivationId], ['demote-to-advisory', pol0.sourceHash, pol1.sourceHash, a.activationId, null]);
  // Lineage guarantee: re-promoting to shadow mints a FRESH activationId (never reuses the retired one).
  const re = policyStore.activate(dataDir(), { text: 'no console.log', scope: 'project', projectId: project, globs: ['**/*.ts'], assert: { kind: 'forbid-added-literal', literal: 'console.log' }, enforcement: 'shadow' });
  assert(re.activationId && re.activationId !== a.activationId, 'a demote retires the old activationId — re-promotion mints a fresh one');
});

test('policy_apply_candidate: refuses an already-plain advisory and an unknown/always policy (nothing to demote)', async () => {
  const server = await _adjImportServer();
  const policyStore = require('./lib/policy-store.js');
  const { dataDir } = require('./lib/data-dir.js');
  const project = 'su-refuse-' + Date.now();
  // Plain glob advisory (no assert) → nothing to demote.
  const g = policyStore.activate(dataDir(), { text: 'plain advisory', scope: 'project', projectId: project, globs: ['**/*.ts'] });
  const gp = policyStore.listVisible(dataDir(), { projectId: project }).find((r) => r.id === g.id);
  const r1 = await server.handleTool('policy_apply_candidate', { policyId: g.id, expectedSourceHash: gp.sourceHash, project });
  assert(r1.isError && /already a plain glob advisory/i.test(_adjText(r1)), 'a plain advisory has no assertion to demote');
  // Always-mode policy → not a glob/shadow policy.
  const al = policyStore.activate(dataDir(), { text: 'always rule', scope: 'project', projectId: project });
  const r2 = await server.handleTool('policy_apply_candidate', { policyId: al.id, expectedSourceHash: 'whatever', project });
  assert(r2.isError && /not a glob\/shadow policy/i.test(_adjText(r2)), 'an always policy cannot be demoted');
  // Unknown id.
  const r3 = await server.handleTool('policy_apply_candidate', { policyId: 'no-such', expectedSourceHash: 'x', project });
  assert(r3.isError && /no active policy/i.test(_adjText(r3)), 'unknown policy id is refused');
  // Missing expectedSourceHash is refused up front.
  const r4 = await server.handleTool('policy_apply_candidate', { policyId: g.id, project });
  assert(r4.isError && /expectedSourceHash is required/i.test(_adjText(r4)), 'expectedSourceHash is mandatory (CAS)');
});

test('policy_self_update_report + apply: both tools are OUT of KB_TOOLS/REMOTE_KB_TOOLS and declared in TOOLS', () => {
  const src = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'servers', 'brain-server', 'lib', 'mcp-server.js'), 'utf-8');
  const kbBlock = src.slice(src.indexOf('const KB_TOOLS'), src.indexOf('export function createBrainServer'));
  for (const t of ['policy_self_update_report', 'policy_apply_candidate']) {
    assert(src.includes(`name: '${t}'`), `${t} is declared in the TOOLS array`);
    assert(!kbBlock.includes(`'${t}'`), `${t} is neither a KB tool nor a remote KB tool`);
  }
});

// ─── graph/* (Session Graph Engine client) — daemon-free, mock fetch/discover ─
const graphDaemon = require('./lib/graph/daemon.js');
const graphClient = require('./lib/graph/client.js');
const { createGraphTools } = require('./lib/graph/tools.js');

/** Mock fetch that records calls and serves canned /api/v1/graph responses. */
function makeGraphFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const s = String(url);
    const sub = s.includes('/api/v1/graph/') ? s.split('/api/v1/graph/')[1] : (s.endsWith('/health') ? 'health' : s);
    calls.push({ sub, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = routes[sub];
    const res = typeof r === 'function' ? r() : r;
    if (!res) throw new Error('no mock route for ' + sub);
    return { status: res.status, headers: { get: (k) => (res.headers || {})[k] }, json: async () => res.json };
  };
  return { calls, fetchImpl };
}
/** A /status route that advances through states on successive calls. */
function seqStatus(states) {
  let i = 0;
  return () => {
    const state = states[Math.min(i, states.length - 1)]; i++;
    return { status: 200, json: { project_id: 'p', root: 'r', state, nodes: state === 'ready' ? 3 : 0, edges: 0 } };
  };
}

test('graph/daemon: readRegistry missing → null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-graph-'));
  assertEq(graphDaemon.readRegistry(d), null);
});
test('graph/daemon: readRegistry valid → info.url', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-graph-'));
  fs.writeFileSync(path.join(d, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:9', port: 9 }));
  const info = graphDaemon.readRegistry(d);
  assert(info && info.url === 'http://127.0.0.1:9', 'url parsed');
});
test('graph/daemon: readRegistry corrupt → null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-graph-'));
  fs.writeFileSync(path.join(d, 'daemon.json'), '{not json');
  assertEq(graphDaemon.readRegistry(d), null);
});
test('graph/daemon: health 200/503 alive, 404/err dead', async () => {
  const ok = await graphDaemon.health('http://x', { fetchImpl: async () => ({ status: 200 }) });
  const degraded = await graphDaemon.health('http://x', { fetchImpl: async () => ({ status: 503 }) });
  const dead = await graphDaemon.health('http://x', { fetchImpl: async () => ({ status: 404 }) });
  const err = await graphDaemon.health('http://x', { fetchImpl: async () => { throw new Error('net'); } });
  assertEq([ok, degraded, dead, err], [true, true, false, false]);
});

test('graph/client: clampInt bounds', () => {
  assertEq(graphClient.clampInt(999, 20, 100), 100);
  assertEq(graphClient.clampInt(0, 20, 100), 1);
  assertEq(graphClient.clampInt('x', 20, 100), 20);
});
test('graph/client: assertSafeRoot rejects disk-root/missing, accepts real dir', () => {
  assert(graphClient.assertSafeRoot('C:') !== null, 'disk root rejected');
  assert(graphClient.assertSafeRoot(path.join(ROOT, '__nope__')) !== null, 'missing rejected');
  assertEq(graphClient.assertSafeRoot(ROOT), null);
});
test('graph/client: callsCaveatFor is Java-only', () => {
  assertEq(graphClient.callsCaveatFor('a.java'), null);
  assert(graphClient.callsCaveatFor('a.py'), 'py caveat');
  assert(graphClient.callsCaveatFor('a.py::f'), 'py node-id caveat');
  assertEq(graphClient.callsCaveatFor('a.java::f'), null);
});
test('graph/client: zeroNodesMessage variants', () => {
  assert(graphClient.zeroNodesMessage({}).includes('refresh'), 'no report → refresh hint');
  assert(graphClient.zeroNodesMessage({ report: { scanned: 5, files: 0 } }).includes('none of a language'), 'language msg');
});

test('graph/client: ensureCapable 404 → GRAPH_API_MISSING', async () => {
  graphClient.__clearCapCache();
  const m = makeGraphFetch({ status: { status: 404, json: { message: 'no api' } } });
  let code = null;
  try { await graphClient.ensureCapable('http://cap404', { root: 'r' }, { fetchImpl: m.fetchImpl }); }
  catch (e) { code = e.code; }
  assertEq(code, 'GRAPH_API_MISSING');
});
test('graph/client: ensureReady ready → status-first, no ingest', async () => {
  const m = makeGraphFetch({ status: { status: 200, json: { state: 'ready', nodes: 3, edges: 2 } } });
  const st = await graphClient.ensureReady('http://ready', { root: 'r' }, { fetchImpl: m.fetchImpl, sleepImpl: async () => {} });
  assertEq(st.state, 'ready');
  assertEq(m.calls.filter(c => c.sub === 'ingest').length, 0);
});
test('graph/client: ensureReady not_indexed → ingest → poll → ready', async () => {
  const m = makeGraphFetch({ status: seqStatus(['not_indexed', 'indexing', 'ready']), ingest: { status: 202, json: {} } });
  const st = await graphClient.ensureReady('http://ni', { root: 'r' }, { fetchImpl: m.fetchImpl, sleepImpl: async () => {} });
  assertEq(st.state, 'ready');
  assertEq(m.calls.filter(c => c.sub === 'ingest').length, 1);
});
test('graph/client: ensureReady 429 on ingest → queued + retryAfter', async () => {
  const m = makeGraphFetch({ status: { status: 200, json: { state: 'not_indexed', nodes: 0 } }, ingest: { status: 429, headers: { 'retry-after': '12' }, json: { code: 'QUEUE_SATURATED' } } });
  const st = await graphClient.ensureReady('http://q', { root: 'r' }, { fetchImpl: m.fetchImpl, sleepImpl: async () => {} });
  assert(st.queued === true, 'queued');
  assertEq(st.retryAfter, 12);
});

test('graph/tools: fail-open when daemon offline', async () => {
  const t = createGraphTools({ cwd: () => ROOT, discover: async () => null });
  const out = await t.handle('graph_status', {});
  assert(!out.isError, 'not isError');
  assert(out.content[0].text.startsWith('🕸️ Graph unavailable'), 'offline text');
});
test('graph/tools: capability 404 surfaces update guidance', async () => {
  graphClient.__clearCapCache();
  const m = makeGraphFetch({ status: { status: 404, json: { message: 'x' } } });
  const t = createGraphTools({ cwd: () => ROOT, fetchImpl: m.fetchImpl, discover: async () => ({ url: 'http://tcap404' }) });
  const out = await t.handle('graph_status', {});
  assert(out.content[0].text.includes('does not expose the Graph API'), 'update guidance');
});
test('graph/tools: read tool never ingests when not ready', async () => {
  graphClient.__clearCapCache();
  const m = makeGraphFetch({ status: { status: 200, json: { state: 'not_indexed', nodes: 0, edges: 0 } } });
  const t = createGraphTools({ cwd: () => ROOT, fetchImpl: m.fetchImpl, discover: async () => ({ url: 'http://tread' }) });
  const out = await t.handle('graph_symbols', {});
  assert(out.content[0].text.includes('not ready'), 'guidance text');
  assertEq(m.calls.filter(c => c.sub === 'ingest').length, 0);
  assertEq(m.calls.filter(c => c.sub === 'symbols').length, 0);
});
test('graph/tools: analyze returns hubs + daemon project_id, sends no expected_project_id', async () => {
  graphClient.__clearCapCache();
  const m = makeGraphFetch({
    status: { status: 200, json: { project_id: 'github.com/acme/x', root: '/r', state: 'ready', nodes: 3, edges: 2 } },
    symbols: { status: 200, json: { symbols: [{ id: 'a.java::A', name: 'A', type: 'CLASS', file: 'a.java', pagerank: 0.9 }] } },
  });
  const t = createGraphTools({ cwd: () => ROOT, fetchImpl: m.fetchImpl, discover: async () => ({ url: 'http://tanalyze' }) });
  const out = await t.handle('graph_analyze', {});
  assert(out.content[0].text.includes('Hubs'), 'hubs header');
  assert(out.content[0].text.includes('A'), 'symbol A listed');
  // path-authoritative: the scope line shows the DAEMON-derived project_id, not a client guess.
  assert(out.content[0].text.includes('github.com/acme/x'), 'daemon project_id displayed');
  // simplification invariant: the client never sends expected_project_id — only path (+ tool args).
  assert(m.calls.every((c) => !c.body || !('expected_project_id' in c.body)), 'no expected_project_id in any request body');
});
test('graph/tools: ROOT_CONFLICT reports both roots', async () => {
  graphClient.__clearCapCache();
  const m = makeGraphFetch({ status: { status: 409, json: { code: 'ROOT_CONFLICT', mappedRoot: '/a', requestedRoot: '/b' } } });
  const t = createGraphTools({ cwd: () => ROOT, fetchImpl: m.fetchImpl, discover: async () => ({ url: 'http://tconf' }) });
  const out = await t.handle('graph_status', {});
  const txt = out.content[0].text;
  assert(txt.includes('/a') && txt.includes('/b') && txt.includes('Root conflict'), 'both roots + label');
});

// ─── graph Part B: same-server daemon resolution (daemon-free, mock health) ────
// The graph must ride the SAME daemon the mcp-memory backend targets. makeResolver mirrors
// mcp-client._connectHttp precedence: explicit serverUrl wins (health-checked, NO registry read);
// else discover via the configured runDir's daemon.json.
test('graph/daemon: makeResolver prefers explicit serverUrl (same server, no registry read)', async () => {
  // A runDir that announces a DIFFERENT url — it must be ignored when serverUrl is set.
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-graphres-'));
  fs.writeFileSync(path.join(otherDir, 'daemon.json'), JSON.stringify({ url: 'http://from-registry:9', port: 9 }));
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return { status: 200 }; };
  const info = await graphDaemon.makeResolver({ serverUrl: 'http://explicit:7', runDir: otherDir })({ fetchImpl });
  assertEq(info, { url: 'http://explicit:7' });
  assert(seen.length > 0 && seen.every((u) => u.startsWith('http://explicit:7/health')), 'health-checked the EXPLICIT url only');
  assert(seen.every((u) => !u.includes('from-registry')), 'the registry url was NOT consulted');
});
test('graph/daemon: makeResolver falls back to runDir daemon.json when no serverUrl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-graphres-'));
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ url: 'http://from-registry:9', port: 9 }));
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return { status: 200 }; };
  const info = await graphDaemon.makeResolver({ serverUrl: '', runDir: dir })({ fetchImpl });
  assert(info && info.url === 'http://from-registry:9', 'discovered from the configured runDir');
  assert(seen.some((u) => u.includes('from-registry')), 'health-checked the discovered registry url');
});

// ─── graph Part A: backend-mode dispatch gate (hermetic via _testHooks) ────────
// The graph lives INSIDE the memory (mcp-memory) server. With the default 'local' backend the
// graph-hosting daemon is opt-in and NOT the configured backend, so the tools must gate exactly
// like the remote KB tools: reach the daemon ONLY in mcp-memory mode, else an honest message with
// ZERO daemon contact. _testHooks.{peekMode,graph} keep these daemon-free.
async function loadBrainServerModule() {
  const urlMod = require('url');
  const R = process.env.CLAUDE_PLUGIN_ROOT;
  return import(urlMod.pathToFileURL(path.join(R, 'servers', 'brain-server', 'lib', 'mcp-server.js')).href);
}
test('graph/dispatch: local backend gates graph tools — honest message, ZERO daemon contact', async () => {
  const mod = await loadBrainServerModule();
  let discoverCalls = 0, fetchCalls = 0;
  const server = mod.createBrainServer({ pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, mode: 'stdio', _testHooks: {
    peekMode: () => 'local',
    graph: {
      discover: async () => { discoverCalls++; return { url: 'http://should-not-be-reached' }; },
      fetchImpl: async () => { fetchCalls++; return { status: 200, headers: { get: () => null }, json: async () => ({}) }; },
    },
  } });
  const out = await server.handleTool('graph_status', {});
  assert(!out.isError, 'not an error result');
  const txt = out.content[0].text;
  assert(txt.includes('"mcp-memory"') && txt.includes('"local"'), 'names the required backend + the current one');
  assertEq([discoverCalls, fetchCalls], [0, 0], 'no daemon discovery/fetch happened in local mode');
});
test('graph/dispatch: mcp-memory backend routes graph tools to the daemon path', async () => {
  graphClient.__clearCapCache();
  const mod = await loadBrainServerModule();
  const m = makeGraphFetch({ status: { status: 200, json: { project_id: 'github.com/acme/graphgate', root: '/r', state: 'ready', nodes: 5, edges: 4 } } });
  let discoverCalls = 0;
  const server = mod.createBrainServer({ pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, mode: 'stdio', _testHooks: {
    peekMode: () => 'mcp-memory',
    graph: { discover: async () => { discoverCalls++; return { url: 'http://graphgate' }; }, fetchImpl: m.fetchImpl },
  } });
  const out = await server.handleTool('graph_status', { root: ROOT });
  assert(!out.isError, 'not an error result');
  assert(out.content[0].text.includes('github.com/acme/graphgate'), 'daemon-derived project_id surfaced (reached the daemon)');
  assert(discoverCalls >= 1, 'the injected same-server resolver was consulted');
  assert(m.calls.some((c) => c.sub === 'status'), 'a /status call hit the daemon');
});
test('graph/dispatch: mcp-memory + unreachable daemon fails open (offline guidance, no throw)', async () => {
  const mod = await loadBrainServerModule();
  let discoverCalls = 0;
  const server = mod.createBrainServer({ pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, mode: 'stdio', _testHooks: {
    peekMode: () => 'mcp-memory',
    graph: {
      discover: async () => { discoverCalls++; return null; }, // daemon offline/absent
      fetchImpl: async () => { throw new Error('fetch must not run after a null discover'); },
    },
  } });
  const out = await server.handleTool('graph_status', {});
  assert(!out.isError, 'never throws to the host (fail-open)');
  assert(out.content[0].text.startsWith('🕸️ Graph unavailable'), 'normal offline guidance, not the gate message');
  assert(discoverCalls >= 1, 'the gate PASSED (mcp-memory) and reached the daemon resolver');
});

// ─── consolidate-datadirs (split-brain KB, Phase 2) ──────────────────────────
// The engine takes fully-injected deps, so these run hermetically: fake store /
// backend / fs / enumerator — no real singletons, no real filesystem, no model.
{
  const CONS = require('./consolidate-datadirs.js');
  const { consolidate } = CONS;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Fake brain-store scoped by project. Mirrors the exact contract the engine
  // relies on: getRaw (full entry, NO vector, NO access bump), listWithVectors
  // ({id,vector}), save(entry,vector) where vector===undefined KEEPS the prior
  // embedding (matches saveSqlite's `if (vector)` guard), init({project}).
  function makeFakeStore(initial = {}) {
    const data = {}; // project -> Map(id -> {entry, vector})
    for (const [proj, entries] of Object.entries(initial)) {
      const m = new Map();
      for (const e of entries) {
        const { vector = null, ...rest } = e;
        m.set(e.id, { entry: clone(rest), vector: vector ? clone(vector) : null });
      }
      data[proj] = m;
    }
    let cur = null;
    const saved = [];
    return {
      _data: data,
      _saved: saved,
      async init({ project }) { cur = project; if (!data[project]) data[project] = new Map(); },
      getRaw(id) { const m = data[cur]; return m && m.has(id) ? clone(m.get(id).entry) : null; },
      listWithVectors(project) {
        const m = data[project || cur];
        if (!m) return [];
        return [...m.values()].map(({ entry, vector }) => ({ id: entry.id, vector: vector ? clone(vector) : null, recurrence: entry.recurrence || 1 }));
      },
      async save(entry, vector) {
        const m = data[cur];
        const prev = m.get(entry.id);
        const vec = vector !== undefined ? (vector ? clone(vector) : null) : (prev ? prev.vector : null);
        m.set(entry.id, { entry: clone(entry), vector: vec });
        saved.push({ project: cur, id: entry.id, entry: clone(entry), passedVector: vector !== undefined });
      },
      getStorageType() { return 'sqlite'; },
      async close() {},
    };
  }

  function makeRecorder() {
    return { calls: [], async init(o) { this.calls.push(['init', o && o.project]); }, async index(e) { this.calls.push(['index', e.id]); }, async registerNode(e) { this.calls.push(['node', e.id]); } };
  }

  // Fake fs: an ORDERED op log plus a live set of "existing" paths, so the
  // injected enumerator can reflect deletions (true cross-run idempotency).
  // Also tracks file CONTENTS (a Map) so the process-apply-lock — which reads,
  // atomically writes (tmp+rename via writeJsonAtomic), and deletes a small JSON
  // file — works fully hermetically. readFileSync throws an ENOENT-coded error
  // for an absent path (so acquireLock treats "no file" as "no lock").
  function makeFakeFs(present) {
    const ops = [];
    const paths = new Set(present || []);
    const contents = new Map(); // path -> string content (lock payload)
    return {
      _ops: ops,
      _paths: paths,
      _contents: contents,
      mkdirSync(p) { ops.push(['mkdir', p]); paths.add(p); },
      cpSync(src, dst) { ops.push(['cp', src, dst]); paths.add(dst); },
      existsSync(p) { return paths.has(p); },
      rmSync(p) { ops.push(['rm', p]); paths.delete(p); contents.delete(p); },
      // Lock + atomic-write seam (readFileSync/writeFileSync/renameSync/unlinkSync):
      readFileSync(p) {
        if (!contents.has(p)) { const e = new Error(`ENOENT: no such file '${p}'`); e.code = 'ENOENT'; throw e; }
        return contents.get(p);
      },
      writeFileSync(p, data) { ops.push(['write', p]); paths.add(p); contents.set(p, String(data)); },
      renameSync(src, dst) {
        ops.push(['rename', src, dst]);
        paths.delete(src); paths.add(dst);
        if (contents.has(src)) { contents.set(dst, contents.get(src)); contents.delete(src); }
      },
      unlinkSync(p) { ops.push(['unlink', p]); paths.delete(p); contents.delete(p); },
    };
  }

  function makeFakeBackend() {
    let cur = null;
    const calls = [];
    return {
      _calls: calls,
      async init({ project }) { cur = project; calls.push(['init', project]); },
      async save(entry) { calls.push(['save', cur, entry.id]); return entry.id; },
      async close() {},
    };
  }

  function makeDeps(cfg) {
    const activeDir = cfg.activeDir || '/A/active';
    const siblingPaths = cfg.siblingPaths || [];
    const fsx = cfg.fs || makeFakeFs(new Set([activeDir, ...siblingPaths]));
    const store = cfg.store || makeFakeStore(cfg.storeInitial || {});
    const index = makeRecorder();
    const graph = makeRecorder();
    const consolidateCalls = [];
    const consolidateFn = cfg.consolidate
      || (async (o) => { consolidateCalls.push({ project: o.project, apply: o.apply, sameStore: o._store === store }); });
    const shards = cfg.shards || {};
    const readShard = cfg.readShard || ((dir, project) => (shards[dir] && shards[dir][project] ? shards[dir][project].map(clone) : []));
    const listProjects = cfg.listProjects || ((dir) => (shards[dir] ? Object.keys(shards[dir]) : []));
    const enumerate = cfg.enumerate || ((active) => {
      const out = [{ path: active, populated: true }];
      for (const p of siblingPaths) out.push({ path: p, populated: fsx._paths.has(p) });
      for (const c of (cfg.extraCandidates || [])) out.push(c);
      return out;
    });
    const _deps = {
      activeDir,
      mode: cfg.mode || 'local',
      store, index, graph, backend: cfg.backend,
      consolidate: consolidateFn,
      enumerate, readShard, listProjects,
      fsx, backupBase: cfg.backupBase || '/A/backups',
      now: cfg.now || (() => 1710000000000),
      // Apply-lock seams (undefined → resolveDeps falls back to real defaults).
      lockPath: cfg.lockPath,
      lockTtlMs: cfg.lockTtlMs,
      pidAlive: cfg.pidAlive,
    };
    return { _deps, activeDir, siblingPaths, store, index, graph, backend: cfg.backend, fsx, consolidateCalls };
  }

  test('consolidate-datadirs: no populated siblings → no-op (reason no-siblings, writes NOTHING)', async () => {
    const h = makeDeps({ siblingPaths: [], extraCandidates: [{ path: '/A/plugins/data/claude-code-boss', populated: false }] });
    const r = await consolidate({ apply: false, _deps: h._deps });
    assertEq(r.reason, 'no-siblings');
    assertEq(r.siblings.length, 0);
    assertEq(r.ok, true);
    assertEq(h.fsx._ops.length, 0);
    assertEq(h.store._saved.length, 0);
    assert(!r.backupDir, 'a no-op never backs up');
  });

  test('consolidate-datadirs: dry-run computes graft/reconcile plan and writes NOTHING', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local',
      shards: {
        [active]: { proj: [{ id: 'dup1' }] },
        [sib]: { proj: [{ id: 'dup1' }, { id: 'new1' }, { id: 'new2' }] },
      },
    });
    const r = await consolidate({ apply: false, _deps: h._deps });
    assertEq(r.apply, false);
    assertEq(r.siblings.length, 1);
    assertEq(r.siblings[0].grafted, 2);     // new1, new2 missing-in-active
    assertEq(r.siblings[0].reconciled, 1);  // dup1 collides
    assertEq(r.siblings[0].deleted, false);
    assertEq(h.fsx._ops.length, 0);          // no mkdir / cp / rm
    assertEq(h.store._saved.length, 0);      // no store writes
    assert(!r.backupDir, 'dry-run never backs up');
  });

  test('consolidate-datadirs: --apply local reconcile-by-id (newer base, recurrence=max, union tags, valid-embedding fallback)', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({
      proj: [
        { id: 'dup1', title: 'A-old', recurrence: 5, tags: ['a'], last_accessed: '2024-01-01T00:00:00Z', created_at: '2023-01-01T00:00:00Z', vector: [1, 1] },
        { id: 'dup2', title: 'A-new', recurrence: 3, tags: ['a2'], last_accessed: '2024-05-05T00:00:00Z', created_at: '2023-01-01T00:00:00Z', vector: [2, 2] },
        { id: 'dup3', title: 'A-x', recurrence: 4, tags: ['a3'], last_accessed: '2024-01-01T00:00:00Z', created_at: '2023-01-01T00:00:00Z', vector: [3, 3] },
      ],
    });
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store,
      shards: { [sib]: { proj: [
        { id: 'dup1', title: 'S-new', recurrence: 2, tags: ['b'], last_accessed: '2024-02-02T00:00:00Z', created_at: '2023-06-01T00:00:00Z', vector: [9, 9] },
        { id: 'dup2', title: 'S-old', recurrence: 9, tags: ['b2'], last_accessed: '2024-02-02T00:00:00Z', created_at: '2023-06-01T00:00:00Z', vector: [8, 8] },
        { id: 'dup3', title: 'S-new', recurrence: 1, tags: ['b3'], last_accessed: '2024-09-09T00:00:00Z', created_at: '2023-06-01T00:00:00Z', vector: [] },
      ] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    const g = (id) => store._data.proj.get(id);
    // dup1: incoming newer → base=incoming(title S-new); recurrence=max(5,2)=5; tags union ['a','b']; embedding=base [9,9]
    assertEq(g('dup1').entry.title, 'S-new');
    assertEq(g('dup1').entry.recurrence, 5);
    assertEq(g('dup1').entry.tags, ['a', 'b']);
    assertEq(g('dup1').vector, [9, 9]);
    // dup2: existing newer → base=existing(title A-new); recurrence=max(3,9)=9; embedding=existing [2,2]
    assertEq(g('dup2').entry.title, 'A-new');
    assertEq(g('dup2').entry.recurrence, 9);
    assertEq(g('dup2').entry.tags, ['a2', 'b2']);
    assertEq(g('dup2').vector, [2, 2]);
    // dup3: incoming newer BUT its embedding is [] (invalid) → keep the other side's valid [3,3]
    assertEq(g('dup3').entry.title, 'S-new');
    assertEq(g('dup3').vector, [3, 3]);
    assertEq(r.siblings[0].reconciled, 3);
    assertEq(r.siblings[0].grafted, 0);
    assert(h.index.calls.some((c) => c[0] === 'index' && c[1] === 'dup1'), 'search index kept consistent');
    assert(h.graph.calls.some((c) => c[0] === 'node' && c[1] === 'dup1'), 'graph kept consistent');
  });

  test('consolidate-datadirs: --apply local grafts missing ids, runs near-dup pass, backs up BEFORE delete, deletes on zero failures', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({ proj: [{ id: 'keep', tags: [], recurrence: 1 }] });
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store, backupBase: '/A/backups',
      shards: { [sib]: { proj: [{ id: 'g1', tags: ['x'], recurrence: 1, vector: [5, 5] }, { id: 'g2', tags: ['y'], recurrence: 1 }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    assertEq(r.siblings[0].grafted, 2);
    assertEq(r.siblings[0].failed, 0);
    assertEq(r.siblings[0].deleted, true);
    assert(store._data.proj.has('g1') && store._data.proj.has('g2'), 'both missing ids grafted');
    assertEq(store._data.proj.get('g1').vector, [5, 5]);
    assert(h.consolidateCalls.some((c) => c.project === 'proj' && c.apply === true && c.sameStore), 'near-dup pass called {project, apply:true, _store}');
    const ops = h.fsx._ops;
    const firstRm = ops.findIndex((o) => o[0] === 'rm');
    const lastCp = ops.map((o) => o[0]).lastIndexOf('cp');
    assert(ops.some((o) => o[0] === 'cp'), 'a backup copy happened');
    assert(firstRm === -1 || lastCp < firstRm, 'every backup cp precedes any delete rm');
    assert(ops.some((o) => o[0] === 'rm' && o[1] === sib), 'sibling deleted after a clean absorb');
    assert(r.backupDir && r.backupDir.indexOf('_boss-backup-') !== -1, 'backup dir is named + reported');
  });

  test('consolidate-datadirs: --apply keeps (does NOT delete) a sibling when any entry fails, but still backs it up', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({});
    const origSave = store.save.bind(store);
    store.save = async (entry, vector) => { if (entry.id === 'boom') throw new Error('simulated write failure'); return origSave(entry, vector); };
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store,
      shards: { [sib]: { proj: [{ id: 'ok1' }, { id: 'boom' }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);                       // per-sibling fail-open; the run itself stays ok
    assert(r.siblings[0].failed >= 1, 'the failing entry is counted');
    assertEq(r.siblings[0].deleted, false);     // fail-loud: NOT deleted
    const ops = h.fsx._ops;
    assert(ops.some((o) => o[0] === 'cp' && o[2].indexOf('sib1') !== -1), 'sibling WAS backed up');
    assert(!ops.some((o) => o[0] === 'rm' && o[1] === sib), 'sibling NOT deleted after a failure');
  });

  test('consolidate-datadirs: --apply mcp-memory pushes every entry idempotently (documentId=id) incl. active-local, deletes siblings, 2nd run no-op', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const backend = makeFakeBackend();
    const fsx = makeFakeFs(new Set([active, sib]));
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'mcp-memory', backend, fs: fsx,
      shards: {
        [active]: { proj: [{ id: 'local-a' }] },
        [sib]: { proj: [{ id: 's1' }, { id: 's2' }], __user__: [{ id: 'u1' }] },
      },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    assertEq(r.activeLocal.pushed, 1);                                   // active-folder leftover local writes pushed too
    assert(backend._calls.some((c) => c[0] === 'save' && c[2] === 'local-a'), 'active-local entry pushed');
    assert(['s1', 's2', 'u1'].every((id) => backend._calls.some((c) => c[2] === id)), 'all sibling entries pushed (project + __user__)');
    assertEq(r.siblings[0].pushed, 3);
    assertEq(r.siblings[0].deleted, true);
    // Idempotent: the sibling was rm-ed from the world → a second apply finds nothing.
    const r2 = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r2.reason, 'no-siblings');
    assertEq(r2.siblings.length, 0);
  });

  test('consolidate-datadirs: local mode keeps __user__ shard isolated from project shards', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({});
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store,
      shards: { [sib]: { proj: [{ id: 'p1' }], __user__: [{ id: 'u1' }] } },
    });
    await consolidate({ apply: true, _deps: h._deps });
    assert(store._data.proj && store._data.proj.has('p1'), 'project entry grafted under project shard');
    assert(store._data.__user__ && store._data.__user__.has('u1'), 'user entry grafted under __user__ shard');
    assert(!store._data.proj.has('u1'), 'user entry did NOT leak into project shard');
    assert(!(store._data.__user__ && store._data.__user__.has('p1')), 'project entry did NOT leak into __user__ shard');
  });

  test('consolidate-datadirs: never deletes the ACTIVE dir', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({});
    const h = makeDeps({ activeDir: active, siblingPaths: [sib], mode: 'local', store, shards: { [sib]: { proj: [{ id: 'x' }] } } });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assert(!h.fsx._ops.some((o) => o[0] === 'rm' && o[1] === active), 'active dir is never rm-ed');
    assert(h.fsx._paths.has(active), 'active dir still present after apply');
    assertEq(r.activeDir, active);
  });

  test('consolidate-datadirs: a failed backup ABORTS the apply before any absorb/delete (fail-loud)', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const store = makeFakeStore({});
    const fsx = makeFakeFs(new Set([active, sib]));
    fsx.cpSync = () => { throw new Error('disk full during backup'); };
    const h = makeDeps({ activeDir: active, siblingPaths: [sib], mode: 'local', store, fs: fsx, shards: { [sib]: { proj: [{ id: 'x' }] } } });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, false);
    assertEq(r.reason, 'backup-failed');
    assert(!fsx._ops.some((o) => o[0] === 'rm' && o[1] === sib), 'no SIBLING delete after a failed backup');
    assertEq(store._saved.length, 0, 'no absorb after a failed backup');
  });

  // ── apply lock (single-writer) ──────────────────────────────────────────────

  test('consolidate-datadirs: a FRESH live lock makes --apply a no-op (reason locked, writes NOTHING)', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const NOW = 1710000000000;
    const lockPath = '/A/active/.runtime/consolidate.lock';
    const store = makeFakeStore({});
    const fsx = makeFakeFs(new Set([active, sib, lockPath]));
    fsx._contents.set(lockPath, JSON.stringify({ pid: 4242, ts: NOW })); // held NOW by a live pid
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store, fs: fsx,
      lockPath, now: () => NOW, pidAlive: () => true,
      shards: { [sib]: { proj: [{ id: 'x' }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.reason, 'locked');
    assertEq(r.apply, true);
    assertEq(r.mode, 'local');
    assertEq(r.activeDir, active);
    assertEq(r.siblings.length, 0);
    assertEq(r.ok, true);
    assertEq(store._saved.length, 0, 'a locked run absorbs nothing');
    assert(!fsx._ops.some((o) => o[0] === 'cp'), 'a locked run backs up nothing');
    assert(!fsx._ops.some((o) => o[0] === 'rm'), 'a locked run deletes nothing (not even the lock it does not own)');
    assert(fsx._paths.has(lockPath), 'the existing lock is left untouched');
    assertEq(JSON.parse(fsx._contents.get(lockPath)).pid, 4242, 'the lock owner was not overwritten');
    assert(fsx._paths.has(sib), 'the sibling is left intact while locked');
  });

  test('consolidate-datadirs: a STALE (old-ts) lock is STOLEN, the apply proceeds, and the lock is RELEASED', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const NOW = 1710000000000; const TTL = 30 * 60 * 1000;
    const lockPath = '/A/active/.runtime/consolidate.lock';
    const store = makeFakeStore({});
    const fsx = makeFakeFs(new Set([active, sib, lockPath]));
    fsx._contents.set(lockPath, JSON.stringify({ pid: 4242, ts: NOW - (TTL + 60000) }));
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store, fs: fsx,
      lockPath, lockTtlMs: TTL, now: () => NOW, pidAlive: () => true, // alive, but ts is stale → still stolen
      shards: { [sib]: { proj: [{ id: 'x' }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    assert(r.reason !== 'locked', 'a stale lock does not block the apply');
    assertEq(r.siblings[0].deleted, true, 'apply proceeded past the stolen lock');
    assert(!fsx._paths.has(lockPath), 'the lock is released (file gone) after a successful apply');
  });

  test('consolidate-datadirs: a fresh-ts lock whose PID is DEAD is stolen (apply proceeds)', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const NOW = 1710000000000;
    const lockPath = '/A/active/.runtime/consolidate.lock';
    const store = makeFakeStore({});
    const fsx = makeFakeFs(new Set([active, sib, lockPath]));
    fsx._contents.set(lockPath, JSON.stringify({ pid: 4242, ts: NOW })); // fresh ts…
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store, fs: fsx,
      lockPath, now: () => NOW, pidAlive: () => false, // …but the owner is gone → stolen
      shards: { [sib]: { proj: [{ id: 'x' }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    assertEq(r.siblings[0].deleted, true, 'apply proceeded past the dead-pid lock');
    assert(!fsx._paths.has(lockPath), 'the lock is released afterward');
  });

  test('consolidate-datadirs: dry-run NEVER creates or checks the apply lock', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const lockPath = '/A/active/.runtime/consolidate.lock';
    const fsx = makeFakeFs(new Set([active, sib]));
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', fs: fsx, lockPath,
      shards: { [active]: { proj: [{ id: 'dup1' }] }, [sib]: { proj: [{ id: 'dup1' }, { id: 'new1' }] } },
    });
    const r = await consolidate({ apply: false, _deps: h._deps });
    assertEq(r.apply, false);
    assertEq(fsx._ops.length, 0, 'dry-run performs zero fs ops (no lock write)');
    assert(!fsx._paths.has(lockPath), 'dry-run never creates the lock file');
  });

  test('consolidate-datadirs: --apply with no prior lock acquires then RELEASES it (published tmp→lock, gone after)', async () => {
    const active = '/A/active'; const sib = '/A/sib1';
    const lockPath = '/A/active/.runtime/consolidate.lock';
    const store = makeFakeStore({});
    const fsx = makeFakeFs(new Set([active, sib]));
    const h = makeDeps({
      activeDir: active, siblingPaths: [sib], mode: 'local', store, fs: fsx, lockPath,
      shards: { [sib]: { proj: [{ id: 'x' }] } },
    });
    const r = await consolidate({ apply: true, _deps: h._deps });
    assertEq(r.ok, true);
    assertEq(r.siblings[0].deleted, true);
    assert(fsx._ops.some((o) => o[0] === 'rename' && o[2] === lockPath), 'the lock payload was atomically published (tmp→lock) while held');
    assert(!fsx._paths.has(lockPath), 'the lock file is gone after a successful apply');
  });

  test('consolidate-datadirs helpers: unionArrays / recencyKey / toRecurrence / validVec / backupStamp', () => {
    const t = CONS._test;
    assertEq(t.unionArrays(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    assertEq(t.unionArrays(null, ['x']), ['x']);
    assert(t.recencyKey({ last_accessed: '2024-02' }) > t.recencyKey({ last_accessed: '2024-01' }), 'last_accessed drives recency');
    assertEq(t.recencyKey({ created_at: '2020' }), '2020'); // falls back to created_at when no last_accessed
    assertEq(t.toRecurrence('7'), 7);
    assertEq(t.toRecurrence(0), 1);
    assertEq(t.validVec([1]), true);
    assertEq(t.validVec([]), false);
    const stamp = t.backupStamp(1710000000000);
    assert(/^\d{4}-\d{2}-\d{2}T/.test(stamp) && stamp.indexOf(':') === -1, 'backup stamp is ISO-ish and filename-safe (no colons)');
  });
}

// ─── consolidate-datadirs-hook (silent SessionStart auto-apply, Phase 3) ──────
// The hook does a cheap fs-only sibling check and, when a populated sibling
// exists, detach-spawns the engine's guarded `--apply`. All seams (dataDir,
// enumerator, spawn, fs) are injected so these run hermetically — no real spawn,
// no real data dir, no SessionStart side effects.
{
  const HOOK = require('./consolidate-datadirs-hook.js');

  test('consolidate-datadirs-hook: no populated sibling → run() spawns NOTHING (steady-state no-op)', () => {
    let spawnCalls = 0; let fsTouches = 0;
    const res = HOOK.run({
      dataDir: () => '/A/active',
      enumerate: () => [
        { path: '/A/active', populated: true },
        { path: '/A/plugins/data/claude-code-boss', populated: false }, // a sibling, but EMPTY
      ],
      spawn: () => { spawnCalls++; return { unref() {} }; },
      fsx: { mkdirSync() { fsTouches++; }, openSync() { fsTouches++; return 7; }, closeSync() {} },
      enginePath: '/eng/consolidate-datadirs.js', execPath: '/bin/node',
    });
    assertEq(res.spawned, false);
    assertEq(res.reason, 'no-siblings');
    assertEq(spawnCalls, 0, 'no child spawned in steady state');
    assertEq(fsTouches, 0, 'no log fd opened in steady state (never even touches the fs)');
  });

  test('consolidate-datadirs-hook: a populated sibling → run() detach-spawns engine --apply (unref) and returns spawned', () => {
    let spawnArgs = null; let unrefed = false; let closedFd = null; const LOGFD = 7;
    const res = HOOK.run({
      dataDir: () => '/A/active',
      enumerate: () => [
        { path: '/A/active', populated: true },
        { path: '/A/other/claude-code-boss', populated: true }, // a POPULATED sibling ≠ active
      ],
      spawn: (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return { unref() { unrefed = true; } }; },
      fsx: { mkdirSync() {}, openSync() { return LOGFD; }, closeSync(fd) { closedFd = fd; } },
      enginePath: '/eng/consolidate-datadirs.js', execPath: '/bin/node',
    });
    assertEq(res.spawned, true);
    assertEq(res.reason, 'spawned');
    assert(spawnArgs, 'spawn was invoked');
    assertEq(spawnArgs.cmd, '/bin/node');
    assertEq(spawnArgs.args, ['/eng/consolidate-datadirs.js', '--apply']);
    assertEq(spawnArgs.opts.detached, true);
    assertEq(spawnArgs.opts.windowsHide, true);
    assertEq(spawnArgs.opts.stdio[0], 'ignore');
    assertEq(spawnArgs.opts.stdio[1], LOGFD);
    assertEq(spawnArgs.opts.stdio[2], LOGFD);
    assert(unrefed, "the child was unref'd so it never blocks SessionStart");
    assertEq(closedFd, LOGFD, 'the parent closed its own copy of the log fd');
  });

  test('consolidate-datadirs-hook: run() is fail-open — an enumerator throw never escapes (spawns nothing)', () => {
    let spawnCalls = 0;
    const res = HOOK.run({
      dataDir: () => '/A/active',
      enumerate: () => { throw new Error('scan blew up'); },
      spawn: () => { spawnCalls++; return { unref() {} }; },
    });
    assertEq(res.spawned, false);
    assertEq(res.reason, 'error');
    assertEq(spawnCalls, 0, 'a crash never spawns');
  });

  test('consolidate-datadirs-hook: a log-open failure falls back to stdio ignore (still spawns detached)', () => {
    let spawnArgs = null;
    const res = HOOK.run({
      dataDir: () => '/A/active',
      enumerate: () => [{ path: '/A/active', populated: true }, { path: '/A/other/claude-code-boss', populated: true }],
      spawn: (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return { unref() {} }; },
      fsx: { mkdirSync() { throw new Error('read-only fs'); }, openSync() { throw new Error('nope'); }, closeSync() {} },
      enginePath: '/eng/consolidate-datadirs.js', execPath: '/bin/node',
    });
    assertEq(res.spawned, true, 'a log-open failure never blocks the merge');
    assertEq(spawnArgs.opts.stdio, 'ignore', 'falls back to stdio ignore when the log fd cannot be opened');
  });

  test('hooks.json: SessionStart registers the silent consolidate-datadirs-hook (command node, timeout 10)', () => {
    const hooksPath = path.join(__dirname, '..', 'hooks', 'hooks.json');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const ss = parsed.hooks.SessionStart;
    assert(Array.isArray(ss) && ss.length >= 1, 'SessionStart is a non-empty array');
    const entries = ss[0].hooks;
    assert(Array.isArray(entries), 'SessionStart[0].hooks is an array');
    const entry = entries.find(
      (e) => e && Array.isArray(e.args) && e.args.some((a) => typeof a === 'string' && a.indexOf('consolidate-datadirs-hook.js') !== -1),
    );
    assert(entry, 'the consolidate-datadirs-hook.js SessionStart entry is present');
    assertEq(entry.type, 'command');
    assertEq(entry.command, 'node');
    assertEq(entry.timeout, 10);
  });
}

test('brain-backend mcp: saveMcp pins documentId = entry.id so re-pushes UPSERT (idempotency)', async () => {
  const daemon = await startFakeDaemon();
  delete require.cache[require.resolve('./brain-backend.js')];
  const backend = require('./brain-backend.js');
  backend.__testHooks._injectConfig({ backend: { type: 'mcp-memory', mcpMemory: { transport: 'http', serverUrl: daemon.url } } });
  try {
    await backend.init({ project: 'projDoc' });
    const id = await backend.save({ id: 'fixed-42', title: 't', summary: 's', content: { detail: 'd' }, type: 'lesson' });
    assertEq(daemon.seen.callArgs.name, 'add_document');
    assertEq(daemon.seen.callArgs.arguments.documentId, 'fixed-42');
    assertEq(id, 'fixed-42');
    await backend.close();
  } finally {
    delete require.cache[require.resolve('./brain-backend.js')];
    await daemon.close();
  }
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  await Promise.all(PENDING);

  const passed = RESULTS.filter(r => r.ok).length;
  const failed = RESULTS.filter(r => !r.ok);

  console.log(`\n🔬 Unit tests — ${RESULTS.length} ran\n${'─'.repeat(60)}`);
  for (const r of RESULTS) {
    if (r.ok) console.log(`  ✓ ${r.name}`);
    else {
      console.log(`  ✗ ${r.name}`);
      console.log(`      ${r.err.split('\n')[0]}`);
    }
  }
  console.log('─'.repeat(60));
  console.log(`Results: ${passed} passed  ${failed.length} failed\n`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
