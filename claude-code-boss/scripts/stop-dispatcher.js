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
 *   - self-review (reads the per-turn verify-journal) runs BEFORE verify-nudge,
 *     which owns the journal's turn-boundary clear — so both see this turn's edits.
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
const hooksConfig = require('./lib/hooks-config.js');
const telem = require('./lib/stop-telemetry.js');

// Execution order — see the header for the invariants this encodes.
const DETECTORS = [
  { name: 'pattern-detect',           mod: require('./pattern-detect.js') },
  { name: 'skill-promote-trigger',    mod: require('./skill-promote-trigger.js') },
  { name: 'decision-scan-response',   mod: require('./decision-scan-response.js') },
  { name: 'decision-promote',         mod: require('./decision-promote.js') },
  { name: 'refine-research',          mod: require('./refine-research.js') },
  { name: 'self-review',              mod: require('./self-review.js') },
  { name: 'verify-nudge',             mod: require('./verify-nudge.js') },
  { name: 'research-followup-detect', mod: require('./research-followup-detect.js') },
  { name: 'failure-retro',            mod: require('./failure-retro.js') },
  { name: 'curation-stop',            mod: require('./curation-stop.js') },
  { name: 'skill-success-detect',     mod: require('./skill-success-detect.js') },
  { name: 'retrieval-feedback',       mod: require('./retrieval-feedback.js') },
  { name: 'session-summary',          mod: require('./session-summary.js') },
  { name: 'conversation-ingest',      mod: require('./conversation-ingest.js') },
  { name: 'capture-dispatch',         mod: require('./capture-dispatch.js') },
  { name: 'auto-continue-stop',       mod: require('./auto-continue-stop.js') },
];

// Reason-concatenation priority when multiple detectors block at once.
const PRIORITY = { 'curation-stop': 0, 'failure-retro': 1 };
const DEFAULT_RANK = 2;
const SEP = '\n\n---\n\n';

function rank(name) {
  return Object.prototype.hasOwnProperty.call(PRIORITY, name) ? PRIORITY[name] : DEFAULT_RANK;
}

function _errMsg(err) { return err && err.message ? err.message : String(err); }
function _round(ms) { return Math.round(ms * 1000) / 1000; }

const DEFAULT_SHADOW_RATE = telem.DEFAULT_SHADOW_RATE;
function getShadowRate() {
  try {
    const o = hooksConfig.load().observability;
    const r = o && o.shadowSampleRate;
    return (typeof r === 'number' && r >= 0 && r <= 1) ? r : DEFAULT_SHADOW_RATE;
  } catch (err) { void err; return DEFAULT_SHADOW_RATE; }
}

/**
 * Run every detector against the same event, in-process and in order, applying
 * the profile gate at the DISPATCHER (not inside detectors). Never throws.
 *
 * Per detector we record an outcome the summary folds into ONE Stop row:
 *   - enabled  → run(); `ran` (+ `blocked` if it fired).
 *   - gated    → skipped by profile (cheap, honest). If sampled AND the detector
 *     exposes `detect()` (ungated logic), run a SHADOW pass → `would_block`
 *     (labeled estimate, never enforced). `free` gates everything.
 *
 * @param {object} event  parsed Stop payload
 * @param {{ profile?:string, runId?:string, shadowRate?:number,
 *           onError?:(name:string,msg:string)=>void }} [opts]
 * @returns {Promise<{ blocks:Array<{name,reason}>, profile:string, runId:string,
 *                     detectors:Array<object> }>}
 */
async function dispatch(event, opts = {}) {
  const profile = opts.profile || hooksConfig.getProfile();
  const runId = opts.runId || telem.newRunId();
  const shadowRate = typeof opts.shadowRate === 'number' ? opts.shadowRate : getShadowRate();
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const list = Array.isArray(opts.detectors) ? opts.detectors : DETECTORS;
  const blocks = [];
  const detectors = [];

  for (const { name, mod } of list) {
    const gs = telem.gateState(name, profile, hooksConfig);
    const entry = { name, gated: !gs.enabled, blocked: false, would_block: null, chars: 0, ms: 0, reason: gs.reason };

    if (gs.enabled) {
      const t0 = performance.now();
      let res = null;
      try {
        res = typeof mod.run === 'function' ? await mod.run(event) : null;
      } catch (err) {
        const msg = _errMsg(err);
        console.error(`[stop-dispatcher] ${name}: ${msg}`);
        try { onError(name, msg); } catch (e) { console.error(`[stop-dispatcher] onError(${name}): ${_errMsg(e)}`); }
        res = null;
      }
      entry.ms = _round(performance.now() - t0);
      if (res && res.block && typeof res.reason === 'string' && res.reason) {
        entry.blocked = true;
        entry.chars = telem.estChars(res.reason);
        blocks.push({ name, reason: res.reason });
      }
    } else if (typeof mod.detect === 'function' && telem.shouldShadow(runId, name, shadowRate)) {
      // Sampled shadow pass: run the ungated detection to learn if it WOULD have
      // blocked. Never enforced — this only measures the bypass's impact.
      const t0 = performance.now();
      let sres = null;
      try {
        sres = await mod.detect(event);
      } catch (err) {
        const msg = _errMsg(err);
        try { onError(name, `shadow:${msg}`); } catch (e) { console.error(`[stop-dispatcher] onError(${name}): ${_errMsg(e)}`); }
        sres = null;
      }
      entry.ms = _round(performance.now() - t0);
      entry.would_block = !!(sres && sres.block && typeof sres.reason === 'string' && sres.reason);
      entry.chars = entry.would_block ? telem.estChars(sres.reason) : 0;
    }

    detectors.push(entry);
  }

  return { blocks, profile, runId, detectors };
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
  const profile = hooksConfig.getProfile();
  const runId = telem.newRunId();

  // Gating is resolved per detector inside dispatch() (including `free`, which
  // gates everything). No early return: even a full passthrough emits the Stop
  // summary so the bypass's impact is observable.
  const { blocks, detectors } = await dispatch(event, {
    profile,
    runId,
    onError: (name, message) => metrics.fire('stop.detector.error',
      { name, message: String(message).slice(0, 200), profile, run_id: runId, schema: telem.SCHEMA_VERSION }, ctx),
  });

  metrics.fire('stop.dispatch', telem.summarize(profile, runId, detectors), ctx);

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

module.exports = { dispatch, mergeBlocks, rank, DETECTORS, PRIORITY, SEP, getShadowRate };
