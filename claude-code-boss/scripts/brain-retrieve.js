#!/usr/bin/env node
const path = require('path');

const _PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

const backend = require('./brain-backend.js');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function extractContext(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s/._-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 20);
}

function formatEntries(entries) {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map((e, i) =>
    `${i + 1}. "${e.title}" (${e.type}, score: ${(e.score || 0).toFixed(2)}) — ${e.summary}`
  );
  return `[BRAIN-RETRIEVE] ${entries.length} relevant entries:\n${lines.join('\n')}`;
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const event = JSON.parse(raw);
    const toolName = event.tool_name || '';
    if (toolName !== 'Bash' && toolName !== 'Write' && toolName !== 'Edit') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const command = event.tool_input?.command || '';
    const filePath = event.tool_input?.file_path
      || event.tool_input?.path
      || '';
    const _sessionId = event.session_id || event.sessionId || 'default';

    const context = toolName === 'Bash'
      ? extractContext(command)
      : extractContext(filePath);

    if (context.length === 0) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const project = event.cwd
      ? path.basename(event.cwd)
      : 'default';

    await backend.init({ project });
    const queryText = context.join(' ');
    const entries = await backend.search(queryText, { topK: 5, minScore: 0.3 });

    if (entries.length === 0) {
      process.stdout.write(JSON.stringify({ found: 0 }));
      return;
    }

    const message = formatEntries(entries);

    process.stdout.write(JSON.stringify({
      found: entries.length,
      method: backend.getMode(),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
      entries: entries.map(e => ({ id: e.id, title: e.title, type: e.type, score: e.score })),
    }));
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({}));
  }
})();

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from', 'was', 'are',
  'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will', 'just',
  'been', 'were', 'they', 'them', 'their', 'what', 'when', 'where',
  'which', 'who', 'how', 'about', 'into', 'over', 'such', 'each',
  'than', 'then', 'these', 'those', 'also', 'very', 'because',
  'para', 'que', 'com', 'uma', 'mais', 'mas', 'como', 'por',
  'dos', 'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
  'node', 'npm', 'npx', 'file', 'path', 'src', 'lib', 'test',
]);
