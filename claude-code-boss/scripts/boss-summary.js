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
const fs = require('fs');
const path = require('path');
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
    state: String(health.state || (health.connected === true ? 'ok' : 'unreachable')),
    mode: String(health.mode || 'unknown'),
    backend: String(health.backend || 'unknown'),
    latencyMs: Number(health.latency) || 0,
    ...(reason ? { reason } : {}),
  };
}

/**
 * What changes when a project's metrics change: mtime and size of the db, its WAL and the carried-over marker.
 * @param {string} project
 * @returns {string|null} null when the files cannot be stat'ed
 */
function dbStamp(project) {
  const db = require('../engine/lib/metrics-store.js')._dbPath(project, require('../engine/lib/data-dir.js').dirResolver()());
  try {
    return [db, `${db}-wal`, path.join(path.dirname(db), 'adopted.json')].map((p) => {
      try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch (err) {
        if (err.code === 'ENOENT') return '-';
        throw err;
      }
    }).join('|');
  } catch (err) {
    console.error(`[boss-summary] dbStamp(${project}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Every project's rows of the window. The daemon asks every 30 s, so the reader is INCREMENTAL: it keeps,
 * per project, the rows of the window, the last row id it saw and the stamp (mtime and size) of the db files.
 * A project whose stamp did not change is not opened at all (opening 312 dbs costs seconds even with nothing
 * new); a changed one asks the store only for rows with a greater id. Rows that left the window are dropped
 * from the cache; a project whose db is gone leaves the cache with it.
 * The first read opens every project's db (~17 s measured after a cold start): once first reads have taken
 * budgetMs, the projects not yet in the cache wait for the next call and the answer says `complete: false`.
 * @param {{listProjects:Function, getEventLogIsolated:Function, dbStamp?:Function}} [storeArg]  injectable for tests; the default store is stamped by dbStamp here, an injected one without dbStamp is opened on every call
 * @param {{now?:Function}} [opts]  clock, injectable for tests
 * @returns {(sinceTs:number, budgetMs?:number) => {rows:object[], complete:boolean}}
 */
function createRowReader(storeArg, { now = Date.now } = {}) {
  const cache = new Map(); // project → { lastId, rows }
  return function readRows(sinceTs, budgetMs = Infinity) {
    const store = storeArg || require('../engine/lib/metrics-store.js');
    const eventNames = [...CURATION_EVENTS, ...ECONOMY_EVENTS, ...VALUE_EVENTS];
    const projects = store.listProjects();
    for (const p of [...cache.keys()]) if (!projects.includes(p)) cache.delete(p);
    const rows = [];
    let coldMs = 0;
    let complete = true;
    for (const project of projects) {
      const cold = !cache.has(project);
      if (cold && coldMs >= budgetMs) { complete = false; continue; }
      const t0 = now();
      const slot = cache.get(project) || { lastId: 0, rows: [], stamp: null };
      const stamp = storeArg ? (storeArg.dbStamp ? storeArg.dbStamp(project) : null) : dbStamp(project);
      if (!cold && stamp != null && stamp === slot.stamp) {
        slot.rows = slot.rows.filter((r) => Number(r.ts) >= sinceTs);
        for (const r of slot.rows) rows.push(r);
        continue;
      }
      const fresh = store.getEventLogIsolated(project, { eventNames, sinceTs, sinceId: slot.lastId });
      slot.stamp = stamp;
      for (const r of fresh) if (Number(r.id) > slot.lastId) slot.lastId = Number(r.id);
      slot.rows = slot.rows.filter((r) => Number(r.ts) >= sinceTs).concat(fresh);
      cache.set(project, slot);
      if (cold) coldMs += now() - t0;
      for (const r of slot.rows) rows.push(r);
    }
    return { rows, complete };
  };
}

const readRows = createRowReader();
const READ_BUDGET_MS = 2000;

/** The summary, or `{ warming: true }` while the first reads still fill the row cache (no partial totals). */
async function run() {
  const now = Date.now();
  const { rows, complete } = readRows(now - DAYS * 86400_000, READ_BUDGET_MS);
  if (!complete) return { warming: true };
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

module.exports = { run, summarizeBoss, createRowReader, dbStamp, DAYS };
