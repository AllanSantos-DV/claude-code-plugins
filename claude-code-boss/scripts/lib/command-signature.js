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
 *
 * Heredocs: an UNQUOTED heredoc's body is folded out (it is stdin data, not
 * structure); one inside `"$(cat <<EOF ...)"` stays best-effort. A heredoc
 * that only writes a file (`cat > f <<EOF`) is skipped as setup; a script fed on
 * stdin (`node - <<EOF`) signs as `<cmd> heredoc-<digest>` — specific to that
 * body, never the bare 1-token `node` that no one-hit marking may target.
 */
const crypto = require('crypto');

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
// Placeholder a folded heredoc leaves in its segment (`<<@0`). Starts with `<`, so
// indexOfShellMeta still cuts there exactly like the original `<<'EOF'` operator.
const HEREDOC_MARK = /<<@(\d+)/;
// A heredoc that only WRITES a file (`cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`)
// is setup for the segments that follow, not the work — skipped like `cd`.
const HEREDOC_MARK_START = /^<<@\d+/;
// A group closer, optionally redirecting the group's output (`} > f`, `) 2>&1 | tail`).
const GROUP_CLOSE = /^[)}]+\s*(?:\d*[<>|&].*)?$/;
const HEREDOC_WRITE_SEGMENT =/^(?:cat\b[^|]*>|tee\b)[^|]*<<@\d+|^cat\b[^|]*<<@\d+[^|]*>/;

/**
 * Fold heredoc BODIES out of a command. A body is data fed on stdin, not shell
 * structure: left in place, every body line became a segment (splitSegments splits
 * on newlines) and a stray `'`/`"` in it flipped the quote state for the rest of the
 * command. Each unquoted `<<[-]WORD` operator becomes a `<<@N` placeholder and its
 * body lines (up to the WORD terminator line) are removed into `bodies[N]`.
 * `<<<` (here-string) is not a heredoc. An unterminated heredoc swallows the rest.
 * @param {string} command
 * @returns {{ text: string, bodies: string[] }}
 */
function foldHeredocs(command) {
  const s = String(command || '');
  const bodies = [];
  let out = '';
  let pending = []; // heredocs opened on the current line: { idx, delim }
  let inSingle = false, inDouble = false;
  let arith = 0; // open `((` / `$((` arithmetic: `<<` there is a bit shift
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && !inSingle) { out += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; out += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; out += c; continue; }
    // Line-scoped (reset at newline): a stray `((` in a comment must not disable
    // heredoc folding for the rest of the command.
    if (!inSingle && !inDouble && s.startsWith('((', i)) { arith++; out += '(('; i++; continue; }
    if (!inSingle && !inDouble && arith && s.startsWith('))', i)) { arith--; out += '))'; i++; continue; }
    if (c === '\n' && !inSingle && !inDouble) arith = 0;
    // `<<<` here-string: consume the whole operator, or its 2nd/3rd `<` would
    // re-scan as a `<<` heredoc opener.
    if (!inSingle && !inDouble && s.startsWith('<<<', i)) { out += '<<<'; i += 2; continue; }
    if (!inSingle && !inDouble && !arith && c === '<' && s[i + 1] === '<') {
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) {
        const idx = bodies.length;
        bodies.push('');
        pending.push({ idx, delim: m[2] });
        out += `<<@${idx}`;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && !inSingle && !inDouble && pending.length) {
      out += c;
      let pos = i + 1;
      for (const h of pending) {
        const lines = [];
        let terminated = false;
        while (pos < s.length) {
          const nl = s.indexOf('\n', pos);
          const end = nl === -1 ? s.length : nl;
          const line = s.slice(pos, end);
          pos = nl === -1 ? s.length : nl + 1;
          if (line.trim() === h.delim) { terminated = true; break; }
          lines.push(line.replace(/\r$/, ''));
        }
        bodies[h.idx] = lines.join('\n');
        if (!terminated) break;
      }
      pending = [];
      i = pos - 1;
      continue;
    }
    out += c;
  }
  return { text: out, bodies };
}

/** Short stable digest of a heredoc body — CRLF/outer-whitespace insensitive. */
function bodyDigest(body) {
  const norm = String(body || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8);
}

// `VAR=$(cmd …)`: the work is the substituted command (ENV_ASSIGN's `\S*` would
// otherwise eat `$(git` and leave `diff HEAD)` as the "command").
// (`$((` is arithmetic, not a command — left to ASSIGN_ONLY_SEGMENT.)
const SUBST_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\$\((?!\()\s*/;
// `VAR=$(cat <<EOF` only loads a heredoc into a variable — setup, like `cat > f <<EOF`.
const SUBST_HEREDOC_LOAD = /^cat\s*<<@\d+\s*$/;

/** Drop trailing `)`/`}` that close a group opened BEFORE this segment (unbalanced). */
function _dropUnbalancedClose(s) {
  let out = s;
  for (;;) {
    const m = /[)}]\s*$/.exec(out);
    if (!m) return out;
    const opens = (out.match(/[({]/g) || []).length;
    const closes = (out.match(/[)}]/g) || []).length;
    if (closes <= opens) return out;
    out = out.slice(0, m.index).trimEnd();
  }
}

/**
 * Leading group openers (`(cd /p && git diff)`, `{ git log; } > f`) and
 * `VAR=$(` are structure, not the command; so are the matching trailing closers.
 * Without this `(cd /p && x)` and `(cd /p && y)` both signed as `(cd /p`.
 */
function _ungroup(segment) {
  let s = segment.trim();
  let hadSubst = false;
  for (;;) {
    if (/^[({]\s*/.test(s)) { s = s.replace(/^[({]\s*/, ''); continue; }
    if (SUBST_ASSIGN.test(s)) { s = s.replace(SUBST_ASSIGN, ''); hadSubst = true; continue; }
    break;
  }
  return { s: _dropUnbalancedClose(s), hadSubst };
}

function stripPrefixes(segment) {
  let s = segment.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const g = _ungroup(s);
    if (g.s !== s) { s = g.s; changed = true; }
    while (ENV_ASSIGN.test(s) && !SUBST_ASSIGN.test(s)) { s = s.replace(ENV_ASSIGN, ''); changed = true; }
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
    // Not inside a redirection (`>&2`, `2>&1`, `<&0`, `&>f`): splitting there made
    // the fd number (`2`) its own segment, and so a junk 1-token signature.
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) continue;
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
  return principalOfFolded(foldHeredocs(command).text);
}

/** principalSegment over a command whose heredoc bodies are already folded. */
/** The segment's command once setup/decoration is discounted, or '' when it is not work. */
function _workOf(rawSeg) {
  if (ASSIGN_ONLY_SEGMENT.test(rawSeg.trim())) return '';
  // `(cd /p` must still read as navigation: look past group openers first.
  const g = _ungroup(rawSeg);
  const seg = g.s;
  if (!seg) return '';
  if (g.hadSubst && SUBST_HEREDOC_LOAD.test(seg)) return '';
  if (NAV_SEGMENT.test(seg)) return '';
  if (ASSIGN_ONLY_SEGMENT.test(seg)) return '';
  if (COMMENT_SEGMENT.test(seg)) return '';
  if (DECOR_SEGMENT.test(seg)) return '';
  const stripped = stripPrefixes(seg);
  if (HEREDOC_WRITE_SEGMENT.test(stripped)) return '';
  // No command of its own: the heredoc left behind by `VAR=$(cat <<EOF` once the
  // assignment prefix is stripped, and the `)` line that closes that `$(`.
  if (HEREDOC_MARK_START.test(stripped) || GROUP_CLOSE.test(stripped)) return '';
  return stripped;
}

function principalOfFolded(text) {
  const segments = splitSegments(text);
  for (const seg of segments) {
    const work = _workOf(seg);
    if (work) return work;
  }
  return segments.length ? stripPrefixes(segments[segments.length - 1]) : '';
}

/**
 * Every segment of `command` that is real work (cd/assignments/comments/echo
 * banners/heredoc-writes discounted), in order. One entry = a single command
 * however it is dressed (`cd x && npm test 2>&1 | tail`); more = a compound.
 */
function workSegments(command) {
  return splitSegments(foldHeredocs(command).text).map(_workOf).filter(Boolean);
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
    // `&>f` / `&>>f` redirects both streams: cut at the `&`, or it leaks a trailing
    // `&` token and the sig stops being a fixed point (pruneOrphanKeys drops it).
    if (!inSingle && !inDouble && c === '&' && s[i + 1] === '>') return i;
  }
  return -1;
}

/**
 * Canonical signature. ONE work segment (however dressed: `cd x && npm test 2>&1 |
 * tail`) → that command's tokens. A COMPOUND (several work segments) → each
 * segment's signature joined with ` && ` (U4, changed in the major): it used to be
 * the first segment only, so ~24% of real commands collapsed onto another
 * command's signature (`git status && git diff` counted — and its bulky diff was
 * blamed — as `git status`). Returns '' for an empty/whitespace command.
 * @param {string} command
 * @returns {string}
 */
function canonicalSig(command) {
  const { text, bodies } = foldHeredocs(command);
  const work = splitSegments(text).map(_workOf).filter(Boolean);
  // Repeats collapse (order kept): `git diff --stat > a; git diff > b` is `git diff` once.
  if (work.length > 1) return [...new Set(work.map(seg => _segmentSig(seg, bodies)).filter(Boolean))].join(' && ');
  const seg = work.length ? work[0] : principalOfFolded(text);
  if (!seg) return '';
  return _segmentSig(seg, bodies);
}

/** Signature of ONE work segment (heredoc digest, cut at pipe/redirect, flags dropped). */
function _segmentSig(segment, bodies) {
  let seg = segment;
  const heredoc = HEREDOC_MARK.exec(seg);
  // A pipe/redirection filters the command's output — it is not part of the
  // command's identity, so the signature is the command BEFORE it. Quoted or
  // escaped metachars are argument data and do NOT cut (see indexOfShellMeta).
  const cut = indexOfShellMeta(seg);
  // The fd number GLUED to the redirection (`2>&1`, `2>/dev/null`) belongs to the
  // redirection (U13, changed in the major): it made `git status 2>&1` sign as
  // `git status 2`, another command than `git status` (~30% of real signatures).
  // An argument followed by a space (`sleep 2 > f`) is kept: the slice ends in ' '.
  if (cut >= 0) seg = seg.slice(0, cut).replace(/(^|\s)\d+$/, '$1');
  const tokens = significantTokens(seg);
  // Stdin-fed script (`node - <<EOF`, `bash -s <<EOF`): the program alone is not
  // the identity — the BODY is what runs. Signing as bare `node` pooled every such
  // script into one 1-token sig that curation_mark_oneoff must refuse as too broad.
  // Only when the command itself names nothing more (<2 tokens): `psql db <<EOF`
  // or `python3 x.py <<EOF` keeps its own sig across inputs.
  // Never a digest ALONE: with no program named it would pool unrelated commands.
  if (heredoc && tokens.length === 1) tokens.push(`heredoc-${bodyDigest(bodies[Number(heredoc[1])])}`);
  return tokens.join(' ');
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

module.exports = { canonicalSig, isGenericAlias, principalSegment, workSegments, significantTokens, indexOfShellMeta, splitSegments, foldHeredocs };
