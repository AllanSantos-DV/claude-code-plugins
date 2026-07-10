#!/usr/bin/env node
/**
 * conversation-ingest.js — Stop hook (GAP 1: conversation ingestion).
 *
 * Opt-in bridge that ships each completed turn (user prompt + assistant reply)
 * to the external mcp-memory server as a `conversation` document, so the daemon
 * can curate/index it server-side and later semantic recall (the UserPromptSubmit
 * hook) surfaces it. Without this, the daemon only ever holds the CURATED entries
 * (lessons/patterns) the other hooks distill — never the raw conversation.
 *
 * Three gates, cheapest first, so the default path costs almost nothing:
 *   1. backend is the external mcp-memory server (else never touch the local KB);
 *   2. ingestion is enabled (opt-in — sending your chat is an explicit choice);
 *   3. this turn wasn't already ingested (per-session content hash dedup).
 *
 * Silent + fail-open: never emits a Stop block, and any error (daemon down, etc.)
 * is logged and swallowed so it can't break the turn. Zero token cost — the
 * conversation goes straight to the daemon over HTTP, never through the model
 * context.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const { readLastAssistantText, readLastUserText } = require('./retrieval-feedback.js');
const brainConfig = require('./lib/brain-config.js');
const backend = require('./brain-backend.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const STAMP = path.join(DATA_DIR, '.runtime', 'ingest-stamp.json');

// Cap the content shipped per side, so one huge turn can't balloon a document.
const MAX_CHARS = 16000;
// Keep the dedup stamp bounded (most recent N turn hashes).
const STAMP_CAP = 200;

function turnKey(sid, userText, assistantText) {
  const h = crypto.createHash('sha1').update(`${userText}\n\n${assistantText}`).digest('hex').slice(0, 12);
  return `${sid}:${h}`;
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

/**
 * Build a `conversation` KB entry from a completed turn. Pure/testable.
 * Returns null when there's nothing worth sending (both sides empty).
 */
function buildConversationEntry(userText, assistantText, { project, sid } = {}) {
  const u = (userText || '').trim();
  const a = (assistantText || '').trim();
  if (!u && !a) return null;
  const clip = (s) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…[truncated]` : s);
  const firstLine = (u.split('\n').find(Boolean) || '(sem prompt)').slice(0, 80);
  const detail = [
    u ? `## Usuário\n${clip(u)}` : '',
    a ? `## Assistente\n${clip(a)}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    type: 'conversation',
    title: `Conversa: ${firstLine}`,
    summary: (u || a).slice(0, 200),
    content: { detail },
    tags: ['conversation'],
    session_id: sid || '',
    source: { kind: 'ingestion', project: project || 'default' },
    confidence: 0.3,
  };
}

async function run(event) {
  const ev = event || {};
  if (ev.stop_hook_active) return {};
  // Gate 1 (cheapest): only the external daemon path ingests raw conversation —
  // never dump chat turns into the local SQLite KB.
  if (backend.peekMode() !== 'mcp-memory') return {};
  // Gate 2: opt-in.
  if (!brainConfig.getIngestion().enabled) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  const project = ev.cwd ? path.basename(ev.cwd) : 'default';

  const userText = readLastUserText(transcriptPath);
  const assistantText = readLastAssistantText(transcriptPath);
  const entry = buildConversationEntry(userText, assistantText, { project, sid });
  if (!entry) return {};

  // Gate 3: dedup — repeated Stops on the same turn shouldn't re-ingest it.
  const key = turnKey(sid, userText, assistantText);
  const stamp = readStamp();
  const keys = Array.isArray(stamp.keys) ? stamp.keys : [];
  if (keys.includes(key)) return {};

  try {
    await backend.init({ project, skipEmbedder: true });
    await backend.save(entry);
    writeStamp({ keys: [...keys, key].slice(-STAMP_CAP) });
  } catch (err) {
    console.error(`[conversation-ingest] ${err.message}`);
  }
  return {}; // never blocks the Stop
}

if (require.main === module) {
  runStopDetectorCli(run, 'conversation-ingest');
}

module.exports = { run, buildConversationEntry, turnKey };
