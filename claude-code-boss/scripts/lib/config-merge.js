'use strict';
/**
 * config-merge.js — the pieces brain-config.js and hooks-config.js share for their
 * layered (shipped default + user override) JSON configs.
 */
const fs = require('fs');

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `override` onto `base`: plain objects merge recursively; arrays and
// scalars from the override REPLACE the base value.
function deepMerge(base, override) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(override)) return out;
  for (const k of Object.keys(override)) {
    const ov = override[k];
    out[k] = (isPlainObject(ov) && isPlainObject(out[k])) ? deepMerge(out[k], ov) : ov;
  }
  return out;
}

/**
 * Cheap identity of a set of files (mtime+size each; 'none' when absent). The
 * daemon resets a config cache only when this changes, instead of re-reading and
 * re-parsing on every hook call.
 */
function filesStamp(...paths) {
  return paths.map((p) => {
    try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch (err) { void err; return 'none'; }
  }).join('|');
}

module.exports = { isPlainObject, deepMerge, filesStamp };
