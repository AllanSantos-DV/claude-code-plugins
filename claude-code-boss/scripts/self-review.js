#!/usr/bin/env node
/**
 * self-review.js — Stop detector (D1, self-review fed by memory).
 *
 * When the turn edited files, look up past lessons/failures relevant to those
 * files and, if any clear the score gate, inject a short advisory so the agent
 * re-checks its work against mistakes it already recorded:
 *
 *   [SELF-REVIEW] Files edited this turn resemble past lessons — verify before
 *   delivering:
 *     • "<title>" (recurrence N) [lesson]
 *
 * HARD CONSTRAINT: never load the embedding model in this hook. Retrieval goes
 * through lib/self-review-retrieve.js — warm HTTP daemon first (model already
 * loaded there), keyword inverted-index fallback otherwise.
 *
 * The edited-file signal is read from the per-turn verify-journal (written by
 * file-edit-detect.js). This detector only READS it; verify-nudge (ordered after
 * this one in the dispatcher) owns the turn-boundary clear. A per-session
 * "surfaced" set prevents re-nagging the same lesson across turns.
 */
'use strict';

const fs = require('fs');
const { writeJsonAtomic } = require('./lib/atomic-write.js');
const path = require('path');

const verifyJournal = require('./lib/verify-journal.js');
const retrievalJournal = require('./lib/retrieval-journal.js');
const hooksCfg = require('./lib/hooks-config.js');
const selfReviewRetrieve = require('./lib/self-review-retrieve.js');
const { extractKeywords } = require('./lib/text-utils.js');
const metrics = require('./lib/metrics.js');

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Build a retrieval query from the turn's edited paths: unique basenames + parent
 * dir segments (dropping generic ones). Returns { query, keywords }.
 *
 * When `cwd` is given, each path is relativized against it FIRST. Edited paths
 * arrive as absolute (file-edit-detect.js journals tool_input.file_path as-is),
 * so without this the directory-segment loop below walks the WHOLE absolute
 * path — on every real invocation that's the OS/user/project-container chain
 * (e.g. "Users", "allan", "Desktop", "Projetos", "<repo-name>"), which are
 * never in GENERIC_DIR and become query noise on every turn, not just in a
 * deeply-nested test fixture. Diluted keywords lower the keyword-index match
 * score (a fraction of matched/total keywords) below the shared relevance
 * gate — silently starving the embedder-free fallback path this detector is
 * required to support (see the HARD CONSTRAINT in the file header). A path
 * outside `cwd` (or no `cwd` given) falls back to the prior absolute-segments
 * behavior, so this is additive, not a behavior change for that case.
 *
 * Comparison is CASE-INSENSITIVE on win32: `cwd` (the Stop event's reported
 * process cwd) and an edited `file_path` (whatever string the tool call used)
 * need not agree on case for the identical real file on a case-insensitive
 * filesystem (e.g. a drive letter, or any segment) — a case-sensitive
 * `startsWith` would silently fail the match and fall through to the exact
 * noise-pollution bug this function exists to fix, with zero signal that
 * relativization didn't happen. POSIX paths are compared case-sensitively
 * (case genuinely distinguishes different files there).
 *
 * Known accepted gap: this assumes `cwd` is the same root the edited paths
 * are relative to. A subagent editing from a DIFFERENT root (e.g. an
 * `isolation:"worktree"` Agent run whose file-edit lands in the same
 * session's verify-journal) won't share `cwd`'s prefix, so relativization
 * silently no-ops for that entry — falling back to the pre-fix absolute-
 * segments behavior for just that path, not worse than before this fix.
 * @param {string[]} paths
 * @param {string} [cwd]
 * @returns {{query:string, keywords:string[]}}
 */
function buildQuery(paths, cwd) {
  const tokens = [];
  const seen = new Set();
  const GENERIC_DIR = new Set(['src', 'lib', 'scripts', 'test', 'tests', 'dist', 'build', 'node_modules', '.', '']);
  const hasCwd = typeof cwd === 'string' && cwd.trim().length > 0;
  const normCwd = hasCwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const caseInsensitive = process.platform === 'win32';
  for (const p of paths || []) {
    let norm = String(p || '').replace(/\\/g, '/');
    if (!norm) continue;
    if (hasCwd) {
      const prefix = `${normCwd}/`; // normCwd may be '' for a root cwd → prefix '/'
      const head = norm.slice(0, prefix.length);
      const matches = caseInsensitive ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
      if (matches) norm = norm.slice(prefix.length);
    }
    const base = norm.split('/').pop();
    if (base && !seen.has(base)) { seen.add(base); tokens.push(base); }
    const dirs = norm.split('/').slice(0, -1);
    for (const d of dirs) {
      if (!GENERIC_DIR.has(d) && !seen.has(d)) { seen.add(d); tokens.push(d); }
    }
  }
  const query = tokens.join(' ');
  // Keywords for the index fallback: split basenames on non-word chars too
  // (e.g. "hooks-config.js" → hooks, config) so the inverted index can match.
  const keywords = extractKeywords(tokens.join(' ').replace(/[.\-_/]+/g, ' '), { minLen: 3, maxTokens: 20 });
  return { query, keywords };
}

/**
 * Compose the advisory reason from gated entries. Pure.
 * @param {object[]} entries
 * @returns {string}
 */
function buildAdvisory(entries) {
  const lines = ['[SELF-REVIEW] Files edited this turn resemble past lessons — verify before delivering:'];
  for (const e of entries) {
    const title = String((e && e.title) || 'untitled').replace(/\s+/g, ' ').trim().slice(0, 120);
    const rec = Number.isInteger(e && e.recurrence) && e.recurrence > 1 ? ` (recurrence ${e.recurrence})` : '';
    const type = e && e.type ? ` [${e.type}]` : '';
    lines.push(`  • "${title}"${rec}${type}`);
  }
  return lines.join('\n');
}

// ── Per-session "already surfaced" guard ──────────────────────────────────────

function surfacedPath(dir, sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(dir, '.runtime', `self-review-surfaced-${safe}.json`);
}

function readSurfaced(p) {
  try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { /* absent/corrupt */ return []; }
}

function writeSurfaced(p, ids) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJsonAtomic(p, ids.slice(-200));
  } catch (err) { console.error(`[self-review] surfaced write failed: ${err.message}`); }
}

// ── Detector entry ────────────────────────────────────────────────────────────

async function run(event, deps = {}) {
  const ev = event || {};
  const cfg = deps.cfg || hooksCfg.getSelfReview();
  if (!cfg.enabled) return {};
  if (ev.stop_hook_active) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const project = ev.cwd ? path.basename(ev.cwd) : 'default';
  const dir = deps.dataDir || dataDir();

  // Edited paths this turn (read-only; verify-nudge owns the journal clear).
  const editPaths = verifyJournal.readEntries(sid)
    .filter(e => e && e.kind === 'edit' && e.path)
    .map(e => e.path);
  if (editPaths.length === 0) return {};

  const { query, keywords } = buildQuery(editPaths, ev.cwd);
  if (!query) return {};

  const retrieveFn = deps.retrieve || selfReviewRetrieve.retrieve;
  const { entries, source } = await retrieveFn(
    { query, keywords },
    { dataDir: dir, project, topK: cfg.topK, minScore: cfg.minScore, types: cfg.types },
  );
  if (!entries.length) return {};

  // Drop lessons already surfaced this session (no re-nagging across turns).
  const sp = surfacedPath(dir, sid);
  const already = new Set(readSurfaced(sp));
  const fresh = entries.filter(e => e && e.id && !already.has(e.id));
  if (!fresh.length) return {};

  writeSurfaced(sp, [...already, ...fresh.map(e => e.id)]);

  // Journal the injection (F3 precision metric): mirrors the PreToolUse retrieval
  // journal so the Stop citation matcher can score whether these were used.
  try {
    retrievalJournal.appendEntry(sid, {
      retrievalId: retrievalJournal.newRetrievalId(),
      ts: Date.now(),
      sid,
      tool: 'Stop/self-review',
      queryTokens: keywords,
      returnedIds: fresh.map(e => e.id),
      returnedTitles: fresh.map(e => e.title || ''),
    });
  } catch (err) { console.error(`[self-review] journal failed: ${err.message}`); }

  const fireMetric = (deps.metrics && deps.metrics.fire) || metrics.fire;
  fireMetric('nudge.emitted', { kind: 'self-review', count: fresh.length, source }, { sessionId: sid, cwd: ev.cwd });
  return { block: true, reason: buildAdvisory(fresh) };
}

if (require.main === module) {
  const { runStopDetectorCli } = require('./lib/hook-io.js');
  runStopDetectorCli(run, 'self-review');
}

module.exports = { run, buildQuery, buildAdvisory, surfacedPath };
