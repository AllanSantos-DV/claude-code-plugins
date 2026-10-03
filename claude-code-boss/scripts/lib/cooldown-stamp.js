'use strict';
/**
 * cooldown-stamp.js — "at most once per N" for advisories: a tiny JSON stamp file
 * ({ ts }) per advisory (or per advisory+project) under the data dir.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

/** True while the stamp at `p` is younger than `ms`. Absent → false; unreadable → logged, false. */
function onCooldown(p, ms, now = Date.now()) {
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf8')).ts;
    return Number.isFinite(t) && now - t < ms;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[cooldown] stamp ${p}: ${err.message}`);
    return false;
  }
}

/** Record "ran now" at `p`. Best-effort: a failed write only means the advisory may repeat. */
function stamp(p, now = Date.now()) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); writeJsonAtomic(p, { ts: now }); }
  catch (err) { console.error(`[cooldown] could not stamp ${p}: ${err.message}`); }
}

module.exports = { onCooldown, stamp };
