#!/usr/bin/env node
/**
 * decision-scan-response.js — Stop hook (Plan #9 Loop 6).
 *
 * Scans the agent's last assistant text for an architectural-decision shape
 * ("I'll use X instead of Y because Z" / "decidi X em vez de Y porque Z") and,
 * if found AND not already pending/promoted, stages a `kind: 'response'` entry
 * in `.runtime/decision-pending.json` so `decision-promote.js` (running later
 * in the Stop chain) nudges the agent to call `capture_lesson({type:'decision'})`.
 *
 * Stricter heuristic than commit/PR detector: requires BOTH a verb of choice
 * AND a rationale connector — false positives degrade UX (Stop nag) so we err
 * tight. Per Plan #9 R4.
 *
 * Per-session stamp avoids nagging on every Stop while the agent iterates on
 * the same response — keyed by hash of the matched span.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const { readLastAssistantText } = require('./retrieval-feedback.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING = path.join(DATA_DIR, '.runtime', 'decision-pending.json');
const PROMOTED = path.join(DATA_DIR, '.runtime', 'decision-promoted-sha.json');

const CHOICE_VERBS = /\b(?:choose|chose|pick(?:ed)?|adopt(?:ed)?|swap(?:ped)?|migrat(?:e|ed)|replace(?:d)?|use|using|switch(?:ed)?\s+to|cutover|move(?:d)?\s+to|escolh(?:emos|i|er)|trocar?|trocamos|migrar?|adotar?|substituir?|vou\s+usar|vamos\s+usar|i'?ll\s+use|i'?m\s+going\s+to\s+use)\b/i;
const RATIONALE = /\b(?:because|since|due to|in favor of|over|instead of|rather than|porque|porqu[êe]|pois|j[áa] que|em favor de|em vez de|ao inv[ée]s de)\b/i;

/**
 * Pure heuristic: returns matched span (sentence containing both signals) or null.
 * Used by the Stop hook AND unit tests.
 */
function findDecisionSpan(text) {
  if (!text || typeof text !== 'string') return null;
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    if (s.length < 16 || s.length > 600) continue;
    if (CHOICE_VERBS.test(s) && RATIONALE.test(s)) return s.trim();
  }
  return null;
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* absent or corrupt: use fallback */ return fallback; }
}
function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
    return true;
  } catch { /* write failed (perms/disk): caller sees false */ return false; }
}

function spanKey(sid, span) {
  const h = crypto.createHash('sha1').update(span).digest('hex').slice(0, 12);
  return `resp:${sid}:${h}`;
}

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  if (ev.stop_hook_active) return emitEmpty();

  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  const text = readLastAssistantText(transcriptPath);
  if (!text) return emitEmpty();

  const span = findDecisionSpan(text);
  if (!span) return emitEmpty();

  const key = spanKey(sid, span);

  const promoted = readJsonSafe(PROMOTED, []);
  if (Array.isArray(promoted) && promoted.includes(key)) return emitEmpty();

  const state = readJsonSafe(PENDING, { pending: [] });
  if (!Array.isArray(state.pending)) state.pending = [];
  if (state.pending.some(p => p.key === key)) return emitEmpty();

  state.pending.push({
    kind: 'response',
    key,
    snippet: span.slice(0, 240),
    fullLen: span.length,
    repoUrl: null,
    ts: Date.now(),
  });
  if (state.pending.length > 10) state.pending = state.pending.slice(-10);
  writeJsonSafe(PENDING, state);

  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[decision-scan-response] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { findDecisionSpan, spanKey };
