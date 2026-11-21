'use strict';
/**
 * folder-ttl-scan.js — which folders hold a 5m prompt-cache TTL in their settings.local.json, and whose it is.
 *
 * A folder is "Boss-stuck" when the key is 5m, the metrics db records a switch of that folder with no restore after
 * it, and the folder state no longer owns it (the state was lost). It is "unrecorded" when the key is 5m with no
 * recorded switch and has stood for more than a day: the user's own value, or a switch whose record is gone.
 */
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const ACTIONS = ['switched', 'restored', 'released'];

/** Newest switch/restore/release event per folder key, across every metrics project. */
function lastEvents({ dataDir, folderKey }) {
  const store = require('../../engine/lib/metrics-store.js');
  const last = new Map();
  for (const project of store.listProjects({ dataDir })) {
    for (const e of store.getEventLogIsolated(project, { eventName: 'compaction.folder', limit: 500, dataDir })) {
      const p = e.payload || {};
      if (!ACTIONS.includes(p.action) || typeof p.folder !== 'string') continue;
      const key = folderKey(p.folder);
      const cur = last.get(key);
      if (!cur || e.ts > cur.ts) last.set(key, { ts: e.ts, action: p.action, dir: p.folder });
    }
  }
  return last;
}

/**
 * @param {{includeMetrics?:boolean, dataDir?:string, now?:number, stateFile?:string, evidence?:(dir:string)=>boolean}} [opts]
 *   includeMetrics: also visit every folder any metrics db ever recorded (hundreds of dbs); off = the folders of the live state only
 * @returns {Array<{folder:string, file:string, value:string, mtime:number, ageDays:number, otherKeys:string[], lastAction:(string|null), lastAt:(number|null), owned:boolean, bossStuck:boolean, unrecorded:boolean}>}
 */
function scanFolders({ includeMetrics = false, dataDir, now = Date.now(), stateFile, evidence } = {}) {
  const ft = require('./folder-ttl.js');
  const switchRecorded = evidence || ft.recordedSwitch;
  const state = ft.readState(stateFile || ft.statePath()) || { folders: {} };
  const last = includeMetrics ? lastEvents({ dataDir, folderKey: ft.folderKey }) : new Map();
  const dirs = new Map();
  for (const e of Object.values(state.folders)) dirs.set(ft.folderKey(e.dir), e.dir);
  for (const [key, ev] of last) if (!dirs.has(key)) dirs.set(key, ev.dir);

  const rows = [];
  for (const [key, dir] of dirs) {
    const file = path.join(dir, '.claude', 'settings.local.json');
    let st;
    try { st = fs.statSync(file); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error(`[folder-ttl-scan] ${file}: ${err.message}`); continue; }
    const value = json && json.env && json.env[ft.KEY];
    if (typeof value !== 'string') continue;
    const ev = includeMetrics ? last.get(key) : (switchRecorded(dir) ? { action: 'switched', ts: null } : null);
    const owned = !!(state.folders[key] && state.folders[key].owned);
    const recorded = !!ev && ev.action === 'switched';
    const ageDays = (now - st.mtimeMs) / DAY_MS;
    rows.push({
      folder: dir, file, value, mtime: st.mtimeMs, ageDays: Math.round(ageDays * 10) / 10,
      otherKeys: [...Object.keys(json).filter((k) => k !== 'env'), ...Object.keys(json.env).filter((k) => k !== ft.KEY).map((k) => `env.${k}`)],
      lastAction: ev ? ev.action : null, lastAt: ev ? ev.ts : null, owned,
      bossStuck: value === ft.SWITCHED && recorded && !owned,
      unrecorded: value === ft.SWITCHED && !recorded && !owned && ageDays > 1,
    });
  }
  return rows;
}

module.exports = { scanFolders };
