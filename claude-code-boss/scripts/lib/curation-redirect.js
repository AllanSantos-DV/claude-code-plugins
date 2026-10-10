'use strict';
/**
 * curation-redirect.js — C2 (Phase C): rewrite a TASK command to its curated script.
 *
 * Measured before (replay-curation-reuse, 3.990 real Bash calls): the guard's
 * "Prefer it next time" hints were followed 19% of the time and deny-redirects 47%;
 * the old auto-redirect only fired for an argless alias of a `.ps1` (never, in
 * practice). Now: a top-level part of the command whose canonical signature AND flags
 * match a curated alias is replaced by the script invocation — same command again,
 * same meaning — and the hook applies it via updatedInput (verified through mcp_tool,
 * C0). A script that declares `passthrough` (it hands its arguments to the command it
 * curates) also takes every VARIANT that starts with one of its aliases, arguments and
 * flags included — the same command runs, only the output is curated; that is the one
 * safe way to widen the match (rtk's rule; similarity, e.g. embeddings, sent writes like
 * `git add`/`gh pr merge` to read-only scripts in the replay). For any other script a
 * variant is NOT rewritten: it runs raw, no hint, and is reported as `uncovered` so the
 * metrics show which scripts deserve extending.
 * `CCB_RAW=1 <cmd>` is the escape hatch when the raw output is genuinely needed.
 */
const path = require('path');
const { canonicalSig, principalSegment, indexOfShellMeta } = require('./command-signature.js');
const { classifySegment } = require('./curation-families.js');

const RAW_ESCAPE = /(^|\s)CCB_RAW=1(\s|$)/;

/** Flags of the first pipeline stage of a part (tokens starting with `-`). */
function flagsOf(part) {
  return new Set(String(part).split('|')[0].trim().split(/\s+/).filter((t) => /^-/.test(t)));
}

/**
 * Split at top-level `&&`, `||`, `;` (outside quotes). Returns null for anything we
 * won't rewrite safely: newlines, heredocs, backticks, command substitution, subshells.
 * @returns {Array<{text:string, sep:string}>|null}
 */
function splitTopLevel(command) {
  const s = String(command || '');
  if (/[\r\n`]|<<|\$\(|^\s*\(|\)\s*$/.test(s)) return null;
  const parts = [];
  let cur = ''; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push({ text: cur, sep: two }); cur = ''; i++; continue; }
    if (c === ';') { parts.push({ text: cur, sep: ';' }); cur = ''; continue; }
    cur += c;
  }
  if (q) return null; // unbalanced quotes
  parts.push({ text: cur, sep: '' });
  return parts;
}

/** True when `test(s, i)` holds at some index outside single/double quotes. */
function hasUnquoted(s, test) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (test(s, i)) return true;
  }
  return false;
}

function joinParts(parts) {
  return parts.map((p, i) => `${i ? ' ' : ''}${p.text.trim()}${p.sep ? ` ${p.sep}` : ''}`).join('');
}

/**
 * Alias profiles of task scripts: { shell, sig, flags, family, extraFrom }.
 *
 * `extraFrom` > 0 marks a VARIANT: an alias that extends the shell's shortest alias with
 * more positionals ("git stash list" over "git stash"). A script invocation carries no
 * arguments, so redirecting a variant ran the base command instead — `git stash list`
 * became `git stash` (push) and hid local changes (B-18, 03/10/2026). A variant is
 * redirected only when the entry declares `acceptsArgs: true`, and then the extra
 * tokens of the command (from index `extraFrom`) go along. Aliases that are not an
 * extension of the base ("npm test" / "npx vitest run") are alternatives, as before.
 */
function profilesFor(shells) {
  const out = [];
  for (const shell of shells || []) {
    const own = [];
    for (const a of shell.aliases || []) {
      const alias = String(a || '').trim();
      if (!alias || classifySegment(alias.split(/\s*(?:&&|\|\||;)\s*/).pop()) !== 'task') continue;
      let sig = ''; try { sig = canonicalSig(alias); } catch (err) { void err; continue; }
      if (!sig) continue;
      own.push({ shell, sig, flags: flagsOf(alias.split(/\s*(?:&&|\|\||;)\s*/).pop()), family: sig.split(' ').slice(0, 2).join(' '), extraFrom: 0 });
    }
    const base = own.reduce((min, p) => (!min || p.sig.split(' ').length < min.sig.split(' ').length ? p : min), null);
    for (const p of own) {
      if (base && p.sig !== base.sig && p.sig.startsWith(`${base.sig} `)) p.extraFrom = base.sig.split(' ').length;
      out.push(p);
    }
  }
  return out;
}

/** Is `p` at or below `dir`? */
function isInside(dir, p) {
  const back = path.relative(path.resolve(dir), path.resolve(p));
  return !!back && !back.startsWith('..') && !path.isAbsolute(back);
}

/**
 * The command that runs a curated script, by extension (absolute, forward slashes), with
 * `CCB_PROJECT_ROOT` naming the project: the script lives in the user's curation home, not
 * in the repo, so it can't find the project from its own location.
 */
function invocationFor(shell, projectRoot, { reportPath = '' } = {}) {
  const rel = String((shell && (shell.script || shell.path || shell.command)) || '').trim(); // `command` = legacy field register writes
  if (!rel) return null;
  // The path is interpolated into a shell command between "…": a `"`, `$` or backtick in a
  // shells.json would break out of the quotes. And the rewrite only ever targets THIS
  // project's scripts — its curation home, or a script of its own repo — never a path
  // elsewhere (pre-release audit).
  if (/["$`]/.test(rel)) return null;
  const { resolveScriptPath, curationHome } = require('../curation-paths.js');
  const abs = projectRoot ? resolveScriptPath(projectRoot, rel) : rel;
  if (!abs) return null;
  if (projectRoot && !isInside(curationHome(projectRoot), abs) && !isInside(projectRoot, abs)) return null;
  if (projectRoot && /["$`]/.test(projectRoot)) return null;
  const file = abs.replace(/\\/g, '/');
  // CCB_RAW_REPORT (lib/raw-report.js): where the script records its raw output size — set only on
  // the invocations this rewrite produces, never by a text replace over the whole command (a
  // non-redirected part that merely contained the literal got it too — audit 3.2.1).
  const rep = String(reportPath || '').replace(/\\/g, '/');
  const reportEnv = rep && !/["$`\n\r]/.test(rep) ? `CCB_RAW_REPORT="${rep}" ` : '';
  const env = projectRoot ? `${reportEnv}CCB_PROJECT_ROOT="${path.resolve(projectRoot).replace(/\\/g, '/')}" ` : '';
  if (/\.(mjs|cjs|js)$/i.test(file)) return `${env}node "${file}"`;
  if (/\.ps1$/i.test(file)) return `${env}powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`;
  if (/\.sh$/i.test(file)) return `${env}bash "${file}"`;
  if (/\.py$/i.test(file)) return `${env}python "${file}"`;
  return null;
}

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)+/;

/**
 * The leading `VAR=value` assignments of a part, kept for the rewrite: `NODE_ENV=test npm test`
 * lost its NODE_ENV when it became the script call (rtk re-prepends them too).
 * @param {string} part
 * @returns {string} '' or the assignments followed by one space
 */
function envPrefixOf(part) {
  const m = ENV_PREFIX.exec(String(part || '').trim());
  return m ? `${m[0].trim()} ` : '';
}

/**
 * The raw arguments that follow `baseTokens` at the head of ONE command part — env/wrapper
 * prefixes stripped, the output pipe/redirect excluded — or null when the head does not start
 * with exactly those tokens (`git -C dir log` is not `git log` + args: `-C dir` would be lost).
 * @param {string} part
 * @param {string[]} baseTokens
 * @returns {string|null}
 */
function argsAfter(part, baseTokens) {
  let head = principalSegment(part);
  const cut = indexOfShellMeta(head);
  if (cut >= 0) head = head.slice(0, cut).replace(/(^|\s)\d+$/, '$1');
  let rest = head.trim();
  for (const t of baseTokens) {
    const m = /^(\S+)(\s+|$)/.exec(rest);
    if (!m || m[1] !== t) return null;
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/**
 * The `passthrough` script whose alias this part starts with (longest alias wins), and the
 * arguments to hand it: what follows the SCRIPT's own command — the base alias for a variant
 * alias ("git stash list" over "git stash" → `list`), the alias itself for an alternative
 * spelling ("npx vitest run" next to "npm test").
 * @returns {{shell:object, args:string}|null}
 */
function passthroughMatch(text, profiles) {
  let best = null;
  for (const pr of profiles) {
    if (!pr.shell || pr.shell.passthrough !== true) continue;
    const own = pr.sig.split(' ');
    if (argsAfter(text, own) === null) continue;
    const strip = pr.extraFrom ? own.slice(0, pr.extraFrom) : own;
    if (!best || own.length > best.len) best = { shell: pr.shell, args: argsAfter(text, strip), len: own.length };
  }
  return best && { shell: best.shell, args: best.args };
}

/**
 * Plan the rewrite of `command`.
 * @returns {{bypass:true}|{rewritten:string|null, replaced:Array<{shellId:string, from:string, to:string}>, uncovered:string[]}}
 */
function planRedirect(command, shells, projectRoot, { reportPath = '' } = {}) {
  if (RAW_ESCAPE.test(String(command || ''))) return { bypass: true };
  const parts = splitTopLevel(command);
  const replaced = []; const uncovered = [];
  if (!parts) return { rewritten: null, replaced, uncovered };
  const profiles = profilesFor(shells);
  if (!profiles.length) return { rewritten: null, replaced, uncovered };
  for (const p of parts) {
    const text = p.text.trim();
    if (!text || classifySegment(text) !== 'task') continue;
    // Output sent to a FILE (`> log`, `>> log`, `2> err`, `&> all`) means the raw output is
    // wanted on disk (typically grepped next) — rewriting would store the curated summary
    // instead. Not rewritten; `> /dev/null` and fd duplication (`2>&1`) don't count.
    if (/(^|\s)(?:\d|&)?>>?\s*(?!&\d)(?!\/dev\/null)[^\s|&;]+/.test(text.split('|')[0]) || /\|\s*tee\b/.test(text)) continue;
    let sig = ''; try { sig = canonicalSig(text); } catch (err) { void err; continue; }
    if (!sig) continue;
    // 1. PASSTHROUGH (a script that declares `passthrough` forwards its argv to the command it
    //    curates): any command that STARTS with one of its aliases is redirected with every
    //    argument and flag after the script's own command — the same command runs, only the
    //    output is curated (rtk's rule: rewrite only to a transparent passthrough). Flag variants
    //    (`mvn test -Dtest=X`, `gh run list --limit 5`) no longer run raw.
    const pass = passthroughMatch(text, profiles);
    if (pass) {
      const inv = invocationFor(pass.shell, projectRoot, { reportPath });
      const to = inv && `${envPrefixOf(text)}${pass.args ? `${inv} ${pass.args}` : inv}`;
      if (to) { replaced.push({ shellId: pass.shell.id, from: text, to }); p.text = to; continue; }
    }
    // 2. EXACT: same signature, and every flag of the command is one the alias already has —
    //    anything else would silently change what runs.
    const flags = flagsOf(text);
    const exact = profiles.find((pr) => pr.sig === sig && [...flags].every((f) => pr.flags.has(f)));
    if (exact) {
      let to = invocationFor(exact.shell, projectRoot, { reportPath });
      if (to && exact.extraFrom) {
        // Variant alias: only a script that reads its argv gets it, WITH the extra tokens (taken
        // after the env/wrapper prefixes — splitting the raw part handed `FOO=1 git stash list`
        // the arguments `stash list`).
        const extra = exact.shell.acceptsArgs === true ? argsAfter(text, exact.sig.split(' ').slice(0, exact.extraFrom)) : null;
        to = extra === null ? null : (extra ? `${to} ${extra}` : to);
      }
      if (to) to = `${envPrefixOf(text)}${to}`;
      if (to) { replaced.push({ shellId: exact.shell.id, from: text, to }); p.text = to; continue; }
    }
    const fam = sig.split(' ').slice(0, 2).join(' ');
    const same = profiles.find((pr) => pr.family === fam);
    if (same && !uncovered.includes(same.shell.id)) uncovered.push(same.shell.id);
  }
  return { rewritten: replaced.length ? joinParts(parts) : null, replaced, uncovered };
}

const FILE_SINK = /(^|\s)(?:\d|&)?>>?\s*(?!&\d)(?!\/dev\/null)[^\s|&;]+/;
const SHAPER = path.join(__dirname, '..', 'shape-output.js').replace(/\\/g, '/');

/**
 * C2b: the shaped form of a single EXPLORATION command when Token Guard isn't
 * installed, else null. `deps` is a test seam for the Token Guard detection.
 */
function planShaping(command, projectRoot, deps = {}) {
  const { classifyCommand, tokenGuardActive } = require('./curation-families.js');
  const cmd = String(command || '').trim();
  if (!cmd || RAW_ESCAPE.test(cmd) || cmd.includes('shape-output.js')) return null;
  const parts = splitTopLevel(cmd);
  if (!parts || parts.length !== 1 || /&\s*$/.test(cmd)) return null;
  if (FILE_SINK.test(cmd.split('|')[0]) || /\|\s*tee\b/.test(cmd)) return null;
  // Never wrapped (pre-release audit, all reproduced):
  //  - its own pipe (`grep … | head`): the agent already bounds it, and pipefail turned
  //    head's early exit into SIGPIPE 141 — a fake failure feeding the error-guard;
  //  - a `#` comment or a trailing `\`: `{ cmd #x; }` is a shell syntax error;
  //  - follow / interactive commands (`tail -f`, `less`, `watch`…): they never reach EOF.
  if (hasUnquoted(cmd, (s, i) => s[i] === '|' && s[i + 1] !== '|' && s[i - 1] !== '|')) return null;
  if (hasUnquoted(cmd, (s, i) => s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) || /\\\s*$/.test(cmd)) return null;
  if (/^(?:\S*\/)?(?:less|more|watch|top|htop|vi|vim|nano)\b/.test(cmd) || /^(?:\S*\/)?tail\b.*\s(?:-[a-zA-Z]*[fF]|--follow)\b/.test(cmd)) return null;
  if (classifyCommand(cmd) !== 'exploration') return null;
  const tgActive = deps.tokenGuardActive || tokenGuardActive;
  if (tgActive({ projectRoot })) return null;
  let fam = 'exploration';
  try {
    const t = canonicalSig(cmd).split(' ');
    fam = (t[0] === 'git' ? t.slice(0, 2) : t.slice(0, 1)).join(' ') || fam; // `git log`, `cat`, `grep`
  } catch (err) { void err; }
  return `set -o pipefail; { ${cmd}; } 2>&1 | node "${SHAPER}" --family "${fam.replace(/"/g, '')}"`;
}

/**
 * The original command inside a planShaping() wrapper, else null. PostToolUse sees the
 * REWRITTEN command: without this the detector read `set -o pipefail; { cat big.txt; }…`
 * as a TASK (`set`) and asked to curate output the shaper already bounds (seen live in
 * the C6 stress: the agent was nudged to mark `set pipefail && cat big.txt` one-off).
 */
const SHAPED_RE = /^set -o pipefail; \{ ([\s\S]+); \} 2>&1 \| node "[^"]*shape-output\.js" --family "[^"]*"$/;
function unwrapShaped(command) {
  const m = SHAPED_RE.exec(String(command || '').trim());
  return m ? m[1] : null;
}

module.exports = { planRedirect, planShaping, unwrapShaped, splitTopLevel, profilesFor, invocationFor, flagsOf, argsAfter, passthroughMatch, RAW_ESCAPE };
