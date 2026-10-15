'use strict';
/**
 * metrics-memo.js — per-project memo of read-only metrics queries, invalidated by the project's own files.
 *
 * The dashboard answers every panel by opening each project's metrics.db in turn (hundreds of them) and running
 * one query per panel; the same untouched databases were reopened dozens of times per visit. A result is reused
 * only while the signature of the files it was read from is unchanged: size + mtime of `metrics.db`, its `-wal`
 * sidecar (WAL writes land there first) and `adopted.json` (it moves the read floor). Any write by any session
 * changes the signature, so a reused result is never older than the data — the cost left is one `stat` per file.
 *
 * Callers put time-relative bounds into the key already rounded (see `bucketTs`), so a window that slides with
 * the clock still hits between rounding steps; the caller re-filters to the exact bound.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX = 6000;

/** Signature of the files a project's metrics are read from; a missing file is part of it (created later = changed). */
function dbSignature(dbFile, stat = fs.statSync) {
  const dir = path.dirname(dbFile);
  return [dbFile, `${dbFile}-wal`, path.join(dir, 'adopted.json')].map((f) => {
    try { const s = stat(f); return `${s.size}:${s.mtimeMs}`; } catch (err) {
      if (err.code === 'ENOENT') return '-';
      throw err;
    }
  }).join('|');
}

/** Round a timestamp down to `stepMs` — a superset lower bound for a query the caller re-filters. */
const bucketTs = (ts, stepMs = 300000) => Math.floor(ts / stepMs) * stepMs;

/**
 * `compute` returning undefined is not remembered.
 * `sigTtlMs` lets a signature read be reused for that long (the memo can then lag a write by at most that).
 * @param {{max?:number, signatureOf:(project:string)=>string, sigTtlMs?:number, now?:()=>number}} opts
 * @returns {{get:(project:string, key:string, compute:()=>any)=>any, size:()=>number, clear:()=>void, stats:()=>{hits:number,misses:number}}}
 */
function createMemo({ max = DEFAULT_MAX, signatureOf, sigTtlMs = 0, now = Date.now }) {
  const sigs = new Map(); // project → { at, sig }: one panel visit asks a dozen queries, one stat sweep serves them all
  const sigFor = (project) => {
    const c = sigs.get(project);
    if (c && now() - c.at < sigTtlMs) return c.sig;
    const sig = signatureOf(project);
    sigs.set(project, { at: now(), sig });
    return sig;
  };
  const map = new Map(); // `${project}\0${key}` → { sig, value }; insertion order = recency
  let hits = 0;
  let misses = 0;
  return {
    get(project, key, compute) {
      const sig = sigFor(project);
      const k = `${project}\0${key}`;
      const e = map.get(k);
      if (e && e.sig === sig) { hits++; map.delete(k); map.set(k, e); return e.value; }
      misses++;
      const value = compute();
      if (value === undefined) return value; // nothing to remember (e.g. the store could not be opened)
      map.delete(k);
      map.set(k, { sig, value });
      if (map.size > max) map.delete(map.keys().next().value);
      return value;
    },
    size: () => map.size,
    clear: () => { map.clear(); sigs.clear(); },
    stats: () => ({ hits, misses }),
  };
}

module.exports = { createMemo, dbSignature, bucketTs };
