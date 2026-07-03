#!/usr/bin/env node
/**
 * stop-dispatcher.js — the single Stop-hook entry (Fase 0).
 *
 * Consolidates the 11 per-Stop Node spawns into ONE in-process pass: read the
 * event once, run each detector's pure `run(event)` in sequence, time each, and
 * merge their block decisions into a single `{decision:'block',reason}` (or `{}`).
 *
 * Why: process spawns dominate the Stop-hook cost, and upcoming detectors
 * (self-review D1/D2) would add more. In-process the detectors share module
 * state (e.g. ONE open SQLite handle instead of four re-opens) and each new
 * detector costs ~zero.
 *
 * Ordering is behavior-preserving, not arbitrary:
 *   - decision-scan-response (stages decision-pending.json) runs BEFORE
 *     decision-promote (reads + clears it).
 *   - failure-retro runs BEFORE curation-stop so it still observes this turn's
 *     pending turn-journal entries and defers ("curation priority") before
 *     curation-stop clears the journal. In the old multi-hook setup this held
 *     via parallel reads; here we make it deterministic via order.
 *
 * Merge/display priority (when >1 detector blocks in the same Stop):
 *   curation-stop > failure-retro > everything else (stable, execution order).
 *   curation-stop is the only detector with escalation semantics, so its reason
 *   leads.
 *
 * Fail-open: a detector throwing is logged and treated as no-block, exactly like
 * the old model where one hook erroring never stopped the others. A fatal error
 * emits `{}` (allow stop).
 */
'use strict';

const { performance } = require('node:perf_hooks');
const { readStdin, parsePayload, emitStopBlock, emitEmpty } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

// Execution order — see the header for the invariants this encodes.
const DETECTORS = [
  { name: 'pattern-detect',           mod: require('./pattern-detect.js') },
  { name: 'skill-promote-trigger',    mod: require('./skill-promote-trigger.js') },
  { name: 'decision-scan-response',   mod: require('./decision-scan-response.js') },
  { name: 'decision-promote',         mod: require('./decision-promote.js') },
  { name: 'refine-research',          mod: require('./refine-research.js') },
  { name: 'verify-nudge',             mod: require('./verify-nudge.js') },
  { name: 'research-followup-detect', mod: require('./research-followup-detect.js') },
  { name: 'failure-retro',            mod: require('./failure-retro.js') },
  { name: 'curation-stop',            mod: require('./curation-stop.js') },
  { name: 'skill-success-detect',     mod: require('./skill-success-detect.js') },
  { name: 'retrieval-feedback',       mod: require('./retrieval-feedback.js') },
  { name: 'auto-continue-stop',       mod: require('./auto-continue-stop.js') },
];

// Reason-concatenation priority when multiple detectors block at once.
const PRIORITY = { 'curation-stop': 0, 'failure-retro': 1 };
const DEFAULT_RANK = 2;
const SEP = '\n\n---\n\n';

function rank(name) {
  return Object.prototype.hasOwnProperty.call(PRIORITY, name) ? PRIORITY[name] : DEFAULT_RANK;
}

/**
 * Run every detector against the same event, in-process and in order.
 * Never throws: a detector crash is logged and treated as no-block.
 *
 * @param {object} event  parsed Stop payload
 * @param {{ onTiming?: (name:string, ms:number)=>void }} [hooks]
 * @returns {Promise<Array<{name:string, reason:string}>>} blocks in exec order
 */
async function dispatch(event, { onTiming } = {}) {
  const blocks = [];
  for (const { name, mod } of DETECTORS) {
    const t0 = performance.now();
    let res = null;
    try {
      res = typeof mod.run === 'function' ? await mod.run(event) : null;
    } catch (err) {
      console.error(`[stop-dispatcher] ${name}: ${err && err.message ? err.message : err}`);
      res = null;
    }
    const ms = Math.round((performance.now() - t0) * 1000) / 1000;
    if (typeof onTiming === 'function') {
      try { onTiming(name, ms); } catch (err) { console.error(`[stop-dispatcher] onTiming(${name}): ${err.message}`); }
    }
    if (res && res.block && typeof res.reason === 'string' && res.reason) {
      blocks.push({ name, reason: res.reason });
    }
  }
  return blocks;
}

/**
 * Merge collected blocks into one Stop envelope. Empty -> {}. Reasons are
 * concatenated in priority order so a single `{decision:'block'}` carries every
 * advisory that fired this Stop.
 *
 * @param {Array<{name:string, reason:string}>} blocks
 * @returns {{decision:'block', reason:string} | {}}
 */
function mergeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return {};
  const ordered = blocks
    .map((b, i) => ({ name: b.name, reason: b.reason, i }))
    .sort((a, b) => (rank(a.name) - rank(b.name)) || (a.i - b.i));
  return { decision: 'block', reason: ordered.map(b => b.reason).join(SEP) };
}

async function main() {
  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const ctx = { sessionId: event.session_id || event.sessionId, cwd: event.cwd };

  const blocks = await dispatch(event, {
    onTiming: (name, ms) => metrics.fire('stop.detector', { name, ms }, ctx),
  });
  metrics.fire('stop.dispatch', { detectors: DETECTORS.length, blocks: blocks.length }, ctx);

  const out = mergeBlocks(blocks);
  if (out.decision === 'block') emitStopBlock(out.reason);
  else emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[stop-dispatcher] fatal: ${err && err.message ? err.message : err}`);
    emitEmpty();
  });
}

module.exports = { dispatch, mergeBlocks, rank, DETECTORS, PRIORITY, SEP };
