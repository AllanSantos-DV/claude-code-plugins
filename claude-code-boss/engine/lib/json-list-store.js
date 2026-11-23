'use strict';
/**
 * json-list-store.js — a per-project JSON file holding ONE array under `key`
 * ({ [key]: [...] }): the shared body of the adjudication, revision-ledger and
 * trigger-evidence stores. Best-effort, last-writer-wins; never throws.
 */
const fs = require('fs');
const { writeJsonAtomic, retryTransient, markUnreadable, isUnreadable } = require('./atomic-write.js');

/**
 * The store at `file`; a missing/corrupt/unreadable file → `{ [key]: [] }` (logged when not missing).
 * A file that exists but could not be read comes back marked, and `appendCapped` will not write over it.
 */
function loadList(file, key, label) {
  try {
    if (!fs.existsSync(file)) return { [key]: [] };
    const obj = JSON.parse(retryTransient(() => fs.readFileSync(file, 'utf-8')));
    return obj && typeof obj === 'object' && Array.isArray(obj[key]) ? obj : { [key]: [] };
  } catch (err) {
    console.error(`[${label}] load failed (${file}): ${err.message}`);
    const empty = { [key]: [] };
    return err instanceof SyntaxError ? empty : markUnreadable(empty);
  }
}

/** Append `record` (already normalized), keep the newest `max`. Returns false + logs on failure. */
function appendCapped(file, key, label, record, max) {
  try {
    const store = loadList(file, key, label);
    if (isUnreadable(store)) {
      console.error(`[${label}] append skipped (${file}): the store could not be read, so writing it would erase every record`);
      return false;
    }
    store[key].push(record);
    if (store[key].length > max) store[key] = store[key].slice(store[key].length - max);
    writeJsonAtomic(file, store);
    return true;
  } catch (err) {
    console.error(`[${label}] append failed: ${err.message}`);
    return false;
  }
}

/** Newest first, optionally only one `policyId`. */
function newestByPolicy(list, policyId) {
  let out = list.slice();
  if (policyId != null && policyId !== '') {
    const want = String(policyId);
    out = out.filter((r) => r && String(r.policyId) === want);
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

module.exports = { loadList, appendCapped, newestByPolicy };
