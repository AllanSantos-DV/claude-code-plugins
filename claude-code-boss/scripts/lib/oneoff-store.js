'use strict';
/**
 * oneoff-store.js — per-project store of curation "one-hit" decisions + command
 * recurrence counts. Backs the curated-script anti-bloat loop:
 *
 *   - the Stop hook blocks volume-heavy commands; the agent either curates them or
 *     marks them one-hit via the `curation_mark_oneoff` MCP tool;
 *   - every matching invocation bumps a WINDOWED recurrence count (D1/D5);
 *   - once the count crosses the configured ceiling (D2), a one-hit marking is
 *     REFUSED — the command must become a real curated script. One-hit can't be a
 *     permanent bypass.
 *
 * Storage: one JSON file per project under <dataDir>/curation-oneoff/<key>.json —
 * NOT the versioned shells.json (count is dynamic state that would churn git).
 * Identity = canonicalSig(command), so cwd/flags/wrappers don't fragment the count.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalSig } = require('./command-signature.js');

const DAY_MS = 86400_000;
const MAX_SEEN = 50;        // cap of retained per-entry occurrence timestamps
const MAX_SESSIONS = 25;
const MAX_ALIASES = 40;

function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/** Stable per-project key: nearest `.git` ancestor (or cwd) basename + path hash. */
function resolveProjectKey(cwd) {
  let dir = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : process.cwd();
  const start = dir;
  for (let i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) break; } catch { /* unreadable: stop walking */ break; }
    const parent = path.dirname(dir);
    if (parent === dir) { dir = start; break; }
    dir = parent;
  }
  const h = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
  return `${sanitize(path.basename(dir)) || 'root'}-${h}`;
}

function storePath(dataDir, projectKey) {
  return path.join(dataDir, 'curation-oneoff', `${projectKey}.json`);
}

function load(dataDir, projectKey) {
  const p = storePath(dataDir, projectKey);
  try {
    if (!fs.existsSync(p)) return { entries: {} };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && obj.entries ? obj : { entries: {} };
  } catch (err) {
    console.error(`[oneoff-store] load failed (${p}): ${err.message}`);
    return { entries: {} };
  }
}

function save(dataDir, projectKey, store) {
  const p = storePath(dataDir, projectKey);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store));
    return true;
  } catch (err) {
    console.error(`[oneoff-store] save failed (${p}): ${err.message}`);
    return false;
  }
}

function countInWindow(entry, now, windowDays) {
  if (!entry || !Array.isArray(entry.seen)) return 0;
  const cutoff = now - windowDays * DAY_MS;
  return entry.seen.filter(ts => ts >= cutoff).length;
}

/** Match: exact canonical sig, or an alias-sig is a token-prefix of the sig. */
function entryMatchesSig(entry, sig) {
  if (!sig) return false;
  if (entry.sig === sig) return true;
  for (const a of entry.aliasSigs || []) {
    if (a && (sig === a || sig.startsWith(a + ' '))) return true;
  }
  return false;
}

function matchEntry(store, command) {
  const sig = canonicalSig(command);
  if (!sig) return null;
  for (const key of Object.keys(store.entries)) {
    if (entryMatchesSig(store.entries[key], sig)) return store.entries[key];
  }
  return null;
}

function pushCapped(arr, val, cap) {
  arr.push(val);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

/**
 * Record one occurrence of a command. Creates the entry (oneHit:false) when
 * `create` and none matches — so the count exists from the 1st volume-heavy hit,
 * available to orient the agent (O1). Returns { matched, created, oneHit, count, sig }.
 */
function touch(dataDir, projectKey, command, { sessionId, now = Date.now(), windowDays = 90, create = false } = {}) {
  const store = load(dataDir, projectKey);
  let entry = matchEntry(store, command);
  let created = false;
  if (!entry) {
    const sig = canonicalSig(command);
    if (!create || !sig) return { matched: false, created: false, oneHit: false, count: 0, sig };
    entry = { sig, aliases: [], aliasSigs: [], seen: [], sessions: [], firstSeen: now, lastSeen: now, oneHit: false, markedAt: null };
    store.entries[sig] = entry;
    created = true;
  }
  pushCapped(entry.seen, now, MAX_SEEN);
  entry.lastSeen = now;
  if (sessionId && !entry.sessions.includes(sessionId)) pushCapped(entry.sessions, sessionId, MAX_SESSIONS);
  save(dataDir, projectKey, store);
  return { matched: true, created, oneHit: !!entry.oneHit, count: countInWindow(entry, now, windowDays), sig: entry.sig };
}

/**
 * Mark a command (by its aliases) as one-hit, MERGING into an overlapping entry
 * (D3). Refuses (D2) when the windowed count already crossed the ceiling — the
 * command recurs too much to be one-hit and must be curated.
 *
 * @returns {{ decision:'marked'|'merged'|'rejected', sig, count, sessions?, aliases? }}
 */
function mark(dataDir, projectKey, { aliases = [], sessionId, now = Date.now(), maxRecurrence = 3, windowDays = 90 } = {}) {
  const store = load(dataDir, projectKey);
  const cleanAliases = [...new Set((Array.isArray(aliases) ? aliases : []).map(a => String(a || '').trim()).filter(Boolean))];
  const aliasSigs = [...new Set(cleanAliases.map(canonicalSig).filter(Boolean))];
  const sig = aliasSigs[0];
  if (!sig) return { decision: 'rejected', sig: '', count: 0, reason: 'empty-signature' };

  let entry = null;
  for (const key of Object.keys(store.entries)) {
    const e = store.entries[key];
    if (aliasSigs.some(s => entryMatchesSig(e, s))) { entry = e; break; }
  }

  const existingCount = entry ? countInWindow(entry, now, windowDays) : 0;
  if (existingCount >= maxRecurrence) {
    return { decision: 'rejected', sig: entry.sig, count: existingCount, sessions: (entry.sessions || []).slice(), aliases: (entry.aliases || []).slice() };
  }

  if (entry) {
    entry.aliases = [...new Set([...(entry.aliases || []), ...cleanAliases])].slice(0, MAX_ALIASES);
    entry.aliasSigs = [...new Set([...(entry.aliasSigs || []), ...aliasSigs])].slice(0, MAX_ALIASES);
    entry.oneHit = true;
    entry.markedAt = now;
    entry.lastSeen = now;
    if (sessionId && !entry.sessions.includes(sessionId)) pushCapped(entry.sessions, sessionId, MAX_SESSIONS);
    save(dataDir, projectKey, store);
    return { decision: 'merged', sig: entry.sig, count: countInWindow(entry, now, windowDays), aliases: entry.aliases.slice() };
  }

  store.entries[sig] = {
    sig, aliases: cleanAliases, aliasSigs, seen: [],
    sessions: sessionId ? [sessionId] : [], firstSeen: now, lastSeen: now, oneHit: true, markedAt: now,
  };
  save(dataDir, projectKey, store);
  return { decision: 'marked', sig, count: 0, aliases: cleanAliases.slice() };
}

/** Remove entries with no occurrence/marking inside the window (cold). #removed. */
function prune(dataDir, projectKey, { now = Date.now(), windowDays = 90 } = {}) {
  const store = load(dataDir, projectKey);
  const cutoff = now - windowDays * DAY_MS;
  let removed = 0;
  for (const key of Object.keys(store.entries)) {
    const e = store.entries[key];
    const fresh = (e.lastSeen && e.lastSeen >= cutoff) || (e.markedAt && e.markedAt >= cutoff);
    if (!fresh) { delete store.entries[key]; removed++; }
  }
  if (removed) save(dataDir, projectKey, store);
  return removed;
}

/** Panorama for SessionStart (O3). */
function summary(dataDir, projectKey) {
  const store = load(dataDir, projectKey);
  const keys = Object.keys(store.entries);
  return { oneHits: keys.filter(k => store.entries[k].oneHit).length, total: keys.length };
}

module.exports = {
  resolveProjectKey, storePath, load, save,
  touch, mark, prune, summary, matchEntry, countInWindow, entryMatchesSig,
};
