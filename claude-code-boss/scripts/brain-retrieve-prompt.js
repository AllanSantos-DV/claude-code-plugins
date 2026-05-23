#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');

const backend = require('./brain-backend.js');

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
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json') && !f.includes('/processed/')).length;
  } catch {
    return 0;
  }
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    let event, userMessage;
    try {
      event = JSON.parse(raw);
      userMessage = event.prompt || event.userMessage || event.text || '';
    } catch {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const sessionId = event.session_id || event.sessionId || 'default';
    const project = event.cwd
      ? path.basename(event.cwd)
      : 'default';

    const keywords = extractKeywords(userMessage);
    const outputs = [];

    const pending = checkPendingPayloads();
    if (pending > 0) {
      outputs.push(`[BRAIN] ${pending} payload(s) pending indexing. Spawn brain-indexer to process.`);
    }

    if (keywords.length > 0) {
      await backend.init({ project });
      const entries = await backend.search(userMessage, { topK: 3, minScore: 0.3 });

      if (entries.length > 0) {
        const lines = entries.map((e, i) =>
          `${i + 1}. "${e.title}" (${e.type}) — ${e.summary}`
        );
        outputs.push(`[BRAIN-RETRIEVE] Conhecimento relevante encontrado:\n${lines.join('\n')}`);
      }
    }

    if (outputs.length === 0) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

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

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from',
  'not', 'but', 'all', 'can', 'will', 'just', 'what', 'when',
  'where', 'which', 'who', 'how', 'about', 'very', 'para',
  'que', 'com', 'uma', 'mais', 'mas', 'como', 'por', 'dos',
  'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
]);
