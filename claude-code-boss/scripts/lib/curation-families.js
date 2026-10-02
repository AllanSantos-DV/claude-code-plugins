'use strict';
/**
 * curation-families.js — which commands curation should even look at (Phase C).
 *
 * Measured on real history (replay-curation-c1, 2026-10-02): of the raw commands that
 * re-ran after a curated script existed, 436 were VARIANTS of generic exploration
 * commands (git log/status/diff, grep, sed -n, cat, ls…) and only 100 the same command
 * again; 18 of 41 per-project scripts were never used — mostly one-off exploration or
 * inline code curated on its first noisy output. Three classes:
 *   - exploration: generic read/inspect commands. Never curated per project; their
 *     output is bounded generically (Token Guard when installed, else the boss shaper).
 *   - inline: code written for the situation (`node -e`, `python -c`, `node -` heredoc).
 *     Never curated — a script would be single-use by definition.
 *   - task: everything else (tests, gates, builds, project scripts) — the only class
 *     curation scripts pay off for (re-run often, worth a domain summary).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { workSegments } = require('./command-signature.js');

const EXPLORATION_PROGRAMS = new Set([
  'grep', 'rg', 'ag', 'find', 'fd', 'ls', 'dir', 'tree', 'cat', 'bat', 'type', 'head', 'tail',
  'sed', 'awk', 'wc', 'less', 'more', 'du', 'stat', 'file', 'cut', 'sort', 'uniq',
  'get-content', 'select-string', 'get-childitem', 'gci', 'curl', 'wget', 'jq', 'od', 'xxd',
]);
const EXPLORATION_GIT = new Set(['log', 'status', 'diff', 'show', 'blame', 'ls-files', 'grep', 'branch', 'shortlog', 'reflog', 'ls-tree', 'cat-file', 'rev-parse', 'describe', 'remote', 'tag', 'config', 'whatchanged', 'name-rev']);
const INLINE_RUNTIMES = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'perl', 'php', 'pwsh', 'powershell', 'bash', 'sh']);
const INLINE_FLAGS = new Set(['-e', '--eval', '-c', '-p', '--print', '-Command', '-command', '-EncodedCommand']);

function _progOf(token) {
  return String(token || '').replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Tokens of one segment, skipping leading VAR=value assignments. */
function _tokens(seg) {
  const toks = String(seg || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  return toks.slice(i);
}

/** Class of ONE work segment: 'exploration' | 'inline' | 'task'. */
function classifySegment(seg) {
  const s = String(seg || '').trim();
  const toks = _tokens(s);
  if (!toks.length) return 'task';
  const prog = _progOf(toks[0]);
  if (INLINE_RUNTIMES.has(prog)) {
    // `node -e '…'`, `python -c …`, `node - <<EOF`, `python - <<'PY'`, `bash -c '…'`.
    if (toks.slice(1).some((t) => INLINE_FLAGS.has(t)) || toks[1] === '-' || /<<-?\s*['"]?\w+/.test(s)) return 'inline';
    return 'task';
  }
  if (prog === 'git') {
    // Skip global options and the VALUE of the ones that take one (`git -C repo log`).
    let sub = null;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (/^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(t)) { i++; continue; }
      if (t.startsWith('-')) continue;
      sub = t; break;
    }
    return sub && EXPLORATION_GIT.has(sub.toLowerCase()) ? 'exploration' : 'task';
  }
  return EXPLORATION_PROGRAMS.has(prog) ? 'exploration' : 'task';
}

/**
 * Class of a whole command: 'task' if ANY work segment is a task (that part may
 * deserve a script), else 'inline' if any is inline, else 'exploration'.
 */
function classifyCommand(command) {
  let segs;
  try { segs = workSegments(String(command || '')); } catch (err) { void err; segs = [String(command || '')]; }
  if (!segs.length) segs = [String(command || '')];
  const kinds = segs.map(classifySegment);
  if (kinds.includes('task')) return 'task';
  if (kinds.includes('inline')) return 'inline';
  return 'exploration';
}

// ─── Token Guard detection (both plugins coexist; decided 2026-10-02) ────────
// Token Guard installs as global hooks in ~/.claude/settings.json (PostToolUse
// adapters/post-hook.cjs bounds big tool results). When it is active, exploration
// output is its job; when it isn't, the boss shapes exploration output itself.
const _tgCache = { key: '', value: false };

function _settingsFiles(projectRoot, home) {
  const files = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')];
  if (projectRoot) files.push(path.join(projectRoot, '.claude', 'settings.json'), path.join(projectRoot, '.claude', 'settings.local.json'));
  return files;
}

function tokenGuardActive({ projectRoot = '', home = os.homedir() } = {}) {
  const files = _settingsFiles(projectRoot, home);
  const stamp = files.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch (err) { void err; return `${f}:-`; } }).join('|');
  if (stamp === _tgCache.key) return _tgCache.value;
  let active = false;
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { void err; continue; }
    const post = (j && j.hooks && j.hooks.PostToolUse) || [];
    if (post.some((g) => (g.hooks || []).some((h) => /token-guard/i.test(`${h.command || ''} ${(h.args || []).join(' ')}`)))) { active = true; break; }
  }
  _tgCache.key = stamp; _tgCache.value = active;
  return active;
}

function _resetTokenGuardCache() { _tgCache.key = ''; _tgCache.value = false; }

module.exports = { classifySegment, classifyCommand, tokenGuardActive, _resetTokenGuardCache, EXPLORATION_PROGRAMS, EXPLORATION_GIT };
