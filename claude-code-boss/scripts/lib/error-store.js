'use strict';
/**
 * error-store.js — per-project durable store of Bash command FAILURES, keyed by
 * canonicalSig. Backs the deterministic error-guard (Phase 2 micro-1):
 *
 *   - failure-detect.js (PostToolUseFailure) RECORDS each Bash failure here,
 *     bumping a WINDOWED count for the command's canonical signature;
 *   - error-guard.js (PreToolUse) LOOKS UP the next Bash command — when its sig
 *     already failed >= threshold times in the window, the guard DENIES the
 *     re-run and injects the recorded cause, so the agent stops looping on a
 *     known-failing command and fixes the cause first;
 *   - error-resolve.js (PostToolUse success) RESOLVES (clears) the sig, so a
 *     command that later PASSES is no longer guarded (no false-positive block).
 *
 * Deterministic: identity is the exact canonicalSig (NO semantic search, NO
 * LLM), so cwd/flags/wrappers don't fragment the count. Mirrors oneoff-store.js
 * (atomic writes, capped arrays, best-effort load with console.error — never an
 * empty catch). Storage: one JSON file per project under
 * <dataDir>/error-guard/<key>.json — dynamic runtime state, NOT versioned.
 *
 * The project key is computed by oneoff-store.resolveProjectKey (imported, not
 * re-derived) so the failure store and the curation store agree on the key.
 */
const fs = require('fs');
const path = require('path');
const { canonicalSig } = require('./command-signature.js');
const { resolveProjectKey } = require('./oneoff-store.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DAY_MS = 86400_000;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_THRESHOLD = 2;
const MAX_SEEN = 50;        // cap of retained per-entry failure timestamps
const MAX_SESSIONS = 25;
const MAX_CAUSE = 500;      // cap of retained cause text (matches buildEntry snippet)

// The project key is already sanitized by resolveProjectKey (basename+hash), so
// like oneoff-store this path builder trusts it — no user string reaches the path.
function storePath(dataDir, projectKey) {
  return path.join(dataDir, 'error-guard', `${projectKey}.json`);
}

function load(dataDir, projectKey) {
  const p = storePath(dataDir, projectKey);
  try {
    if (!fs.existsSync(p)) return { entries: {} };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && obj.entries ? obj : { entries: {} };
  } catch (err) {
    console.error(`[error-store] load failed (${p}): ${err.message}`);
    return { entries: {} };
  }
}

// Best-effort, last-writer-wins: writeJsonAtomic publishes tear-free, but two
// concurrent load->mutate->save cycles can still lose an update (see atomic-write.js).
function save(dataDir, projectKey, store) {
  const p = storePath(dataDir, projectKey);
  try {
    writeJsonAtomic(p, store);
    return true;
  } catch (err) {
    console.error(`[error-store] save failed (${p}): ${err.message}`);
    return false;
  }
}

function countInWindow(entry, now, windowDays) {
  if (!entry || !Array.isArray(entry.seen)) return 0;
  const cutoff = now - windowDays * DAY_MS;
  return entry.seen.filter(ts => ts >= cutoff).length;
}

/** Exact-sig match: this store keys entries by canonicalSig (no aliases). */
function matchEntry(store, sig) {
  if (!sig || !store || !store.entries) return null;
  return store.entries[sig] || null;
}

function pushCapped(arr, val, cap) {
  arr.push(val);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

/**
 * Record one Bash failure for `command`. Upserts the entry keyed by
 * canonicalSig(command): bumps the windowed `seen[]`, refreshes the latest
 * `cause`/`exitCode`, and tracks the session. Returns the current windowed count.
 * @returns {{ recorded:boolean, sig:string, count:number }}
 */
function record(dataDir, projectKey, { command, cause, exitCode = null, sessionId, now = Date.now() } = {}) {
  const sig = canonicalSig(command);
  if (!sig) return { recorded: false, sig: '', count: 0 };
  const store = load(dataDir, projectKey);
  let entry = store.entries[sig];
  if (!entry) {
    entry = { sig, seen: [], cause: '', exitCode: null, sessions: [], firstSeen: now, lastSeen: now };
    store.entries[sig] = entry;
  }
  pushCapped(entry.seen, now, MAX_SEEN);
  entry.lastSeen = now;
  if (typeof cause === 'string' && cause) entry.cause = cause.slice(0, MAX_CAUSE);
  entry.exitCode = Number.isFinite(exitCode) ? exitCode : null;
  if (sessionId && !entry.sessions.includes(sessionId)) pushCapped(entry.sessions, sessionId, MAX_SESSIONS);
  save(dataDir, projectKey, store);
  return { recorded: true, sig, count: countInWindow(entry, now, DEFAULT_WINDOW_DAYS) };
}

/**
 * Look up whether re-running `command` should be blocked. `hit` is true only
 * when the sig's WINDOWED failure count is >= threshold — below it the command
 * gets the benefit of the doubt (a single flaky failure never blocks).
 * @returns {{ hit:boolean, sig:string, count:number, cause?:string, exitCode?:number|null }}
 */
function lookup(dataDir, projectKey, command, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, threshold = DEFAULT_THRESHOLD } = {}) {
  const sig = canonicalSig(command);
  if (!sig) return { hit: false, sig: '', count: 0 };
  const store = load(dataDir, projectKey);
  const entry = matchEntry(store, sig);
  if (!entry) return { hit: false, sig, count: 0 };
  const count = countInWindow(entry, now, windowDays);
  if (count >= threshold) {
    return { hit: true, sig, count, cause: entry.cause || '', exitCode: entry.exitCode ?? null };
  }
  return { hit: false, sig, count };
}

/**
 * Clear the failure record for `command`'s sig — called when the command later
 * SUCCEEDS, so a fixed/now-passing command stops being guarded (prevents a
 * false-positive DENY after the cause is fixed). No-op (no write) when the sig
 * was never recorded, so a success on a healthy command doesn't churn the store.
 * @returns {{ resolved:boolean, sig:string }}
 */
function resolve(dataDir, projectKey, command, { now = Date.now() } = {}) {
  void now; // accepted for signature symmetry; resolve clears unconditionally.
  const sig = canonicalSig(command);
  if (!sig) return { resolved: false, sig: '' };
  const store = load(dataDir, projectKey);
  if (!store.entries[sig]) return { resolved: false, sig };
  delete store.entries[sig];
  save(dataDir, projectKey, store);
  return { resolved: true, sig };
}

/** Remove entries with no failure inside the window (cold). Returns #removed. */
function prune(dataDir, projectKey, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const store = load(dataDir, projectKey);
  const cutoff = now - windowDays * DAY_MS;
  let removed = 0;
  for (const key of Object.keys(store.entries)) {
    const e = store.entries[key];
    const fresh = e.lastSeen && e.lastSeen >= cutoff;
    if (!fresh) { delete store.entries[key]; removed++; }
  }
  if (removed) save(dataDir, projectKey, store);
  return removed;
}

module.exports = {
  resolveProjectKey, storePath, load, save,
  record, lookup, resolve, prune, matchEntry, countInWindow,
};
