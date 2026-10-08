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
 *
 * Every number lands in the metrics store (lib/metrics.js) → /api/metrics/compaction,
 * the Home panel and the Insights event log. Secrets never travel: the module sends
 * the API HOST and the credential KIND, never a value.
 */
const fs = require('fs');
const path = require('path');
const metrics = require('./lib/metrics.js');

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
 * Last main-thread assistant `usage` in the transcript — read from the tail only (a
 * long session's transcript is many MB). null when there is none yet.
 */
function readLastAssistantUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
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
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue; // the first line of a tail window may be cut
    let row;
    try { row = JSON.parse(line); } catch (err) { void err; continue; }
    if (row.type === 'assistant' && !row.isSidechain && row.message && row.message.usage) {
      return { model: row.message.model || null, usage: row.message.usage };
    }
  }
  return null;
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
  const store = require('./lib/metrics-store.js');
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
    const last = readLastAssistantUsage(ev.transcript_path);
    let observed = null;
    if (last) {
      const u = last.usage;
      const parsed = cacheCycle().parseCacheUsage(u);
      const detail = u.cache_creation || {};
      observed = {
        host: data.host || 'unknown',
        auth: data.auth || 'unknown',
        model: last.model,
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        read: parsed.read,
        write: parsed.creation,
        write5m: Number(detail.ephemeral_5m_input_tokens) || 0,
        write1h: Number(detail.ephemeral_1h_input_tokens) || 0,
        cacheState: parsed.state,
        ttlMs: parsed.ttlMs,
        afterCompaction: data.afterCompaction === true,
      };
      await metrics.record('cache.turn', observed, ctx);
    }
    return { observed, ttl: ttlVerdictFor(hostKey, storedCacheTurns()) };
  }

  throw new Error(`compaction-event: unknown kind '${kind}'`);
}

module.exports = { run, readLastAssistantUsage, ttlVerdictFor };
