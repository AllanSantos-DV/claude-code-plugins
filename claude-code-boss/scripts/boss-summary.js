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
 *   compaction — cuts, tokens they cut and the cache hit rate (lib/compaction-metrics.compactionCacheBrief)
 *   brain      — the backend probe (lib/mcp-health.js) without paths or URLs: the reply
 *                travels to every session, so it carries a reason CODE, never a location
 */
const fs = require('fs');
const path = require('path');
const { summarizeCuration, CURATION_EVENTS, ECONOMY_EVENTS } = require('./lib/curation-metrics.js');
const { summarize } = require('./lib/value-summary.js');
const { compactionCacheBrief, foldCacheTurn } = require('./lib/compaction-metrics.js');
const { CHARS_PER_TOKEN } = require('./lib/economy-metrics.js');

const DAYS = 30;
const SESSION_WINDOW_MS = 86400_000;
const VALUE_EVENTS = ['lesson.captured', 'retrieve.cited', 'retrieve.injected'];
const COMPACTION_EVENTS = ['compaction.run', 'compaction.settled'];
// One row per API call, thousands a day: folded into per-day totals instead of kept as rows.
const CACHE_EVENT = 'cache.turn';
const DAY_MS = 86400_000;

const tokens = (chars) => Math.round((Number(chars) || 0) / CHARS_PER_TOKEN);

const GUARD_TTL_MS = 60_000;
const GUARD_TIMEOUT_MS = 5000;
const guardCache = { at: 0, value: null, lastError: '' };

/**
 * Whether the token-guard kit is in force, from `token-guard status --json` (`active`: true, false or
 * null; `inactiveReason` when it is not). Cached for a minute: the daemon answers every session's poll.
 * A kit that cannot be asked (not installed, older than the `--json` status) is logged once and gives null.
 * @param {{exec?: Function, now?: number}} [deps]
 * @returns {{active: boolean|null, inactiveReason?: string}|null}
 */
function tokenGuardStatus({ exec, now = Date.now() } = {}) {
  if (now - guardCache.at < GUARD_TTL_MS) return guardCache.value;
  guardCache.at = now;
  if (exec) {
    let out = '';
    let failure = null;
    try { out = exec(); } catch (err) { failure = err; out = (err && err.stdout) || ''; }
    settleGuard(out, failure);
    return guardCache.value;
  }
  // Asynchronous: the daemon's event loop also serves the hooks' deadlines, and the kit is a Node shim that takes a second.
  require('child_process').execFile(
    process.platform === 'win32' ? 'token-guard.cmd' : 'token-guard', ['status', '--json'],
    { encoding: 'utf8', timeout: GUARD_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
    (err, stdout) => settleGuard(stdout, err));
  return guardCache.value;
}

/**
 * Stores the kit's answer. A non-zero exit that still printed its JSON counts as the answer: the
 * inactive kit is the case the status exists for.
 * @param {string} out stdout of `token-guard status --json`
 * @param {Error|null} failure the spawn error, if any
 */
function settleGuard(out, failure) {
  let value = null;
  let error = '';
  if (String(out || '').trim() || !failure) {
    try {
      const j = JSON.parse(out);
      if (j && (typeof j.active === 'boolean' || j.active === null)) {
        value = { active: j.active, ...(j.inactiveReason ? { inactiveReason: String(j.inactiveReason).slice(0, 160) } : {}) };
      } else error = 'token-guard status --json has no "active" field (token-guard older than 2.20.1)';
    } catch (err) {
      void err;
      error = 'token-guard status --json did not answer JSON (token-guard older than 2.20.1)';
    }
  } else error = `token-guard status --json failed: ${failure.message.split('\n')[0]}`;
  if (error && error !== guardCache.lastError) console.error(`[boss-summary] ${error}`);
  guardCache.lastError = error;
  guardCache.value = value;
}

/**
 * @param {object[]} rows  metrics rows (curation + economy + value events) of the window
 * @param {object|null} health  probeHealth() answer, or null when the probe threw
 * @param {{now?:number, days?:number, healthError?:string, cache?:{turns:number, read:number, write:number, input:number}, guard?:{active:boolean|null, inactiveReason?:string}|null}} [opts]  cache: the window's cache.turn totals; guard: tokenGuardStatus()
 */
function summarizeBoss(rows, health, { now = Date.now(), days = DAYS, healthError, cache, guard } = {}) {
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
      ...(guard ? { active: guard.active, ...(guard.inactiveReason ? { inactiveReason: guard.inactiveReason } : {}) } : {}),
    },
    value: { days, lessons: v.learned.total, cited: v.memoryCited, injected: v.retrievalPrecision.injected },
    compaction: { days, ...compactionCacheBrief(rows, cache ? { cache } : {}) },
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
 * cache.turn rows are not kept: each project folds them into per-day totals, summed over the days in the window.
 * @returns {(sinceTs:number, budgetMs?:number) => {rows:object[], complete:boolean, cache:{turns:number, read:number, write:number, input:number}}}
 */
function createRowReader(storeArg, { now = Date.now } = {}) {
  const slots = new Map(); // project → { lastId, rows, stamp, cacheDays }
  return function readRows(sinceTs, budgetMs = Infinity) {
    const store = storeArg || require('../engine/lib/metrics-store.js');
    const eventNames = [...CURATION_EVENTS, ...ECONOMY_EVENTS, ...VALUE_EVENTS, ...COMPACTION_EVENTS, CACHE_EVENT];
    const fromDay = Math.floor(sinceTs / DAY_MS);
    const cache = { turns: 0, read: 0, write: 0, input: 0 };
    const addCache = (slot) => {
      for (const [day, t] of slot.cacheDays) {
        if (day < fromDay) { slot.cacheDays.delete(day); continue; }
        cache.turns += t.turns; cache.read += t.read; cache.write += t.write; cache.input += t.input;
      }
    };
    const projects = store.listProjects();
    for (const p of [...slots.keys()]) if (!projects.includes(p)) slots.delete(p);
    const rows = [];
    let coldMs = 0;
    let complete = true;
    for (const project of projects) {
      const cold = !slots.has(project);
      if (cold && coldMs >= budgetMs) { complete = false; continue; }
      const t0 = now();
      const slot = slots.get(project) || { lastId: 0, rows: [], stamp: null, cacheDays: new Map() };
      const stamp = storeArg ? (storeArg.dbStamp ? storeArg.dbStamp(project) : null) : dbStamp(project);
      if (!cold && stamp != null && stamp === slot.stamp) {
        slot.rows = slot.rows.filter((r) => Number(r.ts) >= sinceTs);
        for (const r of slot.rows) rows.push(r);
        addCache(slot);
        continue;
      }
      const fresh = store.getEventLogIsolated(project, { eventNames, sinceTs, sinceId: slot.lastId });
      slot.stamp = stamp;
      const kept = [];
      for (const r of fresh) {
        if (Number(r.id) > slot.lastId) slot.lastId = Number(r.id);
        if ((r.eventName || r.event_name) !== CACHE_EVENT) { kept.push(r); continue; }
        let p = r.payload || {};
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; continue; } }
        const day = Math.floor(Number(r.ts) / DAY_MS);
        if (!slot.cacheDays.has(day)) slot.cacheDays.set(day, { turns: 0, read: 0, write: 0, input: 0 });
        foldCacheTurn(slot.cacheDays.get(day), p);
      }
      slot.rows = slot.rows.filter((r) => Number(r.ts) >= sinceTs).concat(kept);
      slots.set(project, slot);
      addCache(slot);
      if (cold) coldMs += now() - t0;
      for (const r of slot.rows) rows.push(r);
    }
    return { rows, complete, cache };
  };
}

const readRows = createRowReader();
const READ_BUDGET_MS = 2000;

/** The summary, or `{ warming: true }` while the first reads still fill the row cache (no partial totals). */
async function run() {
  const now = Date.now();
  const { rows, complete, cache } = readRows(now - DAYS * 86400_000, READ_BUDGET_MS);
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
  return summarizeBoss(rows, health, { now, healthError, cache, guard: tokenGuardStatus({ now }) });
}

module.exports = { run, summarizeBoss, tokenGuardStatus, createRowReader, dbStamp, DAYS };
