#!/usr/bin/env node
/**
 * brain-retrieve-prompt.js — UserPromptSubmit hook (adaptive, vector path)
 *
 * Surfaces relevant Brain knowledge for the prompt, ONCE per turn. Uses the
 * MULTILINGUAL vector path so pt-BR prompts match the English-canonical KB
 * (the old keyword path could not — cross-lingual miss).
 *
 * Adaptive gate: inject ONLY when cosine relevance clears a real threshold
 * (config kb.retrieval.minScoreFast). If nothing is relevant enough, inject
 * NOTHING — no blind "call brain_search" nudge. Injected context accumulates in
 * the conversation (anthropics/claude-code#45849), so we keep it minimal and
 * high-signal: small topK + real threshold.
 *
 * Runs the embedder in-process (~600ms cold load, once per turn — tolerable;
 * see IMPROVEMENT-PLAN latency sub-gate). Advisory: the hook informs, the agent
 * decides.
 */
const path = require('path');

const embedder = require('./brain-embedder.js');
const store = require('./brain-store.js');
const brainConfig = require('./lib/brain-config.js');
const { extractKeywords } = require('./lib/text-utils.js');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');
const retrievalJournal = require('./lib/retrieval-journal.js');

(async () => {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw);
    if (!event) { emitEmpty(); return; }

    const userMessage = event.prompt || event.userMessage || event.text || '';
    const project = event.cwd ? path.basename(event.cwd) : 'default';

    // Cheap pre-filter: skip trivial/short prompts (don't even load the model).
    const kw = extractKeywords(userMessage, { minLen: 4, maxTokens: 15 });
    if (kw.length < 3) { emitEmpty(); return; }

    const { topK, minScore } = brainConfig.getRetrievalFast();

    let entries = [];
    try {
      await store.init({ project });
      if (!embedder.getStatus().ready) await embedder.init();
      const vector = await embedder.embed(userMessage);
      if (!vector) { emitEmpty(); return; }            // no model → degrade silently
      // minScore is applied to RAW cosine (relevance gate) before rerank.
      // Over-fetch + dedup by title: the KB can hold duplicate entries (same
      // title, different id — a known hygiene gap) that would waste topK slots.
      const raw = await store.search(vector, { topK: topK + 4, minScore });
      const seenTitles = new Set();
      for (const e of raw) {
        const t = (e.title || '').trim().toLowerCase();
        if (t && seenTitles.has(t)) continue;
        seenTitles.add(t);
        entries.push(e);
        if (entries.length >= topK) break;
      }
    } catch (err) {
      // brain-health already surfaces a KB-down advisory; don't double-inject here.
      console.error(`[BRAIN-RETRIEVE-PROMPT] search failed: ${err.message}`);
      emitEmpty();
      return;
    }

    // Adaptive gate: nothing cleared the relevance threshold → inject NOTHING.
    if (!entries.length) { emitEmpty(); return; }

    const lines = entries.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);

    // Persist the retrieval so the Stop-hook can score citations/exposure. Best-effort.
    try {
      const sid = event.session_id || event.sessionId || 'default';
      retrievalJournal.appendEntry(sid, {
        retrievalId: retrievalJournal.newRetrievalId(),
        ts: Date.now(),
        sid,
        tool: 'UserPromptSubmit',
        queryTokens: kw.slice(0, 10),
        project,
        returnedIds: entries.map(e => e.id),
        returnedTitles: entries.map(e => e.title),
      });
    } catch (err) {
      console.error(`[BRAIN-RETRIEVE-PROMPT] journal append failed: ${err.message}`);
    }

    emitJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[BRAIN] ${entries.length} relevant lesson(s):\n${lines.join('\n')}`,
      },
    });
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE-PROMPT] Error: ${err.message}`);
    emitEmpty();
  }
})();
