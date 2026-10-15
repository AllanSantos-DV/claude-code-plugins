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

const path = require('path');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const retrievalJournal = require('./lib/retrieval-journal.js');
const { extractKeywords } = require('./lib/text-utils.js');
const { readTailLines } = require('./lib/transcript-tail.js');

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
    const tail = readTailLines(transcriptPath, lookback);
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
  } catch { /* unreadable transcript: empty */ return ''; }
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

/** User counterpart of extractAssistantText — pulls the text of a user turn. */
function extractUserText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const isUser =
    rec.type === 'user' ||
    rec.role === 'user' ||
    rec.message?.role === 'user';
  if (!isUser) return '';
  const content =
    (rec.message && rec.message.content) ??
    rec.content ??
    rec.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Skip tool_result blocks — those are tool output echoed back as a "user"
    // turn, not something the human typed.
    return content
      .filter(c => c && c.type !== 'tool_result' && (c.type === 'text' || typeof c.text === 'string'))
      .map(c => c.text || '')
      .join(' ');
  }
  return '';
}

/**
 * Last human user prompt in the transcript (mirrors readLastAssistantText).
 * Defensive: tolerates schema variations and partial reads.
 */
function readLastUserText(transcriptPath, lookback = 30) {
  try {
    const tail = readTailLines(transcriptPath, lookback);
    for (let i = tail.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(tail[i]);
        const text = extractUserText(rec);
        if (text && text.trim()) return text.trim();
      } catch { /* skip malformed line */ }
    }
    return '';
  } catch { /* unreadable transcript: empty */ return ''; }
}

/**
 * The (id, title) pairs of a journal entry that really entered the prompt: `injectedIds` (what survived the config's type
 * filter) when the recall recorded it, else everything it returned (entries written by older builds and by other writers).
 */
function injectedPairs(ent) {
  const ids = ent.returnedIds || [];
  const titles = ent.returnedTitles || [];
  const pairs = ids.map((id, i) => [id, titles[i] || '']);
  if (!Array.isArray(ent.injectedIds)) return pairs;
  const kept = new Set(ent.injectedIds);
  return pairs.filter(([id]) => kept.has(id));
}

/**
 * From a journal of retrievals + an agent reply, decide which entry IDs to
 * bump as cited. Dedupes IDs across retrievals (per-turn cooldown).
 */
function findCitations(journalEntries, replyText) {
  const seen = new Set();
  const out = [];
  for (const ent of journalEntries || []) {
    const pairs = injectedPairs(ent);
    for (const [id, title] of pairs) {
      if (!id || seen.has(id)) continue;
      const m = citationMatch(title, replyText);
      if (m.cited) {
        seen.add(id);
        // `project` = the KB scope the entry was RETRIEVED from (journal), so the
        // citation is recorded where the entry actually lives.
        out.push({ id, title, matchedTokens: m.matchedTokens, project: ent.project || null });
      }
    }
  }
  return out;
}

/** Chars the journalled recalls really put in the prompt (entries from before this field count 0). */
function injectedChars(journalEntries) {
  let n = 0;
  for (const e of journalEntries || []) n += Number(e.injectedChars) || 0;
  return n;
}

// ── Main (hook entry) ─────────────────────────────────────────────────────

async function run(event) {
  const ev = event || {};
  const sid = ev.session_id || ev.sessionId || 'default';
  const transcriptPath = ev.transcript_path || ev.transcriptPath || '';
  // Always sweep stale journal entries (>1h) regardless of outcome.
  retrievalJournal.sweepOld(60 * 60 * 1000);

  const entries = retrievalJournal.readEntries(sid);
  if (!entries.length) return {};

  // Distinct KB entries that really entered the prompt this turn — the precision denominator (F3 #7).
  const injectedIds = new Set();
  for (const e of entries) for (const [id] of injectedPairs(e)) if (id) injectedIds.add(id);
  const returnedCount = new Set(entries.flatMap((e) => e.returnedIds || [])).size;
  // The metrics project is the session's own key (by project id), never the folder name: the two split one project's events across two databases.
  const mctx = { sessionId: sid, cwd: ev.cwd };

  const replyText = readLastAssistantText(transcriptPath);
  // Only record precision signals on turns we can actually score (assistant reply
  // present) — recording injected without a scoreable reply biases precision down.
  if (replyText) {
    const cited = findCitations(entries, replyText);
    try {
      const store = require('./brain-store.js');
      const metrics = require('./lib/metrics.js');
      if (injectedIds.size && injectedChars(entries) > 0) metrics.fire('retrieve.injected', { count: injectedIds.size, chars: injectedChars(entries) }, mctx);
      else if (returnedCount) metrics.fire('retrieve.empty', { returned: returnedCount, reason: 'filtered' }, mctx);
      // KB citations go to the scope each entry was retrieved from. It used to be
      // basename(cwd): the UPDATE then hit a shard without the entry and silently
      // changed 0 rows, so citations of real lessons were never counted. No scope
      // (folder without a project id = memory off) → nothing recorded.
      const fallback = require('./lib/project-id.js').tryResolveProjectId({ cwd: ev.cwd });
      const byScope = new Map();
      for (const c of cited) {
        const scope = c.project || fallback;
        if (!scope) continue;
        if (!byScope.has(scope)) byScope.set(scope, []);
        byScope.get(scope).push(c.id);
      }
      // On mcp-memory the entries live on the server: the citation goes there as a "helpful"
      // feedback signal; store.init would only create an empty local db per scope.
      const backend = require('./brain-backend.js');
      const remote = backend.peekMode() === 'mcp-memory';
      for (const [scope, ids] of byScope) {
        if (remote) {
          await backend.init({ project: scope, skipEmbedder: true });
          for (const id of ids) await backend.signalHelpful(id);
          continue;
        }
        await store.init({ project: scope });
        for (const id of ids) store.recordCitation(id);
      }
      for (const c of cited) metrics.fire('retrieve.cited', { entryId: c.id }, mctx);
    } catch (err) {
      console.error(`[retrieval-feedback] recordCitation failed: ${err.message}`);
    }
  }

  retrievalJournal.clearEntries(sid);
  return {};
}

if (require.main === module) {
  runStopDetectorCli(run, 'retrieval-feedback');
}

module.exports = {
  run,
  titleTokens,
  citationMatch,
  findCitations,
  injectedPairs,
  injectedChars,
  readLastAssistantText,
  extractAssistantText,
  readLastUserText,
  extractUserText,
};
