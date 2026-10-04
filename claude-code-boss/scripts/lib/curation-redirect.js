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
 * C0). A variant (other positionals/flags) is NOT rewritten: it runs raw, no hint, and
 * is reported as `uncovered` so the metrics show which scripts deserve extending.
 * `CCB_RAW=1 <cmd>` is the escape hatch when the raw output is genuinely needed.
 */
const path = require('path');
const { canonicalSig } = require('./command-signature.js');
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

/** The command that runs a curated script, by extension (absolute, forward slashes). */
function invocationFor(shell, projectRoot) {
  const rel = String((shell && (shell.script || shell.path || shell.command)) || '').trim(); // `command` = legacy field register writes
  if (!rel) return null;
  // The path is interpolated into a shell command between "…": a `"`, `$` or backtick in a
  // repo's shells.json would break out of the quotes. And the rewrite only ever targets
  // the project's OWN scripts — never a path outside its root (pre-release audit).
  if (/["$`]/.test(rel)) return null;
  if (projectRoot) {
    const back = path.relative(path.resolve(projectRoot), path.resolve(projectRoot, rel));
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  }
  const abs = (projectRoot ? path.resolve(projectRoot, rel) : rel).replace(/\\/g, '/');
  if (/\.(mjs|cjs|js)$/i.test(abs)) return `node "${abs}"`;
  if (/\.ps1$/i.test(abs)) return `powershell -NoProfile -ExecutionPolicy Bypass -File "${abs}"`;
  if (/\.sh$/i.test(abs)) return `bash "${abs}"`;
  if (/\.py$/i.test(abs)) return `python "${abs}"`;
  return null;
}

/**
 * Plan the rewrite of `command`.
 * @returns {{bypass:true}|{rewritten:string|null, replaced:Array<{shellId:string, from:string, to:string}>, uncovered:string[]}}
 */
function planRedirect(command, shells, projectRoot) {
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
    const flags = flagsOf(text);
    const exact = profiles.find((pr) => pr.sig === sig && [...flags].every((f) => pr.flags.has(f)));
    if (exact) {
      let to = invocationFor(exact.shell, projectRoot);
      if (to && exact.extraFrom) {
        // Variant alias: only a script that reads its argv gets it, WITH the extra tokens.
        const extra = text.split('|')[0].trim().split(/\s+/).slice(exact.extraFrom);
        to = exact.shell.acceptsArgs === true ? [to, ...extra].join(' ') : null;
      }
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

module.exports = { planRedirect, planShaping, unwrapShaped, splitTopLevel, profilesFor, invocationFor, flagsOf, RAW_ESCAPE };
