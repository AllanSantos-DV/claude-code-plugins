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
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, emitStopBlock, emitEmpty } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING = path.join(DATA_DIR, '.runtime', 'decision-pending.json');
const PROMOTED = path.join(DATA_DIR, '.runtime', 'decision-promoted-sha.json');
const PROMOTED_LRU = 50;

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
    return true;
  } catch { return false; }
}

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

(async () => {
  try {
    const raw = await readStdin();
    // Anti-loop guard: if Claude already retried this Stop, let it stop.
    try {
      const input = JSON.parse(raw || '{}');
      if (input.stop_hook_active) { emitEmpty(); return; }
    } catch { /* malformed input — fall through */ }

    const state = readJsonSafe(PENDING, { pending: [] });
    const pending = Array.isArray(state.pending) ? state.pending : [];
    if (pending.length === 0) { emitEmpty(); return; }

    // Filter out anything already promoted (defensive — detect already filters).
    const promotedSet = new Set(readJsonSafe(PROMOTED, []));
    const fresh = pending.filter(p => p.key && !promotedSet.has(p.key));
    if (fresh.length === 0) {
      // Nothing fresh — clear stale pending and exit.
      writeJsonSafe(PENDING, { pending: [] });
      emitEmpty();
      return;
    }

    // Promote first (so a hook retry doesn't double-nudge) then emit.
    promote(fresh.map(p => p.key));
    writeJsonSafe(PENDING, { pending: [] });

    for (const item of fresh) {
      metrics.fire('decision.captured', { kind: item.kind, key: item.key, repoUrl: item.repoUrl });
    }

    emitStopBlock(buildReason(fresh));
  } catch {
    emitEmpty();
  }
})();
