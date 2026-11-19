'use strict';

/**
 * transcript-repair.js — repairs session transcripts whose compaction copies chain to a row before the boundary.
 *
 * After a `session.compact` answered with tool results that still carried their engine handle, Claude Code wrote each
 * copied tool result with `parentUuid` / `sourceToolAssistantUUID` of the pre-boundary original. From a transcript past
 * 5 MB it loads from the last boundary, misses that parent and drops the brief and the start of the kept tail. The
 * repair re-points each such result to the copy of its call written after the same boundary. It changes nothing else:
 * a crossing row that is not a tool result (a queued message, the caveat of a native /compact) is reported, never guessed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUIET_MS = 15 * 60000;
const SESSION_RETRIES = 3;

/**
 * @param {string} text transcript content
 * @returns {{fixes: Array<{line:number, from:string, to:string}>, unfixable: number, boundaries: number, lastCrossing: number}}
 *   `line` is the 0-based index of the row to re-point; `unfixable` counts crossing rows left as they are.
 */
function planRepair(text) {
  const rows = text.split('\n').map((l) => { if (l.length < 2) return null; try { return JSON.parse(l); } catch { return null; } });
  const lineOf = new Map();
  rows.forEach((o, i) => { if (o && o.uuid) lineOf.set(o.uuid, i); });
  const bounds = [];
  rows.forEach((o, i) => { if (o && o.type === 'system' && o.subtype === 'compact_boundary') bounds.push(i); });
  const fixes = [];
  let unfixable = 0;
  bounds.forEach((b, k) => {
    const end = k + 1 < bounds.length ? bounds[k + 1] : rows.length;
    const ownerByTool = new Map();
    const ownerByResponse = new Map();
    for (let i = b + 1; i < end; i++) {
      const o = rows[i];
      if (!o || o.type !== 'assistant' || o.isSidechain) continue;
      const calls = (o.message?.content ?? []).filter((c) => c.type === 'tool_use');
      for (const c of calls) ownerByTool.set(c.id, o.uuid);
      if (calls.length && o.message?.id) ownerByResponse.set(o.message.id, o.uuid);
    }
    for (let i = b + 1; i < end; i++) {
      const o = rows[i];
      if (!o || !o.parentUuid || o.isSidechain || o.isCompactSummary) continue;
      const parentLine = lineOf.get(o.parentUuid);
      if (parentLine === undefined || parentLine >= b) continue;
      const toolId = o.type === 'user' && Array.isArray(o.message?.content) ? o.message.content.find((c) => c.type === 'tool_result')?.tool_use_id : null;
      const to = toolId ? (ownerByTool.get(toolId) ?? ownerByResponse.get(rows[parentLine]?.message?.id)) : null;
      if (to) fixes.push({ line: i, from: o.parentUuid, to }); else unfixable++;
    }
  });
  return { fixes, unfixable, boundaries: bounds.length, lastCrossing: crossingsOfLastSegment(rows, lineOf, bounds) };
}

/** Rows after the last boundary whose parent sits before it, on the chain from the newest main-thread row. */
function crossingsOfLastSegment(rows, lineOf, bounds) {
  if (!bounds.length) return 0;
  const last = bounds[bounds.length - 1];
  let leaf = null;
  for (const o of rows) if (o && o.uuid && !o.isSidechain && (o.type === 'user' || o.type === 'assistant')) leaf = o.uuid;
  let n = 0;
  const seen = new Set();
  for (let c = leaf; c && lineOf.has(c) && !seen.has(c);) {
    seen.add(c);
    const o = rows[lineOf.get(c)];
    if (lineOf.get(c) < last) break;
    const p = o.parentUuid ? lineOf.get(o.parentUuid) : undefined;
    if (p !== undefined && p < last && !o.isCompactSummary) n++;
    c = o.parentUuid;
  }
  return n;
}

/**
 * @param {string[]} lines transcript split on '\n'
 * @param {Array<{line:number, to:string}>} fixes
 * @returns {string[]} a copy with each listed row re-pointed
 */
function applyFixes(lines, fixes) {
  const out = lines.slice();
  for (const f of fixes) {
    const o = JSON.parse(out[f.line]);
    o.parentUuid = f.to;
    if (o.sourceToolAssistantUUID) o.sourceToolAssistantUUID = f.to;
    out[f.line] = JSON.stringify(o);
  }
  return out;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Session ids of the Claude Code processes that are running (`<sessionsDir>/<pid>.json` with a live pid).
 * An entry of a running pid that stays unreadable may be a live session being rewritten: its id is unknown, so this
 * throws and nothing may be repaired. An unreadable entry of a dead pid is a leftover.
 * @returns {Set<string>}
 */
function liveSessionIds({ sessionsDir, isAlive = pidAlive, retryMs = 1000 }) {
  const ids = new Set();
  if (!fs.existsSync(sessionsDir)) return ids;
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const pid = Number(f.slice(0, -5));
    let entry = null;
    for (let attempt = 0; !entry; attempt++) {
      if (!isAlive(pid)) break;
      try { entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch (err) {
        if (attempt === SESSION_RETRIES - 1) throw new Error(`sessions/${f} unreadable (${err.message}): cannot tell which session is live; nothing repaired`);
        sleep(retryMs);
      }
    }
    if (entry && entry.sessionId) ids.add(entry.sessionId);
  }
  return ids;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const parsedCount = (lines) => lines.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } }).length;

/** Why a rewritten file is not acceptable, or null: same line count, same parsed lines, only the planned rows changed, nothing left to fix. */
function verifyRewrite(beforeLines, afterLines, plan) {
  if (afterLines.length !== beforeLines.length) return `line count ${afterLines.length} instead of ${beforeLines.length}`;
  if (parsedCount(afterLines) !== parsedCount(beforeLines)) return 'parsed lines differ';
  const changed = afterLines.filter((l, i) => l !== beforeLines[i]).length;
  if (changed !== plan.fixes.length) return `${changed} rows changed instead of ${plan.fixes.length}`;
  const again = planRepair(afterLines.join('\n'));
  if (again.fixes.length) return `${again.fixes.length} rows still to fix`;
  if (again.lastCrossing > plan.lastCrossing) return 'more crossings than before';
  return null;
}

/** The stable folder for repair backups: under the plugin data dir, never a temp folder. */
function defaultBackupRoot(dataDirFn = require('../../engine/lib/data-dir.js').dataDir) {
  return path.join(dataDirFn(), 'transcript-repair');
}

/**
 * Repairs every transcript under `root` (`<root>/<project>/<session>.jsonl`) that has a crossing tool result.
 * Skips a session that is running and a file written within `quietMs`. Each file is copied to
 * `<backupRoot>/<runId>/<project>/<file>` first, written through a temp file and renamed, re-read and verified; a failed
 * check puts the backup back. The run is recorded in `<backupRoot>/<runId>/manifest.json`.
 * @param {{root:string, sessionsDir:string, backupRoot:string, isAlive?:(pid:number)=>boolean, now?:number, quietMs?:number,
 *   runId?:string, dryRun?:boolean, retryMs?:number, verify?:(before:string[], after:string[], plan:object)=>string|null}} o
 */
function repairTranscripts(o) {
  const { root, sessionsDir, backupRoot, dryRun = false, quietMs = QUIET_MS, now = Date.now(), verify = verifyRewrite } = o;
  const live = dryRun ? new Set() : liveSessionIds({ sessionsDir, isAlive: o.isAlive, retryMs: o.retryMs });
  const runId = o.runId || new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, runId);
  const report = { root, mode: dryRun ? 'scan' : 'repair', backupDir: dryRun ? null : backupDir, files: 0, affected: 0, repaired: 0, rowsFixed: 0, unfixableRows: 0, skippedLive: [], skippedRecent: [], failed: [], stillCrossing: [] };
  const recorded = [];
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const rel = `${proj}/${f}`;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('compact_boundary')) continue;
      report.files++;
      const plan = planRepair(text);
      report.unfixableRows += plan.unfixable;
      if (!plan.fixes.length) continue;
      report.affected++;
      const lines = text.split('\n');
      if (dryRun) {
        report.rowsFixed += plan.fixes.length;
        const left = planRepair(applyFixes(lines, plan.fixes).join('\n')).lastCrossing;
        if (left) report.stillCrossing.push({ file: rel, links: left });
        continue;
      }
      if (live.has(f.slice(0, -6))) { report.skippedLive.push(rel); continue; }
      if (now - fs.statSync(file).mtimeMs < quietMs) { report.skippedRecent.push(rel); continue; }
      const backup = path.join(backupDir, proj, f);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      if (fs.readFileSync(backup, 'utf8') !== text) { report.failed.push({ file: rel, why: 'backup differs from the file; written meanwhile' }); continue; }
      const fixed = applyFixes(lines, plan.fixes);
      const tmp = `${file}.repair-tmp`;
      fs.writeFileSync(tmp, fixed.join('\n'));
      if (fs.readFileSync(file, 'utf8') !== text) { fs.rmSync(tmp); report.failed.push({ file: rel, why: 'file changed during the repair' }); continue; }
      fs.renameSync(tmp, file);
      const problem = verify(lines, fs.readFileSync(file, 'utf8').split('\n'), plan);
      if (problem) { fs.copyFileSync(backup, file); report.failed.push({ file: rel, why: `${problem}; restored from backup` }); continue; }
      const after = fs.readFileSync(file, 'utf8');
      const left = planRepair(after).lastCrossing;
      if (left) report.stillCrossing.push({ file: rel, links: left });
      report.repaired++;
      report.rowsFixed += plan.fixes.length;
      recorded.push({ file: rel, rowsFixed: plan.fixes.length, bytesBefore: Buffer.byteLength(text), bytesAfter: Buffer.byteLength(after), sha256Before: sha256(text), sha256After: sha256(after) });
    }
  }
  if (recorded.length) fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ runId, createdAt: new Date(now).toISOString(), root, files: recorded }, null, 1));
  return report;
}

/**
 * Moves a backup tree made elsewhere (`<from>/<project>/<file>.jsonl`) into `<backupRoot>/<runId>/` and writes its
 * manifest from the files themselves: the rows that differ between each backup and the transcript now.
 * A move across volumes copies and leaves the source in place (`leftAtSource`): nothing here deletes a backup.
 */
function adoptBackup({ from, root, backupRoot, runId = `adopted-${new Date().toISOString().replace(/[:.]/g, '-')}` }) {
  if (!fs.existsSync(from)) throw new Error(`adoptBackup: ${from} does not exist`);
  const target = path.join(backupRoot, runId);
  if (fs.existsSync(target)) throw new Error(`adoptBackup: ${target} already exists`);
  fs.mkdirSync(backupRoot, { recursive: true });
  let leftAtSource = false;
  try { fs.renameSync(from, target); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, target, { recursive: true });
    leftAtSource = true;
  }
  const files = [];
  for (const proj of fs.readdirSync(target)) {
    const dir = path.join(target, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const before = fs.readFileSync(path.join(dir, f), 'utf8');
      const current = path.join(root, proj, f);
      const entry = { file: `${proj}/${f}`, bytesBefore: Buffer.byteLength(before), sha256Before: sha256(before) };
      if (fs.existsSync(current)) {
        const after = fs.readFileSync(current, 'utf8');
        const a = before.split('\n'); const b = after.split('\n');
        Object.assign(entry, { rowsFixed: a.filter((l, i) => l !== b[i]).length, bytesAfter: Buffer.byteLength(after), sha256After: sha256(after) });
      } else entry.missingNow = true;
      files.push(entry);
    }
  }
  const manifest = { runId, createdAt: new Date().toISOString(), root, adopted: true, leftAtSource, files };
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

module.exports = { planRepair, applyFixes, liveSessionIds, repairTranscripts, adoptBackup, defaultBackupRoot, QUIET_MS };
