'use strict';
/**
 * json-file.js — tolerant JSON read/write for small state files.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.js');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* absent or corrupt: use fallback */ return fallback; }
}

function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJsonAtomic(p, obj);
    return true;
  } catch { /* write failed (perms/disk): caller sees false */ return false; }
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

module.exports = { readJsonSafe, writeJsonSafe, saveJson };
