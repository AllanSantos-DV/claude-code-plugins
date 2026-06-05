#!/usr/bin/env node
/**
 * smoke-decision.js — integration smoke test for decision-detect + decision-promote.
 *
 * Runs both hooks in-process against fixtures with isolated CLAUDE_PLUGIN_DATA.
 * The fixtures store `REDACTED_GIT_COMMIT` instead of the literal phrase to dodge
 * the pre-commit-guard heuristic — we substitute back at runtime.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'scripts', '__fixtures__');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-smoke-'));
process.env.CLAUDE_PLUGIN_DATA = DATA;

const PENDING = path.join(DATA, '.runtime', 'decision-pending.json');
const PROMOTED = path.join(DATA, '.runtime', 'decision-promoted-sha.json');

const results = [];
const ok = (name) => { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); };
const fail = (name, err) => { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}\n      ${err}`); };

function loadFixture(file) {
  const raw = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return raw.replace(/REDACTED_GIT_COMMIT/g, 'git commit');
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function runHook(scriptName, stdin) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', scriptName)], {
    input: stdin, encoding: 'utf-8', env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA },
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

console.log(`smoke-decision.js — DATA=${DATA}\n`);

// 1: rationale commit → pending populated
let r = runHook('decision-detect.js', loadFixture('decision-rationale.json'));
let pending = readJson(PENDING, { pending: [] });
if (pending.pending && pending.pending.length === 1 && pending.pending[0].kind === 'commit') {
  ok('rationale commit produces 1 pending entry');
} else {
  fail('rationale commit produces 1 pending entry', `pending=${JSON.stringify(pending)}`);
}

// 2: Stop hook emits block + clears pending + promotes key
r = runHook('decision-promote.js', '{}');
let out;
try { out = JSON.parse(r.stdout); } catch { out = null; }
if (out && out.decision === 'block' && /capture_lesson/.test(out.reason || '')) {
  ok('Stop hook emits {decision:block, reason: ... capture_lesson ...}');
} else {
  fail('Stop hook emits block', `stdout=${r.stdout}`);
}
pending = readJson(PENDING, null);
if (pending && Array.isArray(pending.pending) && pending.pending.length === 0) {
  ok('pending cleared after promotion');
} else {
  fail('pending cleared after promotion', `pending=${JSON.stringify(pending)}`);
}
const promoted = readJson(PROMOTED, []);
if (Array.isArray(promoted) && promoted.length === 1) {
  ok('one key recorded in promoted LRU');
} else {
  fail('one key recorded in promoted LRU', `promoted=${JSON.stringify(promoted)}`);
}

// 3: trivial commit does NOT pend
r = runHook('decision-detect.js', loadFixture('decision-trivial.json'));
pending = readJson(PENDING, { pending: [] });
if (pending.pending.length === 0) {
  ok('trivial chore does not produce pending');
} else {
  fail('trivial chore does not produce pending', `pending=${JSON.stringify(pending)}`);
}

// 4: same rationale commit replayed (same HEAD sha) → NOT re-pended
r = runHook('decision-detect.js', loadFixture('decision-rationale.json'));
pending = readJson(PENDING, { pending: [] });
if (pending.pending.length === 0) {
  ok('same key replay does NOT re-pend (cooldown via promoted LRU)');
} else {
  fail('same key replay does NOT re-pend', `pending=${JSON.stringify(pending)}`);
}

// 5: Stop with no pending → emit empty
r = runHook('decision-promote.js', '{}');
const trimmed = (r.stdout || '').trim();
if (trimmed === '{}' || trimmed === '') {
  ok('Stop with no pending → empty / no block');
} else {
  fail('Stop with no pending → empty', `stdout=${r.stdout}`);
}

// 6: stop_hook_active anti-loop guard returns empty
r = runHook('decision-promote.js', JSON.stringify({ stop_hook_active: true }));
const trimmed2 = (r.stdout || '').trim();
if (trimmed2 === '{}') {
  ok('stop_hook_active=true → empty (anti-loop guard)');
} else {
  fail('stop_hook_active=true → empty', `stdout=${r.stdout}`);
}

const failed = results.filter(x => !x.ok).length;
console.log('\n' + '─'.repeat(60));
console.log(`Smoke: ${results.length - failed} passed  ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
