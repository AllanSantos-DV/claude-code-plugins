/**
 * sqlite-compat.js — backend-agnostic SQLite loader (zero native deps by default).
 *
 * WHY: `better-sqlite3` is a native addon that needs node-gyp + a C++ toolchain
 * to compile. On fresh machines (no Build Tools) or newer Node with no prebuilt
 * binary, `npm install` fails and the Brain DB silently degrades. Node ships a
 * built-in SQLite (`node:sqlite`) since v22.5 — no flag since v22.13 / v23.4 —
 * which works on any modern Node with nothing to compile or download.
 *
 * Resolution order (first that loads wins, cached):
 *   1. node:sqlite           — built-in, preferred, zero install cost
 *   2. better-sqlite3        — legacy compiled fallback, only if already present
 *   3. null                  — caller degrades (brain-store → JSON, others → no-op)
 *
 * `loadSqlite()` NEVER throws — it returns a constructor or null. This keeps call
 * sites free of return-only catch blocks (a CI-enforced rule) and lets each
 * consumer choose its own degradation path.
 *
 * The returned constructor exposes the subset of the better-sqlite3 surface this
 * plugin actually uses, so existing call sites work unchanged:
 *   const Database = loadSqlite();
 *   const db = new Database(path, { readonly: true });
 *   db.pragma('journal_mode = WAL');   // routed to exec() on node:sqlite
 *   db.exec(sql);
 *   const stmt = db.prepare(sql);
 *   stmt.run(...args);  // { changes, lastInsertRowid }
 *   stmt.get(...args);  // object | undefined
 *   stmt.all(...args);  // object[]
 *   db.close();
 *
 * node:sqlite API deltas bridged here (validated against Node v26 docs,
 * https://nodejs.org/api/sqlite.html):
 *   - constructor option is `readOnly` (camelCase), not better-sqlite3's `readonly`
 *   - there is no `.pragma()` method → PRAGMAs go through `.exec('PRAGMA …')`
 *   - BLOB columns read back as `Uint8Array`, not Node `Buffer` (callers that
 *     decode BLOBs must handle both — see brain-store `blobToVector`)
 */
'use strict';

let _resolved; // undefined = not resolved yet; (function|null) once resolved
let _backend = 'none';
let _warningPatched = false;

/**
 * Drop ONLY the benign "SQLite is an experimental feature" ExperimentalWarning
 * that node:sqlite emits once per process. It goes to stderr and would otherwise
 * print on every hook invocation (and leak into aggregated hook-error logs).
 * Every other process warning is passed through untouched.
 */
function suppressSqliteExperimentalWarning() {
  if (_warningPatched) return;
  _warningPatched = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    const msg = typeof warning === 'string'
      ? warning
      : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return original(warning, ...rest);
  };
}

/** Wrap node:sqlite's DatabaseSync in the better-sqlite3-compatible surface. */
function makeNodeSqliteCtor(DatabaseSync) {
  class Statement {
    constructor(stmt) { this._stmt = stmt; }
    run(...args) { return this._stmt.run(...args); }
    get(...args) { return this._stmt.get(...args); }
    all(...args) { return this._stmt.all(...args); }
  }

  return class Database {
    constructor(filename, opts = {}) {
      const options = {};
      // better-sqlite3 `readonly` → node:sqlite `readOnly`
      if (opts.readonly) options.readOnly = true;
      this._db = new DatabaseSync(filename, options);
    }

    // better-sqlite3 `.pragma('k = v')`; node:sqlite has no pragma() → route to exec.
    pragma(statement) {
      this._db.exec(`PRAGMA ${statement}`);
      return undefined;
    }

    exec(sql) { return this._db.exec(sql); }
    prepare(sql) { return new Statement(this._db.prepare(sql)); }
    close() { return this._db.close(); }
  };
}

function tryNodeSqlite() {
  let mod;
  try {
    suppressSqliteExperimentalWarning();
    mod = require('node:sqlite');
  } catch (err) {
    // node:sqlite absent (Node < 22.5 or built without SQLite) — try next backend.
    if (process.env.BRAIN_DEBUG) {
      console.error(`[sqlite-compat] node:sqlite unavailable: ${err.message}`);
    }
    return null;
  }
  if (!mod || typeof mod.DatabaseSync !== 'function') return null;
  _backend = 'node:sqlite';
  return makeNodeSqliteCtor(mod.DatabaseSync);
}

function tryBetterSqlite3() {
  try {
    const Database = require('better-sqlite3');
    _backend = 'better-sqlite3';
    return Database;
  } catch (err) {
    // Not installed / failed to build — expected on the zero-native-dep path.
    if (process.env.BRAIN_DEBUG) {
      console.error(`[sqlite-compat] better-sqlite3 unavailable: ${err.message}`);
    }
    return null;
  }
}

/**
 * Resolve a SQLite Database constructor, preferring the built-in backend.
 * Returns null when no SQLite backend is available (caller must degrade).
 * Result is cached for the lifetime of the process.
 * @returns {Function|null}
 */
function loadSqlite() {
  if (_resolved !== undefined) return _resolved;
  _resolved = tryNodeSqlite() || tryBetterSqlite3() || null;
  return _resolved;
}

/**
 * Name of the resolved backend: 'node:sqlite' | 'better-sqlite3' | 'none'.
 * Calls loadSqlite() so the value is accurate even if queried first.
 * @returns {string}
 */
function getSqliteBackend() {
  loadSqlite();
  return _backend;
}

module.exports = { loadSqlite, getSqliteBackend };
