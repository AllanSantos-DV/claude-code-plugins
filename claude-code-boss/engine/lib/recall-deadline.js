'use strict';
/**
 * recall-deadline.js — how long a prompt waits for its memory recall.
 *
 * The recalled context is what makes the work in a project good, so the wait is never a short fixed number: it
 * starts at a floor, follows the recall latency actually observed lately, and stretches while the machine is busy
 * (CPU in use, several sessions asking the same memory server). Only past the ceiling does the prompt go on without
 * memory, with the visible degraded-memory notice. Free memory is deliberately not a signal: it gates nothing.
 */

const os = require('os');

/** Headroom over the recent p90 latency, so a normal recall lands well inside its deadline. */
const LATENCY_HEADROOM = 1.3;
/** Extra deadline per additional session that asked for a recall lately, up to SESSION_STRETCH_MAX. */
const SESSION_STRETCH_STEP = 0.1;
const SESSION_STRETCH_MAX = 0.5;
/** Extra deadline at a fully busy CPU. */
const CPU_STRETCH_MAX = 0.5;
/** How long a session counts as running after its last recall. */
const SESSION_WINDOW_MS = 10 * 60 * 1000;

/**
 * @param {{latencies?: number[], sessions?: number, cpuBusy?: number, minMs: number, maxMs: number}} signals
 *   latencies: recent recall durations (ms), degraded ones included; sessions: sessions seen lately;
 *   cpuBusy: CPU in use, 0..1.
 * @returns {number} deadline in ms, within [minMs, maxMs]
 */
function adaptiveDeadlineMs({ latencies = [], sessions = 1, cpuBusy = 0, minMs, maxMs }) {
  const sorted = latencies.filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : 0;
  const base = Math.max(minMs, p90 * LATENCY_HEADROOM);
  const sessionStretch = Math.min(SESSION_STRETCH_MAX, Math.max(0, sessions - 1) * SESSION_STRETCH_STEP);
  const cpuStretch = CPU_STRETCH_MAX * Math.min(1, Math.max(0, cpuBusy));
  return Math.min(maxMs, Math.max(minMs, Math.round(base * (1 + sessionStretch + cpuStretch))));
}

/**
 * Counts the distinct sessions that asked for a recall within the window.
 * @param {{windowMs?: number, now?: () => number}} [opts]
 */
function createSessionTracker({ windowMs = SESSION_WINDOW_MS, now = Date.now } = {}) {
  const seen = new Map();
  return {
    note(sessionId) {
      seen.set(String(sessionId || 'default'), now());
    },
    count() {
      const cutoff = now() - windowMs;
      for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
      return Math.max(1, seen.size);
    },
  };
}

/**
 * CPU in use since the previous sample, from the cumulative per-core times (the first sample has no baseline and reads 0).
 * @param {() => Array<{times: {user:number, nice:number, sys:number, idle:number, irq:number}}>} [cpus]
 */
function createCpuSampler(cpus = os.cpus) {
  let prev = null;
  const totals = () => cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.all += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, all: 0 });
  return {
    sample() {
      const cur = totals();
      const last = prev;
      prev = cur;
      if (!last) return 0;
      const all = cur.all - last.all;
      return all > 0 ? Math.min(1, Math.max(0, 1 - (cur.idle - last.idle) / all)) : 0;
    },
  };
}

/**
 * The per-prompt recall deadline, read from live signals on every call.
 * @param {{getConfig: () => {hookBudgetMinMs:number, hookBudgetMaxMs:number}, readLatencies: () => number[],
 *   sessions?: ReturnType<typeof createSessionTracker>, cpu?: ReturnType<typeof createCpuSampler>}} deps
 */
function createRecallBudget({ getConfig, readLatencies, sessions = createSessionTracker(), cpu = createCpuSampler() }) {
  return {
    forSession(sessionId) {
      sessions.note(sessionId);
      const cfg = getConfig();
      return adaptiveDeadlineMs({ latencies: readLatencies(), sessions: sessions.count(), cpuBusy: cpu.sample(), minMs: cfg.hookBudgetMinMs, maxMs: cfg.hookBudgetMaxMs });
    },
  };
}

module.exports = { adaptiveDeadlineMs, createSessionTracker, createCpuSampler, createRecallBudget, LATENCY_HEADROOM, SESSION_WINDOW_MS };
