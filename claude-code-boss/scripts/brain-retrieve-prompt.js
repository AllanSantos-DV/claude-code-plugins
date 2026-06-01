#!/usr/bin/env node
/**
 * brain-retrieve-prompt.js — UserPromptSubmit hook
 *
 * Lean retrieval/advisory hook for the prompt step:
 *   1. Brain: advisory if payloads pending indexing (capped count).
 *   2. Brain: semantic retrieval of relevant knowledge for the user message —
 *      this surfaces captured lessons too (they're Brain entries via capture_lesson).
 *
 * Tone is advisory: the hook informs, the agent decides.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const backend = require('./brain-backend.js');
const brainConfig = require('./lib/brain-config.js');
const hooksConfig = require('./lib/hooks-config.js');
const { extractKeywords } = require('./lib/text-utils.js');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');

const HOME = os.homedir();
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');

// Never display an unbounded backlog count.
const COUNT_CAP = 20;

function checkPendingPayloads() {
  if (!fs.existsSync(PENDING_DIR)) return 0;
  try {
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length;
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE-PROMPT] pending count failed: ${err.message}`);
    return 0;
  }
}

function fmtCount(n) {
  return n > COUNT_CAP ? `${COUNT_CAP}+` : String(n);
}

(async () => {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw);
    if (!event) { emitEmpty(); return; }
    const userMessage = event.prompt || event.userMessage || event.text || '';

    const project = event.cwd ? path.basename(event.cwd) : 'default';
    const outputs = [];

    // 1. Brain: pending indexing advisory (capped).
    // Silenced once pending >= brainStop threshold — Stop hook will block then,
    // making this advisory noisy duplicate context.
    const pending = checkPendingPayloads();
    const bs = hooksConfig.getBrainStop();
    const stopThreshold = bs.enabled ? bs.threshold : Infinity;
    if (pending > 0 && pending < stopThreshold) {
      outputs.push(`[BRAIN] ${fmtCount(pending)} payload(s) pending indexing — run brain-indexer via Task if you want them searchable.`);
    }

    // 2. Brain: semantic retrieval (also surfaces captured lessons).
    // Backend now honors minScore on the keyword fallback path; just consume config.
    const { topK, minScore } = brainConfig.getRetrievalFast();
    const keywords = extractKeywords(userMessage, { minLen: 4, maxTokens: 15 });
    if (keywords.length >= 3) {
      try {
        await backend.init({ project, skipEmbedder: true });
        const entries = await backend.search(userMessage, { topK, minScore });
        if (entries.length > 0) {
          const lines = entries.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);
          outputs.push(`[BRAIN-RETRIEVE] Relevant knowledge found:\n${lines.join('\n')}`);
        }
      } catch (err) {
        console.error(`[BRAIN-RETRIEVE-PROMPT] backend search failed: ${err.message}`);
      }
    }

    if (outputs.length === 0) { emitEmpty(); return; }

    emitJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: outputs.join('\n\n'),
      },
    });
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE-PROMPT] Error: ${err.message}`);
    emitEmpty();
  }
})();
