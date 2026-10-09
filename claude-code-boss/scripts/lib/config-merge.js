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
  let userConfigError = null;
  let p = null;
  try { p = userPath(); } catch (err) { console.error(`[${label}] user-config path unresolved: ${err.message}`); }
  if (p && fs.existsSync(p)) {
    let text = null;
    let raw;
    try {
      text = fs.readFileSync(p, 'utf-8');
      raw = JSON.parse(text);
      if (!isPlainObject(raw)) throw new Error('not a JSON object');
      keepLastGood(p, text, label);
    } catch (err) {
      // An unreadable user-config used to be skipped SILENTLY — the merged config fell back to the
      // shipped defaults (backend: local), i.e. the backend switched on its own (owner: switching is
      // always the user's explicit act). Now: restore the last good copy, keep the corrupt one aside,
      // and leave a notice; without a good copy, say so loud (pre-release/owner request 2026-10-09).
      if (text !== null && !text.trim()) {
        raw = undefined; // emptied on purpose = a reset to the defaults, not corruption
      } else if (modifiedWithin(p, RECENT_MS)) {
        // Possibly a save still being written (editor truncate+write): use the good copy for THIS
        // read only and never touch the user's file — the next read decides (audit 3.1.1).
        console.error(`[${label}] user-config unreadable right after a change (${p}): using its last good copy for now`);
        raw = readLastGood(p);
        if (raw === undefined) userConfigError = `${p}: ${err.message}`;
      } else {
        console.error(`[${label}] user-config unreadable (${p}): ${err.message}`);
        raw = restoreLastGood(p, label);
        if (raw === undefined) userConfigError = `${p}: ${err.message}`;
      }
    }
    if (isPlainObject(raw)) {
      if (versioned) {
        version = Number.isInteger(raw._v) ? raw._v : 0;
        const { _v, ...rest } = raw;
        override = rest;
      } else {
        override = raw;
      }
    }
  }
  return { config: isPlainObject(override) ? deepMerge(shipped, override) : shipped, version, userConfigError };
}

const LAST_GOOD = '.last-good';
const NOTICE = '.recovery-notice.json';

/**
 * Keep a copy of the last user-config that parsed (written only when it changed).
 * @param {string} p  user-config path
 * @param {string} text  its current, valid content
 * @param {string} label
 */
function keepLastGood(p, text, label) {
  try {
    const lg = p + LAST_GOOD;
    if (fs.existsSync(lg) && fs.readFileSync(lg, 'utf-8') === text) return;
    writeFileAtomic(lg, text);
  } catch (err) { console.error(`[${label}] last-good copy not kept: ${err.message}`); }
}

/**
 * Active recovery of an unreadable user-config: the corrupt file is kept aside
 * (<file>.corrupt-<ts>), the last good copy is put back, and a notice is left for the next
 * SessionStart (brain-health). Returns the restored object, or undefined when there is no
 * usable copy (the caller reports the error loud).
 * @param {string} p
 * @param {string} label
 * @returns {object|undefined}
 */
const RECENT_MS = 5000;

function modifiedWithin(p, ms) {
  try { return Date.now() - fs.statSync(p).mtimeMs < ms; } catch (err) { void err; return false; }
}

/** The last good copy as an object, or undefined (no file operations). */
function readLastGood(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p + LAST_GOOD, 'utf-8'));
    return isPlainObject(obj) ? obj : undefined;
  } catch (err) { void err; return undefined; }
}

function restoreLastGood(p, label) {
  try {
    const lg = p + LAST_GOOD;
    if (!fs.existsSync(lg)) return undefined;
    const text = fs.readFileSync(lg, 'utf-8');
    const obj = JSON.parse(text);
    if (!isPlainObject(obj)) return undefined;
    // A symlinked config (dotfiles) is repaired at its target, not replaced by a regular file.
    let real = p;
    try { real = fs.realpathSync(p); } catch (err) { void err; }
    const corrupt = `${real}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(real, corrupt);
    } catch (err) {
      // Another process restored it a moment ago: take what is there now.
      if (err.code === 'ENOENT') {
        try { const now = JSON.parse(fs.readFileSync(p, 'utf-8')); if (isPlainObject(now)) return now; } catch (e2) { void e2; }
        return obj;
      }
      throw err;
    }
    writeFileAtomic(real, text);
    writeFileAtomic(p + NOTICE, JSON.stringify({ at: new Date().toISOString(), file: p, corruptCopy: corrupt }));
    console.error(`[${label}] user-config restored from its last good copy; the corrupt one is at ${corrupt}`);
    return obj;
  } catch (err) {
    console.error(`[${label}] user-config recovery failed: ${err.message}`);
    return undefined;
  }
}

/**
 * Recovery state of a user-config for the SessionStart advisory: a one-shot notice after an
 * automatic restore (consumed when read), or the file still unreadable (no good copy).
 * @param {string} p  user-config path
 * @param {{consume?: boolean}} [opts]
 * @returns {{restored?: object, unreadable?: string}|null}
 */
function userConfigRecoveryStatus(p, { consume = true } = {}) {
  const out = {};
  const n = p + NOTICE;
  try {
    if (fs.existsSync(n)) {
      out.restored = JSON.parse(fs.readFileSync(n, 'utf-8'));
      if (consume) fs.rmSync(n, { force: true });
    }
  } catch (err) { console.error(`[config-merge] recovery notice unreadable: ${err.message}`); }
  try {
    if (fs.existsSync(p)) {
      const v = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!isPlainObject(v)) out.unreadable = 'not a JSON object';
    }
  } catch (err) { out.unreadable = err.message; }
  return Object.keys(out).length ? out : null;
}

module.exports = { isPlainObject, deepMerge, filesStamp, loadLayered, userConfigRecoveryStatus };
