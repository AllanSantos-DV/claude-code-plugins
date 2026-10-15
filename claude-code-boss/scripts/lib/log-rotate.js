'use strict';
/**
 * log-rotate.js — append to a log file that never grows past `maxBytes`.
 *
 * router.log was appended line by line by the router and by model-router-ensure (one
 * run per SessionStart and per prompt) and had reached 12.8 MB / 90k lines with no
 * rotation. Size-based: when the next line would cross the cap, the file shifts to
 * `.1` (`.1` → `.2` …, the oldest dropped) and a fresh file starts.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_KEEP = 3;

function rotate(file, keep) {
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

/**
 * Append `line` (newline added) to `file`, rotating first when it would pass `maxBytes`.
 * Throws on I/O errors — callers that must never fail on logging catch it themselves.
 */
function appendRotating(file, line, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  const data = `${line}\n`;
  let size = 0;
  try { size = fs.statSync(file).size; } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  if (size > 0 && size + Buffer.byteLength(data) > maxBytes) rotate(file, keep);
  fs.appendFileSync(file, data);
}

module.exports = { appendRotating, DEFAULT_MAX_BYTES, DEFAULT_KEEP };
