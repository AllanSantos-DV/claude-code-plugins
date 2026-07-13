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
const os = require('os');
const { loadSqlite } = require('./sqlite-compat');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

const VALID_EVENT_NAME = /^[a-z][a-z0-9._-]{1,63}$/;

let _db = null;
let _project = null;

function metricsDir(project) {
  return path.join(STORE_DIR, 'metrics', project);
}

function dbPath(project) {
  return path.join(metricsDir(project), 'metrics.db');
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
function migrateLegacyIfNeeded(project, db) {
  const marker = path.join(metricsDir(project), '.migrated-from-brain-db');
  if (fs.existsSync(marker)) return;
  try {
    const legacyPath = path.join(STORE_DIR, 'brain', project, 'brain.db');
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

/** Open (or reuse) the metrics DB for `project`. Never throws; false = unavailable. */
function init({ project = 'default' } = {}) {
  if (_db && _project === project) return true;
  if (_db) close();
  const Database = loadSqlite();
  if (!Database) return false;
  try {
    fs.mkdirSync(metricsDir(project), { recursive: true });
    _db = new Database(dbPath(project));
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('busy_timeout = 5000');
    createTables(_db);
    _project = project;
    migrateLegacyIfNeeded(project, _db);
    return true;
  } catch (err) {
    console.error(`[metrics-store] init failed (${project}): ${err.message}`);
    _db = null;
    _project = null;
    return false;
  }
}

function isReady() { return !!_db; }

function close() {
  if (_db) { try { _db.close(); } catch { /* noop */ } }
  _db = null;
  _project = null;
}

function safeParseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { /* non-JSON value: null */ return null; }
}

/** Append a single event row. Returns inserted id (or 0 on no-op/failure). */
function recordMetric(eventName, payload, sessionId) {
  if (!_db || !eventName || !VALID_EVENT_NAME.test(eventName)) return 0;
  try {
    const info = _db.prepare(
      `INSERT INTO metrics_event (ts, event_name, payload, session_id, project) VALUES (?, ?, ?, ?, ?)`
    ).run(
      Date.now(), eventName, payload ? JSON.stringify(payload) : null, sessionId || null, _project || null,
    );
    return Number(info.lastInsertRowid) || 0;
  } catch (err) {
    console.error(`[metrics-store] recordMetric(${eventName}) failed: ${err.message}`);
    return 0;
  }
}

/** List recent raw events (newest first) for the currently-open project. */
function getEventLog({ eventName = null, limit = 50 } = {}) {
  if (!_db) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  try {
    const rows = eventName
      ? _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event WHERE event_name = ? ORDER BY ts DESC LIMIT ?`).all(eventName, cap)
      : _db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                       FROM metrics_event ORDER BY ts DESC LIMIT ?`).all(cap);
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
 */
function getEventLogIsolated(project, { eventName = null, limit = 50 } = {}) {
  const Database = loadSqlite();
  if (!Database) return [];
  const p = dbPath(project);
  if (!fs.existsSync(p)) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  let db;
  try { db = new Database(p); } catch (e) { console.error('[metrics-store] isolated open failed:', p, e.message); return []; }
  try {
    const rows = eventName
      ? db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                      FROM metrics_event WHERE event_name = ? ORDER BY ts DESC LIMIT ?`).all(eventName, cap)
      : db.prepare(`SELECT id, ts, event_name, payload, session_id, project
                      FROM metrics_event ORDER BY ts DESC LIMIT ?`).all(cap);
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

/** Aggregate counts per event_name within a time window (days back from now). */
function getMetricsSummary(rangeDays = 7) {
  const empty = { totals: {}, daily: [], windowMs: rangeDays * 86400_000, sinceTs: 0 };
  if (!_db) return empty;
  try {
    const sinceTs = Date.now() - rangeDays * 86400_000;
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

/** Project names that have a metrics DB on disk (for cross-project aggregation). */
function listProjects() {
  const base = path.join(STORE_DIR, 'metrics');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(p => fs.existsSync(path.join(base, p, 'metrics.db')));
}

module.exports = {
  init, isReady, close,
  recordMetric, getEventLog, getEventLogIsolated, getMetricsSummary, cleanupMetrics,
  listProjects,
  _getDbForTests: () => _db,
};
