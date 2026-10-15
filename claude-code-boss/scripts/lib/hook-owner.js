'use strict';
/**
 * hook-owner.js — say WHICH plugin owns a hook that just failed (best effort).
 *
 * Claude Code writes a failing hook into the session transcript as an attachment
 * (`hook_non_blocking_error`: hookName/hookEvent/stderr/exitCode/durationMs, plus the raw
 * `command` for command hooks; `hook_cancelled` with timedOut/timeoutMs for a timeout) and
 * labels it on screen only by event ("UserPromptSubmit hook error") — never by plugin
 * (anthropics/claude-code#86368). This module reads the NEW records of the current
 * session on the next prompt and builds a visible line naming the owner:
 *
 *   - command hook  → exact match of the recorded command string against every installed
 *     plugin's hooks.json and the user/project settings: unique match = "dono: X".
 *   - mcp_tool hook → the record has NO command, so only event(+matcher) narrows it:
 *     one candidate = "dono provável: X"; several = "candidatos: A, B". Never faked certainty.
 *
 * Rides the UserPromptSubmit `systemMessage`. Each record is told once (state file).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE = 'hook-owner-state.json';
const TAIL_BYTES = 512 * 1024;
const KEEP_SEEN = 60;
const MAX_SHOWN = 3;
const FAIL_TYPES = new Set(['hook_non_blocking_error', 'hook_cancelled']);

const readJson = (file) => require('../../engine/lib/json-file.js').readJsonLoud(file, 'hook-owner');

function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Flatten a `{hooks:{Event:[{matcher,hooks:[...]}]}}` object into plain entries. */
function flattenHooks(doc, source) {
  const root = doc && typeof doc === 'object' ? (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : doc) : null;
  const out = [];
  if (!root) return out;
  for (const [event, groups] of Object.entries(root)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        out.push({ source, event, matcher: g.matcher || '', type: h.type || 'command', command: h.command || null, args: Array.isArray(h.args) ? h.args.map(String) : [], tool: h.tool || null, server: h.server || null });
      }
    }
  }
  return out;
}

/** Every hook the machine could be running for this cwd, tagged with its owner. */
function loadRegistry({ cwd, env = process.env } = {}) {
  const dir = claudeDir(env);
  const entries = [];
  const installed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = (installed && installed.plugins) || {};
  for (const [key, list] of Object.entries(plugins)) {
    const name = String(key).split('@')[0];
    for (const inst of (Array.isArray(list) ? list : [])) {
      if (!inst || !inst.installPath) continue;
      entries.push(...flattenHooks(readJson(path.join(inst.installPath, 'hooks', 'hooks.json')), `plugin ${name}`));
    }
  }
  entries.push(...flattenHooks(readJson(path.join(dir, 'settings.json')), 'settings do usuário (~/.claude/settings.json)'));
  if (cwd) {
    entries.push(...flattenHooks(readJson(path.join(cwd, '.claude', 'settings.json')), 'settings do projeto (.claude/settings.json)'));
    entries.push(...flattenHooks(readJson(path.join(cwd, '.claude', 'settings.local.json')), 'settings locais do projeto (.claude/settings.local.json)'));
  }
  return entries;
}

function matcherFits(entryMatcher, value) {
  if (!entryMatcher || entryMatcher === '*' || !value) return true;
  try { return new RegExp(`^(?:${entryMatcher})$`).test(value); }
  catch (err) { console.error(`[hook-owner] bad matcher ${JSON.stringify(entryMatcher)} (${err.message}) — treated as a fit`); return true; }
}

/**
 * Does a recorded command string belong to this hook entry? A hook declared as
 * `command` + `args` is recorded with the pieces joined (exact quoting is the host's), so
 * compare by the command word plus every arg appearing in the record, not by one string.
 */
function commandMatches(entry, recorded) {
  if (!entry.command) return false;
  if (!entry.args.length) return entry.command === recorded;
  return recorded.startsWith(entry.command) && entry.args.every((a) => recorded.includes(a));
}

/**
 * Who owns this failure record? → `{ certain, owners: [label...] }`.
 * `certain` only for an exact command-string match with ONE owner.
 */
function findOwners(rec, registry) {
  const colon = String(rec.hookName || '').indexOf(':');
  const matcherValue = colon >= 0 ? String(rec.hookName).slice(colon + 1) : '';
  const byEvent = registry.filter((e) => e.event === rec.hookEvent && matcherFits(e.matcher, matcherValue));
  let pool;
  let certain = false;
  if (rec.command) {
    pool = byEvent.filter((e) => e.type === 'command' && commandMatches(e, rec.command));
    certain = true;
  } else {
    pool = byEvent.filter((e) => e.type === 'mcp_tool');
    // A tool/server name in the error text narrows it further.
    const text = `${rec.stderr || ''}\n${rec.stdout || ''}`;
    const named = pool.filter((e) => (e.tool && text.includes(e.tool)) || (e.server && text.includes(e.server)));
    if (named.length) { pool = named; certain = false; }
  }
  const owners = [...new Set(pool.map((e) => e.source))];
  return { certain: certain && owners.length === 1, owners };
}

function describe(rec, registry) {
  const { certain, owners } = findOwners(rec, registry);
  const event = rec.hookName || rec.hookEvent || 'hook';
  const what = rec.type === 'hook_cancelled'
    ? `estourou o tempo (${Math.round((rec.timeoutMs || rec.durationMs || 0) / 1000)}s)`
    : `falhou (saída ${rec.exitCode})`;
  let who;
  if (!owners.length) who = 'dono não identificado (nenhum plugin ou settings declara esse hook)';
  else if (certain) who = `dono: ${owners[0]}`;
  else if (owners.length === 1) who = `dono provável: ${owners[0]}`;
  else who = `candidatos: ${owners.join(', ')}`;
  return `Hook ${event} ${what} → ${who}.`;
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
 * `stateDir`/`env` are injectable for tests.
 */
function takeFailureNotices({ event, stateDir, env = process.env } = {}) {
  if (!event || !event.transcript_path || !event.session_id) return null;
  const failures = readFailures(event.transcript_path);
  if (!failures.length) return null;
  const file = path.join(stateDir || require('../../engine/lib/data-dir.js').globalDir(), STATE);
  const state = readJson(file) || {};
  const seen = new Set((state.seen && state.seen[event.session_id]) || []);
  const fresh = failures.filter((f) => !seen.has(f.uuid));
  if (!fresh.length) return null;
  const registry = loadRegistry({ cwd: event.cwd, env });
  const shown = fresh.slice(0, MAX_SHOWN);
  const lines = shown.map((f) => describe(f, registry));
  // Only what was actually shown counts as told: the overflow is named on the next prompt.
  if (fresh.length > MAX_SHOWN) lines.push(`(+${fresh.length - MAX_SHOWN} falhas de hook)`);
  state.seen = { ...(state.seen || {}), [event.session_id]: [...seen, ...shown.map((f) => f.uuid)].slice(-KEEP_SEEN) };
  const ids = Object.keys(state.seen);
  if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) delete state.seen[id];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  require('../../engine/lib/atomic-write.js').writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
  return lines.join(' ');
}

module.exports = { takeFailureNotices, findOwners, describe, loadRegistry, readFailures, flattenHooks };
