'use strict';
/**
 * config-merge.js — the pieces brain-config.js and hooks-config.js share for their
 * layered (shipped default + user override) JSON configs.
 */
const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write.js');

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

/**
 * Load a layered config: the shipped defaults deep-merged with the user override.
 * One-time backfill first: when the global override does not exist yet but a legacy
 * per-data-dir one does, copy it up (an existing global is never overwritten; only
 * the active data dir is consulted). Fail-open: an unreadable shipped file → {}
 * (logged); an absent/unreadable override → shipped only.
 *
 * `userPath`/`legacyPath` are functions (resolved lazily — the legacy path costs a
 * dataDir() call). `versioned`: the override carries a persistence-only `_v` stamp,
 * returned as `version` and stripped before merging (never a config field).
 * @returns {{ config: object, version: number }}
 */
function loadLayered({ label, shippedPath, userPath, legacyPath, versioned = false }) {
  let shipped = {};
  try {
    shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf-8'));
  } catch (err) {
    console.error(`[${label}] load failed (${shippedPath}): ${err.message}`);
  }
  try {
    const globalPath = userPath();
    if (!fs.existsSync(globalPath)) {
      const legacy = legacyPath();
      if (fs.existsSync(legacy)) writeFileAtomic(globalPath, fs.readFileSync(legacy));
    }
  } catch (err) {
    console.error(`[${label}] user-config backfill skipped: ${err.message}`);
  }
  let override = null;
  let version = 0;
  try {
    const p = userPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (versioned && isPlainObject(raw)) {
        version = Number.isInteger(raw._v) ? raw._v : 0;
        const { _v, ...rest } = raw;
        override = rest;
      } else {
        override = raw;
      }
    }
  } catch (err) { void err; /* override absent/unreadable → shipped only */ }
  return { config: isPlainObject(override) ? deepMerge(shipped, override) : shipped, version };
}

module.exports = { isPlainObject, deepMerge, filesStamp, loadLayered };
