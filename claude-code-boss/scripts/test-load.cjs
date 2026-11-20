'use strict';

const os = require('node:os');
const cp = require('node:child_process');

const MIN_WINDOW_MS = 500;
const MAX_FACTOR = 8;

function cpuTimes() {
  const t = { idle: 0, total: 0, at: Date.now() };
  for (const { times: x } of os.cpus()) {
    t.idle += x.idle;
    t.total += x.user + x.nice + x.sys + x.idle + x.irq;
  }
  return t;
}

let previous = cpuTimes();
let last = 1;

/**
 * How many times slower than an idle machine wall-clock work runs right now: 1 when the CPUs are idle,
 * 1 / (1 - busy share) otherwise, capped at 8. The busy share is read from the CPU times since the previous
 * call; a call closer than 500 ms to the previous one answers the last value.
 * @returns {number}
 */
function loadFactor() {
  const now = cpuTimes();
  if (now.at - previous.at < MIN_WINDOW_MS) return last;
  const total = now.total - previous.total;
  if (total > 0) {
    const busy = 1 - (now.idle - previous.idle) / total;
    last = Math.min(MAX_FACTOR, Math.max(1, 1 / Math.max(1 / MAX_FACTOR, 1 - busy)));
  }
  previous = now;
  return last;
}

/**
 * A wall-clock limit that follows the machine: `ms` on an idle machine, longer while other processes use the CPUs.
 * @param {number} ms limit on an idle machine
 * @returns {number}
 */
function loadLimit(ms) {
  return Math.ceil(ms * loadFactor());
}

const scaled = new WeakSet();

/**
 * Makes every `timeout` given to spawnSync, execFileSync and execSync follow the machine load, so a child that is
 * only slow because the machine is busy is not killed as a hang. Idempotent per target.
 * @param {object} [target] the module to patch, child_process by default
 */
function scaleSpawnTimeouts(target = cp) {
  if (scaled.has(target)) return;
  scaled.add(target);
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const real = target[name];
    target[name] = function (...args) {
      const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a) && Number.isFinite(a.timeout));
      if (at > 0) args[at] = { ...args[at], timeout: loadLimit(args[at].timeout) };
      return Reflect.apply(real, this, args);
    };
  }
}

module.exports = { loadFactor, loadLimit, scaleSpawnTimeouts, MAX_FACTOR };
