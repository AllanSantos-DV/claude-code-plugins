#!/usr/bin/env node
/**
 * recall-health.js — makes recall DEGRADATION visible instead of silent.
 *
 * The compose recall path fails OPEN (empty context, prompt still runs) so a bad
 * daemon never breaks a turn — but that means "no memory" can go unnoticed. This
 * tiny counter records every recall outcome to DATA_DIR/.runtime/recall-health.json
 * so brain-health / the dashboard can surface a degraded state (e.g. "compose
 * unavailable — recall has been empty for N turns").
 *
 * Degraded reasons: 'no-compose' (daemon < 2.18 / tool missing), 'remote-error',
 * 'timeout'. Everything else (a hit, or an honest 'no-match') counts as ok.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DATA_DIR = dataDir();
const FILE = path.join(DATA_DIR, '.runtime', 'recall-health.json');

const DEGRADED_REASONS = new Set(['no-compose', 'remote-error', 'timeout']);

/** Whether a retrieve `reason` represents a degraded recall (pure/testable). */
function isDegraded(reason) {
  return DEGRADED_REASONS.has(reason);
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch (err) { void err; return { ok: 0, degraded: 0, byReason: {}, lastDegraded: null }; }
}

/** Record one recall outcome. Returns the updated snapshot. */
function record(reason) {
  const h = read();
  h.ok = h.ok || 0;
  h.degraded = h.degraded || 0;
  h.byReason = h.byReason || {};
  if (isDegraded(reason)) {
    h.degraded += 1;
    h.byReason[reason] = (h.byReason[reason] || 0) + 1;
    h.lastDegraded = { reason, ts: Date.now() };
  } else {
    h.ok += 1;
  }
  // Best-effort, last-writer-wins (tear-free publish, no cross-process lock).
  try {
    writeJsonAtomic(FILE, h);
  } catch (err) {
    console.error(`[recall-health] write failed: ${err.message}`);
  }
  return h;
}

/** Current snapshot for health/dashboard surfacing. */
function getStatus() {
  const h = read();
  const total = (h.ok || 0) + (h.degraded || 0);
  return {
    ok: h.ok || 0,
    degraded: h.degraded || 0,
    total,
    degradedRate: total ? (h.degraded || 0) / total : 0,
    byReason: h.byReason || {},
    lastDegraded: h.lastDegraded || null,
  };
}

module.exports = { record, getStatus, isDegraded, FILE };
