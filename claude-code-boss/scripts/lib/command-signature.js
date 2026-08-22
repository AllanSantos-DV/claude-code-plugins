'use strict';
/**
 * command-signature.js — canonical signature of a raw shell command.
 *
 * The curation one-hit/recurrence store must count the SAME command consistently
 * across cwd, flags and wrappers, so a one-hit marking can't be fragmented (and a
 * recurring command can't masquerade as new). This module derives that canonical
 * form. Pure — no I/O.
 *
 *   `cd /proj && git --no-pager log -5`  → `git log`
 *   `NODE_ENV=test npm test -- --watch`  → `npm test`
 *   `env FOO=bar sudo npm ci`            → `npm ci`
 *
 * Limits (honest): a command embedded inside `-c "..."` (shell-in-shell) and
 * variable positional args (file paths) are best-effort — volume+recurrence is the
 * final net.
 */

// Navigation/setup segments that are dropped entirely.
const NAV_SEGMENT = /^(?:cd|pushd|popd)\b/;
// A segment made up ONLY of `VAR=value` assignment(s). It declares state for the
// segments that FOLLOW (`D=/proj; sed -n 1,5p "$D/a.js"`) — it is not an
// invocation, so it can never be the principal segment. Treating it as one made
// every `VAR=path; cmd ...` read sign as the ASSIGNMENT: unrelated commands
// collapsed onto one signature (false recurrence, past the curation ceiling) and
// the alias check then rejected that same signature as too broad — leaving the
// command both uncurable and unsilenceable. Distinct from ENV_ASSIGN, which
// strips a PREFIX off a segment that also carries a command.
const ASSIGN_ONLY_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z_][A-Za-z0-9_]*=\S*$/;
// A pure comment segment (`# proximo passo`). Not an invocation; a multi-line
// command that opens with one used to sign as the COMMENT.
const COMMENT_SEGMENT = /^#/;
// Decorative output segments (`echo "=== marketplace.json"`). Agents bracket
// multi-line inspections with banners; the banner is narration, not the work.
// Picking it as the principal made the signature the BANNER TEXT -- observed live:
// `sed -n 1,30p release.yml` signed as `... echo "=== marketplace.json"`. Skipped
// like nav/assignment; the last-segment fallback still covers an all-echo command.
const DECOR_SEGMENT = /^(?:echo|printf)\b/;
// Leading `VAR=val ` env assignment(s) — stripped from the front of a segment.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
// Simple command-prefixing wrappers that precede the real command.
const WRAPPER_PREFIX = /^(?:env|time|nice|sudo|command|builtin|exec)\b\s+/;
// A backslash before a newline JOINS the two lines -- it is not a separator.
const LINE_CONT = /\\\r?\n/g;

function stripPrefixes(segment) {
  let s = segment.trim();
  let changed = true;
  while (changed) {
    changed = false;
    while (ENV_ASSIGN.test(s)) { s = s.replace(ENV_ASSIGN, ''); changed = true; }
    if (WRAPPER_PREFIX.test(s)) { s = s.replace(WRAPPER_PREFIX, ''); changed = true; }
  }
  return s.trim();
}

/**
 * Split a compound command on SHELL-ACTIVE `&&`, `||` and `;` — separators inside
 * quotes are argument DATA, not structure. A quote-blind regex split the `;` in a
 * sed script (`sed -n '1,2p;5,6p' f`) mid-argument and shredded the signature.
 * Same class as indexOfShellMeta below, which already guards `|`/`<`/`>`.
 * A single `|` is NOT a separator — `cmd | filter` is one invocation of `cmd`
 * (mirrors matchCuratedShell); indexOfShellMeta trims it from the sig later.
 * @param {string} command
 * @returns {string[]} trimmed, non-empty segments
 */
function splitSegments(command) {
  // Fold line continuations FIRST: a trailing backslash+newline is a join, and
  // leaving it in leaked a bare `\\` token into the signature.
  const s = String(command || '').replace(LINE_CONT, ' ');
  const out = [];
  let start = 0, inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && !inSingle) { i++; continue; } // escaped char is data
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    // `;`, a NEWLINE and a lone `&` (background) each end a command. Newlines were
    // missing entirely: every line of a multi-line command fused into one segment,
    // so unrelated invocations shared a signature.
    if (c === ';' || c === '\n' || c === '\r') { out.push(s.slice(start, i)); start = i + 1; continue; }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      out.push(s.slice(start, i));
      i++;
      start = i + 1;
      continue;
    }
    // Lone `&` backgrounds the command to its left -- a separator, unlike `&&`.
    if (c === '&') { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * The principal segment of a compound command: the first segment that is an actual
 * invocation. Navigation (`cd`), assignment-only (`D=/proj`), comment (`# ...`)
 * and decorative (`echo "=== x"`) segments are skipped — none of them is the
 * work being done. Env/wrapper prefixes are then stripped. Falls back to the last
 * segment, so a command that is ONLY decoration still signs as itself.
 * @param {string} command
 * @returns {string}
 */
function principalSegment(command) {
  const segments = splitSegments(command);
  for (const seg of segments) {
    if (NAV_SEGMENT.test(seg)) continue;
    if (ASSIGN_ONLY_SEGMENT.test(seg)) continue;
    if (COMMENT_SEGMENT.test(seg)) continue;
    if (DECOR_SEGMENT.test(seg)) continue;
    const stripped = stripPrefixes(seg);
    if (stripped) return stripped;
  }
  return segments.length ? stripPrefixes(segments[segments.length - 1]) : '';
}

/** Significant (non-flag) tokens of a segment — drops anything starting with '-'. */
function significantTokens(segment) {
  return segment.split(/\s+/).filter(t => t && !t.startsWith('-'));
}

/**
 * Index of the first SHELL-ACTIVE pipe/redirection metachar (`|`, `<`, `>`) —
 * i.e. outside quotes and not backslash-escaped. A `\|` inside a grep pattern
 * (`grep "a\|b" file`) is data, not a pipe: cutting there truncated the sig to
 * `grep "a\` — losing the operands and colliding unrelated greps (observed
 * live, v1.19.0). Best-effort like the rest of this module (single-quote
 * backslash semantics are approximated).
 * @param {string} s
 * @returns {number} index, or -1 when none
 */
function indexOfShellMeta(s) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && !inSingle) { i++; continue; } // escaped char is data
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && (c === '|' || c === '<' || c === '>')) return i;
  }
  return -1;
}

/**
 * Canonical signature: principal segment, env/wrapper/nav stripped, non-flag
 * tokens joined. Returns '' for an empty/whitespace command.
 * @param {string} command
 * @returns {string}
 */
function canonicalSig(command) {
  let seg = principalSegment(command);
  if (!seg) return '';
  // A pipe/redirection filters the command's output — it is not part of the
  // command's identity, so the signature is the command BEFORE it. Quoted or
  // escaped metachars are argument data and do NOT cut (see indexOfShellMeta).
  const cut = indexOfShellMeta(seg);
  if (cut >= 0) seg = seg.slice(0, cut);
  return significantTokens(seg).join(' ');
}

/**
 * D4 — an alias is too generic (a silencer risk) when its canonical form has
 * fewer than 2 significant tokens (e.g. `git`, `npm`, `cat`). Such a 1-token alias
 * matches unrelated subcommands/args by prefix and would silence them. The tool
 * rejects these and asks for the subcommand.
 * @param {string} alias
 * @returns {boolean}
 */
function isGenericAlias(alias) {
  const sig = canonicalSig(alias);
  if (!sig) return true;
  return sig.split(' ').filter(Boolean).length < 2;
}

module.exports = { canonicalSig, isGenericAlias, principalSegment, significantTokens, indexOfShellMeta, splitSegments };
