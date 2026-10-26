'use strict';
/**
 * metrics-store.js — dedicated, backend-independent storage for hook telemetry.
 *
 * Metrics (Stop-hook timing, profile bypass counts, capture rates) are a
 * PER-MACHINE operational concern — not knowledge, and not something a team
 * shares. `brain-config`'s `backend.type` (`local` | `mcp-memory`) decides
 * where KNOWLEDGE entries live; that choice must never affect metrics. Before
 * this module existed, metrics rode on `brain-store.js`'s own SQLite
 * connection — which happened to stay available even under `mcp-memory`
 * (brain-store always tries SQLite for itself, regardless of `backend.type`,
 * since it's `brain-backend.js` — a layer metrics never went through — that
 * actually switches to the mcp-memory daemon). That was working BY ACCIDENT,
 * not by design: nothing stopped a future change to brain-store's init order
 * from silently breaking telemetry. This module makes the separation explicit
 * and owns its own file, so metrics work identically no matter what backend
 * the KB uses, and the coupling can't reappear by accident.
 *
 * No JSON fallback (unlike brain-store): if no SQLite backend resolves at all
 * (node:sqlite ships in Node >=22.5 with no compile step, and this plugin
 * requires >=22.13, so this is a near-theoretical case), recording/reading
 * just no-ops — honest, never throws, exactly like every other hook failure
 * mode in this plugin.
 *
 * Same singleton-per-process, cycle-by-project pattern as brain-store.js: a
 * hook invocation is one project per process; long-lived callers (dashboard)
 * cycle projects sequentially via close()+init().
 */
const fs = require('fs');
const path = require('path');
const { loadSqlite } = require('./sqlite-compat');

// opts.dataDir on init / isolated reads / listProjects (a host passing its own), else the resolved data dir.
const storeDir = require('./data-dir.js').dirResolver();

const VALID_EVENT_NAME = /^[a-z][a-z0-9._-]{1,63}$/;

let _db = null;
let _floor = 0; // carried-over floor of the open db (floorFor)
let _project = null;
let _dir = null; // data dir of the open db
// Open connections by project, least recently used first. The daemon serves several
// sessions at once: with one connection, every interleaved hook paid close + open +
// pragmas + CREATE IF NOT EXISTS + migration check (5,35 ms vs 0,10 ms per insert).
const MAX_OPEN = 8;
const _open = new Map(); // `${dir}|${project}` -> { db, insert, dir, project }
let _insert = null;

function metricsDir(project, dir = _dir || storeDir()) {
  return path.join(dir, 'metrics', project);
}

function dbPath(project, dir) {
  return path.join(metricsDir(project, dir), 'metrics.db');
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload TEXT,
      session_id TEXT,
      project TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_event_ts ON metrics_event(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_event_name ON metrics_event(event_name);
  `);
}

/**
 * One-shot migration: copies any pre-existing `metrics_event` rows out of the
 * OLD location (brain-store's per-project `brain.db`, where telemetry lived
 * before this module) into the new dedicated file, then drops the legacy
 * table. Marked by a sentinel file so it runs at most once per project — a
 * clean cutover, not an ongoing dual-read.
 */
function migrateLegacyIfNeeded(project, db, dir) {
  const marker = path.join(metricsDir(project, dir), '.migrated-from-brain-db');
  if (fs.existsSync(marker)) return;
  try {
    const legacyPath = path.join(dir, 'brain', project, 'brain.db');
    if (fs.existsSync(legacyPath)) {
      const Database = loadSqlite();
      if (Database) {
        const legacy = new Database(legacyPath);
        try {
          const tables = legacy.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
          if (tables.includes('metrics_event')) {
            const rows = legacy.prepare(
              `SELECT ts, event_name, payload, session_id, project FROM metrics_event`
            ).all();
            if (rows.length) {
              const insert = db.prepare(
                `INSERT INTO metrics_event (ts, event_name, payload, session_id, project) VALUES (?, ?, ?, ?, ?)`
              );
              for (const r of rows) insert.run(r.ts, r.event_name, r.payload, r.session_id, r.project);
              console.error(`[metrics-store] migrated ${rows.length} legacy row(s) for '${project}' from brain.db`);
            }
            legacy.exec(`DROP TABLE metrics_event`);
          }
        } finally {
          legacy.close();
        }
      }
    }
  } catch (err) {
    console.error(`[metrics-store] legacy migration failed (${project}): ${err.message}`);
  } finally {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
    } catch { /* best-effort marker; a retry next time is harmless */ }
  }
}

/** Open (or reuse) the metrics DB for `project` (under `dataDir`, default the resolved one). Never throws; false = unavailable. */
function init({ project = 'default', dataDir } = {}) {
  const dir = storeDir({ dataDir });
  if (_db && _project === project && _dir === dir) return true;
  const key = dir + '|' + project;
  const cached = _open.get(key);
  if (cached) {
    _open.delete(key);
    _open.set(key, cached); // most recently used
    _db = cached.db;
    _insert = cached.insert;
    _project = project;
    _dir = dir;
    _floor = floorFor(project, dir);
    return true;
  }
  const Database = loadSqlite();
  if (!Database) return false;
  let db = null;
  try {
    fs.mkdirSync(metricsDir(project, dir), { recursive: true });
    db = new Database(dbPath(project, dir));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    createTables(db);
    migrateLegacyIfNeeded(project, db, dir);
    const insert = db.prepare(
      `INSERT INTO metrics_event (ts, event_name, payload, session_id, project) VALUES (?, ?, ?, ?, ?)`
    );
    while (_open.size >= MAX_OPEN) {
      const [oldest, entry] = _open.entries().next().value;
      _open.delete(oldest);
      try { entry.db.close(); } catch (err) { console.error(`[metrics-store] close failed (${oldest}): ${err.message}`); }
    }
    _open.set(key, { db, insert });
    _db = db;
    _insert = insert;
    _project = project;
    _dir = dir;
    _floor = floorFor(project, dir);
    return true;
  } catch (err) {
    console.error(`[metrics-store] init failed (${project}): ${err.message}`);
    if (db) { try { db.close(); } catch (e) { void e; } }
    _db = null;
    _insert = null;
    _project = null;
    _dir = null;
    return false;
  }
}

function isReady() { return !!_db; }

/** Close every open connection (callers use it to release the DB files). */
function close() {
  for (const { db } of _open.values()) { try { db.close(); } catch { /* noop */ } }
  _open.clear();
  _db = null;
  _insert = null;
  _floor = 0;
  _project = null;
  _dir = null;
}

function safeParseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { /* non-JSON value: null */ return null; }
}

/** Append a single event row. Returns inserted id (or 0 on no-op/failure). */
function recordMetric(eventName, payload, sessionId) {
  if (!_db || !eventName || !VALID_EVENT_NAME.test(eventName)) return 0;
  try {
    const info = _insert.run(
      Date.now(), eventName, payload ? JSON.stringify(payload) : null, sessionId || null, _project || null,
    );
    return Number(info.lastInsertRowid) || 0;
  } catch (err) {
    console.error(`[metrics-store] recordMetric(${eventName}) failed: ${err.message}`);
    return 0;
  }
}

/** List recent raw events (newest first) for the currently-open project. */
function getEventLog({ eventName = null, limit = 50, sinceTs = null } = {}) {
  if (!_db) return [];
  const cap = windowCap(limit, sinceTs);
  try {
    const lo = lowerBound(sinceTs, _floor);
    const rows = eventName
      ? _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event WHERE event_name = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`).all(eventName, lo, cap)
      : _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(lo, cap);
    return rows.map(r => ({
      id: r.id, ts: r.ts, eventName: r.event_name,
      payload: safeParseJson(r.payload), sessionId: r.session_id, project: r.project,
    }));
  } catch (err) {
    console.error(`[metrics-store] getEventLog failed: ${err.message}`);
    return [];
  }
}

/**
 * Read an ARBITRARY project's metrics DB via a throwaway connection, without
 * touching the module singleton — mirrors brain-store's isolated-read
 * rationale (e.g. a detector needs the `__user__` project's events while a
 * different project is the active one for this hook run). Read-only; []
 * if the DB file or SQLite backend is unavailable.
 * `eventNames` (array) reads several event kinds in one open, which is the expensive part.
 */
function getEventLogIsolated(project, { eventName = null, eventNames = null, limit = 50, sinceTs = null, sinceId = null, dataDir } = {}) {
  const Database = loadSqlite();
  if (!Database) return [];
  const dir = storeDir({ dataDir });
  const p = dbPath(project, dir);
  if (!fs.existsSync(p)) return [];
  const cap = windowCap(limit, sinceTs);
  let db;
  try { db = new Database(p); } catch (e) { console.error('[metrics-store] isolated open failed:', p, e.message); return []; }
  try {
    const lo = lowerBound(sinceTs, floorFor(project, dir));
    const names = Array.isArray(eventNames) && eventNames.length ? eventNames : (eventName ? [eventName] : null);
    // sinceId: only rows written after that id (incremental readers keep the last id they saw).
    const idCut = sinceId == null ? '' : ' AND id > ?';
    const idArg = sinceId == null ? [] : [Number(sinceId) || 0];
    const rows = names
      ? db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                      FROM metrics_event WHERE event_name IN (${names.map(() => '?').join(',')}) AND ts >= ?${idCut} ORDER BY ts DESC LIMIT ?`).all(...names, lo, ...idArg, cap)
      : db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                      FROM metrics_event WHERE ts >= ?${idCut} ORDER BY ts DESC LIMIT ?`).all(lo, ...idArg, cap);
    return rows.map(r => ({
      id: r.id, ts: r.ts, eventName: r.event_name,
      payload: safeParseJson(r.payload), sessionId: r.session_id, project: r.project,
    }));
  } catch (err) {
    console.error(`[metrics-store] getEventLogIsolated(${project}) failed: ${err.message}`);
    return [];
  } finally {
    try { db.close(); } catch { /* throwaway connection */ }
  }
}

/**
 * EXACT windowed aggregation of shadow-evaluation events for the CURRENTLY-OPEN
 * project — the count `policy_shadow_report` needs. Unlike `getEventLog` (capped at
 * 500 rows, grouped only by event_name), this groups by the payload's `activationId`
 * AND `outcome` in SQL with NO row cap, so the per-policy trigger/pass/unevaluable
 * tallies are exact regardless of volume. `json_extract` requires SQLite's JSON1
 * (bundled in node:sqlite) — if it's ever unavailable it throws, which we log and
 * turn into `[]` (honest empty, never a crash).
 * @param {{eventName:string, sinceTs:number, dataDir?:string}} opts
 * @returns {Array<{activationId:(string|null), outcome:(string|null), count:number}>}
 */
function getEvaluationCounts({ eventName, sinceTs = 0 } = {}) {
  if (!_db || !eventName) return [];
  try {
    const rows = _db.prepare(
      `SELECT json_extract(payload,'$.activationId') AS activation_id,
              json_extract(payload,'$.outcome')      AS outcome,
              COUNT(*) AS count
         FROM metrics_event
        WHERE event_name = ? AND ts >= ?
        GROUP BY activation_id, outcome`
    ).all(eventName, Number(sinceTs) || 0);
    return rows.map((r) => ({ activationId: r.activation_id, outcome: r.outcome, count: r.count }));
  } catch (err) {
    console.error(`[metrics-store] getEvaluationCounts(${eventName}) failed: ${err.message}`);
    return [];
  }
}

/**
 * Isolated (throwaway-connection) variant of `getEvaluationCounts` for an ARBITRARY
 * project — mirrors `getEventLogIsolated` so the report can read a SPECIFIC project's
 * db without disturbing the singleton bound to the active hook run. Read-only; `[]`
 * if the db file or SQLite backend is unavailable.
 * @param {string} project
 * @param {{eventName:string, sinceTs:number}} opts
 * @returns {Array<{activationId:(string|null), outcome:(string|null), count:number}>}
 */
function getEvaluationCountsIsolated(project, { eventName, sinceTs = 0, dataDir } = {}) {
  if (!eventName) return [];
  const Database = loadSqlite();
  if (!Database) return [];
  const p = dbPath(project, storeDir({ dataDir }));
  if (!fs.existsSync(p)) return [];
  let db;
  try { db = new Database(p, { readonly: true }); }
  catch (e) { console.error('[metrics-store] isolated open failed:', p, e.message); return []; }
  try {
    const rows = db.prepare(
      `SELECT json_extract(payload,'$.activationId') AS activation_id,
              json_extract(payload,'$.outcome')      AS outcome,
              COUNT(*) AS count
         FROM metrics_event
        WHERE event_name = ? AND ts >= ?
        GROUP BY activation_id, outcome`
    ).all(eventName, Number(sinceTs) || 0);
    return rows.map((r) => ({ activationId: r.activation_id, outcome: r.outcome, count: r.count }));
  } catch (err) {
    console.error(`[metrics-store] getEvaluationCountsIsolated(${project}) failed: ${err.message}`);
    return [];
  } finally {
    try { db.close(); } catch { /* throwaway connection */ }
  }
}

/** Aggregate counts per event_name within a time window (days back from now). */
function getMetricsSummary(rangeDays = 7) {
  const empty = { totals: {}, daily: [], windowMs: rangeDays * 86400_000, sinceTs: 0 };
  if (!_db) return empty;
  try {
    const sinceTs = lowerBound(Date.now() - rangeDays * 86400_000, _floor);
    const totalRows = _db.prepare(
      `SELECT event_name, COUNT(*) AS count FROM metrics_event WHERE ts >= ? GROUP BY event_name`
    ).all(sinceTs);
    const totals = {};
    for (const r of totalRows) totals[r.event_name] = r.count;

    const dailyRows = _db.prepare(
      `SELECT date(ts/1000, 'unixepoch') AS date, event_name, COUNT(*) AS count
         FROM metrics_event WHERE ts >= ?
         GROUP BY date, event_name
         ORDER BY date ASC, event_name ASC`
    ).all(sinceTs);

    return { totals, daily: dailyRows, windowMs: rangeDays * 86400_000, sinceTs };
  } catch (err) {
    console.error(`[metrics-store] getMetricsSummary failed: ${err.message}`);
    return empty;
  }
}

/**
 * EXACT curation usage of `project` (isolated read-only connection, no row cap): the
 * oldest curation.* event (how far the usage history goes back) and the ids of curated
 * scripts that RAN since `sinceTs` (curation.used / .redirected / .piped). Feeds the
 * never-used prune, which must not trust a history shorter than its window.
 * @returns {{historyFromTs:(number|null), usedIds:string[]}}
 */
// Events born together with usage tracking (3.0, Phase C) — any of them proves the usage
// counters were live at that time. curation.flagged is deliberately absent (2.x).
const USAGE_ERA_EVENTS = ['curation.used', 'curation.redirected', 'curation.piped', 'curation.uncovered',
  'curation.skipped', 'curation.pending', 'curation.bypass', 'curation.shaped'];

function getCurationUsageIsolated(project, sinceTs = 0, { dataDir } = {}) {
  const Database = loadSqlite();
  const empty = { historyFromTs: null, usedIds: [] };
  if (!Database) return empty;
  const dir = storeDir({ dataDir });
  const p = dbPath(project, dir);
  if (!fs.existsSync(p)) return empty;
  let db;
  try { db = new Database(p); } catch (e) { console.error('[metrics-store] usage open failed:', p, e.message); return empty; }
  try {
    // "Usage measured since" = the oldest event that only exists since USAGE was tracked
    // (3.0). NOT any curation.* event: curation.flagged dates back to 2.x, which made a
    // 2.x→3.0 install pass the history check on day one and list in-use scripts as
    // "never ran" (pre-release audit: 23 of 42 on a real project).
    const lo = lowerBound(0, floorFor(project, dir)); // the carried-over history belongs to the project-id key now
    const first = db.prepare(`SELECT MIN(ts) AS t FROM metrics_event WHERE ts >= ? AND event_name IN (${USAGE_ERA_EVENTS.map(() => '?').join(',')})`).get(lo, ...USAGE_ERA_EVENTS);
    const rows = db.prepare(`SELECT DISTINCT COALESCE(json_extract(payload,'$.scriptId'), json_extract(payload,'$.shellId')) AS id
                               FROM metrics_event
                              WHERE event_name IN ('curation.used','curation.redirected','curation.piped') AND ts >= ?`).all(Math.max(Number(sinceTs) || 0, lo));
    return { historyFromTs: first && Number.isFinite(first.t) ? first.t : null, usedIds: rows.map((r) => r.id).filter(Boolean) };
  } catch (err) {
    console.error(`[metrics-store] getCurationUsageIsolated(${project}) failed: ${err.message}`);
    return empty;
  } finally {
    try { db.close(); } catch { /* throwaway connection */ }
  }
}

/** Delete metrics_event rows older than `keepDays`. Returns count deleted. */
function cleanupMetrics(keepDays = 30) {
  if (!_db) return 0;
  try {
    const cutoff = Date.now() - keepDays * 86400_000;
    const info = _db.prepare(`DELETE FROM metrics_event WHERE ts < ?`).run(cutoff);
    return info.changes || 0;
  } catch (err) {
    console.error(`[metrics-store] cleanupMetrics failed: ${err.message}`);
    return 0;
  }
}

// Retention of high-volume NOISE rows. These events only ever feed counts in the curation
// panel (curation.skipped by class, shell-escape.* by kind), yet they grew +590/day per
// project with no retention. Raw rows older than
// NOISE_KEEP_DAYS become ONE `metrics.daily` row per (UTC day, event) holding the count, so
// every panel total stays the same; nothing else is touched.
const NOISE_EVENTS = ['curation.skipped', 'shell-escape.rewritten', 'shell-escape.warned', 'shell-escape.denied'];
const NOISE_KEEP_DAYS = 14;
const DAY_MS = 86400_000;

/**
 * Summarize then delete the noise rows of the OPEN project older than `keepDays` (whole UTC
 * days only, so a day is summarized exactly once). One transaction: the summaries and the
 * delete land together or not at all.
 * @returns {{summarized:number, deleted:number}}
 */
function compactNoise({ keepDays = NOISE_KEEP_DAYS, now = Date.now() } = {}) {
  const out = { summarized: 0, deleted: 0 };
  if (!_db) return out;
  const cutoff = Math.floor((now - keepDays * DAY_MS) / DAY_MS) * DAY_MS;
  const marks = NOISE_EVENTS.map(() => '?').join(',');
  try {
    const rows = _db.prepare(`SELECT ts, event_name, payload FROM metrics_event WHERE ts < ? AND event_name IN (${marks})`).all(cutoff, ...NOISE_EVENTS);
    if (!rows.length) return out;
    const days = new Map();
    for (const r of rows) {
      const day = Math.floor(r.ts / DAY_MS) * DAY_MS;
      const key = `${day}|${r.event_name}`;
      let d = days.get(key);
      if (!d) { d = { day, event: r.event_name, count: 0, byClass: {} }; days.set(key, d); }
      d.count++;
      if (r.event_name === 'curation.skipped') {
        const p = safeParseJson(r.payload) || {};
        const cls = p.class === 'inline' ? 'inline' : 'exploration';
        d.byClass[cls] = (d.byClass[cls] || 0) + 1;
      }
    }
    const insert = _db.prepare(`INSERT INTO metrics_event (ts, event_name, payload, session_id, project) VALUES (?, 'metrics.daily', ?, NULL, ?)`);
    const del = _db.prepare(`DELETE FROM metrics_event WHERE ts < ? AND event_name IN (${marks})`);
    // BEGIN/COMMIT by hand: node:sqlite (sqlite-compat) has no transaction() helper.
    _db.exec('BEGIN');
    try {
      for (const d of days.values()) {
        const payload = { day: new Date(d.day).toISOString().slice(0, 10), event: d.event, count: d.count, ...(Object.keys(d.byClass).length ? { byClass: d.byClass } : {}) };
        insert.run(d.day, JSON.stringify(payload), _project || null);
        out.summarized++;
      }
      out.deleted = Number(del.run(cutoff, ...NOISE_EVENTS).changes) || 0;
      _db.exec('COMMIT');
    } catch (err) {
      _db.exec('ROLLBACK');
      throw err;
    }
    return out;
  } catch (err) {
    console.error(`[metrics-store] compactNoise failed (${_project}): ${err.message}`);
    return { summarized: 0, deleted: 0 };
  }
}

/**
 * Row cap of an event read. A TIME-WINDOW read (`sinceTs`) is a total, not a "latest N" peek: the
 * old fixed cap of 500 silently cut the dashboard's 30-day curation summary (it asked for 2000) and
 * the SessionStart digest down to the newest 500 events of each kind.
 */
function windowCap(limit, sinceTs) {
  if (sinceTs != null) return 1_000_000;
  return Math.max(1, Math.min(500, Number(limit) || 50));
}

/** Project names that have a metrics DB on disk (for cross-project aggregation). */
function listProjects({ dataDir } = {}) {
  const base = path.join(storeDir({ dataDir }), 'metrics');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(p => fs.existsSync(path.join(base, p, 'metrics.db')));
}

/**
 * The "already carried over" floor of a project's db: a legacy folder-name db whose history was
 * COPIED into a project-id key (metrics-project.adoptLegacyDb) is marked with the newest ts that
 * copy holds; every read of this db counts only rows AFTER it. Summing both dbs counted that history
 * twice in every total; dropping the whole legacy db instead hid the rows written there later (a
 * same-named repo without an id, sessions still on the previous build) — pre-release audit 3.2.1.
 * @returns {number} 0 when the db was never carried over
 */
function floorFor(project, dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(metricsDir(project, dir), 'adopted.json'), 'utf8'));
    return Number.isFinite(Number(m.at)) ? Number(m.at) : 0;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[metrics-store] adopted.json of ${project} unreadable — no floor: ${err.message}`);
    return 0;
  }
}

/** The lower ts bound of a read: the caller's window, raised past the carried-over floor. */
function lowerBound(sinceTs, floor) {
  return Math.max(sinceTs == null ? 0 : Number(sinceTs), floor > 0 ? floor + 1 : 0);
}

module.exports = {
  init, isReady, close,
  recordMetric, getEventLog, getEventLogIsolated, getCurationUsageIsolated,
  getEvaluationCounts, getEvaluationCountsIsolated,
  getMetricsSummary, cleanupMetrics,
  listProjects, _dbPath: dbPath,
  compactNoise,
  NOISE_EVENTS,
  NOISE_KEEP_DAYS,
  _getDbForTests: () => _db,
  _openCountForTests: () => _open.size,
};
