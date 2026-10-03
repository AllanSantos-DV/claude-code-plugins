'use strict';
/**
 * piped-store.js — how often the agent filtered a curated script's output the SAME way.
 *
 * `node tests.mjs | tail -3` repeated means the script prints more than the agent
 * wants: the fix is in the script (bake the filter / outputLines), not in every call.
 * Key: project + script + normalized filter. The Stop asks AT MOST ONCE per key (within
 * the window): after that the agent decides — tuned the script, or explained why the
 * filter stays (seen live: after tuning, the filter no longer cut anything, and a
 * "reset on script change" rule just re-asked two runs later). PostToolUse only sees
 * the output AFTER the pipe, so "does the filter still cut?" can't be measured here.
 * State: one JSON file in the plugin data dir, pruned by window and size.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

const MAX_KEYS = 500;
const ASK_AT = 2;

/**
 * Count one piped run. Returns {count, ask}: `ask` is true exactly once per key —
 * the run that reaches ASK_AT while the key was never asked.
 * @param {{file:string, project:string, scriptId:string, filter:string, windowDays:number, deliverable?:boolean, now?:number}} a
 */
function touch({ file, project, scriptId, filter, windowDays, deliverable = true, now = Date.now() }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) { if (err.code !== 'ENOENT') console.error(`[piped-store] read ${file}: ${err.message}`); }
  const entries = state && typeof state.entries === 'object' && state.entries ? state.entries : {};
  const windowMs = windowDays * 86400_000;
  for (const k of Object.keys(entries)) if (!entries[k] || now - (entries[k].last || 0) > windowMs) delete entries[k];
  const key = `${project}\u0000${scriptId}\u0000${filter}`;
  const e = entries[key] || { count: 0, asked: false };
  e.count += 1;
  e.last = now;
  // Only a DELIVERABLE ask spends the once-per-key slot: a sub-agent run (its Stop is not
  // the parent's) counts, but must not burn the ask the main agent never sees (audit).
  const ask = deliverable && e.count >= ASK_AT && !e.asked;
  if (ask) e.asked = true;
  entries[key] = e;
  const keys = Object.keys(entries);
  if (keys.length > MAX_KEYS) keys.sort((a, b) => entries[a].last - entries[b].last).slice(0, keys.length - MAX_KEYS).forEach((k) => { delete entries[k]; });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { entries });
  } catch (err) {
    console.error(`[piped-store] could not persist ${file}: ${err.message}`);
  }
  return { count: e.count, ask };
}

module.exports = { touch, MAX_KEYS, ASK_AT };
