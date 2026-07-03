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

// && || ;  segment separators. Pipe (`|`) is NOT a separator — `cmd | filter` is a
// single invocation of `cmd` (mirrors matchCuratedShell).
const SEGMENT_SPLIT = /\s*(?:&&|\|\|)\s*|\s*;\s*/;
// Navigation/setup segments that are dropped entirely.
const NAV_SEGMENT = /^(?:cd|pushd|popd)\b/;
// Leading `VAR=val ` env assignment(s) — stripped from the front of a segment.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
// Simple command-prefixing wrappers that precede the real command.
const WRAPPER_PREFIX = /^(?:env|time|nice|sudo|command|builtin|exec)\b\s+/;

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
 * The principal segment of a compound command: the first non-navigation segment
 * (after stripping env/wrapper prefixes). Falls back to the last segment.
 * @param {string} command
 * @returns {string}
 */
function principalSegment(command) {
  const segments = String(command || '').split(SEGMENT_SPLIT).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (NAV_SEGMENT.test(seg)) continue;
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

module.exports = { canonicalSig, isGenericAlias, principalSegment, significantTokens, indexOfShellMeta };
