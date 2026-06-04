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
      // Backend failure here mirrors what the brain MCP server hits in-process
      // — surface it instead of silent emitEmpty so the user/agent can recover.
      console.error(`[BRAIN-RETRIEVE-PROMPT] backend search failed: ${err.message}`);
      emitJson({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            `[BRAIN] Knowledge base unreachable: ${err.message}. ` +
            'The brain MCP server likely failed to connect this session. ' +
            'Action: re-run `.vscode/scripts/install-local.mjs` (takes effect on next turn — ' +
            'no Claude Code restart needed) or check node_modules / data-dir permissions. ' +
            'Proceeding without KB context.',
        },
      });
      return;
    }

    if (entries.length === 0) {
      // Passive search (English-canonical KB) found nothing — often because the
      // prompt is in another language or uses different wording. Nudge an active,
      // curated search so saved patterns actually get reused (cross-lingual).
      emitJson({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            '[BRAIN] No direct matches. If this task may relate to prior work, call the ' +
            '`brain_search` MCP tool with 2-4 English concept terms/tags (the KB is stored ' +
            'in English) to retrieve and reuse relevant lessons/patterns before proceeding.',
        },
      });
      return;
    }

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
