#!/usr/bin/env node
/**
 * conversation-ingest.js — Stop hook (cooperative conversation ingestion).
 *
 * Ships the RAW session transcript (JSONL) to the external mcp-memory server's
 * `ingest_conversation` tool on each Stop. The server is the smart half: it
 * discovers the consumer template (once, cached), distills user→assistant pairs,
 * types/scopes/curates them, and DEDUPS by event-id per (consumer×session) — so
 * re-sending the whole transcript each turn is safe (only new pairs are staged)
 * and the client stays stateless. This replaces the previous per-turn
 * `add_document(type=conversation)` bridge.
 *
 * Why cumulative (validated in the server source): the template is discovered
 * ONCE per consumerId and persisted; a tiny per-turn packet risks "discovery
 * failed" on that first pass, so sending the accumulated transcript guarantees
 * enough context. `IngestionCheckpoint` dedups the overlap; `BatchSizer` chunks
 * server-side; `MAX_RAW_CHARS`=8M is the only hard cap (marathon-session window).
 *
 * Three gates, cheapest first:
 *   1. backend is the external mcp-memory server;
 *   2. ingestion is enabled (opt-in — sending your chat is an explicit choice);
 *   3. this exact transcript wasn't already sent (duplicate-Stop dedup).
 *
 * Silent + fail-open (never blocks the Stop) but fail-LOUD in the log: if the
 * server can't distill (e.g. its LLM is off → "discovery failed; raw mode"), we
 * log the degraded state — never pretend success.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const brainConfig = require('./lib/brain-config.js');
const backend = require('./brain-backend.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const STAMP = path.join(DATA_DIR, '.runtime', 'ingest-stamp.json');

const CONSUMER_ID = 'claude-code-boss';
// Stay just under the server's MAX_RAW_CHARS (8_000_000, fail-loud above). For a
// marathon session we send a trailing window aligned to a line boundary; the
// server dedups the overlap with what it already ingested.
const SAFE_MAX_CHARS = 7_500_000;
// Keep the dedup stamp bounded (most recent N transcript hashes).
const STAMP_CAP = 200;

/** Clamp an oversize transcript to a trailing, line-aligned window (pure/testable). */
function clampRaw(raw) {
  const s = String(raw == null ? '' : raw);
  if (s.length <= SAFE_MAX_CHARS) return s;
  const tail = s.slice(s.length - SAFE_MAX_CHARS);
  const nl = tail.indexOf('\n');
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

/** Dedup key for an exact transcript payload (duplicate-Stop guard). Pure/testable. */
function transcriptKey(sid, raw) {
  const h = crypto.createHash('sha1').update(String(raw || '')).digest('hex').slice(0, 12);
  return `${sid || 'default'}:${h}`;
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP, 'utf-8')); }
  catch { /* absent/corrupt → fresh */ return { keys: [] }; }
}

function writeStamp(state) {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error(`[conversation-ingest] stamp write failed: ${err.message}`);
    return false;
  }
}

async function run(event) {
  const ev = event || {};
  if (ev.stop_hook_active) return {};
  // Gate 1 (cheapest): only the external daemon ingests raw conversation.
  if (backend.peekMode() !== 'mcp-memory') return {};
  // Gate 2: opt-in (sending your chat is an explicit choice).
  if (!brainConfig.getIngestion().enabled) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  if (!transcriptPath) return {};
  // Same client-side identity the recall path uses (resolveProject in the
  // brain-server), so the ingested docs and later recall agree on the project.
  const project = require('./lib/project-id.js').resolveProjectId({ cwd: ev.cwd });

  let raw = '';
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch (err) { console.error(`[conversation-ingest] read transcript: ${err.message}`); return {}; }
  raw = clampRaw(raw);
  if (!raw.trim()) return {};

  // Gate 3: don't re-send the exact same transcript (e.g. a duplicate Stop event).
  const key = transcriptKey(sid, raw);
  const stamp = readStamp();
  const keys = Array.isArray(stamp.keys) ? stamp.keys : [];
  if (keys.includes(key)) return {};

  try {
    await backend.init({ project, skipEmbedder: true });
    const res = await backend.ingestConversation(raw, { consumerId: CONSUMER_ID, sessionId: sid });
    // Fail-loud (non-fatal): the server couldn't distill (e.g. its LLM is off).
    // Staging is durable and drains when the LLM is back — never fake success.
    if (res && res.ok === false) {
      console.error(`[conversation-ingest] server did not distill (${res.message || 'unknown'}); staging is durable — will drain when the server LLM is available`);
    }
    writeStamp({ keys: [...keys, key].slice(-STAMP_CAP) });
  } catch (err) {
    console.error(`[conversation-ingest] ${err.message}`);
  }
  return {}; // never blocks the Stop
}

if (require.main === module) {
  runStopDetectorCli(run, 'conversation-ingest');
}

module.exports = { run, clampRaw, transcriptKey };

