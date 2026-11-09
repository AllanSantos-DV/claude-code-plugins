'use strict';
/**
 * phase-restart-measure.js — does the phase-restart notice pay on THIS machine? A read-only replay of the
 * Claude Code transcripts already on disk (they are only ever opened for reading).
 *
 * The question (docs/research/fases-handoff): after a task was delivered (a `git commit`), the next person prompt
 * with the context past X and the cache warm can either carry on — re-reading the whole context every call — or
 * write a short handoff and start a new session from it. The replay walks every session's real API calls and
 * prices both against what the boss already does (the cold cut at 300k with the folder TTL: 1h up to 300k, 5m
 * past it; the engine's own compaction at 967k). Per-call prices come from economy-metrics (official page); a
 * model it does not price is billed as Opus 5.5 and counted in `unpricedCalls`.
 *
 * What it does not price: answer quality (a long context degrades it — context rot) and the risk of losing state
 * in the handoff. A gain here is the dollar side only.
 */
const fs = require('fs');
const path = require('path');
const { priceOf } = require('./economy-metrics.js');

const W = 1e6;
const ENGINE_AT = W - 33000;   // the engine's own auto-compaction on a 1M window
const COLD_CUT_AT = 300000;    // the boss's cold cut (30% of 1M) and the folder TTL switch
const SUM_OUT = 8000, POST = 48000;          // the engine summary: output billed, first context after it (measured)
const BASE = 16000, TAIL = 2000, FRAC = 0.09; // the boss's model-free cold cut: prefix + tail + what the brief keeps
const DEFAULT_PRICE = Object.freeze({ in: 4, out: 20, read: 0.2, w5: 5, w1h: 8 }); // Opus 5.5, US$/MTok
const COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*commit\b/; // options (and their values) before the subcommand

/** The machine's local calendar day of a timestamp, `YYYY-MM-DD`. */
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** US$/MTok for a model id as the transcript writes it; null = not priced (the caller bills Opus 5.5). */
function priceFor(model) {
  const p = priceOf(model);
  if (!p) return null;
  return { in: p.inputUsd, out: p.inputUsd * 5, read: p.inputUsd * p.readRatio, w5: p.inputUsd * 1.25, w1h: p.inputUsd * 2 };
}

/** A transcript row that is a person's prompt (not a tool result, meta text, compact summary or local command). */
function isPersonPrompt(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary || !o.message) return false;
  const c = o.message.content;
  if (typeof c === 'string') return c.trim().length > 0 && !c.startsWith('<command-') && !c.startsWith('<local-command');
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && b.type === 'text' && b.text && b.text.trim()) && !c.some((b) => b && b.type === 'tool_result');
}

/**
 * One session's main-thread API calls, one per message.id, oldest first:
 * `{ ts, ctx, out, model, person, delivered }` — `person` = the first call after a person prompt, `delivered` = that
 * prompt came right after a turn that ran `git commit` (the task boundary the hook uses).
 * @param {Iterable<string>} lines transcript JSONL lines
 */
function seriesFromLines(lines) {
  const seen = new Set();
  const calls = [];
  let personNext = false, commitSince = false, commitPrev = false;
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (err) { void err; continue; } // a torn last line while the session writes
    if (isPersonPrompt(o)) { personNext = true; commitPrev = commitSince; commitSince = false; continue; }
    if (o.type !== 'assistant' || o.isSidechain || !o.message) continue;
    if (Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b && b.type === 'tool_use' && b.name === 'Bash' && b.input && COMMIT_RE.test(String(b.input.command || ''))) commitSince = true;
      }
    }
    const u = o.message.usage;
    if (!u) continue;
    const id = o.message.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const ctx = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
    if (!ctx) continue; // the engine's zeroed copies after a compaction
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    calls.push({ ts, ctx, out: u.output_tokens || 0, model: o.message.model || '', person: personNext, delivered: personNext && commitPrev });
    personNext = false;
  }
  return calls;
}

/** Top-level session transcripts (sub-agent files live in nested folders) modified inside the window. */
function listTranscripts(root, days, now = Date.now()) {
  const since = now - days * 86400e3;
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    let st;
    try { st = fs.statSync(dir); } catch (err) { console.error(`[phase-restart-measure] skipped ${dir}: ${err.message}`); continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch (err) { console.error(`[phase-restart-measure] skipped ${p}: ${err.message}`); }
    }
  }
  return out;
}

/**
 * Replay one session. `opts.X` null = the boss as it is; else the notice is taken at every delivered person prompt
 * past X with a warm cache: the model reads the context once and writes `handoffTokens`, the new session starts at
 * BASE + handoff and re-reads `rereadTokens` on its first call.
 * @returns {{cost:number, notices:number, daily:Object<string,number>, unpriced:number}}
 */
function simulate(calls, opts = {}) {
  const ttlFor = (s) => (s <= COLD_CUT_AT ? 60 : 5);
  let cost = 0, s = 0, prev = null, prevTtl = 60, notices = 0, extra = 0, unpriced = 0;
  const daily = {};
  for (const c of calls) {
    let P = priceFor(c.model);
    if (!P) { P = DEFAULT_PRICE; unpriced++; }
    const before = cost;
    const gap = prev ? (c.ts - prev.ts) / 60000 : Infinity;
    const cold = gap >= prevTtl;
    let d;
    if (!prev) d = c.ctx;
    else if (c.ctx < prev.ctx * 0.6) d = 0; // a compaction in the real session: our replay keeps its own size
    else d = Math.max(0, c.ctx - prev.ctx);
    let lost = false;
    if (prev && s > COLD_CUT_AT && cold) { s = Math.round(BASE + TAIL + FRAC * Math.max(0, s - BASE)); lost = true; }
    else if (opts.X && prev && !cold && s > opts.X && c.person && c.delivered) {
      const act = (s * P.read + opts.handoffTokens * P.out) / 1e6;
      cost += act;
      s = BASE + opts.handoffTokens;
      extra = opts.rereadTokens;
      notices++;
      lost = true;
    }
    if (extra && !lost && prev) { d += extra; extra = 0; }
    s += d;
    if (s > ENGINE_AT) { cost += ((cold ? s * P.in : s * P.read) + SUM_OUT * P.out) / 1e6; s = POST; lost = true; }
    const w = ttlFor(s) >= 60 ? P.w1h : P.w5;
    if (cold || lost || !prev) cost += (s * w) / 1e6;
    else cost += ((s - d) * P.read + d * w) / 1e6;
    cost += (c.out * P.out) / 1e6;
    prevTtl = ttlFor(s);
    prev = c;
    const k = localDay(c.ts);
    daily[k] = (daily[k] || 0) + (cost - before);
  }
  return { cost, notices, daily, unpriced };
}

const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : 0);
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The measurement over sessions already parsed (pure — unit-tested).
 * @param {Array<{id:string, calls:Array}>} sessions
 * @param {{thresholdTokens?:number, handoffTokens?:number, rereadTokens?:number, days?:number}} [o]
 */
function measureSessions(sessions, o = {}) {
  const X = o.thresholdTokens || 400000;
  const opts = { X, handoffTokens: o.handoffTokens ?? 6000, rereadTokens: o.rereadTokens ?? 30000 };
  const perDay = {};
  let crossings = 0, calls = 0, base = 0, withNotice = 0, notices = 0, unpriced = 0;
  const crossDays = new Set();
  for (const s of sessions) {
    let prevCtx = 0;
    for (const c of s.calls) {
      calls++;
      const day = localDay(c.ts);
      (perDay[day] = perDay[day] || new Set()).add(s.id);
      if (prevCtx <= X && c.ctx > X) { crossings++; crossDays.add(`${s.id}|${day}`); }
      prevCtx = c.ctx;
    }
    const b = simulate(s.calls);
    const a = simulate(s.calls, opts);
    base += b.cost; withNotice += a.cost; notices += a.notices; unpriced += b.unpriced;
  }
  const activeDays = Object.keys(perDay).length;
  const sessionsPerDay = Object.values(perDay).map((x) => x.size);
  const saving = base - withNotice;
  return {
    thresholdTokens: X, handoffTokens: opts.handoffTokens, rereadTokens: opts.rereadTokens, days: o.days ?? null,
    sessions: sessions.length, calls, activeDays,
    sessionsPerDay: { median: median(sessionsPerDay), p90: pct(sessionsPerDay, 0.9), max: sessionsPerDay.length ? Math.max(...sessionsPerDay) : 0 },
    crossings, sessionDaysCrossing: crossDays.size,
    crossingsPerSessionDay: crossDays.size ? r2(crossings / crossDays.size) : 0,
    notices, baseUsd: r2(base), savingUsd: r2(saving),
    savingUsdPerDay: activeDays ? r2(saving / activeDays) : 0,
    savingPct: base ? r2((100 * saving) / base) : 0,
    savingPerNoticeUsd: notices ? r2(saving / notices) : 0,
    unpricedCalls: unpriced,
    verdict: notices > 0 && saving > 0 ? 'gain' : 'no-gain',
  };
}

/**
 * Read this machine's transcripts (read-only) and measure.
 * @param {{root:string, days?:number, thresholdTokens?:number, now?:number}} o
 */
function measure(o) {
  const days = o.days || 30;
  const t0 = Date.now();
  const now = o.now || Date.now();
  const since = now - days * 86400e3;
  const files = listTranscripts(o.root, days, now);
  const sessions = [];
  for (const f of files) {
    // A file touched inside the window can hold older days: only the window's calls count.
    const calls = seriesFromLines(fs.readFileSync(f, 'utf8').split('\n')).filter((c) => c.ts >= since && c.ts <= now);
    if (calls.length) sessions.push({ id: path.basename(f, '.jsonl'), calls });
  }
  return { at: new Date().toISOString(), root: o.root, files: files.length, ...measureSessions(sessions, { ...o, days }), durationMs: Date.now() - t0 };
}

module.exports = { seriesFromLines, listTranscripts, simulate, measureSessions, measure, priceFor, localDay };
