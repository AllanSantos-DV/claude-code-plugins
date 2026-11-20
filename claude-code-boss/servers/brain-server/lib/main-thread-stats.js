// How long the daemon's main thread was unavailable, and how much of that was garbage collection.
// Every session's HTTP, MCP and fast PreToolUse guards share this thread, so a stall here shows up as latency in
// hooks that did no work of their own; /health reports both numbers so a stall can be told apart from a slow hook.
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';

const LONG_PAUSE_MS = 100;
const TICK_MS = 50;
const KEEP_LONG = 5;
const msFromNs = (v) => Math.round(Number(v) / 1e5) / 10;
const GC_KIND = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };

/**
 * Start measuring the main thread: event-loop delay and garbage-collection pauses since start.
 * @returns {{stats: () => object, stop: () => void}}
 */
export function createMainThreadStats() {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const gc = { count: 0, totalMs: 0, maxMs: 0, longPauses: 0, recentLong: [] };
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const ms = e.duration;
      gc.count++;
      gc.totalMs += ms;
      if (ms > gc.maxMs) gc.maxMs = ms;
      if (ms >= LONG_PAUSE_MS) {
        gc.longPauses++;
        const kind = GC_KIND[(e.detail && e.detail.kind) || e.kind] || 'other';
        gc.recentLong.push({ at: new Date(performance.timeOrigin + e.startTime).toISOString(), ms: Math.round(ms), kind });
        if (gc.recentLong.length > KEEP_LONG) gc.recentLong.shift();
      }
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  // The histogram has no timestamps; a ticking timer dates each long stall so it can be matched with a GC pause.
  const stalls = { count: 0, recent: [] };
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK_MS;
    last = now;
    if (lag < LONG_PAUSE_MS) return;
    stalls.count++;
    stalls.recent.push({ at: new Date(performance.timeOrigin + now - lag).toISOString(), ms: Math.round(lag) });
    if (stalls.recent.length > KEEP_LONG) stalls.recent.shift();
  }, TICK_MS);
  tick.unref();
  return {
    stats: () => ({
      loopDelay: { p50Ms: msFromNs(loop.percentile(50)), p99Ms: msFromNs(loop.percentile(99)), maxMs: msFromNs(loop.max) },
      longStalls: { count: stalls.count, recent: stalls.recent.slice() },
      gc: { count: gc.count, totalMs: Math.round(gc.totalMs), maxMs: Math.round(gc.maxMs), longPauses: gc.longPauses, recentLong: gc.recentLong.slice() },
    }),
    stop: () => { loop.disable(); obs.disconnect(); clearInterval(tick); },
  };
}
