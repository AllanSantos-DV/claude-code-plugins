#!/usr/bin/env node
/**
 * verify-nudge.js — Stop detector (D2, self-review): "you edited files but ran
 * no test/verify command this turn".
 *
 * Reads the per-turn verify-journal (populated by file-edit-detect.js for edits
 * and by curation-detect.js for Bash command signatures), and if the turn had
 * file edits but no test-like command, injects a single advisory. It's a NUDGE,
 * not a gate: a per-session counter caps total nudges (default 1, like
 * auto-continue-stop) and there is NO escalation.
 *
 * Heuristic (deliberately loose — advisory only): a command "counts as verify"
 * when its canonical signature or matched curated-shell id/script contains a
 * test/verify token (test, spec, vitest, pytest, gate, lint, tsc, …), extendable
 * via `hooksConfig.verifyNudge.testPatterns`.
 *
 * Pure helpers (buildTestRegex / isVerifyCommand / evaluate) are exported for
 * unit tests; the detector clears the journal every turn (turn boundary).
 */
'use strict';

const fs = require('fs');
const { writeJsonAtomic } = require('./lib/atomic-write.js');
const path = require('path');

const verifyJournal = require('./lib/verify-journal.js');
const hooksCfg = require('./lib/hooks-config.js');
const metrics = require('./lib/metrics.js');

// Word-boundary tokens that mark a command as a test/verify run. Compound tool
// names (vitest, pytest) are listed explicitly so `\btest\b` tightness doesn't
// miss them, while `\b…\b` avoids false hits like `latest` / `investigate`.
const DEFAULT_TOKENS = [
  'test', 'tests', 'spec', 'specs', 'vitest', 'jest', 'pytest', 'mocha',
  'rspec', 'phpunit', 'tox', 'gate', 'check', 'lint', 'eslint', 'tsc',
  'typecheck', 'mypy', 'ruff', 'pyright',
];

/**
 * Build the test/verify matcher from defaults + config extras. Extras are
 * treated as LITERAL tokens/phrases (regex metachars escaped) so a bad config
 * value can never throw or match unexpectedly.
 * @param {string[]} [extra]
 * @returns {RegExp}
 */
function buildTestRegex(extra = []) {
  const toks = [...DEFAULT_TOKENS, ...(Array.isArray(extra) ? extra : [])]
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${toks.join('|')})\\b`, 'i');
}

/**
 * Does a journal `cmd` entry look like a test/verify command?
 * @param {object} entry
 * @param {RegExp} re
 * @returns {boolean}
 */
function isVerifyCommand(entry, re) {
  if (!entry || entry.kind !== 'cmd') return false;
  const hay = `${entry.sig || ''} ${entry.curated || ''}`;
  return re.test(hay);
}

/**
 * Summarize a turn's journal: edit count, whether any verify command ran, and
 * the resulting nudge decision. Pure.
 * @param {object[]} entries
 * @param {RegExp} re
 * @returns {{edits:number, ranVerify:boolean, shouldNudge:boolean}}
 */
function evaluate(entries, re) {
  let edits = 0;
  let ranVerify = false;
  for (const e of entries || []) {
    if (!e) continue;
    if (e.kind === 'edit') edits++;
    else if (e.kind === 'cmd' && isVerifyCommand(e, re)) ranVerify = true;
  }
  return { edits, ranVerify, shouldNudge: edits > 0 && !ranVerify };
}

function buildReason(edits) {
  const s = edits === 1 ? '' : 's';
  return `[verify] ${edits} file${s} edited but no test/verify command ran this turn. `
    + `Run the project's tests (or a focused check) before delivering — or say why verification isn't applicable.`;
}

// ── Per-session counter cap (mirrors auto-continue-stop) ──────────────────────

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function counterPath(dir, sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(dir, '.runtime', `verify-nudge-${safe}.json`);
}

function readCounter(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { /* absent/corrupt: start at zero */ return { count: 0 }; }
}

function writeCounter(file, n) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { count: n });
  } catch (err) { console.error(`[verify-nudge] counter write failed: ${err.message}`); }
}

async function run(event) {
  const ev = event || {};
  const sid = ev.session_id || ev.sessionId || 'default';

  // Turn boundary: ALWAYS drain the per-turn verify-journal — even when this
  // detector is disabled (standard profile) or on a Stop retry. file-edit-detect
  // + curation-detect keep writing to it every turn, so if verify-nudge (the
  // designated clearer) skipped the clear when off, the journal would grow
  // unbounded. self-review (ordered before this detector) already read it.
  const entries = verifyJournal.readEntries(sid);
  verifyJournal.clearEntries(sid);

  const cfg = hooksCfg.getVerifyNudge();
  if (!cfg.enabled) return {};

  // Anti-loop: on a Stop retry the fresh-turn evaluation already happened.
  if (ev.stop_hook_active) return {};

  const summary = evaluate(entries, buildTestRegex(cfg.testPatterns));
  if (!summary.shouldNudge) return {};

  // Session cap: counter, no escalation (it's a nudge, not a gate).
  const cFile = counterPath(dataDir(), sid);
  const cur = readCounter(cFile);
  if (cur.count >= cfg.maxBlocks) return {};
  writeCounter(cFile, cur.count + 1);

  metrics.fire('nudge.emitted', { kind: 'verify', edits: summary.edits }, { sessionId: sid, cwd: ev.cwd });
  return { block: true, reason: buildReason(summary.edits) };
}

if (require.main === module) {
  const { runStopDetectorCli } = require('./lib/hook-io.js');
  runStopDetectorCli(run, 'verify-nudge');
}

module.exports = {
  run,
  buildTestRegex,
  isVerifyCommand,
  evaluate,
  buildReason,
  counterPath,
  readCounter,
  writeCounter,
  DEFAULT_TOKENS,
};
