#!/usr/bin/env node
const path = require('path');

const backend = require('./brain-backend.js');
const brainConfig = require('./lib/brain-config.js');
const { extractKeywords } = require('./lib/text-utils.js');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');
const retrievalJournal = require('./lib/retrieval-journal.js');

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
    const event = parsePayload(raw);
    if (!event) { emitEmpty(); return; }

    const toolName = event.tool_name || '';
    if (toolName !== 'Bash' && toolName !== 'Write' && toolName !== 'Edit') {
      emitEmpty();
      return;
    }

    const command = event.tool_input?.command || '';
    const filePath = event.tool_input?.file_path
      || event.tool_input?.path
      || '';

    const context = toolName === 'Bash'
      ? extractKeywords(command, { minLen: 4, maxTokens: 20 })
      : extractKeywords(filePath, { minLen: 4, maxTokens: 20 });

    if (context.length === 0) { emitEmpty(); return; }

    const project = event.cwd ? path.basename(event.cwd) : 'default';

    await backend.init({ project, skipEmbedder: true });
    const queryText = context.join(' ');
    const { topK, minScore } = brainConfig.getRetrievalFast();
    const entries = await backend.search(queryText, { topK, minScore });

    if (entries.length === 0) {
      emitJson({ found: 0 });
      return;
    }

    const message = formatEntries(entries);

    // Persist retrieval for the Stop-hook citation matcher (Plan #1).
    // Best-effort — never fail the hook if journal write errors.
    try {
      const sid = event.session_id || event.sessionId || 'default';
      const retrievalId = retrievalJournal.newRetrievalId();
      retrievalJournal.appendEntry(sid, {
        retrievalId,
        ts: Date.now(),
        sid,
        tool: toolName,
        queryTokens: context.slice(0, 10),
        project,
        returnedIds: entries.map(e => e.id),
        returnedTitles: entries.map(e => e.title),
      });
    } catch (err) {
      console.error(`[BRAIN-RETRIEVE] journal append failed: ${err.message}`);
    }

    emitJson({
      found: entries.length,
      method: backend.getMode(),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
      entries: entries.map(e => ({ id: e.id, title: e.title, type: e.type, score: e.score })),
    });
  } catch (err) {
    console.error(`[BRAIN-RETRIEVE] Error: ${err.message}`);
    emitEmpty();
  }
})();
