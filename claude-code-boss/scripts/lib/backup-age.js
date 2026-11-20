'use strict';
/**
 * backup-age.js — how old the newest backup of the dashboard's Backup card is, and the doctor's verdict on it.
 * The Brain changes on its own every week (consolidation, promotion), so a missing or old backup is worth saying.
 */
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const BACKUP_NAME = /^ccb-backup-[0-9TZ-]+(-pre-restore)?\.tar\.gz$/;
const BACKUP_STALE_DAYS = 30;

/**
 * Newest backup archive of the dashboard's Backup card.
 * @param {string} backupsDir
 * @returns {{count:number, newestMs:number|null}}
 */
function newestBackup(backupsDir) {
  let names;
  try { names = fs.readdirSync(backupsDir).filter((f) => BACKUP_NAME.test(f)); } catch (err) {
    if (err.code === 'ENOENT') return { count: 0, newestMs: null };
    throw err;
  }
  const times = names.map((f) => fs.statSync(path.join(backupsDir, f)).mtimeMs);
  return { count: names.length, newestMs: times.length ? Math.max(...times) : null };
}

/**
 * Doctor verdict on backup age.
 * @param {{count:number, newestMs:number|null}} backup
 * @param {number} now
 * @param {number} [staleDays]
 * @returns {{ok:boolean, detail:string}}
 */
function backupVerdict(backup, now, staleDays = BACKUP_STALE_DAYS) {
  if (!backup || !backup.newestMs) return { ok: false, detail: 'no backup has been taken yet' };
  const age = Math.floor((now - backup.newestMs) / DAY);
  if (age > staleDays) return { ok: false, detail: `the newest backup is ${age} days old (more than ${staleDays})` };
  return { ok: true, detail: `newest backup is ${age} day(s) old (${backup.count} kept)` };
}

module.exports = { newestBackup, backupVerdict, BACKUP_STALE_DAYS };
