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

function joinParts(parts) {
  return parts.map((p, i) => `${i ? ' ' : ''}${p.text.trim()}${p.sep ? ` ${p.sep}` : ''}`).join('');
}

/** Alias profiles of task scripts: { shell, sig, flags, family }. */
function profilesFor(shells) {
  const out = [];
  for (const shell of shells || []) {
    for (const a of shell.aliases || []) {
      const alias = String(a || '').trim();
      if (!alias || classifySegment(alias.split(/\s*(?:&&|\|\||;)\s*/).pop()) !== 'task') continue;
      let sig = ''; try { sig = canonicalSig(alias); } catch (err) { void err; continue; }
      if (!sig) continue;
      out.push({ shell, sig, flags: flagsOf(alias.split(/\s*(?:&&|\|\||;)\s*/).pop()), family: sig.split(' ').slice(0, 2).join(' ') });
    }
  }
  return out;
}

/** The command that runs a curated script, by extension (absolute, forward slashes). */
function invocationFor(shell, projectRoot) {
  const rel = String((shell && (shell.script || shell.path)) || '').trim();
  if (!rel) return null;
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
      const to = invocationFor(exact.shell, projectRoot);
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

module.exports = { planRedirect, planShaping, splitTopLevel, profilesFor, invocationFor, flagsOf, RAW_ESCAPE };
