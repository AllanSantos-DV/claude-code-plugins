'use strict';
/**
 * hook-latency-alert.js — warn BEFORE daemon-served hooks start expiring.
 *
 * The daemon's /health carries per-hook latency (C4c: calls, p95, expired…). A hook
 * whose p95 crosses half of its deadline (the hooks.json timeout minus the margin) is one
 * bad spike away from expiring — and an expired hook decides nothing (fail-open). This
 * turns that number into a BRAIN-HEALTH line, at most once per hook per 6 h per daemon
 * process (a restart resets the stats, so it resets the alert too).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { writeJsonAtomic } = require('./atomic-write.js');

const MIN_CALLS = 10;          // no verdict on a handful of samples
const P95_FRACTION = 0.5;      // p95 at half the deadline = no headroom left
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Pure: slow hooks out of /health's hookLatency.
 * @param {object} hookLatency  {hook_x: {calls, ok, degraded, expired, queued, p50Ms, p95Ms, maxMs}}
 * @param {object} deadlines    {hook_x: ms} (hook-tools.deadlinesFromHooksJson)
 * @returns {Array<{name:string, p95Ms:number, deadlineMs:number|null, expired:number, calls:number}>}
 */
function slowHooks(hookLatency, deadlines = {}) {
  if (!hookLatency || typeof hookLatency !== 'object' || hookLatency.unavailable) return [];
  const out = [];
  for (const [name, s] of Object.entries(hookLatency)) {
    if (!s || typeof s !== 'object') continue;
    const timed = (s.calls || 0) - (s.queued || 0); // fire-and-forget calls have no latency
    if (timed < MIN_CALLS && !(s.expired > 0)) continue;
    const deadlineMs = Number.isFinite(deadlines[name]) ? deadlines[name] : null;
    const slow = s.expired > 0 || (deadlineMs && s.p95Ms >= deadlineMs * P95_FRACTION);
    if (slow) out.push({ name, p95Ms: s.p95Ms || 0, deadlineMs, expired: s.expired || 0, calls: s.calls || 0 });
  }
  return out.sort((a, b) => (b.expired - a.expired) || (b.p95Ms - a.p95Ms));
}

function alertText(list) {
  const items = list.map((h) => `\`${h.name.replace(/^hook_/, '')}\` p95 ${h.p95Ms}ms${h.deadlineMs ? ` (prazo ${h.deadlineMs}ms)` : ''}${h.expired ? `, ${h.expired} prazo(s) estourado(s) — decidiu nada nesses casos` : ''}`);
  return `[BRAIN-HEALTH] Hook(s) do daemon sem folga: ${items.join('; ')}. Em ${list[0].calls}+ chamadas desde o início do daemon. Veja /dashboard → Curation & guards (latência por hook); reiniciar o Claude Code reinicia o daemon e zera a medição.`;
}

/** GET the daemon's /health (short timeout). Resolves the JSON or null. */
function fetchHealth(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (err) { void err; resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * The alert line for the hooks not alerted in the last 6 h for this daemon pid, or null.
 * @param {{health:object, deadlines:object, stampFile:string, now?:number}} a
 */
function alertOnce({ health, deadlines, stampFile, now = Date.now() }) {
  const list = slowHooks(health && health.hookLatency, deadlines);
  if (!list.length) return null;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') console.error(`[hook-latency-alert] stamp ${stampFile}: ${err.message}`); }
  const pid = String((health && health.pid) || '?');
  const seen = st.pid === pid && st.hooks && typeof st.hooks === 'object' ? st.hooks : {};
  const fresh = list.filter((h) => !(Number.isFinite(seen[h.name]) && now - seen[h.name] < COOLDOWN_MS));
  if (!fresh.length) return null;
  for (const h of fresh) seen[h.name] = now;
  try { fs.mkdirSync(path.dirname(stampFile), { recursive: true }); writeJsonAtomic(stampFile, { pid, hooks: seen }); }
  catch (err) { console.error(`[hook-latency-alert] could not stamp ${stampFile}: ${err.message}`); }
  return alertText(fresh);
}

module.exports = { slowHooks, alertText, fetchHealth, alertOnce, MIN_CALLS, P95_FRACTION, COOLDOWN_MS };
