'use strict';
/**
 * glob-match.js — dependency-free, ReDoS-safe SEGMENT-BASED glob matcher backing
 * the glob-scoped policies (Phase 2 micro-3). A glob policy is surfaced ONLY when
 * an edited file's project-relative path matches one of its patterns, so this
 * matcher runs on the PostToolUse hot path against attacker-influenceable input
 * (a policy glob AND a file path) — it MUST stay polynomial.
 *
 * WHY NOT a RegExp built from the glob: the naive "escape then substitute
 * `*`→`.*`" turns a pattern like `*a*a*a…b` into a regex that backtracks
 * pathologically on a long non-matching string (catastrophic backtracking →
 * ReDoS). Instead we match with two bounded dynamic-programming layers:
 *
 *   1. SEGMENT layer (memoized recursion over `/`-split segments): a glob segment
 *      that is EXACTLY `**` consumes zero-or-more path segments; any other segment
 *      must match exactly ONE path segment via segMatch. O(globSegs × pathSegs)
 *      states, each memoized.
 *   2. CHARACTER layer (segMatch, iterative DP): classic wildcard match within a
 *      single segment — `*` = zero-or-more chars (no `/`), `?` = exactly one char,
 *      everything else literal. O(len(glob) × len(seg)). NO regex.
 *
 * Both layers are bounded by pattern-length × path-length, so the total cost is
 * strictly polynomial regardless of the pattern shape.
 *
 * Normalization (both glob and path): `\`→`/`, strip a single leading `./`.
 * If the glob has NO `/`, it is matched against basename(path) (so `*.ts` matches
 * `src/app.ts`); otherwise against the full normalized path.
 */

/** Normalize a glob or path: `\`→`/`, strip one leading `./`. Non-strings → ''. */
function normalize(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** Basename of an already-normalized (`/`-separated) path. */
function basename(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Character-level wildcard match of a SINGLE glob segment against a single path
 * segment (neither contains `/`). Iterative DP, O(len(g) × len(s)) — no regex, no
 * backtracking. `*` = zero-or-more chars, `?` = exactly one char, else literal.
 * Any `**` inside a non-`**` segment collapses to `*` (defensive; the segment
 * layer already peels off standalone `**`).
 * @param {string} glob
 * @param {string} str
 * @returns {boolean}
 */
function segMatch(glob, str) {
  const g = String(glob).replace(/\*\*/g, '*'); // collapse ** → * within a segment
  const n = g.length;
  const m = str.length;
  // prev = row for pattern prefix length i-1; cur = row for i. prev[j] answers
  // "does g[0..i) match str[0..j)?". prev[0] seeded true (empty matches empty).
  let prev = new Array(m + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= n; i++) {
    const c = g[i - 1];
    const cur = new Array(m + 1).fill(false);
    if (c === '*') {
      cur[0] = prev[0];                                   // '*' can match empty
      for (let j = 1; j <= m; j++) cur[j] = cur[j - 1] || prev[j];
    } else if (c === '?') {
      for (let j = 1; j <= m; j++) cur[j] = prev[j - 1];  // '?' consumes exactly one char
    } else {
      for (let j = 1; j <= m; j++) cur[j] = prev[j - 1] && str[j - 1] === c;
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * Segment-level anchored match with memoized recursion. `**` (a whole segment)
 * consumes zero-or-more path segments; any other segment matches exactly one via
 * segMatch. Full match requires BOTH segment lists fully consumed.
 * @param {string[]} globSegs
 * @param {string[]} pathSegs
 * @returns {boolean}
 */
function segmentsMatch(globSegs, pathSegs) {
  const G = globSegs.length;
  const P = pathSegs.length;
  const memo = new Map();
  function go(gi, pi) {
    const key = gi * (P + 1) + pi;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res;
    if (gi === G) {
      res = pi === P;                                     // both fully consumed
    } else if (globSegs[gi] === '**') {
      // zero path segments (advance glob) OR consume one path segment (advance path)
      res = go(gi + 1, pi) || (pi < P && go(gi, pi + 1));
    } else {
      res = pi < P && segMatch(globSegs[gi], pathSegs[pi]) && go(gi + 1, pi + 1);
    }
    memo.set(key, res);
    return res;
  }
  return go(0, 0);
}

/**
 * Does `glob` match `relPath`? Segment-based, anchored, ReDoS-safe.
 * @param {string} glob
 * @param {string} relPath
 * @returns {boolean}
 */
function matchGlob(glob, relPath) {
  const g = normalize(glob);
  if (g === '') return false;                             // empty pattern matches nothing
  const p = normalize(relPath);
  // No `/` in the glob → match the basename (so `*.ts` matches `src/app.ts`).
  const target = g.includes('/') ? p : basename(p);
  return segmentsMatch(g.split('/'), target.split('/'));
}

/**
 * True if ANY glob in the array matches relPath. Non-array → false.
 * @param {string[]} globs
 * @param {string} relPath
 * @returns {boolean}
 */
function anyGlobMatches(globs, relPath) {
  if (!Array.isArray(globs)) return false;
  for (const g of globs) {
    if (matchGlob(g, relPath)) return true;
  }
  return false;
}

/**
 * The FIRST glob (in array order) that matches relPath, or null. Callers pass a
 * canonically-sorted glob array, so "first" is deterministic — used to explain
 * WHICH rule matched in the post-edit advisory.
 * @param {string[]} globs
 * @param {string} relPath
 * @returns {string|null}
 */
function firstGlobMatch(globs, relPath) {
  if (!Array.isArray(globs)) return null;
  for (const g of globs) {
    if (matchGlob(g, relPath)) return g;
  }
  return null;
}

module.exports = { matchGlob, anyGlobMatches, firstGlobMatch, segMatch };
