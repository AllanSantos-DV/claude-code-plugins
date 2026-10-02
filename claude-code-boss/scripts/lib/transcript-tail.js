'use strict';
/**
 * lib/transcript-tail.js — bounded reads from the END of a transcript JSONL.
 *
 * Stop detectors only look at the last few lines (or a trailing window) of the
 * transcript, but used to readFileSync the WHOLE file — ~200 ms and hundreds of
 * MB of heap for a 90 MB marathon session. In a spawned hook that only slowed the
 * hook; inside the shared brain daemon (Phase G) it froze every session's hooks.
 * These helpers read backwards from EOF and stop as soon as they have enough.
 */
const fs = require('fs');

const CHUNK = 64 * 1024;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function _readRange(fd, from, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, from);
  return n === len ? buf : buf.subarray(0, n);
}

/**
 * The last `maxLines` non-empty lines of a file, oldest first — the same result
 * as `readFileSync(p,'utf-8').split('\n').filter(Boolean).slice(-maxLines)`, but
 * reading at most `maxBytes` from the end. When the cap is hit before enough
 * lines are found, returns the complete lines inside the window (a partial first
 * line is dropped). Missing/unreadable file → [].
 *
 * @param {string} filePath
 * @param {number} maxLines
 * @param {number} [maxBytes]
 * @returns {string[]}
 */
function readTailLines(filePath, maxLines, maxBytes = DEFAULT_MAX_BYTES) {
  if (!filePath || !(maxLines > 0)) return [];
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch (err) { void err; return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const limit = Math.min(size, maxBytes);
    let start = size;
    let buf = Buffer.alloc(0);
    let chunk = CHUNK;
    for (;;) {
      const step = Math.min(chunk, start - (size - limit));
      if (step <= 0) break;
      start -= step;
      chunk *= 2; // geometric growth: few concats even when lines are huge
      buf = Buffer.concat([_readRange(fd, start, step), buf]);
      // maxLines complete lines need maxLines newlines before the tail (or BOF).
      let nl = 0;
      for (let i = buf.length - 1; i >= 0 && nl <= maxLines; i--) if (buf[i] === 0x0a) nl++;
      if (nl > maxLines) break;
    }
    let lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines = lines.slice(1); // first piece may be a cut line
    return lines.filter(Boolean).slice(-maxLines);
  } catch (err) {
    console.error(`[transcript-tail] ${filePath}: ${err.message}`);
    return [];
  } finally {
    try { fs.closeSync(fd); } catch (err) { void err; }
  }
}

/**
 * The trailing `maxBytes` of a file as a utf-8 string, read asynchronously (the
 * read runs on the libuv pool, not the event loop). Whole file when smaller.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readTailText(filePath, maxBytes) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close();
  }
}

module.exports = { readTailLines, readTailText, DEFAULT_MAX_BYTES };
