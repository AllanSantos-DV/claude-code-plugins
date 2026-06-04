#!/usr/bin/env node
/**
 * brain-retrieve-prompt.js — UserPromptSubmit hook
 *
 * Semantic retrieval for the prompt step: surfaces relevant Brain knowledge
 * (captured lessons/patterns via capture_lesson) so it gets reused. Advisory:
 * the hook informs, the agent decides.
 */
const path = require('path');

const backend = require('./brain-backend.js');
const brainConfig = require('./lib/brain-config.js');
const { extractKeywords } = require('./lib/text-utils.js');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');

(async () => {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw);
    if (!event) { emitEmpty(); return; }
    const userMessage = event.prompt || event.userMessage || event.text || '';
    const project = event.cwd ? path.basename(event.cwd) : 'default';

    // Semantic retrieval (surfaces captured lessons/patterns for reuse).
    // Backend honors minScore on the keyword fallback path; just consume config.
    const { topK, minScore } = brainConfig.getRetrievalFast();
    const keywords = extractKeywords(userMessage, { minLen: 4, maxTokens: 15 });
    if (keywords.length < 3) { emitEmpty(); return; }

    let entries = [];
    try {
      await backend.init({ project, skipEmbedder: true });
      entries = await backend.search(userMessage, { topK, minScore });
    } catch (err) {
      console.error(`[BRAIN-RETRIEVE-PROMPT] backend search failed: ${err.message}`);
      emitEmpty();
      return;
    }

    if (entries.length === 0) { emitEmpty(); return; }

    const lines = entries.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[BRAIN-RETRIEVE] Relevant knowledge found:\n${lines.join('\n')}`,
      },
    });
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE-PROMPT] Error: ${err.message}`);
    emitEmpty();
  }
})();
