'use strict';
/**
 * json-file.js — tolerant JSON read/write for small state files.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

/** Read JSON or `fallback`. A missing file is normal; a corrupt or unreadable one falls back too, but SAYS so. */
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[json-file] ${p} unreadable (${err.message}) — using the fallback`);
    return fallback;
  }
}

/** Read JSON; missing → null, anything else reported (tagged `label`) and → null. */
function readJsonLoud(p, label = 'json-file') {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[${label}] ${p} unreadable: ${err.message}`);
    return null;
  }
}

function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJsonAtomic(p, obj);
    return true;
  } catch (err) { console.error(`[json-file] write failed (${p}): ${err.message}`); return false; }
}

/** Atomic JSON write that LOGS a failure (tagged `label`) and reports it as false. */
function saveJson(p, obj, label) {
  try {
    writeJsonAtomic(p, obj);
    return true;
  } catch (err) {
    console.error(`[${label}] save failed (${p}): ${err.message}`);
    return false;
  }
}

module.exports = { readJsonSafe, readJsonLoud, writeJsonSafe, saveJson };
