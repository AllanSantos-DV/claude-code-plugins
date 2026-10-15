'use strict';
/**
 * folder-ttl.js — the prompt-cache TTL of the sessions in ONE folder, switched 1h → 5m while every live session
 * there is past the compaction threshold, and back after the cut (owner, 14/10).
 *
 * WHY a folder: Claude Code re-reads `<launch cwd>/.claude/settings.local.json` on every change (Claude Code Docs,
 * "Claude Code settings": the files are watched and reloaded), and that file sits above the user's settings, so its
 * `env.CLAUDE_CODE_PROMPT_CACHE_TTL` beats the `1h` the cost-tuning writes in the user's env. Measured in real
 * interactive sessions (CC 2.1.293, docs/BACKLOG.md "5ª rodada"): the session in that folder switched 1h→5m→1h, the
 * sessions in other folders did not, a launcher's `--settings` env without the key did not block it, and a session
 * whose cwd is a SUBFOLDER reads only its own cwd's file — not the git root's, not a parent's. So "the same folder" is
 * the exact launch cwd, normalized (case and slashes on Windows), never a prefix.
 *
 * Rules:
 *   - the TTL is the only thing the sessions of a folder share: 5m only when EVERY live session there is past the
 *     threshold; otherwise the file holds what it held before (one session past it does not switch the others);
 *   - ownership: we write only the key, remember what was there, and restore exactly that. A value the user put
 *     there (before us, or a change after us) is theirs: we never write over it and give up ownership;
 *   - a session is live while it reports (turns + a heartbeat from the module); one that stops reporting for
 *     LIVE_MS is dropped, so a crashed session's switch is restored at the next report of anyone (SessionStart of
 *     the next session included) — the "dead owner" sweep runs on every report;
 *   - a file we create inside a git repo goes to the repo's `info/exclude` (local, never committed) when git does
 *     not already ignore it.
 * The daemon is the single writer (every module reports through it), so the state needs no cross-process lock.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const KEY = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const SWITCHED = '5m';
const LIVE_MS = 5 * 60000;       // the module heartbeats every 2 min; 5 min without a report = gone
const LOCAL_REL = path.join('.claude', 'settings.local.json');

function hiddenSpawnSync(cmd, args, opts) { return spawnSync(cmd, args, { ...opts, windowsHide: true }); }

function statePath() {
  return path.join(require('../../engine/lib/data-dir.js').globalDir(), 'folder-ttl-state.json');
}

/**
 * The folder identity: the exact launch cwd, resolved, forward slashes, no trailing slash, lower case on Windows.
 * Never a prefix match: a folder and its subfolder are different folders (measured — each reads its own file).
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string}
 */
function folderKey(dir, platform = process.platform) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('folder-ttl: folder is required');
  let p = (platform === 'win32' ? path.win32 : path.posix).resolve(dir.trim()).replace(/\\/g, '/');
  if (p.length > 1 && !/^[A-Za-z]:\/$/.test(p)) p = p.replace(/\/+$/, '');
  return platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * What the folder's TTL should be now. Pure.
 * @param {{sessions: Object<string,{above:boolean, seenAt:number}>}} entry
 * @param {number} now
 * @param {number} [liveMs]
 * @returns {{live: string[], allAbove: boolean, want: ('5m'|null)}}  want null = whatever was there before us
 */
function planFolder(entry, now, liveMs = LIVE_MS) {
  const live = Object.entries((entry && entry.sessions) || {}).filter(([, s]) => now - Number(s.seenAt) < liveMs).map(([id]) => id);
  const allAbove = live.length > 0 && live.every((id) => entry.sessions[id].above === true);
  return { live, allAbove, want: allAbove ? SWITCHED : null };
}

function readLocal(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const json = JSON.parse(raw); // unparsable = the user's file in a state we must not touch: throw (fail-loud)
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} is not a JSON object`);
  return json;
}

/** Keep a file we created out of git: the repo's info/exclude (local only), unless git already ignores it. */
function excludeFromGit(dir, run = hiddenSpawnSync) {
  const rel = '.claude/settings.local.json';
  const ig = run('git', ['-C', dir, 'check-ignore', '-q', rel], { encoding: 'utf8' });
  if (ig.error) return { git: false, reason: `git not runnable: ${ig.error.message}` };
  if (ig.status === 0) return { git: true, ignored: 'already' };
  if (ig.status === 128) return { git: false };
  const ex = run('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  const pre = run('git', ['-C', dir, 'rev-parse', '--show-prefix'], { encoding: 'utf8' });
  if (ex.status !== 0 || pre.status !== 0) throw new Error(`git rev-parse failed in ${dir}: ${(ex.stderr || pre.stderr || '').trim()}`);
  const excludeFile = path.resolve(dir, ex.stdout.trim());
  const line = `/${pre.stdout.trim()}${rel}`;
  const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  return { git: true, ignored: 'info/exclude', excludeFile, line };
}

/**
 * Write env.<KEY> = 5m into the folder's settings.local.json. Returns the ownership record, or a skip reason when
 * the user already has the key there.
 */
function applySwitch(dir, run = hiddenSpawnSync) {
  const file = path.join(dir, LOCAL_REL);
  const dotDir = path.dirname(file);
  const dirExisted = fs.existsSync(dotDir);
  const json = readLocal(file);
  if (json && json.env && Object.prototype.hasOwnProperty.call(json.env, KEY)) return { skipped: `the folder's settings.local.json already sets ${KEY}=${json.env[KEY]} (the user's value)` };
  const next = json ? { ...json, env: { ...(json.env || {}), [KEY]: SWITCHED } } : { env: { [KEY]: SWITCHED } };
  fs.mkdirSync(dotDir, { recursive: true });
  const git = json ? null : excludeFromGit(dir, run);
  writeJsonAtomic(file, next);
  return { owned: { wrote: SWITCHED, createdFile: !json, createdDir: !dirExisted, hadEnv: !!(json && json.env), at: Date.now(), git } };
}

/** Undo applySwitch. A value changed since (not ours any more) is left alone. */
function restore(dir, owned) {
  const file = path.join(dir, LOCAL_REL);
  const json = readLocal(file);
  if (!json) return { restored: false, reason: 'file gone' };
  if (!json.env || json.env[KEY] !== owned.wrote) return { restored: false, reason: `${KEY} changed since we wrote it (now ${json.env ? json.env[KEY] : 'absent'}): the user's value, left alone` };
  const env = { ...json.env };
  delete env[KEY];
  const next = { ...json };
  if (Object.keys(env).length || owned.hadEnv) next.env = env; else delete next.env;
  if (owned.createdFile && !Object.keys(next).length) {
    fs.unlinkSync(file);
    if (owned.createdDir) {
      try { fs.rmdirSync(path.dirname(file)); } catch (err) { if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err; }
    }
    return { restored: true, removedFile: true };
  }
  writeJsonAtomic(file, next);
  return { restored: true };
}

function loadState(file) {
  if (!fs.existsSync(file)) return { folders: {} };
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return s && typeof s === 'object' && s.folders ? s : { folders: {} };
}

/** Bring one folder's file in line with its plan. Mutates the entry; returns what happened. */
function reconcile(entry, now, { run = hiddenSpawnSync, liveMs = LIVE_MS } = {}) {
  const plan = planFolder(entry, now, liveMs);
  for (const id of Object.keys(entry.sessions || {})) if (!plan.live.includes(id)) delete entry.sessions[id];
  let action = 'none';
  let detail = null;
  if (plan.want && !entry.owned && !entry.userValue) {
    const r = applySwitch(entry.dir, run);
    if (r.skipped) { entry.userValue = true; action = 'skipped'; detail = r.skipped; } else { entry.owned = r.owned; action = 'switched'; }
  } else if (!plan.want && entry.owned) {
    const r = restore(entry.dir, entry.owned);
    delete entry.owned;
    action = r.restored ? 'restored' : 'released';
    detail = r.reason || null;
  }
  if (!plan.want) delete entry.userValue; // judged again the next time every session is past the threshold
  return { ...plan, action, detail, ttl: entry.owned ? SWITCHED : null };
}

/**
 * One report from a session's module (or its end), then the sweep of every folder (dead owners restored).
 * @param {{sessionId:string, folder:string, above?:boolean, end?:boolean}} r
 * @param {{now?:number, file?:string, run?:Function, liveMs?:number}} [opts]
 * @returns {{folder:string, live:number, allAbove:boolean, ttl:('5m'|null), action:string, detail:(string|null), swept:Array}}
 */
function report(r, { now = Date.now(), file = statePath(), run = hiddenSpawnSync, liveMs = LIVE_MS } = {}) {
  if (!r || typeof r.sessionId !== 'string' || !r.sessionId) throw new Error('folder-ttl: sessionId is required');
  const key = folderKey(r.folder);
  const state = loadState(file);
  const entry = state.folders[key] || (state.folders[key] = { dir: path.resolve(r.folder), sessions: {} });
  if (r.end) delete entry.sessions[r.sessionId];
  else entry.sessions[r.sessionId] = { above: r.above === true, seenAt: now };
  let mine = null;
  const swept = [];
  const errors = [];
  for (const [k, e] of Object.entries(state.folders)) {
    try {
      const out = reconcile(e, now, { run, liveMs });
      if (k === key) mine = out;
      else if (out.action !== 'none') swept.push({ folder: e.dir, action: out.action, detail: out.detail });
    } catch (err) {
      errors.push(`${e.dir}: ${err.message}`);
      if (k === key) mine = { live: [], allAbove: false, ttl: e.owned ? SWITCHED : null, action: 'error', detail: err.message };
    }
    if (!Object.keys(e.sessions || {}).length && !e.owned) delete state.folders[k];
  }
  writeJsonAtomic(file, state);
  if (errors.length && (!mine || mine.action !== 'error')) swept.push(...errors.map((m) => ({ action: 'error', detail: m })));
  return { folder: entry.dir, live: mine.live.length, allAbove: mine.allAbove, ttl: mine.ttl, action: mine.action, detail: mine.detail, swept };
}

module.exports = { KEY, SWITCHED, LIVE_MS, folderKey, planFolder, applySwitch, restore, reconcile, report, excludeFromGit, statePath };
