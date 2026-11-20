'use strict';
/**
 * maintenance-notices.js — the one-shot lines that tell the user about maintenance they did not start:
 * the weekly KB consolidation (it deletes merged duplicates) and curated scripts that never ran. Every function takes the data dir (or its inputs) explicitly, so a test passes a
 * temp folder and never reaches the real store.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');
const { onCooldown, stamp } = require('./cooldown-stamp.js');

const DAY = 86400000;
const UNUSED_WINDOW_DAYS = 30;
const UNUSED_NOTICE_COOLDOWN_MS = 7 * DAY;
const LISTED_IDS = 3;

const consolidationFile = (dataDir) => path.join(dataDir, '.runtime', 'consolidation-notice.json');
const unusedStampFile = (dataDir, project) => path.join(dataDir, '.runtime', `unused-scripts-notice-${String(project).replace(/[^\w.-]+/g, '_')}.json`);

/**
 * Note one applied consolidation: a metric row and the line the next SessionStart shows once.
 * A run that merged nothing leaves no trace.
 * @param {string} dataDir
 * @param {{project:string, groups:number, merged:number, deleted:number}} result
 * @param {(name:string, payload:object)=>void} recordEvent
 * @param {number} [now]
 * @returns {boolean} true when something was recorded
 */
function recordConsolidation(dataDir, result, recordEvent, now = Date.now()) {
  const { project, groups, merged, deleted } = result;
  if (!(merged > 0 || deleted > 0)) return false;
  try { recordEvent('lesson.consolidated', { project, groups, merged, deleted }); } catch (err) {
    console.error(`[maintenance-notices] metric lesson.consolidated not recorded: ${err.message}`);
  }
  const file = consolidationFile(dataDir);
  let items = [];
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')).items || []; } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[maintenance-notices] ${file} unreadable, rewritten: ${err.message}`);
  }
  items = items.filter((i) => i.project !== project);
  items.push({ ts: now, project, groups, merged, deleted });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { items });
  return true;
}

/**
 * The consolidation line for SessionStart, shown once: the file is removed when read.
 * @param {string} dataDir
 * @returns {string|null}
 */
function takeConsolidationNotice(dataDir) {
  const file = consolidationFile(dataDir);
  let items;
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')).items; } catch (err) {
    if (err.code !== 'ENOENT') { console.error(`[maintenance-notices] ${file} unreadable, removed: ${err.message}`); fs.rmSync(file, { force: true }); }
    return null;
  }
  fs.rmSync(file, { force: true });
  if (!Array.isArray(items) || !items.length) return null;
  const merged = items.reduce((n, i) => n + (i.merged || 0), 0);
  const deleted = items.reduce((n, i) => n + (i.deleted || 0), 0);
  const where = items.map((i) => i.project).join(', ');
  return `[MEMORY] The weekly consolidation merged ${merged} group(s) of near-duplicate lessons and removed ${deleted} duplicate(s) (${where}). A backup can be taken and restored in /dashboard -> Backup.`;
}

/**
 * Weekly line about curated scripts that never ran in the window and are old enough to judge, or null.
 * The week is only spent when a line is returned.
 * @param {string} dataDir
 * @param {{root:string, project?:string, now?:number, days?:number, prune?:Function}} a
 *   project — the METRICS key (default: the one the dashboard's prune panel uses for `root`)
 *   prune — `pruneCandidates` of lib/shells-prune.js (injectable for a test)
 * @returns {string|null}
 */
function unusedScriptsNotice(dataDir, { root, project, now = Date.now(), days = UNUSED_WINDOW_DAYS, prune } = {}) {
  const sp = require('./shells-prune.js');
  const metricsKey = project || sp.metricsProjectFor(root, require('../../engine/lib/metrics-store.js').listProjects());
  const stampFile = unusedStampFile(dataDir, metricsKey);
  if (onCooldown(stampFile, UNUSED_NOTICE_COOLDOWN_MS, now)) return null;
  const find = prune || sp.pruneCandidates;
  const r = find({ root, days, now, project: metricsKey });
  if (!r.ok) {
    if (/unreadable/.test(r.error || '')) console.error(`[maintenance-notices] unused scripts: ${r.error}`);
    return null;
  }
  if (!r.candidates.length) return null;
  stamp(stampFile, now);
  const ids = r.candidates.slice(0, LISTED_IDS).map((c) => c.id);
  const more = r.candidates.length > LISTED_IDS ? ` and ${r.candidates.length - LISTED_IDS} more` : '';
  return `[CURATION] ${r.candidates.length} curated script(s) never ran in the last ${days} days (${ids.join(', ')}${more}). Remove them in /dashboard -> Curation & guards.`;
}

module.exports = {
  recordConsolidation, takeConsolidationNotice, unusedScriptsNotice, UNUSED_WINDOW_DAYS,
};
