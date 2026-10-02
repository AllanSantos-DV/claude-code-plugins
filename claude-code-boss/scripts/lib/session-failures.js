'use strict';
/**
 * lib/session-failures.js — which Bash commands keep failing in THIS session,
 * read from the session's own transcript (the authoritative record).
 *
 * Backs error-guard (backlog U2/U10, policy chosen by replaying 9.4k real Bash
 * calls from 66 sessions — .claude/scripts/replay-guards.mjs):
 *   - scope = the session (the transcript), not a 90-day project-wide store:
 *     a failure from another session/day no longer blocks today's run;
 *   - key = canonicalSig + EFFECTIVE directory (`cd X &&` target, else the call's
 *     cwd): `cd repoA && ls` and `cd repoB && ls` are different commands;
 *   - a command is blocked when it failed >= threshold times in the session AND
 *     no file was edited (Edit/Write/MultiEdit/NotebookEdit) since its last
 *     failure — re-running blindly is blocked, re-running after a fix attempt is
 *     not. Retrying alone never unblocks; only a success or an edit does.
 * Replay result vs the old policy: false blocks 34 → 4, blind re-run loops let
 * through 17 → 14.
 *
 * Reading the transcript (instead of a store fed by PostToolUseFailure) also
 * removes a race: that hook now runs in the daemon's background queue, so its
 * record could land after the next PreToolUse. The transcript already holds the
 * previous tool_result when the next tool call starts (verified 2026-10-02).
 *
 * Incremental: per transcript, only bytes appended since the previous call are
 * parsed (memo per thread). A shrunk file (compaction rewrite) restarts the scan;
 * a cold start reads at most the last COLD_MAX_BYTES.
 */
const fs = require('fs');
const path = require('path');
const { canonicalSig } = require('./command-signature.js');
const { redact } = require('./redact.js');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COLD_MAX_BYTES = 8 * 1024 * 1024;
const MEMO_MAX = 64;
const HOOK_DENIAL = /^PreToolUse:Bash hook error/;
const CD_PREFIX = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/;

const _memo = new Map(); // transcriptPath → state

function effectiveDir(cwd, command) {
  const m = CD_PREFIX.exec(String(command || ''));
  const target = m ? (m[1] || m[2] || m[3]) : '';
  const win = process.platform === 'win32';
  // Git Bash spells C:\x as /c/x — the same directory.
  const t = target && win ? target.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : target;
  let dir = path.resolve(cwd || '.', t || '.');
  if (win) dir = dir.toLowerCase();
  return dir;
}

function keyOf(command, cwd) {
  const sig = canonicalSig(redact(String(command || '')).text);
  return sig ? `${sig}@${effectiveDir(cwd, command)}` : '';
}

function _newState() {
  return { offset: 0, uses: new Map(), failures: new Map(), editSeq: 0, carry: '' };
}

function _text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function _ingestLine(st, line) {
  if (!line || line.indexOf('"tool_') < 0) return;
  let o;
  try { o = JSON.parse(line); } catch (err) { void err; return; }
  if (o.isSidechain || o.agentId) return; // a sub-agent's commands are not this session's loop
  const content = o.message && o.message.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_use') {
      if (EDIT_TOOLS.has(b.name)) st.editSeq++;
      else if (b.name === 'Bash' && b.input && b.input.command) st.uses.set(b.id, keyOf(b.input.command, o.cwd));
    } else if (b.type === 'tool_result' && st.uses.has(b.tool_use_id)) {
      const key = st.uses.get(b.tool_use_id);
      st.uses.delete(b.tool_use_id);
      if (!key) continue;
      const text = _text(b.content);
      if (HOOK_DENIAL.test(text)) continue;          // blocked by a hook: neither a failure nor a success
      if (b.is_error) {
        const f = st.failures.get(key) || { count: 0 };
        const exit = /Exit code (\d+)/.exec(text);
        f.count++;
        f.lastFailEditSeq = st.editSeq;
        f.exitCode = exit ? Number(exit[1]) : null;
        f.cause = redact(text.replace(/^Exit code \d+\s*/, '')).text.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300);
        st.failures.set(key, f);
      } else {
        st.failures.delete(key);                     // it works now
      }
    }
  }
}

/** Bring the memoized index of `transcriptPath` up to date and return it. */
function scan(transcriptPath) {
  let size;
  try { size = fs.statSync(transcriptPath).size; } catch (err) { void err; return null; }
  let st = _memo.get(transcriptPath);
  if (!st || size < st.offset) {
    st = _newState();
    st.offset = Math.max(0, size - COLD_MAX_BYTES);
    st.coldCut = st.offset > 0; // first line may be partial → dropped below
  }
  if (size > st.offset) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(size - st.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, st.offset);
      st.offset += n;
      const lines = (st.carry + buf.subarray(0, n).toString('utf8')).split('\n');
      st.carry = lines.pop(); // incomplete last line waits for the rest
      if (st.coldCut) { lines.shift(); st.coldCut = false; }
      for (const line of lines) _ingestLine(st, line);
    } finally { fs.closeSync(fd); }
  }
  _memo.delete(transcriptPath);
  _memo.set(transcriptPath, st);
  if (_memo.size > MEMO_MAX) _memo.delete(_memo.keys().next().value);
  return st;
}

/**
 * @param {string} transcriptPath
 * @param {string} command
 * @param {string} cwd
 * @param {{threshold?:number}} [opts]
 * @returns {{hit:boolean, sig:string, count:number, cause?:string, exitCode?:number|null}}
 */
function lookup(transcriptPath, command, cwd, { threshold = 2 } = {}) {
  const key = keyOf(command, cwd);
  const sig = key ? key.slice(0, key.lastIndexOf('@')) : '';
  if (!key || !transcriptPath) return { hit: false, sig, count: 0 };
  const st = scan(transcriptPath);
  const f = st && st.failures.get(key);
  if (!f) return { hit: false, sig, count: 0 };
  const hit = f.count >= threshold && st.editSeq === f.lastFailEditSeq;
  return { hit, sig, count: f.count, cause: f.cause, exitCode: f.exitCode, editedSince: st.editSeq !== f.lastFailEditSeq };
}

function _resetMemo() { _memo.clear(); }

module.exports = { lookup, scan, keyOf, effectiveDir, _resetMemo };
