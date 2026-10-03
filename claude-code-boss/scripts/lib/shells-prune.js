'use strict';
/**
 * shells-prune.js — prune curated scripts that NEVER ran in a window.
 *
 * Every registered alias is a command the guard may redirect and a line in the
 * SessionStart curation notice: a script nobody runs is pure noise. Safety rules
 * (a wrong prune silently removes a working redirect):
 *   - usage comes from the metrics store (curation.used/.redirected/.piped), which
 *     only exists since 3.0 — candidates require the usage history to cover the
 *     WHOLE window, else none ("insufficient history"), never "everything unused";
 *   - a script younger than the window is never a candidate;
 *   - apply re-derives the candidates and refuses any id that isn't one (loud);
 *   - only the shells.json registration goes (backup written); the script file
 *     stays — re-registering it restores the redirect.
 */
const fs = require('fs');
const path = require('path');
const { getShellsConfigPath } = require('../curation-paths.js');
const { writeFileAtomic } = require('./atomic-write.js');

const DAY = 86400_000;

function readShellsFile(root) {
  const file = getShellsConfigPath(root);
  if (!file || !fs.existsSync(file)) return { file, json: null };
  return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const scriptOf = (s) => String((s && (s.script || s.command || s.path)) || '').trim();

// Backups live in the plugin data dir — never next to shells.json (a versioned .vscode/
// would get them committed) — and only the newest KEEP_BACKUPS per project are kept.
const KEEP_BACKUPS = 5;
function backupPath(root, now) {
  const { dataDir } = require('./data-dir.js');
  const dir = path.join(dataDir(), '.runtime', 'shells-backups');
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `${path.basename(path.resolve(root)).replace(/[^\w.-]+/g, '_')}-`;
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - (KEEP_BACKUPS - 1)))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (err) { console.error(`[shells-prune] could not drop old backup ${f}: ${err.message}`); }
  }
  return path.join(dir, `${prefix}${now}.json`);
}

function ageDaysOf(root, rel, now) {
  try {
    const st = fs.statSync(path.resolve(root, rel));
    const born = Math.min(st.birthtimeMs > 0 ? st.birthtimeMs : Infinity, st.mtimeMs);
    return (now - born) / DAY;
  } catch (err) {
    if (err.code === 'ENOENT') return Infinity; // dangling entry: the file is gone — prunable
    throw err;
  }
}

/**
 * @param {{root:string, days:number, now?:number, usage?:Function, project?:string}} a
 *   usage(project, sinceTs) → {historyFromTs, usedIds} (default: metrics-store)
 *   project — the METRICS key (lib/metrics.js writes under the session root's basename;
 *   with shells.json in a subfolder, basename(root) reads an empty db). Default basename(root).
 * @returns {{ok:boolean, days:number, historyFromTs:(number|null), candidates:Array<{id:string, script:string, ageDays:number|null}>, reason?:string, error?:string}}
 */
function pruneCandidates({ root, days = 30, now = Date.now(), usage, project } = {}) {
  if (!root) return { ok: false, days, historyFromTs: null, candidates: [], error: 'root is required' };
  let shells;
  try {
    const { file, json } = readShellsFile(root);
    if (!json) return { ok: false, days, historyFromTs: null, candidates: [], error: `no shells config under ${root}${file ? ` (${file})` : ''}` };
    shells = Array.isArray(json.shells) ? json.shells : [];
  } catch (err) {
    return { ok: false, days, historyFromTs: null, candidates: [], error: `shells config unreadable: ${err.message}` };
  }
  const since = now - days * DAY;
  const read = usage || ((project, sinceTs) => require('./metrics-store.js').getCurationUsageIsolated(project, sinceTs));
  const { historyFromTs, usedIds } = read(project || path.basename(path.resolve(root)), since);
  if (!historyFromTs || historyFromTs > since) {
    const from = historyFromTs ? new Date(historyFromTs).toISOString().slice(0, 10) : 'never';
    return { ok: true, days, historyFromTs, candidates: [], reason: `insufficient usage history for a ${days}-day window (curation metrics since ${from}) — nothing is called unused before the window is covered` };
  }
  const used = new Set(usedIds);
  const candidates = [];
  for (const s of shells) {
    if (!s || !s.id || used.has(s.id)) continue;
    const rel = scriptOf(s);
    const age = rel ? ageDaysOf(root, rel, now) : Infinity;
    if (age < days) continue; // younger than the window: no verdict yet
    candidates.push({ id: s.id, script: rel, ageDays: Number.isFinite(age) ? Math.floor(age) : null });
  }
  return { ok: true, days, historyFromTs, candidates };
}

/**
 * Remove `ids` from shells.json — only ids that are CURRENT candidates.
 * @returns {{ok:boolean, removed?:string[], backup?:string, file?:string, error?:string}}
 */
function pruneShells({ root, ids, days = 30, now = Date.now(), usage, project } = {}) {
  const want = [...new Set((ids || []).map(String))];
  if (!want.length) return { ok: false, error: 'no ids to prune' };
  const c = pruneCandidates({ root, days, now, usage, project });
  if (!c.ok) return { ok: false, error: c.error };
  const allowed = new Set(c.candidates.map((x) => x.id));
  const refused = want.filter((id) => !allowed.has(id));
  if (refused.length) {
    return { ok: false, error: `refused — not prune candidates in a ${days}-day window: ${refused.join(', ')}${c.reason ? ` (${c.reason})` : ''}` };
  }
  const { file, json } = readShellsFile(root);
  const backup = backupPath(root, now);
  fs.copyFileSync(file, backup);
  const before = json.shells.length;
  json.shells = json.shells.filter((s) => !want.includes(String(s && s.id)));
  writeFileAtomic(file, JSON.stringify(json, null, 2) + String.fromCharCode(10)); // keep it human-readable (writeJsonAtomic is compact)
  return { ok: true, removed: want, kept: json.shells.length, removedCount: before - json.shells.length, backup: backup.replace(/\\/g, '/'), file: file.replace(/\\/g, '/') };
}

/**
 * Metrics key for a shells root when the calling session is unknown (dashboard): the
 * nearest folder from `root` up to its repo top (`.git`) whose basename has a metrics
 * db in `known` — sessions record under the SESSION root, which can be an ancestor of
 * the shells.json folder. Falls back to basename(root).
 */
function metricsProjectFor(root, known) {
  const have = new Set(known || []);
  let dir = path.resolve(root);
  for (let i = 0; i < 12; i++) {
    if (have.has(path.basename(dir))) return path.basename(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(path.resolve(root));
}

module.exports = { pruneCandidates, pruneShells, metricsProjectFor };
