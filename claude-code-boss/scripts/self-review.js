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
const path = require('path');
const os = require('os');

const verifyJournal = require('./lib/verify-journal.js');
const retrievalJournal = require('./lib/retrieval-journal.js');
const hooksCfg = require('./lib/hooks-config.js');
const selfReviewRetrieve = require('./lib/self-review-retrieve.js');
const { extractKeywords } = require('./lib/text-utils.js');
const metrics = require('./lib/metrics.js');

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Build a retrieval query from the turn's edited paths: unique basenames + parent
 * dir segments (dropping generic ones). Returns { query, keywords }.
 * @param {string[]} paths
 * @returns {{query:string, keywords:string[]}}
 */
function buildQuery(paths) {
  const tokens = [];
  const seen = new Set();
  const GENERIC_DIR = new Set(['src', 'lib', 'scripts', 'test', 'tests', 'dist', 'build', 'node_modules', '.', '']);
  for (const p of paths || []) {
    const norm = String(p || '').replace(/\\/g, '/');
    if (!norm) continue;
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
    fs.writeFileSync(p, JSON.stringify(ids.slice(-200)));
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

  const { query, keywords } = buildQuery(editPaths);
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
