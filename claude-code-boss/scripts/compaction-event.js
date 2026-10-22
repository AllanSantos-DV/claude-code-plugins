#!/usr/bin/env node
'use strict';
/**
 * compaction-event.js — the Node side of the controlled compaction (hooks/compaction.mjs).
 *
 * The function-hook module runs with no Node, so it reaches the boss through the
 * daemon like every migrated hook: the internal tool `hook_compaction_event`
 * (lib/hook-tools.js), reached through the daemon route POST /hook/compaction-event
 * (token-gated like /mcp; the hook_* tools are unlisted, so a module cannot $.mcp.call
 * them), runs `run(ev)` here, with `ev.payload` = `{ kind, ... }`.
 *
 *   hello    → the compaction config + the cache TTL already observed for this host
 *   turn     → reads the LAST response's real `usage` from the transcript (the module's
 *              turn usage has no TTL breakdown) and records `cache.turn`: host, auth
 *              kind, model, cache read/write and the contracted window (ephemeral_5m /
 *              ephemeral_1h). Replies the window this turn proved, so the module waits
 *              for the REAL TTL of the host it talks to (subscription and API differ).
 *   gate | run | resume | settled | error → `compaction.<kind>` (the trail)
 *   folder | folder-end → the folder's shared cache TTL (lib/folder-ttl.js): 5m while every live session of the
 *              launch folder is past the threshold, restored after the cut / at the end; `compaction.folder` on change
 *
 * Every number lands in the metrics store (lib/metrics.js) → /api/metrics/compaction,
 * the Home panel and the Insights event log. Secrets never travel: the module sends
 * the API HOST and the credential KIND, never a value.
 */
const fs = require('fs');
const path = require('path');
const metrics = require('../engine/lib/metrics.js');

const RECORDED = new Set(['gate', 'run', 'resume', 'settled', 'error']);
const TAIL_BYTES = 512 * 1024;
const TTL_LOOKBACK = 500; // cache.turn rows read to judge a host's window

function cacheCycle() {
  return require(path.join(__dirname, '..', 'servers', 'model-router', 'cache-cycle.js'));
}

/** The compaction config the module runs with (hooks-config `compaction` block). */
function compactionConfig() {
  return require('./lib/hooks-config.js').getCompaction();
}

/**
 * The main thread's API calls in the transcript tail (a long transcript is many MB),
 * newest last, one per `message.id` — a call's thinking / tool_use / text rows share it.
 *
 * Attribution is per API call, not per turn, because both of these were seen live:
 *   - after a compaction the engine re-writes the kept assistant rows with their usage
 *     ZEROED (synthetic copies) — never a request, skipped;
 *   - interactive: the answer's row is not in the file yet when turn.complete fires — a
 *     "last row" read took the previous turn's call. Reading every call since the last one
 *     observed (`sinceId`) records each exactly once, whenever it lands.
 * `afterCompaction` = the first real call after a compact_boundary: the price of rewriting
 * history, read from the transcript itself.
 * When `sinceId` fell out of the tail window, only the latest call is returned (never a flood) and
 * `info.gap` says so: the calls between it and the window are not recorded (compactacao-router-13).
 * @param {{gap?:{skippedInWindow:number, transcriptBytes:number}}} [info] filled when the last call seen is out of the window
 * @returns {Array<{id:string, model:string|null, usage:object, afterCompaction:boolean}>}
 */
function readNewApiCalls(transcriptPath, sinceId, info) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const st = fs.statSync(transcriptPath);
  const len = Math.min(st.size, TAIL_BYTES);
  const fd = fs.openSync(transcriptPath, 'r');
  let text;
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const calls = [];
  const seen = new Set();
  let boundaryPending = false;
  let lastBoundaryCall = -1; // index in calls of the first call after the last boundary
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue; // the first line of a tail window may be cut
    let row;
    try { row = JSON.parse(line); } catch (err) { void err; continue; }
    if (row.type === 'system' && row.subtype === 'compact_boundary') { boundaryPending = true; lastBoundaryCall = calls.length; continue; }
    if (row.type !== 'assistant' || row.isSidechain || !row.message || !row.message.usage) continue;
    const u = row.message.usage;
    const total = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
      + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (total <= 0) continue; // a re-written copy, not a request
    const id = row.message.id || row.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    calls.push({ id, model: row.message.model || null, usage: u, afterCompaction: boundaryPending });
    boundaryPending = false;
  }
  // First observation of a process: the calls since the last compact_boundary in the tail are
  // this session's (a resumed one compacted before its first prompt); no boundary: the latest only.
  if (!sinceId) { const afterB = calls.filter((c, k) => k >= lastBoundaryCall); return lastBoundaryCall >= 0 && afterB.length ? afterB : calls.slice(-1); }
  const at = calls.findIndex((c) => c.id === sinceId);
  if (at >= 0) return calls.slice(at + 1);
  if (info && calls.length) info.gap = { skippedInWindow: calls.length - 1, transcriptBytes: st.size };
  return calls.slice(-1); // since fell out of the window: latest only
}

/** Window verdict for one host|auth from the cache.turn rows already stored. */
function ttlVerdictFor(hostKey, rows) {
  const acc = { write5m: 0, write1h: 0 };
  let samples = 0;
  for (const r of rows) {
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; continue; } }
    if (`${p.host}|${p.auth}` !== hostKey) continue;
    acc.write5m += Number(p.write5m) || 0;
    acc.write1h += Number(p.write1h) || 0;
    samples++;
  }
  return { ...cacheCycle().deriveTtlVerdict(acc), samples };
}

function storedCacheTurns() {
  const store = require('../engine/lib/metrics-store.js');
  if (!store.isReady()) return [];
  return store.getEventLog({ eventName: 'cache.turn', limit: TTL_LOOKBACK });
}

async function run(ev) {
  const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : null;
  if (!p || typeof p.kind !== 'string') throw new Error('compaction-event: payload.kind is required');
  const ctx = { sessionId: ev.session_id || null, cwd: ev.cwd || '' };
  const { kind, ...data } = p;

  if (RECORDED.has(kind)) {
    await metrics.record(`compaction.${kind}`, data, ctx);
    return {};
  }

  const hostKey = `${data.host || 'unknown'}|${data.auth || 'unknown'}`;
  if (kind === 'hello') {
    // A record first opens this project's store, so the verdict reads its history.
    await metrics.record('compaction.session', { host: data.host, auth: data.auth, source: data.source || null }, ctx);
    return { config: compactionConfig(), ttl: ttlVerdictFor(hostKey, storedCacheTurns()) };
  }

  if (kind === 'turn') {
    const info = {};
    const calls = readNewApiCalls(ev.transcript_path, data.sinceMessageId || null, info);
    // Calls lost between the last one seen and the tail window: counted, not silently dropped.
    if (info.gap) await metrics.record('cache.turn.gap', { ...info.gap, tailBytes: TAIL_BYTES, sinceMessageId: data.sinceMessageId }, ctx);
    let observed = null;
    for (const c of calls) {
      const u = c.usage;
      const parsed = cacheCycle().parseCacheUsage(u);
      const detail = u.cache_creation || {};
      const write5m = Number(detail.ephemeral_5m_input_tokens) || 0;
      const write1h = Number(detail.ephemeral_1h_input_tokens) || 0;
      observed = {
        host: data.host || 'unknown',
        auth: data.auth || 'unknown',
        model: c.model,
        messageId: c.id,
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        read: parsed.read,
        write: parsed.creation,
        write5m,
        write1h,
        cacheState: parsed.state,
        // The window this call WROTE, hit or miss. parseCacheUsage leaves it null on a hit, but after the folder TTL
        // switches to 5m every call is a "hit" on the 1h system prefix (~18k read) that re-writes the rest at 5m:
        // with null the session kept judging by 1h, waited, and never cut (a91f3364: 62 cold re-writes, no cut).
        ttlMs: write1h > 0 ? cacheCycle().TTL_1H : (write5m > 0 ? cacheCycle().TTL_5M : null),
        afterCompaction: c.afterCompaction,
      };
      await metrics.record('cache.turn', observed, ctx);
    }
    return {
      observed, recorded: calls.length,
      lastMessageId: calls.length ? calls[calls.length - 1].id : (data.sinceMessageId || null),
      ttl: ttlVerdictFor(hostKey, storedCacheTurns()),
      config: compactionConfig(), // the dashboard slider reaches open sessions from their next turn
    };
  }

  // The folder's shared cache TTL (lib/folder-ttl.js): every live session of a folder reports whether it is past
  // the threshold; 5m only while all are, restored after the cut or when a session ends / stops reporting.
  if (kind === 'folder' || kind === 'folder-end') {
    if (!ctx.sessionId) throw new Error('compaction-event: folder report without session_id');
    const out = require('./lib/folder-ttl.js').report({ sessionId: ctx.sessionId, folder: data.folder, above: data.above === true, end: kind === 'folder-end' });
    if (out.action !== 'none' || out.swept.length) await metrics.record('compaction.folder', { ...out, above: data.above === true, end: kind === 'folder-end' }, ctx);
    return { folderTtl: out };
  }

  throw new Error(`compaction-event: unknown kind '${kind}'`);
}

module.exports = { run, readNewApiCalls, ttlVerdictFor };
