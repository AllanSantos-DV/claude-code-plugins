'use strict';
/**
 * limit-calibration.js — recalibrate "limit units per 1%" from the plan's own rate_limit blocks.
 *
 * Claude Code writes a synthetic assistant message (`error: "rate_limit"`, `isApiErrorMessage`) to the
 * transcript when the plan's limit rejects a call: "You've hit your session limit · resets 10:20pm
 * (America/Sao_Paulo)". That is the 100% point of the 5 h window ending at the reset time, so the
 * limit units spent in [reset − 5 h, block] ÷ 100 is one reading of "units per 1%".
 * (economy-metrics.calibrateLimit takes the median over windows.)
 *
 * Pure parts (parseReset, unitsPerWindow) are unit-tested; scanTranscripts does the file I/O.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { limitUnits, routeOf, calibrateLimit, LIMIT_UNITS_PER_PERCENT } = require('./economy-metrics.js');

const WINDOW_MS = 5 * 3600_000;
const MIN_WINDOWS = 5;
const MAX_CV = 0.15;
const RESET_RE = /session limit\s*·\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i;

/** Offset (ms) of `tz` from UTC at instant `t`. Throws on an unknown zone. */
function tzOffsetMs(tz, t) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(t));
  const g = (k) => Number(parts.find((p) => p.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(t / 1000) * 1000;
}

/**
 * Epoch ms of the reset a block announces ("resets 10:20pm (America/Sao_Paulo)"): the first
 * occurrence of that wall-clock time at or after the block. Null when the text is not a session-limit block.
 */
function parseReset(text, blockTs) {
  const m = RESET_RE.exec(String(text || ''));
  if (!m || !Number.isFinite(blockTs)) return null;
  const tz = m[4].trim();
  let hh = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hh += 12;
  const mm = Number(m[2] || 0);
  const off = tzOffsetMs(tz, blockTs);
  const local = new Date(blockTs + off); // wall clock of the block, read through the UTC getters
  for (let d = -1; d <= 1; d++) {
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, hh, mm) - off;
    if (guess >= blockTs) return guess;
  }
  return null;
}

/**
 * Units spent on the subscription route in each distinct block window.
 * @param {Array<{ts:number, resetTs:number}>} blocks
 * @param {Array<{ts:number, units:number}>} turns  subscription-route requests (any project: the limit is per account)
 * @returns {Array<number>} one entry per distinct reset (a block repeated in copied transcripts counts once)
 */
function unitsPerWindow(blocks, turns) {
  const firstHit = new Map(); // resetTs → earliest block ts
  for (const b of blocks || []) {
    if (!Number.isFinite(b.resetTs) || !Number.isFinite(b.ts)) continue;
    const prev = firstHit.get(b.resetTs);
    if (prev === undefined || b.ts < prev) firstHit.set(b.resetTs, b.ts);
  }
  const out = [];
  for (const [resetTs, hitTs] of firstHit) {
    const from = resetTs - WINDOW_MS;
    let u = 0;
    for (const t of turns || []) if (t.ts >= from && t.ts <= hitTs) u += t.units;
    if (u > 0) out.push(u);
  }
  return out;
}

/** cache.turn metric rows → subscription-route turns (the shape unitsPerWindow takes). */
function turnsFromRows(rows) {
  const turns = [];
  for (const r of rows || []) {
    if ((r.eventName || r.event_name) !== 'cache.turn') continue;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; continue; } }
    if (routeOf(p.messageId) !== 'subscription') continue;
    turns.push({ ts: Number(r.ts), units: limitUnits(p) });
  }
  return turns;
}

/** Subscription-route spend of one transcript line (assistant message with usage), or null. */
function turnOfLine(o) {
  const m = o && o.message;
  if (!m || !m.usage || routeOf(m.id) !== 'subscription') return null;
  const u = m.usage;
  const cc = u.cache_creation || {};
  const units = limitUnits({
    input: u.input_tokens, read: u.cache_read_input_tokens, output: u.output_tokens,
    write: u.cache_creation_input_tokens, write5m: cc.ephemeral_5m_input_tokens, write1h: cc.ephemeral_1h_input_tokens,
  });
  return { id: m.id, ts: Date.parse(o.timestamp), units };
}

/**
 * Reads the transcripts of the last `days` days: the distinct session-limit blocks, and the plan-route spend
 * (one entry per message id — a streamed message is written several times, the last has the final usage;
 * copied transcripts repeat it). The metrics store only has cache.turn rows from when they were added, so
 * the transcripts are the source that reaches back to the old blocks.
 * @returns {{blocks:Array<{ts:number,resetTs:number}>, turns:Array<{ts:number,units:number}>}}
 */
function scanTranscripts({ days = 30, now = Date.now(), root = path.join(os.homedir(), '.claude', 'projects') } = {}) {
  const since = now - days * 86400_000;
  const blocks = new Map();
  const turns = new Map();
  let projects;
  try { projects = fs.readdirSync(root); } catch (err) { throw new Error(`limit-calibration: cannot read ${root}: ${err.message}`); }
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let files;
    try { files = fs.readdirSync(dir); } catch (err) { void err; continue; } // a stray file in the projects dir
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < since) continue;
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        const isBlock = line.includes('"rate_limit"');
        if (!isBlock && !line.includes('"msg_0')) continue;
        let o;
        try { o = JSON.parse(line); } catch (err) { void err; continue; } // a torn last line of a live transcript
        if (isBlock && o.error === 'rate_limit' && o.isApiErrorMessage) {
          const ts = Date.parse(o.timestamp);
          const text = (o.message && Array.isArray(o.message.content) ? o.message.content : []).map((c) => c && c.text).join(' ');
          const resetTs = parseReset(text, ts);
          if (resetTs != null && !blocks.has(`${resetTs}:${ts}`)) blocks.set(`${resetTs}:${ts}`, { ts, resetTs }); // weekly-limit blocks: another window
          continue;
        }
        const t = turnOfLine(o);
        if (t && Number.isFinite(t.ts) && t.ts >= since) turns.set(t.id, { ts: t.ts, units: t.units });
      }
    }
  }
  return { blocks: [...blocks.values()].sort((a, b) => a.ts - b.ts), turns: [...turns.values()] };
}

/**
 * Calibration reading: {unitsPerPercent, windows, source}. `source` says whether it is measured
 * ('rate-limit-blocks') or the committed default ('default' — no block with spend data found).
 * The spend only counts what the transcripts on this machine show: other devices or the claude.ai app on the
 * same plan are not in it, so the reading is a LOWER bound of the real units per 1%.
 */
function calibrate(blocks, turns) {
  const windows = unitsPerWindow(blocks, turns);
  if (!windows.length) return { unitsPerPercent: LIMIT_UNITS_PER_PERCENT, windows: 0, source: 'default' };
  const measured = calibrateLimit(windows);
  const mean = windows.reduce((s, x) => s + x, 0) / windows.length;
  const sd = Math.sqrt(windows.reduce((s, x) => s + (x - mean) ** 2, 0) / windows.length);
  const cv = sd / mean;
  // Few or scattered windows do not beat the committed default (9 windows, CV 0.075): report, don't replace.
  const trusted = windows.length >= MIN_WINDOWS && cv <= MAX_CV;
  return {
    unitsPerPercent: trusted ? measured : LIMIT_UNITS_PER_PERCENT,
    measuredUnitsPerPercent: measured, windows: windows.length, cv, perWindow: windows,
    source: trusted ? 'rate-limit-blocks' : 'default',
  };
}

/**
 * Calibration with a day-long cache (the scan reads every transcript of the window, ~5 s): the dashboard
 * asks on every refresh. A failed scan is NOT cached and propagates (the caller shows the default and why).
 */
function cachedCalibration({ file, now = Date.now(), maxAgeMs = 86400_000, days = 60, scan = scanTranscripts } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && now - c.at < maxAgeMs && c.days === days) return c.reading;
  } catch (err) { void err; /* no cache yet or unreadable: scan */ }
  const { blocks, turns } = scan({ days, now });
  const reading = { ...calibrate(blocks, turns), scannedAt: now, blocks: blocks.length };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now, days, reading }));
  } catch (err) { console.error(`[limit-calibration] cache write failed: ${err.message}`); }
  return reading;
}

module.exports = { cachedCalibration, parseReset, unitsPerWindow, turnsFromRows, turnOfLine, scanTranscripts, calibrate, WINDOW_MS };
