'use strict';
/**
 * hook-owner.js — say where a hook that just failed comes from, by what the hook DECLARES.
 *
 * Claude Code writes a failing hook into the session transcript as an attachment
 * (`hook_non_blocking_error`: hookName/hookEvent/stderr/exitCode/durationMs, plus the raw
 * `command` for command hooks; `hook_cancelled` with timedOut/timeoutMs for a timeout) and
 * labels it on screen only by event ("UserPromptSubmit hook error") — never by plugin
 * (anthropics/claude-code#86368). This module reads the NEW records of the current
 * session on the next prompt and builds a visible line naming the origin.
 *
 * Hook-origin convention (shared by every project that installs hooks): the origin is what the
 * hook declares, never a guess —
 *   - command hook   → `--hook-origin=<project>` at the end of the command line (the record
 *     carries the command; every command hook in hooks/hooks.json is signed with it);
 *   - no command line (mcp_tool) → the error text starts with `[hook-origin=<project>]`.
 * Declared → "origem: <project>"; not declared (or two different declarations) → "origem não
 * declarada". Never "dono" or "provável".
 *
 * Rides the UserPromptSubmit `systemMessage`. Each record is told once (state file).
 */
const fs = require('fs');
const path = require('path');

const STATE = 'hook-owner-state.json';
const TAIL_BYTES = 512 * 1024;
const KEEP_SEEN = 60;
const MAX_SHOWN = 3;
const FAIL_TYPES = new Set(['hook_non_blocking_error', 'hook_cancelled']);

const HOOK_ORIGIN_FLAG = '--hook-origin';
const BOSS_ORIGIN = 'claude-code-boss';
const UNDECLARED = 'origem não declarada';
const NAME = '[a-z0-9][a-z0-9._-]{0,63}';
const IN_COMMAND = new RegExp(String.raw`(?:^|\s)${HOOK_ORIGIN_FLAG}=(${NAME})(?=\s|$)`, 'gi');
const IN_OUTPUT = new RegExp(String.raw`\[hook-origin=(${NAME})\]`, 'gi');

const readJson = (file) => require('../../engine/lib/json-file.js').readJsonLoud(file, 'hook-owner');

/** Origin declared by a failed hook (command first, then its output), or null if none / two different. */
function declaredOrigin({ command = '', output = '' } = {}) {
  for (const [text, re] of [[command, IN_COMMAND], [output, IN_OUTPUT]]) {
    const found = new Set([...String(text || '').matchAll(re)].map((m) => m[1].toLowerCase()));
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return null;
  }
  return null;
}

/** Visible line for one failure record: event, what happened, declared origin. */
function describe(rec) {
  const origin = declaredOrigin({ command: rec.command, output: `${rec.stderr || ''}
${rec.stdout || ''}` });
  const event = rec.hookName || rec.hookEvent || 'hook';
  const what = rec.type === 'hook_cancelled'
    ? `estourou o tempo (${Math.round((rec.timeoutMs || rec.durationMs || 0) / 1000)}s)`
    : `falhou (saída ${rec.exitCode})`;
  return `Hook ${event} ${what} → ${origin ? `origem: ${origin}` : UNDECLARED}.`;
}

/** Failure records in the tail of a transcript, oldest first. */
function readFailures(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is cut mid-record
    const out = [];
    for (const line of lines) {
      if (!line.includes('"hook_non_blocking_error"') && !line.includes('"hook_cancelled"')) continue;
      let row;
      try { row = JSON.parse(line); }
      catch (err) { console.error(`[hook-owner] unparsable transcript line (${err.message}) — skipped`); continue; }
      const a = row && row.attachment;
      if (a && FAIL_TYPES.has(a.type) && row.uuid) out.push({ ...a, uuid: row.uuid });
    }
    return out;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[hook-owner] cannot read transcript ${transcriptPath}: ${err.message}`);
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * New (not yet told) failures of this session → one visible message, or null.
 * `stateDir` is injectable for tests.
 */
function takeFailureNotices({ event, stateDir } = {}) {
  if (!event || !event.transcript_path || !event.session_id) return null;
  const failures = readFailures(event.transcript_path);
  if (!failures.length) return null;
  const file = path.join(stateDir || require('../../engine/lib/data-dir.js').globalDir(), STATE);
  const state = readJson(file) || {};
  const seen = new Set((state.seen && state.seen[event.session_id]) || []);
  const fresh = failures.filter((f) => !seen.has(f.uuid));
  if (!fresh.length) return null;
  const shown = fresh.slice(0, MAX_SHOWN);
  const lines = shown.map((f) => describe(f));
  // Only what was actually shown counts as told: the overflow is named on the next prompt.
  if (fresh.length > MAX_SHOWN) lines.push(`(+${fresh.length - MAX_SHOWN} falhas de hook)`);
  state.seen = { ...(state.seen || {}), [event.session_id]: [...seen, ...shown.map((f) => f.uuid)].slice(-KEEP_SEEN) };
  const ids = Object.keys(state.seen);
  if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) delete state.seen[id];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  require('../../engine/lib/atomic-write.js').writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
  return lines.join(' ');
}

module.exports = { takeFailureNotices, declaredOrigin, describe, readFailures, HOOK_ORIGIN_FLAG, BOSS_ORIGIN, UNDECLARED };
