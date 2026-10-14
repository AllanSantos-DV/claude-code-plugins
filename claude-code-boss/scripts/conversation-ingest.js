#!/usr/bin/env node
/**
 * conversation-ingest.js — Stop hook (cooperative conversation ingestion).
 *
 * Ships the session transcript (JSONL) to the external mcp-memory server's
 * `ingest_conversation` tool. The server is the smart half: it parses the
 * transcript with the deterministic `claude-code-boss` template seed, stages the
 * user→assistant pairs, DEDUPS by event uuid per (consumer×session) and curates
 * them asynchronously with its LLM.
 *
 * Only the DELTA is sent. Per session we persist the byte offset the next send
 * starts from (`.runtime/ingest-state.json`); re-sending the whole transcript each
 * Stop made every turn slower than the last, and a marathon session crossed the
 * server's 10 MiB body limit (HTTP 413 on every Stop, forever). Invariants:
 *   - A chunk is only sent when it holds at least one user line AND one assistant
 *     line with text: a chunk the server's template finds nothing in marks the
 *     template degraded and triggers a BLOCKING LLM rediscovery on its side.
 *   - The offset advances only on success, and stops at the start of a trailing
 *     user prompt that has no assistant reply yet — the server does not mark an
 *     unpaired prompt as seen, so the next chunk must carry it again (the uuid
 *     dedup absorbs the overlap).
 *   - The JSON-escaped payload never exceeds MAX_PAYLOAD_BYTES, which keeps it
 *     under both the server's MAX_RAW_CHARS (8M) and its 10 MiB body cap; older
 *     lines past that window are dropped (the first send of a huge transcript).
 *
 * Failures back off exponentially (persisted, so it survives worker recycles and
 * daemon restarts) instead of retrying on every Stop, and they are VISIBLE: the
 * detector returns a `notice` (Stop systemMessage) on the first failure of a
 * streak, again at most every NOTICE_REPEAT_MS, and once on recovery. A healthy
 * ingest is not proof of healthy curation — the server answers ok:true even when
 * its LLM is down — so `ingest_status` is polled (throttled) and a stalled
 * staging queue is surfaced the same way.
 *
 * Concurrent Stops run in separate processes only in CLI mode; a lost state
 * update there costs a re-sent overlap, which the server's dedup absorbs.
 */
'use strict';

const { writeJsonAtomic } = require('./lib/atomic-write.js');
const fs = require('fs');
const path = require('path');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const brainConfig = require('./lib/brain-config.js');
const brainBackend = require('./brain-backend.js');

const { dataDir } = require('./lib/data-dir.js');
const { readRange } = require('./lib/transcript-tail.js');
const STATE = path.join(dataDir(), '.runtime', 'ingest-state.json');

const CONSUMER_ID = 'claude-code-boss';
// Bytes of JSON.stringify(raw). Every char costs >= 1 byte, so this also caps the
// char count under the server's MAX_RAW_CHARS (8M) with room for the envelope.
const MAX_PAYLOAD_BYTES = 7_500_000;
// The Stop hook has ~29s for all detectors; the upload must fit well inside it.
const INGEST_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const NOTICE_REPEAT_MS = 30 * 60_000;
// The server drains staging every 60s; 10 min without progress is a stall.
const STATUS_EVERY_MS = 10 * 60_000;
const SESSION_CAP = 200;

function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/** 'user' | 'assistant' when the line is a message of that role carrying text, else null. */
function textRole(line) {
  if (!line.includes('"role"')) return null;
  let o;
  try { o = JSON.parse(line); } catch (err) { void err; return null; } // torn/non-JSON line: not a message
  const m = o && o.message;
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  const c = m.content;
  const hasText = typeof c === 'string'
    ? c.trim() !== ''
    : Array.isArray(c) && c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '');
  return hasText ? m.role : null;
}

/**
 * Pick the chunk of `buf` (file bytes starting at absolute offset `base`) to send.
 * Pure: `{ raw, nextOffset }`, or `{ raw: null, reason }` when nothing should go.
 * `cutHead` — `buf` starts mid-file at an arbitrary byte, so its first line is torn.
 */
function selectChunk(buf, base, { cutHead = false, maxPayloadBytes = MAX_PAYLOAD_BYTES } = {}) {
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end === 0) return { raw: null, reason: 'no complete line' };
  let start = 0;
  if (cutHead) {
    start = buf.indexOf(0x0a) + 1;
    if (start >= end) return { raw: null, reason: 'no complete line' };
  }
  const lines = [];
  for (let at = start; at < end;) {
    const nl = buf.indexOf(0x0a, at);
    lines.push({ at, text: buf.toString('utf-8', at, nl) });
    at = nl + 1;
  }
  // Newest lines first until the escaped payload would overflow.
  let first = lines.length;
  for (let budget = maxPayloadBytes; first > 0; first--) {
    // Escaped line minus its 2 quotes, plus 2 for the escaped "\n" separator.
    budget -= Buffer.byteLength(JSON.stringify(lines[first - 1].text));
    if (budget < 0) break;
  }
  const kept = lines.slice(first);
  let lastUser = -1;
  let assistantAfterUser = false;
  let anyAssistant = false;
  kept.forEach((l, i) => {
    const role = textRole(l.text);
    if (role === 'user') { lastUser = i; assistantAfterUser = false; }
    else if (role === 'assistant') { anyAssistant = true; if (lastUser >= 0) assistantAfterUser = true; }
  });
  if (lastUser < 0 || !anyAssistant) return { raw: null, reason: 'no user+assistant text pair yet' };
  return {
    raw: buf.toString('utf-8', kept[0].at, end),
    nextOffset: base + (assistantAfterUser ? end : kept[lastUser].at),
  };
}

function readState(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`[conversation-ingest] state unreadable, starting fresh: ${err.message}`);
    s = {};
  }
  return {
    sessions: s.sessions && typeof s.sessions === 'object' ? s.sessions : {},
    failures: Number(s.failures) || 0,
    nextAttemptAt: Number(s.nextAttemptAt) || 0,
    lastError: s.lastError || null,
    noticedAt: Number(s.noticedAt) || 0,
    statusCheckedAt: Number(s.statusCheckedAt) || 0,
    curationStalled: !!s.curationStalled,
    curationNoticedAt: Number(s.curationNoticedAt) || 0,
  };
}

function writeState(file, state) {
  const ids = Object.keys(state.sessions);
  if (ids.length > SESSION_CAP) {
    ids.sort((a, b) => (state.sessions[b].at || 0) - (state.sessions[a].at || 0))
      .slice(SESSION_CAP).forEach((id) => { delete state.sessions[id]; });
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, state);
  } catch (err) {
    console.error(`[conversation-ingest] state write failed: ${err.message}`);
  }
}

function shortErr(msg) {
  const s = String(msg || 'unknown error').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** Record a failed attempt; returns the notice to show (or null while throttled). */
function onFailure(state, message, now) {
  const firstOfStreak = state.failures === 0;
  state.failures += 1;
  state.lastError = shortErr(message);
  const wait = backoffMs(state.failures);
  state.nextAttemptAt = now + wait;
  console.error(`[conversation-ingest] ${state.lastError} (attempt ${state.failures}, next in ${Math.round(wait / 1000)}s)`);
  if (!firstOfStreak && now - state.noticedAt < NOTICE_REPEAT_MS) return null;
  state.noticedAt = now;
  const next = wait < 60_000 ? `${Math.round(wait / 1000)}s` : `${Math.round(wait / 60_000)} min`;
  return `[INGEST] Conversation ingestion to mcp-memory failed ${state.failures}x: ${state.lastError.replace(/[.?!]$/, '')}. `
    + `Retrying with backoff (next in ${next}); the transcript stays on disk and resumes where it stopped.`;
}

function onSuccess(state) {
  const recovered = state.failures > 0
    ? `[INGEST] Conversation ingestion to mcp-memory recovered after ${state.failures} failed attempt(s).`
    : null;
  state.failures = 0;
  state.nextAttemptAt = 0;
  state.lastError = null;
  state.noticedAt = 0;
  return recovered;
}

/**
 * Curation health from one `ingest_status` staging snapshot vs. the previous one
 * of the same session. Pure. `prev` absent → only signals that need no history.
 */
function curationStalled(staging, prev) {
  const st = staging || {};
  const pending = Number(st.pending) || 0;
  const pf = Number(st.permanently_failed) || 0;
  if ((Number(st.in_cooldown) || 0) > 0) return true;
  if (!prev) return false;
  if (pf > (Number(prev.permanently_failed) || 0)) return true;
  return pending > 0 && (Number(st.success) || 0) === (Number(prev.success) || 0) && pending >= (Number(prev.pending) || 0);
}

async function checkCuration(be, state, sess, sid, now) {
  state.statusCheckedAt = now;
  let res;
  try {
    res = await be.ingestStatus({ consumerId: CONSUMER_ID, sessionId: sid, timeoutMs: STATUS_TIMEOUT_MS });
  } catch (err) {
    console.error(`[conversation-ingest] ingest_status: ${err.message}`);
    return null;
  }
  const st = res && res.staging;
  if (!st) {
    console.error(`[conversation-ingest] ingest_status gave no staging: ${shortErr(JSON.stringify(res))}`);
    return null;
  }
  const stalled = curationStalled(st, sess.curation);
  sess.curation = { at: now, pending: Number(st.pending) || 0, success: Number(st.success) || 0, permanently_failed: Number(st.permanently_failed) || 0 };
  if (!stalled) {
    const wasStalled = state.curationStalled;
    state.curationStalled = false;
    state.curationNoticedAt = 0;
    return wasStalled ? '[INGEST] mcp-memory curation is moving again.' : null;
  }
  const first = !state.curationStalled;
  state.curationStalled = true;
  if (!first && now - state.curationNoticedAt < NOTICE_REPEAT_MS) return null;
  state.curationNoticedAt = now;
  return `[INGEST] mcp-memory curation is stalled for this session: ${st.pending} pair(s) pending `
    + `(${st.in_cooldown} in retry cooldown, ${st.permanently_failed} permanently failed)`
    + `${st.last_error ? ` — last error: ${shortErr(st.last_error)}` : ''}. `
    + 'The pairs stay staged on the server and are curated when its LLM is back.';
}

/**
 * @param {object} event  Stop payload
 * @param {{ backend?: object, now?: () => number, statePath?: string }} [deps]  test seams
 */
async function run(event, deps = {}) {
  const be = deps.backend || brainBackend;
  const now = (deps.now || Date.now)();
  const statePath = deps.statePath || STATE;
  const ev = event || {};
  if (ev.stop_hook_active) return {};
  // Gate 1 (cheapest): only the external daemon ingests raw conversation.
  if (be.peekMode() !== 'mcp-memory') return {};
  // Gate 2: opt-in (sending your chat is an explicit choice).
  if (!brainConfig.getIngestion().enabled) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  if (!transcriptPath) return {};

  const state = readState(statePath);
  // Gate 3: backing off after a failure — no read, no network.
  if (now < state.nextAttemptAt) return {};

  // Same client-side identity the recall path uses (resolveProject in the
  // brain-server), so the ingested docs and later recall agree on the project.
  // HARD CONTRACT (native-java ADR-018): the STRICT resolver THROWS when there is no
  // stable scope (no .memory/project.json, no legacy marker, no git remote up to the
  // session root). BLOCK ingestion here — fail-LOUD (actionable SCOPE_HELP in the
  // message) rather than stamping folder-path scope-junk on the shared memory — while
  // the Stop hook stays fail-OPEN (never crashes the session). Said once per session:
  // it is a property of the folder, not a transient failure to back off from.
  const prev = state.sessions[sid];
  let project;
  try {
    project = require('./lib/project-id.js').resolveProjectId({ cwd: ev.cwd || require('./lib/hook-context.js').hookEnv().CLAUDE_PROJECT_DIR });
  } catch (err) {
    console.error(`[conversation-ingest] ${err.message}`);
    if (prev && prev.scopeNoticed) return {};
    state.sessions[sid] = { ...prev, scopeNoticed: true, at: now };
    writeState(statePath, state);
    return { notice: `[INGEST] Conversation ingestion to mcp-memory is skipped for this project: ${shortErr(err.message)}` };
  }

  let size;
  try { size = fs.statSync(transcriptPath).size; }
  catch (err) { console.error(`[conversation-ingest] transcript: ${err.message}`); return {}; }
  // A different file or one that shrank (rewritten) restarts from the top.
  const from = prev && prev.path === transcriptPath && prev.offset <= size ? prev.offset : 0;
  if (from >= size) return {};
  const windowStart = Math.max(from, size - MAX_PAYLOAD_BYTES);
  const chunk = selectChunk(readRange(transcriptPath, windowStart, size), windowStart, { cutHead: windowStart > from });
  if (!chunk.raw) return {};

  const notices = [];
  try {
    await be.init({ project, skipEmbedder: true });
    const res = await be.ingestConversation(chunk.raw, { consumerId: CONSUMER_ID, sessionId: sid, timeoutMs: INGEST_TIMEOUT_MS });
    if (res && res.ok === false) {
      notices.push(onFailure(state, `server rejected the transcript: ${res.code || res.error || res.message || 'unknown'}`, now));
    } else {
      notices.push(onSuccess(state));
      const sess = { ...(prev && prev.path === transcriptPath ? prev : {}), path: transcriptPath, offset: chunk.nextOffset, at: now };
      state.sessions[sid] = sess;
      if (now - state.statusCheckedAt >= STATUS_EVERY_MS) notices.push(await checkCuration(be, state, sess, sid, now));
    }
  } catch (err) {
    if (err && err.code === 'CIRCUIT_OPEN') {
      // The shared breaker already reports the daemon as down (recall health);
      // nothing was attempted, so this is neither a failure nor a success.
      console.error(`[conversation-ingest] ${err.message}`);
      return {};
    }
    notices.push(onFailure(state, err && err.message, now));
  }
  writeState(statePath, state);
  const notice = notices.filter(Boolean).join('\n');
  return notice ? { notice } : {};
}

if (require.main === module) {
  runStopDetectorCli(run, 'conversation-ingest');
}

module.exports = { run, selectChunk, textRole, curationStalled, backoffMs, MAX_PAYLOAD_BYTES };
