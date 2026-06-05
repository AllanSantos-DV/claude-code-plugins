#!/usr/bin/env node
/**
 * retrieval-feedback.js — Stop hook (Plan #1 — Retrieval feedback loop).
 *
 * For each KB entry surfaced by brain-retrieve* hooks this turn, check whether
 * the agent's final reply mentions distinctive tokens from the entry title.
 * If yes → bump cited_count via brain-store.recordCitation. The boost then
 * feeds back into the next rerank (soft, capped), gradually preferring
 * entries that proved useful.
 *
 * Silent: never emits a stop block; only mutates the SQLite counter + clears
 * the journal. Cleanup also sweeps stale journal files (>1h, any session).
 *
 * Pure functions exported for unit tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const retrievalJournal = require('./lib/retrieval-journal.js');
const { extractKeywords } = require('./lib/text-utils.js');

// ── Pure helpers (testable) ───────────────────────────────────────────────

/**
 * Distinctive tokens from a KB-entry title — lowercased, length ≥4, deduped,
 * stopwords removed. Caller uses these to grep the agent reply text.
 */
function titleTokens(title, maxTokens = 8) {
  if (!title) return [];
  const tokens = extractKeywords(title, { minLen: 4, maxTokens });
  // Dedupe + cap
  return [...new Set(tokens.map(t => t.toLowerCase()))].slice(0, maxTokens);
}

/**
 * Decide if an entry is "cited" in the reply. Heuristic:
 *   - ≥2 distinct distinctive tokens from the title appear, OR
 *   - ≥1 token appears AND the lowercased title shares a contiguous run of
 *     ≥10 chars with the reply (caught paraphrases that copy a phrase).
 * Returns { cited:boolean, matchedTokens:[...] }.
 */
function citationMatch(title, replyText) {
  const tokens = titleTokens(title);
  if (!tokens.length || !replyText) return { cited: false, matchedTokens: [] };
  const lower = replyText.toLowerCase();
  const matched = tokens.filter(t => lower.includes(t));
  if (matched.length >= 2) return { cited: true, matchedTokens: matched };
  if (matched.length >= 1) {
    // contiguous-substring fallback for paraphrase tolerance
    const titleLower = String(title).toLowerCase();
    for (let len = Math.min(40, titleLower.length); len >= 10; len -= 2) {
      for (let i = 0; i + len <= titleLower.length; i++) {
        const slice = titleLower.slice(i, i + len);
        if (slice.includes(' ') && lower.includes(slice)) {
          return { cited: true, matchedTokens: matched };
        }
      }
    }
  }
  return { cited: false, matchedTokens: matched };
}

/**
 * Extract the last assistant text from a Claude Code transcript JSONL file.
 * Defensive: tolerates schema variations and partial reads.
 */
function readLastAssistantText(transcriptPath, lookback = 30) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const buf = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = buf.split('\n').filter(Boolean);
    const tail = lines.slice(-lookback);
    const chunks = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(tail[i]);
        const text = extractAssistantText(rec);
        if (text) {
          chunks.push(text);
          if (chunks.join(' ').length > 4000) break;
        }
      } catch { /* skip malformed line */ }
    }
    return chunks.reverse().join('\n');
  } catch { return ''; }
}

function extractAssistantText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const isAssistant =
    rec.type === 'assistant' ||
    rec.role === 'assistant' ||
    rec.message?.role === 'assistant';
  if (!isAssistant) return '';
  const content =
    (rec.message && rec.message.content) ??
    rec.content ??
    rec.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
      .map(c => c.text || '')
      .join(' ');
  }
  return '';
}

/**
 * From a journal of retrievals + an agent reply, decide which entry IDs to
 * bump as cited. Dedupes IDs across retrievals (per-turn cooldown).
 */
function findCitations(journalEntries, replyText) {
  const seen = new Set();
  const out = [];
  for (const ent of journalEntries || []) {
    const titles = ent.returnedTitles || [];
    const ids = ent.returnedIds || [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id || seen.has(id)) continue;
      const m = citationMatch(titles[i] || '', replyText);
      if (m.cited) {
        seen.add(id);
        out.push({ id, title: titles[i] || '', matchedTokens: m.matchedTokens });
      }
    }
  }
  return out;
}

// ── Main (hook entry) ─────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  const project = ev.cwd ? path.basename(ev.cwd) : 'default';

  // Always sweep stale journal entries (>1h) regardless of outcome.
  retrievalJournal.sweepOld(60 * 60 * 1000);

  const entries = retrievalJournal.readEntries(sid);
  if (!entries.length) return emitEmpty();

  const replyText = readLastAssistantText(transcriptPath);
  if (!replyText) {
    // Nothing to score against — clear the session journal and exit.
    retrievalJournal.clearEntries(sid);
    return emitEmpty();
  }

  const cited = findCitations(entries, replyText);
  if (cited.length > 0) {
    try {
      const store = require('./brain-store.js');
      await store.init({ project });
      for (const c of cited) {
        store.recordCitation(c.id);
      }
    } catch (err) {
      console.error(`[retrieval-feedback] recordCitation failed: ${err.message}`);
    }
  }

  retrievalJournal.clearEntries(sid);
  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[retrieval-feedback] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = {
  titleTokens,
  citationMatch,
  findCitations,
  readLastAssistantText,
  extractAssistantText,
};
