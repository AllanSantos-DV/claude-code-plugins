#!/usr/bin/env node
'use strict';
/**
 * boss-summary.js — what the Boss band and /boss (hooks/boss.mjs) show, in one read.
 *
 * The function-hook module has no Node, so it reads this through the daemon: GET
 * /hook/boss-summary (servers/brain-server/lib/http-daemon.js, token-gated like /mcp,
 * cached there so N sessions polling cost one computation) → internal tool
 * `hook_boss_summary` (lib/hook-tools.js, heavy lane) → `run()` here.
 *
 *   tokenGuard — curation savings over the window (lib/curation-metrics.js, the same
 *                numbers as the dashboard's Curation panel) and, per session seen in the
 *                last day, the exact savings of that session (shaper cuts + measured runs)
 *   value      — lessons captured, memories cited / injected (lib/value-summary.js)
 *   brain      — the backend probe (lib/mcp-health.js) without paths or URLs: the reply
 *                travels to every session, so it carries a reason CODE, never a location
 */
const { summarizeCuration, CURATION_EVENTS, ECONOMY_EVENTS } = require('./lib/curation-metrics.js');
const { summarize } = require('./lib/value-summary.js');
const { CHARS_PER_TOKEN } = require('./lib/economy-metrics.js');

const DAYS = 30;
const SESSION_WINDOW_MS = 86400_000;
const VALUE_EVENTS = ['lesson.captured', 'retrieve.cited', 'retrieve.injected'];

const tokens = (chars) => Math.round((Number(chars) || 0) / CHARS_PER_TOKEN);

/**
 * @param {object[]} rows  metrics rows (curation + economy + value events) of the window
 * @param {object|null} health  probeHealth() answer, or null when the probe threw
 * @param {{now?:number, days?:number, healthError?:string}} [opts]
 */
function summarizeBoss(rows, health, { now = Date.now(), days = DAYS, healthError } = {}) {
  const cur = summarizeCuration(rows);
  const recent = new Map(); // session id → its rows of the last day
  for (const r of rows) {
    const sid = r.sessionId || r.session_id;
    if (!sid || !(Number(r.ts) >= now - SESSION_WINDOW_MS)) continue;
    if (!recent.has(sid)) recent.set(sid, []);
    recent.get(sid).push(r);
  }
  const bySession = {};
  for (const [sid, list] of recent) {
    const s = summarizeCuration(list);
    const saved = tokens(s.shaped.savedChars + s.exact.savedChars);
    if (saved > 0) bySession[sid] = saved;
  }
  const v = summarize(rows);
  return {
    generatedAt: now,
    brain: brainOf(health, healthError),
    tokenGuard: {
      days,
      savedTokens: cur.totals.savedTokensApprox,
      exactTokens: tokens(cur.shaped.savedChars + cur.exact.savedChars),
      estimatedTokens: tokens(cur.redirectSavings.estChars),
      bySession,
    },
    value: { days, lessons: v.learned.total, cited: v.memoryCited, injected: v.retrievalPrecision.injected },
  };
}

function brainOf(health, healthError) {
  if (!health) return { connected: false, mode: 'unknown', backend: 'unknown', reason: `probe-failed: ${String(healthError || 'no answer').slice(0, 120)}` };
  const reason = health.details && health.details.reason ? String(health.details.reason).split(':')[0] : undefined;
  return {
    connected: health.connected === true,
    mode: String(health.mode || 'unknown'),
    backend: String(health.backend || 'unknown'),
    latencyMs: Number(health.latency) || 0,
    ...(reason ? { reason } : {}),
  };
}

/** Every project's rows of the window, one open per project. */
function readRows(sinceTs) {
  const store = require('../engine/lib/metrics-store.js');
  const eventNames = [...CURATION_EVENTS, ...ECONOMY_EVENTS, ...VALUE_EVENTS];
  const rows = [];
  for (const project of store.listProjects()) {
    for (const r of store.getEventLogIsolated(project, { eventNames, sinceTs })) rows.push(r);
  }
  return rows;
}

async function run() {
  const now = Date.now();
  const rows = readRows(now - DAYS * 86400_000);
  let health = null;
  let healthError;
  try {
    const { probeHealth } = require('./lib/mcp-health.js');
    health = await probeHealth(require('../engine/lib/brain-config.js').load());
  } catch (err) {
    healthError = err && err.message ? err.message : String(err);
    console.error(`[boss-summary] brain health probe failed: ${healthError}`);
  }
  return summarizeBoss(rows, health, { now, healthError });
}

module.exports = { run, summarizeBoss, DAYS };
