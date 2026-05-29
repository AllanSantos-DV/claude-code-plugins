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

const HOME = os.homedir();
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');

// Never display an unbounded backlog count.
const COUNT_CAP = 20;

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from',
  'not', 'but', 'all', 'can', 'will', 'just', 'what', 'when',
  'where', 'which', 'who', 'how', 'about', 'very', 'para',
  'que', 'com', 'uma', 'mais', 'mas', 'como', 'por', 'dos',
  'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being',
  'into', 'over', 'then', 'than', 'some', 'such', 'only', 'also',
]);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s/._-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 15);
}

function checkPendingPayloads() {
  if (!fs.existsSync(PENDING_DIR)) return 0;
  try {
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function fmtCount(n) {
  return n > COUNT_CAP ? `${COUNT_CAP}+` : String(n);
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write(JSON.stringify({})); return; }

    let event, userMessage;
    try {
      event = JSON.parse(raw);
      userMessage = event.prompt || event.userMessage || event.text || '';
    } catch {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const project = event.cwd ? path.basename(event.cwd) : 'default';
    const outputs = [];

    // 1. Brain: pending indexing advisory (capped)
    const pending = checkPendingPayloads();
    if (pending > 0) {
      outputs.push(`[BRAIN] ${fmtCount(pending)} payload(s) pending indexing — run brain-indexer via Task if you want them searchable.`);
    }

    // 2. Brain: semantic retrieval (also surfaces captured lessons)
    const keywords = extractKeywords(userMessage);
    if (keywords.length > 0) {
      try {
        await backend.init({ project });
        const entries = await backend.search(userMessage, { topK: 3, minScore: 0.3 });
        if (entries.length > 0) {
          const lines = entries.map((e, i) => `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`);
          outputs.push(`[BRAIN-RETRIEVE] Conhecimento relevante encontrado:\n${lines.join('\n')}`);
        }
      } catch (err) {
        console.error(`[BRAIN-RETRIEVE-PROMPT] backend search failed: ${err.message}`);
      }
    }

    if (outputs.length === 0) { process.stdout.write(JSON.stringify({})); return; }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: outputs.join('\n\n'),
      },
    }));
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE-PROMPT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({}));
  }
})();
