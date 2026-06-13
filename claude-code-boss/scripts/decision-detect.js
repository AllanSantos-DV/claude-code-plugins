#!/usr/bin/env node
/**
 * decision-detect.js — PostToolUse Bash hook (lean signal).
 *
 * DESIGN (in-loop capture, twin of correction-detect/pattern-detect):
 * inspect `tool_input.command` for `git commit -m ...` / heredoc-style commits /
 * `gh pr create|edit --body ...`. If the message looks like an architectural
 * decision (verb of choice + rationale connector OR multi-paragraph body), stash
 * a pending-promotion record in `.runtime/decision-pending.json`. The Stop hook
 * `decision-promote.js` reads that state and nudges the in-loop agent — who has
 * full context — to call `capture_lesson({type:'decision', ...})` once.
 *
 * Cheap, regex-only, false-positive tolerant: the agent is the judge of whether
 * to actually capture. We only fire one nudge per (sha or pr-url) via the
 * promoted-LRU stored alongside.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { readStdin } = require('./lib/hook-io.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING = path.join(DATA_DIR, '.runtime', 'decision-pending.json');
const PROMOTED = path.join(DATA_DIR, '.runtime', 'decision-promoted-sha.json');

// ─── Extractors ──────────────────────────────────────────────────────────────

/** Return the commit message body extracted from a `git commit` command, or null. */
function extractCommitMsg(cmd) {
  if (!cmd || !/\bgit\s+commit\b/i.test(cmd)) return null;

  // Pattern A: heredoc -- git commit -m "$(cat <<'EOF' ... EOF\n)"
  const heredoc = cmd.match(/<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\b/);
  if (heredoc) return heredoc[2].trim();

  // Pattern B: --message=<value> (single or double-quoted, or bare token)
  const longFlag = cmd.match(/--message=("([^"]*)"|'([^']*)'|(\S+))/);
  if (longFlag) return (longFlag[2] || longFlag[3] || longFlag[4] || '').trim();

  // Pattern C: -m "..."  /  -m '...' (last one wins per git semantics)
  // Capture each -m argument; supports double or single quote.
  const dquoted = [...cmd.matchAll(/-m\s+"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  const squoted = [...cmd.matchAll(/-m\s+'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
  const bare    = [...cmd.matchAll(/-m\s+(\S+)/g)].map(m => m[1])
                    .filter(s => !s.startsWith('"') && !s.startsWith("'"));
  const all = [...dquoted, ...squoted, ...bare];
  if (all.length) return all.join('\n\n').trim();
  return null;
}

/** Return the PR body extracted from a `gh pr create|edit --body` command, or null. */
function extractPrBody(cmd) {
  if (!cmd || !/\bgh\s+pr\s+(create|edit)\b/i.test(cmd)) return null;

  // heredoc shape: --body "$(cat <<'EOF' ... EOF\n)"
  const heredoc = cmd.match(/<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\b/);
  if (heredoc) return heredoc[2].trim();

  // --body "..." / --body '...'
  const dq = cmd.match(/--body\s+"((?:[^"\\]|\\.)*)"/);
  if (dq) return dq[1].trim();
  const sq = cmd.match(/--body\s+'((?:[^'\\]|\\.)*)'/);
  if (sq) return sq[1].trim();

  // --body-file <path>: read the file if it still exists & is small
  const bf = cmd.match(/--body-file\s+(\S+)/);
  if (bf) {
    try {
      const p = bf[1].replace(/^["']|["']$/g, '');
      const st = fs.statSync(p);
      if (st.size < 50_000) return fs.readFileSync(p, 'utf-8').trim();
    } catch { /* gone */ }
  }
  return null;
}

// ─── Heuristic ───────────────────────────────────────────────────────────────

const CHOICE_VERBS = /\b(choose|chose|pick(ed)?|adopt(ed)?|swap(ped)?|migrat(e|ed)|replace(d)?|use(d)?|switch(ed)?\s+to|cutover|move(d)?\s+to|escolh(emos|i|er)|trocar?|trocamos|migrar?|adotar?|substituir?)\b/i;
const RATIONALE = /\b(because|since|due to|in favor of|over|instead of|rather than|porque|porqu[êe]|pois|j[áa] que|em favor de|em vez de|ao inv[ée]s de)\b/i;

function looksLikeDecision(text) {
  if (!text || text.length < 8) return false;
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (CHOICE_VERBS.test(text)) return true;
  if (RATIONALE.test(text))    return true;
  if (lines.length >= 3)       return true; // multi-paragraph body usually contains rationale
  return false;
}

// ─── State I/O ───────────────────────────────────────────────────────────────

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* absent or corrupt: use fallback */ return fallback; }
}
function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
    return true;
  } catch { /* write failed (perms/disk): caller sees false */ return false; }
}

function alreadyPromoted(key) {
  const arr = readJsonSafe(PROMOTED, []);
  return Array.isArray(arr) && arr.includes(key);
}

function getRepoUrl() {
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8', timeout: 1000 });
    if (r.status === 0) return (r.stdout || '').trim();
  } catch { /* ignore */ }
  return null;
}

function getHeadSha() {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 1000 });
    if (r.status === 0) return (r.stdout || '').trim();
  } catch { /* ignore */ }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write('{}'); return; }
    let event;
    try { event = JSON.parse(raw); } catch { process.stdout.write('{}'); return; }

    if (event.tool_name !== 'Bash') { process.stdout.write('{}'); return; }
    const cmd = event.tool_input?.command || '';
    if (!cmd) { process.stdout.write('{}'); return; }

    let kind = null;
    let msg = extractCommitMsg(cmd);
    if (msg) kind = 'commit';
    if (!msg) {
      msg = extractPrBody(cmd);
      if (msg) kind = /\bgh\s+pr\s+create\b/i.test(cmd) ? 'pr-create' : 'pr-edit';
    }
    if (!msg || !looksLikeDecision(msg)) { process.stdout.write('{}'); return; }

    // Build a stable key:
    //   commit  → HEAD sha (after the commit ran successfully)
    //   pr-*    → first url-looking token in the command, else hash of msg
    let key = null;
    if (kind === 'commit') {
      key = getHeadSha() || ('msg:' + msg.slice(0, 60));
    } else {
      const urlM = cmd.match(/https?:\/\/[^\s"']+/);
      key = urlM ? urlM[0] : ('msg:' + msg.slice(0, 60));
    }
    if (alreadyPromoted(key)) { process.stdout.write('{}'); return; }

    const pending = readJsonSafe(PENDING, { pending: [] });
    if (!Array.isArray(pending.pending)) pending.pending = [];

    // Deduplicate inside pending too.
    if (pending.pending.some(p => p.key === key)) {
      process.stdout.write('{}');
      return;
    }

    pending.pending.push({
      kind,
      key,
      snippet: msg.slice(0, 240),
      fullLen: msg.length,
      repoUrl: getRepoUrl(),
      ts: Date.now(),
    });
    // Cap pending to last 10 (defensive).
    if (pending.pending.length > 10) pending.pending = pending.pending.slice(-10);
    writeJsonSafe(PENDING, pending);

    process.stdout.write('{}');
  } catch {
    process.stdout.write('{}');
  }
})();

// Expose for unit testing.
module.exports = { extractCommitMsg, extractPrBody, looksLikeDecision };
