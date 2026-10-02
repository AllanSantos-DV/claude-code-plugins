'use strict';
/**
 * lib/transcript-turns.js — the LAST N human turns of a Claude Code transcript,
 * cleaned: user text + assistant text (+ thinking, opt-in). Tool calls, tool
 * outputs, sub-agent turns, hook feedback and compaction summaries are dropped
 * (the mechanical clean of lib/transcript-block.js).
 *
 * Reads BACKWARDS from EOF and stops as soon as it holds N complete turns (or hits
 * a byte cap), so its cost follows the size of the last N turns, never the size of
 * the session. Reusable by any part of the plugin that needs "what was just said"
 * (lesson capture is the first caller).
 */
const fs = require('fs');
const { extractCycles, isHumanTurn } = require('./transcript-block.js');

const DEFAULT_TURNS = 3;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;

function _parse(line) {
  try { return JSON.parse(line); } catch (err) { void err; return null; }
}

/**
 * @param {string} transcriptPath
 * @param {{ turns?:number, includeThinking?:boolean, maxBytes?:number }} [opts]
 * @returns {Array<{promptId:string, user:string, assistant:string, thinking?:string}>}
 *   oldest-first, at most `turns` entries; [] when the file is missing/unreadable.
 */
function readLastTurns(transcriptPath, opts = {}) {
  const turns = Number.isInteger(opts.turns) && opts.turns > 0 ? opts.turns : DEFAULT_TURNS;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  if (!transcriptPath) return [];
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch (err) { void err; return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let start = size;
    let carry = Buffer.alloc(0);  // bytes of a line cut at the chunk's left edge
    const objs = [];              // parsed envelopes, newest first
    const prompts = new Set();    // distinct human-turn promptIds seen so far
    let chunk = CHUNK;
    while (start > floor && prompts.size <= turns) {
      const step = Math.min(chunk, start - floor);
      start -= step;
      chunk *= 2;
      const buf = Buffer.alloc(step);
      const n = fs.readSync(fd, buf, 0, step, start);
      const data = Buffer.concat([buf.subarray(0, n), carry]);
      // The first piece may be a cut line unless we reached the file start.
      let firstNl = start > floor ? data.indexOf(0x0a) : -1;
      if (start > floor && firstNl === -1) { carry = data; continue; }
      carry = start > floor ? data.subarray(0, firstNl + 1) : Buffer.alloc(0);
      const body = data.subarray(start > floor ? firstNl + 1 : 0).toString('utf8');
      const lines = body.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const o = _parse(lines[i]);
        if (!o) continue;
        objs.push(o);
        if (isHumanTurn(o)) prompts.add(o.promptId || `__line-${objs.length}`);
      }
    }
    // Forward order → the same reduction transcript-block applies everywhere.
    return extractCycles(objs.reverse(), { includeThinking: !!opts.includeThinking }).slice(-turns);
  } catch (err) {
    console.error(`[transcript-turns] ${transcriptPath}: ${err.message}`);
    return [];
  } finally {
    try { fs.closeSync(fd); } catch (err) { void err; }
  }
}

module.exports = { readLastTurns, DEFAULT_TURNS, DEFAULT_MAX_BYTES };
