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
  assertEq(r.correctionDetect.enabled, false);
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
// CLAUDE_PLUGIN_DATA is repointed at the same temp dir so a stray real user
// override (DATA_DIR/hooks/user-config.json) never leaks into these assertions.
function withHooksConfigFile(obj, fn) {
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hcfg-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'hooks-config.json'), JSON.stringify(obj));
  process.env.CLAUDE_PLUGIN_ROOT = dir;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  delete require.cache[require.resolve('./lib/hooks-config.js')];
  const hc = require('./lib/hooks-config.js');
  try { return fn(hc); }
  finally {
    process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
    if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedData;
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
    assertEq(hc.getCorrectionDetect().enabled, false);
    assertEq(hc.getDecisionScan().enabled, false);
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

test('hooks-config: DATA_DIR user-config overrides shipped profile (update-safe)', () => {
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hcfg-ovr-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  // shipped says standard...
  fs.writeFileSync(path.join(dir, 'config', 'hooks-config.json'), JSON.stringify({ profile: 'standard' }));
  // ...DATA_DIR user-config says dev → user wins, survives shipped updates.
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'user-config.json'), JSON.stringify({ profile: 'dev' }));
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

test('hooks-config: saveProfile writes DATA_DIR override; invalid name throws', () => {
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
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'OK:' + (msg.params && msg.params.name) }] } }));
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

// ─── metrics (Plan #5) ───────────────────────────────────────────────────────

test('metrics: recordMetric inserts + getMetricsSummary aggregates', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-'));
  const isolated = require('./brain-store.js');
  try {
    await isolated.init({ project: 'ccb-units-metrics' });
    if (isolated.getStorageType() !== 'sqlite') {
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
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics: recordMetric rejects invalid event names', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-bad-'));
  const isolated = require('./brain-store.js');
  try {
    await isolated.init({ project: 'ccb-units-metrics-bad' });
    if (isolated.getStorageType() !== 'sqlite') return;
    assertEq(isolated.recordMetric('', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('UPPER.case', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('1starts.with.digit', {}, 'sid'), 0);
    assertEq(isolated.recordMetric('has spaces', {}, 'sid'), 0);
    assert(isolated.recordMetric('valid.name_ok-1', {}, 'sid') > 0, 'valid name accepted');
  } finally {
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics: getEventLogIsolated reads another project\'s DB without touching the singleton', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-iso-'));
  const isolated = require('./brain-store.js');
  try {
    // Write a metric into '__user__' project's own DB.
    await isolated.init({ project: '__user__' });
    if (isolated.getStorageType() !== 'sqlite') return;
    isolated.recordMetric('lesson.captured', { type: 'research' }, null);
    await isolated.close();

    // Re-init the SAME module instance to a DIFFERENT project — this is what
    // a Stop detector's store.init({project: currentProject}) leaves in
    // place. (No require-cache dance: STORE_DIR is read once at require time
    // from CLAUDE_PLUGIN_DATA, so re-requiring under a concurrently-mutated
    // env var — other tests run interleaved via Promise.all — would race;
    // reusing the instance and switching _project via init() does not.)
    await isolated.init({ project: 'other-proj' });
    if (isolated.getStorageType() !== 'sqlite') return;

    // The singleton's own getEventLog must NOT see the __user__ event.
    assertEq(isolated.getEventLog({ eventName: 'lesson.captured', limit: 50 }).length, 0);

    // getEventLogIsolated reads the __user__ DB directly, singleton untouched.
    const rows = isolated.getEventLogIsolated('__user__', { eventName: 'lesson.captured', limit: 50 });
    assertEq(rows.length, 1);
    assertEq(rows[0].payload.type, 'research');
    assertEq(isolated.getStatus().project, 'other-proj', 'singleton project unchanged by isolated read');
  } finally {
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics: getEventLog filters + caps to 500', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-log-'));
  const isolated = require('./brain-store.js');
  try {
    await isolated.init({ project: 'ccb-units-metrics-log' });
    if (isolated.getStorageType() !== 'sqlite') return;
    for (let i = 0; i < 5; i++) isolated.recordMetric('retrieve.fired', { i }, 'sid');
    for (let i = 0; i < 3; i++) isolated.recordMetric('failure.retro.fired', { i }, 'sid');
    const all = isolated.getEventLog({ limit: 50 });
    assertEq(all.length, 8);
    const filtered = isolated.getEventLog({ eventName: 'retrieve.fired', limit: 50 });
    assertEq(filtered.length, 5);
    const capped = isolated.getEventLog({ limit: 99999 });
    assert(capped.length <= 500, `cap applied, got ${capped.length}`);
  } finally {
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
});

test('metrics: cleanupMetrics deletes rows older than cutoff', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-metrics-cleanup-'));
  const isolated = require('./brain-store.js');
  try {
    await isolated.init({ project: 'ccb-units-metrics-cleanup' });
    if (isolated.getStorageType() !== 'sqlite') return;
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
    try { await isolated.close(); } catch { /* ignore */ }
    delete require.cache[require.resolve('./brain-store.js')];
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
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-xscope-'));
  // research-followup is dev-only now; force dev so run() actually exercises suppression.
  fs.mkdirSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'hooks', 'user-config.json'), JSON.stringify({ profile: 'dev' }));
  hooksConfig._resetCache();
  const isolatedStore = require('./brain-store.js');
  delete require.cache[require.resolve('./research-followup-detect.js')];
  const rf = require('./research-followup-detect.js');
  try {
    const currentProject = 'rf-xscope-proj';

    // 1) active-research-detect fires a nudge in the CURRENT project.
    await isolatedStore.init({ project: currentProject, skipEmbedder: true });
    if (isolatedStore.getStorageType() !== 'sqlite') return;
    isolatedStore.recordMetric('nudge.emitted', { kind: 'research', signals: ['libMention'] }, 'sid-1');

    // 2) capture_lesson({type:'research'}) admits — MCP handler writes into
    //    __user__ (mirrors mcp-server.js's storageProject switch + restore).
    await isolatedStore.close();
    await isolatedStore.init({ project: '__user__', skipEmbedder: true });
    isolatedStore.recordMetric('lesson.captured', { type: 'research', decision: 'admit', scope: 'user' }, null);
    await isolatedStore.close();
    await isolatedStore.init({ project: currentProject, skipEmbedder: true });

    // 3) Stop hook runs for this session/project.
    const result = await rf.run({ session_id: 'sid-1', cwd: `/fake/${currentProject}` });
    assertEq(result.block, undefined, `expected no block, got: ${JSON.stringify(result)}`);

    await isolatedStore.close();
  } finally {
    delete require.cache[require.resolve('./brain-store.js')];
    delete require.cache[require.resolve('./research-followup-detect.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
    hooksConfig._resetCache();
  }
});

test('research-followup.run: no capture at all still nudges (regression guard)', async () => {
  delete require.cache[require.resolve('./brain-store.js')];
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-rf-nocap-'));
  // research-followup is dev-only now; force dev so run() emits the nudge.
  fs.mkdirSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'hooks', 'user-config.json'), JSON.stringify({ profile: 'dev' }));
  hooksConfig._resetCache();
  const isolatedStore = require('./brain-store.js');
  delete require.cache[require.resolve('./research-followup-detect.js')];
  const rf = require('./research-followup-detect.js');
  try {
    const currentProject = 'rf-nocap-proj';
    await isolatedStore.init({ project: currentProject, skipEmbedder: true });
    if (isolatedStore.getStorageType() !== 'sqlite') return;
    isolatedStore.recordMetric('nudge.emitted', { kind: 'research', signals: ['libMention'] }, 'sid-2');

    const result = await rf.run({ session_id: 'sid-2', cwd: `/fake/${currentProject}` });
    assertEq(result.block, true, 'nudge should still fire with no capture at all');

    await isolatedStore.close();
  } finally {
    delete require.cache[require.resolve('./brain-store.js')];
    delete require.cache[require.resolve('./research-followup-detect.js')];
    process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
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

test('retrieve-core: short prompt pre-filters (no embedder)', async () => {
  const r = await retrieveCore.retrieve('oi', { project: 'ccb-nonexistent-test' });
  assertEq(r.reason, 'short');
  assertEq(r.entries.length, 0);
});

// ─── brain-config: contextExcludeTypes + DATA_DIR user-override deep-merge ────
const brainConfig = require('./lib/brain-config.js');

// Run `fn` with a temp DATA_DIR user-override (brain/user-config.json = `obj`).
// `obj === undefined` writes no override (exercises the "absent" path). Restores
// CLAUDE_PLUGIN_DATA + the brain-config cache afterwards no matter what.
function withUserConfig(obj, fn) {
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-usercfg-'));
  if (obj !== undefined) {
    fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'brain', 'user-config.json'), JSON.stringify(obj));
  }
  process.env.CLAUDE_PLUGIN_DATA = dir;
  brainConfig._resetCache();
  try {
    return fn();
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = saved;
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

test('conversation-ingest.buildConversationEntry: both sides empty → null', () => {
  assertEq(convIngest.buildConversationEntry('', '', {}), null);
  assertEq(convIngest.buildConversationEntry('   ', null, {}), null);
});

test('conversation-ingest.buildConversationEntry: carries both sides + conversation type', () => {
  const e = convIngest.buildConversationEntry('como faz X?', 'faz assim Y', { project: 'proj', sid: 's1' });
  assertEq(e.type, 'conversation');
  assert(e.title.startsWith('Conversa: como faz X?'), `title from first user line, got ${e.title}`);
  assert(e.content.detail.includes('## Usuário'), 'detail has user section');
  assert(e.content.detail.includes('## Assistente'), 'detail has assistant section');
  assertEq(e.session_id, 's1');
  assertEq(e.source.project, 'proj');
});

test('conversation-ingest.buildConversationEntry: truncates oversize content', () => {
  const big = 'x'.repeat(20000);
  const e = convIngest.buildConversationEntry(big, big, {});
  assert(e.content.detail.includes('…[truncated]'), 'clips oversize content');
  assert(e.content.detail.length < 2 * 20000, 'shorter than the raw concatenation');
});

test('conversation-ingest.turnKey: stable for same content, differs by content', () => {
  assertEq(convIngest.turnKey('s', 'a', 'b'), convIngest.turnKey('s', 'a', 'b'));
  assert(convIngest.turnKey('s', 'a', 'b') !== convIngest.turnKey('s', 'a', 'c'), 'content change → new key');
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
  const fakeStore = {
    init: async ({ project }) => { inited = project; },
    getStorageType: () => 'sqlite',
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
  const first = await sessionSummary.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { dataDir: dir, store: fakeStore });
  assertEq(first.block, true);
  assert(first.reason.includes('Captured 3 lesson'), 'counts 2 project + 1 user-scoped in-session lessons');
  // Cap: second call returns {} (counter written).
  const second = await sessionSummary.run({ hook_event_name: 'Stop', session_id: sid, cwd }, { dataDir: dir, store: fakeStore });
  assertEq(Object.keys(second).length, 0);
});

test('session-summary.run: missing start stamp → counts nothing (no all-time report)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ss-nostamp-'));
  fs.mkdirSync(path.join(dir, '.runtime'), { recursive: true });
  const fakeStore = {
    init: async () => {}, getStorageType: () => 'sqlite',
    // Old lessons exist, but with no stamp sinceTs=now → none counted.
    getEventLog: () => ([{ eventName: 'lesson.captured', ts: Date.now() - 999999, project: 'p' }]),
  };
  const r = await sessionSummary.run({ hook_event_name: 'Stop', session_id: 'nostamp', cwd: path.join(os.tmpdir(), 'p') }, { dataDir: dir, store: fakeStore });
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

test('stop-dispatcher.DETECTORS: 15 detectors, ordering invariants hold', () => {
  const names = dispatcher.DETECTORS.map(d => d.name);
  assertEq(names.length, 15);
  assert(names.includes('verify-nudge'), 'verify-nudge (D2) registered');
  assert(names.includes('self-review'), 'self-review (D1) registered');
  assert(names.includes('session-summary'), 'session-summary (U2) registered');
  assert(names.includes('conversation-ingest'), 'conversation-ingest (GAP1) registered');
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
