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
const { classify, CURATED_SUCCESS_MAX_CHARS, CURATED_SUCCESS_MAX_LINES } = require('./curation-classifier.js');
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

test('scope: splitTopK splits topK by ratio with sensible floors', () => {
  const { splitTopK } = require('./lib/scope-search.js');
  // Default ratio 0.6
  let s = splitTopK(5, 0.6);
  assertEq(s.projectK, 3);
  assertEq(s.userK, 2);
  s = splitTopK(10, 0.6);
  assertEq(s.projectK, 6);
  assertEq(s.userK, 4);
  // All project
  s = splitTopK(5, 1);
  assertEq(s.projectK, 5);
  assertEq(s.userK, 0);
  // All user (project floors to 1)
  s = splitTopK(5, 0);
  assertEq(s.projectK, 1);
  assertEq(s.userK, 4);
  // Edge: topK=1 → projectK=1, userK=0
  s = splitTopK(1, 0.6);
  assertEq(s.projectK, 1);
  assertEq(s.userK, 0);
  // Invalid ratio → clamped to [0,1], default fallback
  s = splitTopK(5);
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
