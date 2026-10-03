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
const { writeJsonAtomic } = require('./atomic-write.js');

const DAY_MS = 86400_000;
const MAX_SEEN = 50;        // cap of retained per-entry occurrence timestamps
const MAX_SESSIONS = 25;
const MAX_ALIASES = 40;

function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/** Stable per-project key: nearest `.git` ancestor (or cwd) basename + path hash. */
function resolveProjectKey(cwd) {
  // A given-but-missing cwd still names the caller's folder; never swap in process.cwd()
  // (in the shared daemon that is another session's project).
  let dir = cwd ? path.resolve(cwd) : process.cwd();
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

// A key written before the signature fix can be a bare `VAR=value` segment:
// canonicalSig used to treat an assignment-only segment as the command, so
// `D="/proj"; sed ...` signed as the ASSIGNMENT. Such a key is unproducible now,
// and it was never silenceable either -- isGenericAlias rejects a 1-token sig, so
// curation_mark_oneoff refused it. All it could do was accumulate recurrence and
// force a block the agent had no way to clear. Drop it on load; the next save()
// persists the cleanup. Self-healing migration -- no version gate needed, because
// the current signature algorithm can never mint one of these again.
const ASSIGN_ONLY_KEY = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/**
 * Drop store keys the current canonicalSig can no longer produce. Mutates + returns.
 *
 * Two independent rules, because neither subsumes the other:
 *
 *  1. NON-IDEMPOTENT keys. Every key was minted BY canonicalSig, so re-signing a key
 *     must return the key itself. When it doesn't, the key came from an older version
 *     of the algorithm and no live command can ever produce it again -- it can only
 *     sit there accumulating a count nothing will match. This rule is generic: it
 *     self-heals across ANY future signature change, instead of needing a new regex
 *     per fix (the `\|`-cut fix and the newline-fusion fix each left such keys).
 *  2. ASSIGN_ONLY keys -- see above. These ARE fixed points (`D="/proj"` re-signs to
 *     itself), so rule 1 does not catch them; the regex is still required.
 *
 * Cost is one canonicalSig per key per load (tens of keys) -- pure string work.
 */
function pruneOrphanKeys(store) {
  if (!store || !store.entries) return store;
  for (const k of Object.keys(store.entries)) {
    if (ASSIGN_ONLY_KEY.test(k) || canonicalSig(k) !== k) { delete store.entries[k]; continue; }
    const e = store.entries[k];
    // 3. UNRELATED alias sigs. A batch mark used to coalesce every passed sig into
    //    ONE entry, so `ssh mac-ts ...` carried aliasSigs [`grep ...`, `git diff`]:
    //    every later `git diff` bumped the ssh entry (observed at 50/3) and the Stop
    //    reason blamed the ssh sig, which mark_oneoff then refused past the ceiling.
    //    Detach them; the unrelated commands get their own entries on next sight.
    if (Array.isArray(e.aliasSigs)) e.aliasSigs = e.aliasSigs.filter(a => sigsRelated(a, k));
  }
  return store;
}

/** Same command family: equal, or one is a whole-token prefix of the other. */
function sigsRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

/**
 * A 1-token sig (`node`, `pytest`) can't be curated — curation_register_shell
 * refuses 1-token aliases — so the recurrence ceiling is unenforceable for it:
 * holding it to one would leave a flagged sig with NO sanctioned way to clear it.
 * Such a sig is marked by EXACT match only (never as a prefix alias) and stays
 * suppressible regardless of count.
 * Only a PROGRAM NAME qualifies: a junk token (`2` from an old `>&2` split, a bare
 * `heredoc-<digest>`) pooled unrelated commands, and exempting it would silence
 * them all forever. Those keep the ceiling and age out of the window.
 */
// A program run by RELATIVE path (`./gradlew`, `bin/build.sh`, `../tools/x`) is just as
// much a program — and a 1-token sig the MCP refuses as an alias, so without the
// exemption it could never be marked. Absolute paths stay out (machine-specific).
const PROGRAM_NAME = /^(?:\.{1,2}\/)?(?:[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\/)*[A-Za-z_][A-Za-z0-9_.+-]*$/;
function isCeilingExempt(sig) {
  if (!sig) return false;
  const toks = sig.split(' ').filter(Boolean);
  return toks.length === 1 && PROGRAM_NAME.test(toks[0]) && !toks[0].startsWith('heredoc-');
}

function load(dataDir, projectKey) {
  const p = storePath(dataDir, projectKey);
  try {
    if (!fs.existsSync(p)) return { entries: {} };
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj && typeof obj === 'object' && obj.entries ? pruneOrphanKeys(obj) : { entries: {} };
  } catch (err) {
    console.error(`[oneoff-store] load failed (${p}): ${err.message}`);
    return { entries: {} };
  }
}

// Best-effort, last-writer-wins: writeJsonAtomic publishes tear-free, but two
// concurrent load→mutate→save cycles can still lose an update (see atomic-write.js).
function save(dataDir, projectKey, store) {
  const p = storePath(dataDir, projectKey);
  try {
    writeJsonAtomic(p, store);
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

/**
 * True when a command/sig is covered by a VALID one-hit marking (marked AND still
 * under the recurrence ceiling) — the same suppression rule curation-detect
 * applies, exposed so curation-stop can reconcile blocked entries mid-retry.
 */
function isOneHit(store, { command, sig } = {}, { now = Date.now(), windowDays = 90, maxRecurrence = 3 } = {}) {
  const s = (sig && String(sig).trim()) || canonicalSig(command || '');
  if (!s) return false;
  for (const key of Object.keys(store.entries)) {
    const e = store.entries[key];
    if (e.oneHit && entryMatchesSig(e, s)) {
      return isCeilingExempt(e.sig) || countInWindow(e, now, windowDays) < maxRecurrence;
    }
  }
  return false;
}

/**
 * True when ANY one-hit marking landed at/after `sinceMs` — a good-faith progress
 * signal for the Stop hook even when the marked sig didn't match the blocked
 * entries (the agent acted on the block; don't deadlock it).
 */
function markedSince(store, sinceMs) {
  if (!Number.isFinite(sinceMs)) return false;
  return Object.keys(store.entries).some(k => {
    const e = store.entries[k];
    return e.oneHit && Number.isFinite(e.markedAt) && e.markedAt >= sinceMs;
  });
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
  return { matched: true, created, oneHit: !!entry.oneHit, count: countInWindow(entry, now, windowDays), sig: entry.sig, ceilingExempt: isCeilingExempt(entry.sig) };
}

/**
 * Mark commands (by their aliases and/or exact canonical sigs) as one-hit.
 *
 * Each DISTINCT signature is resolved on its own: it MERGES into the entry that
 * already matches it (D3) or gets a fresh entry. A batch call used to coalesce
 * every passed sig into ONE entry, pooling unrelated commands' recurrence — the
 * next `git diff` then bumped (and was reported under) an unrelated `ssh ...` sig
 * past the ceiling. Aliases ride with the sig they canonicalize to.
 *
 * Refuses (D2) a sig whose windowed count already crossed the ceiling — it recurs
 * too much to be one-hit and must be curated. A refusal is per-sig: the rest of a
 * batch still registers. 1-token sigs are ceiling-exempt and exact-match only
 * (see isCeilingExempt).
 *
 * `sigs` are canonical signatures taken verbatim (e.g. copied from the Stop-hook
 * reason's `sig \`...\``) — preferred over aliases because they match the store
 * exactly, with no alias→sig derivation to get wrong.
 *
 * @returns {{ decision:'marked'|'merged'|'rejected', sig, signatures?, count, sessions?, aliases?, rejected? }}
 *   `sig` is the REPRESENTATIVE (first registered) signature; `signatures`
 *   (marked/merged only) is the COMPLETE set covered by every touched entry, so a
 *   batch caller sees all that registered. `rejected` lists the per-sig refusals
 *   ({ sig, count }) — present whenever at least one sig was refused.
 */
function mark(dataDir, projectKey, { aliases = [], sigs = [], sessionId, now = Date.now(), maxRecurrence = 3, windowDays = 90 } = {}) {
  const store = load(dataDir, projectKey);
  const cleanAliases = [...new Set((Array.isArray(aliases) ? aliases : []).map(a => String(a || '').trim()).filter(Boolean))];
  const explicitSigs = [...new Set((Array.isArray(sigs) ? sigs : []).map(s => String(s || '').trim()).filter(Boolean))];
  // sig → raw aliases that canonicalize to it (insertion order = caller order).
  const groups = new Map();
  for (const s of explicitSigs) if (!groups.has(s)) groups.set(s, []);
  for (const a of cleanAliases) {
    const s = canonicalSig(a);
    if (!s) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(a);
  }
  if (groups.size === 0) return { decision: 'rejected', sig: '', count: 0, reason: 'empty-signature' };

  const touched = [];   // { entry, created }
  const rejected = [];  // { sig, count, entry }
  for (const [sig, rawAliases] of groups) {
    const exempt = isCeilingExempt(sig);
    // A 1-token sig matches by exact key only — as a prefix alias it would
    // silence every `node <anything>`.
    let entry = exempt ? (store.entries[sig] || null) : null;
    if (!exempt) {
      for (const key of Object.keys(store.entries)) {
        if (entryMatchesSig(store.entries[key], sig)) { entry = store.entries[key]; break; }
      }
    }
    const count = entry ? countInWindow(entry, now, windowDays) : 0;
    if (!exempt && count >= maxRecurrence) { rejected.push({ sig: entry.sig, count, entry }); continue; }
    const created = !entry;
    if (created) {
      entry = { sig, aliases: [], aliasSigs: [], seen: [], sessions: [], firstSeen: now, lastSeen: now, oneHit: true, markedAt: now };
      store.entries[sig] = entry;
    }
    entry.aliases = [...new Set([...(entry.aliases || []), ...rawAliases])].slice(0, MAX_ALIASES);
    // Only a RELATED sig joins aliasSigs (an unrelated one is already covered by the
    // alias that matched it, and pruneOrphanKeys would detach it anyway).
    if (!exempt && sigsRelated(sig, entry.sig)) {
      entry.aliasSigs = [...new Set([...(entry.aliasSigs || []), sig])].slice(0, MAX_ALIASES);
    }
    entry.oneHit = true;
    entry.markedAt = now;
    entry.lastSeen = now;
    if (sessionId && !entry.sessions.includes(sessionId)) pushCapped(entry.sessions, sessionId, MAX_SESSIONS);
    if (!touched.some(t => t.entry === entry)) touched.push({ entry, created });
  }

  const rejectedOut = rejected.map(r => ({ sig: r.sig, count: r.count }));
  if (touched.length === 0) {
    const first = rejected[0];
    return { decision: 'rejected', sig: first.sig, count: first.count, sessions: (first.entry.sessions || []).slice(), aliases: (first.entry.aliases || []).slice(), rejected: rejectedOut };
  }
  save(dataDir, projectKey, store);
  const head = touched[0].entry;
  const signatures = [...new Set(touched.flatMap(t => [t.entry.sig, ...(t.entry.aliasSigs || [])]))];
  const out = {
    decision: touched.every(t => t.created) ? 'marked' : 'merged',
    sig: head.sig,
    signatures,
    count: countInWindow(head, now, windowDays),
    aliases: [...new Set(touched.flatMap(t => t.entry.aliases || []))],
  };
  if (rejectedOut.length) out.rejected = rejectedOut;
  return out;
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
  pruneOrphanKeys,
  resolveProjectKey, storePath, load, save,
  touch, mark, prune, summary, matchEntry, countInWindow, entryMatchesSig,
  isOneHit, markedSince, sigsRelated, isCeilingExempt,
};
