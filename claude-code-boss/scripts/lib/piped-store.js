'use strict';
/**
 * piped-store.js — how often the agent filtered a curated script's output the SAME way.
 *
 * `node tests.mjs | tail -3` repeated means the script prints more than the agent
 * wants: the fix is in the script (bake the filter / outputLines), not in every call.
 * Key: project + script + normalized filter. A count is reset when the script file
 * changed after it (the agent already tuned it — never nag twice for the same thing).
 * State: one JSON file in the plugin data dir, pruned by window and size.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

const MAX_KEYS = 500;

/**
 * Count one piped run and return the count for (project, script, filter).
 * @param {{file:string, project:string, scriptId:string, scriptMtimeMs:number, filter:string, windowDays:number, now?:number}} a
 */
function touch({ file, project, scriptId, scriptMtimeMs, filter, windowDays, now = Date.now() }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) { if (err.code !== 'ENOENT') console.error(`[piped-store] read ${file}: ${err.message}`); }
  const entries = state && typeof state.entries === 'object' && state.entries ? state.entries : {};
  const windowMs = windowDays * 86400_000;
  for (const k of Object.keys(entries)) if (!entries[k] || now - (entries[k].last || 0) > windowMs) delete entries[k];
  const key = `${project}\u0000${scriptId}\u0000${filter}`;
  let e = entries[key];
  // The script changed after the last count → the agent tuned it; start over.
  if (!e || (Number.isFinite(scriptMtimeMs) && scriptMtimeMs > (e.last || 0))) e = { count: 0 };
  e.count += 1;
  e.last = now;
  entries[key] = e;
  const keys = Object.keys(entries);
  if (keys.length > MAX_KEYS) keys.sort((a, b) => entries[a].last - entries[b].last).slice(0, keys.length - MAX_KEYS).forEach((k) => { delete entries[k]; });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { entries });
  } catch (err) {
    console.error(`[piped-store] could not persist ${file}: ${err.message}`);
  }
  return e.count;
}

module.exports = { touch, MAX_KEYS };
