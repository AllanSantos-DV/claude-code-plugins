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
