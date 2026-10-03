#!/usr/bin/env node
/**
 * decision-promote.js — Stop hook (lean injector).
 *
 * Reads `.runtime/decision-pending.json` written by decision-detect.js.
 * If any pending decisions exist (commit/PR with rationale signals), nudges
 * the in-loop agent — who has full context — to call `capture_lesson` with
 * type:'decision' for each one, then marks them as promoted (LRU 50 keys) so
 * we never nudge the same sha/url twice.
 *
 * Anti-loop: honors `stop_hook_active` per the Claude Code Stop hook contract.
 * Idempotent: clears `pending` on every successful emit; promoted-LRU prevents
 * re-nudge if decision-detect somehow re-stages the same key.
 */
'use strict';
const { readJsonSafe, writeJsonSafe } = require('./lib/json-file.js');
const path = require('path');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

const { dataDir } = require('./lib/data-dir.js');
const DATA_DIR = dataDir();
const PENDING = path.join(DATA_DIR, '.runtime', 'decision-pending.json');
const PROMOTED = path.join(DATA_DIR, '.runtime', 'decision-promoted-sha.json');
const OTHERS_TTL_MS = 24 * 60 * 60 * 1000; // another session's unconsumed entries expire after a day
const PROMOTED_LRU = 50;


function promote(keys) {
  const arr = readJsonSafe(PROMOTED, []);
  const next = Array.isArray(arr) ? arr.filter(k => !keys.includes(k)) : [];
  for (const k of keys) next.push(k);
  while (next.length > PROMOTED_LRU) next.shift();
  writeJsonSafe(PROMOTED, next);
}

function buildReason(items) {
  const lines = items.map((it, i) => {
    const snip = (it.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const tag = it.kind === 'commit' ? 'commit'
      : it.kind === 'pr-create' ? 'PR'
      : it.kind === 'pr-edit' ? 'PR-edit'
      : it.kind === 'response' ? 'response'
      : it.kind || 'item';
    return `${i + 1}. [${tag} ${shortKey(it.key)}] ${snip}`;
  }).join('\n');

  return [
    'You just committed/opened a PR/wrote a response whose content looks like an architectural decision (verb of choice + rationale, or multi-paragraph body):',
    '',
    lines,
    '',
    'For EACH that is a real decision (choice between alternatives + the *why*), call the `capture_lesson` MCP tool ONCE with:',
    '  { type: "decision", title, summary, detail, tags: ["decision","architecture", <area>], sourceUrl: <commit-sha-or-PR-url-or-empty-for-response> }',
    '',
    'Skip any that are pure chores/fixes with no rationale. Do not over-capture.',
  ].join('\n');
}

function shortKey(k) {
  if (!k) return '?';
  if (k.startsWith('http')) return k.slice(-24);
  if (k.startsWith('msg:')) return k.slice(0, 16) + '…';
  return k.slice(0, 7); // sha
}

async function run(event) {
  const input = event || {};
  // Anti-loop guard: if Claude already retried this Stop, let it stop.
  if (input.stop_hook_active) return {};

  const state = readJsonSafe(PENDING, { pending: [] });
  const all = Array.isArray(state.pending) ? state.pending : [];
  if (all.length === 0) return {};
  // The file is shared by every session the daemon serves: surface ONLY this
  // session's entries (another session's commits are not this turn's to capture),
  // keep the other sessions' fresh entries for their own Stop, drop the stale/legacy.
  const sid = input.session_id || input.sessionId || null;
  const now = Date.now();
  const pending = all.filter(p => sid && p.sessionId === sid);
  const others = all.filter(p => p.sessionId && p.sessionId !== sid && now - (p.ts || 0) < OTHERS_TTL_MS);
  if (pending.length === 0) {
    if (others.length !== all.length) writeJsonSafe(PENDING, { pending: others });
    return {};
  }

  // Filter out anything already promoted (defensive — detect already filters).
  const promotedSet = new Set(readJsonSafe(PROMOTED, []));
  const fresh = pending.filter(p => p.key && !promotedSet.has(p.key));
  if (fresh.length === 0) {
    // Nothing fresh — drop this session's stale entries and exit.
    writeJsonSafe(PENDING, { pending: others });
    return {};
  }

  // Promote first (so a hook retry doesn't double-nudge) then emit.
  promote(fresh.map(p => p.key));
  writeJsonSafe(PENDING, { pending: others });

  for (const item of fresh) {
    metrics.fire('nudge.emitted', { kind: 'decision', decisionKind: item.kind, key: item.key, repoUrl: item.repoUrl },
      { sessionId: input.session_id || input.sessionId, cwd: input.cwd });
  }

  return { block: true, reason: buildReason(fresh) };
}

if (require.main === module) {
  runStopDetectorCli(run, 'decision-promote');
}

module.exports = { run };
