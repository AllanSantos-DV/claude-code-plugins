#!/usr/bin/env node
/**
 * Correction Detect — UserPromptSubmit hook.
 *
 * Every 2 turns, reads the conversation transcript to extract the last
 * assistant response + current user message, and writes a payload with
 * the FULL TURN CONTEXT so the correction-analyzer agent can understand
 * what the assistant said and what the user is replying to.
 *
 * No regex detection — LLM does the judgment in the subagent.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const CORRECTIONS_DIR = path.join(PLUGIN_DATA, 'detect-corrections');

const DETECT_INTERVAL = 2;
const MAX_TRANSCRIPT_LINES = 6; // last 3 turns max

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });
}

function getTurnCount(sessionId) {
  const counterFile = path.join(CORRECTIONS_DIR, '.counter', `${sessionId.slice(0, 8)}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(counterFile, 'utf-8'));
    return (data.turn || 0) + 1;
  } catch {
    return 1;
  }
}

function saveTurnCount(sessionId, turn) {
  const dir = path.join(CORRECTIONS_DIR, '.counter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId.slice(0, 8)}.json`),
    JSON.stringify({ sessionId, turn }),
  );
}

/**
 * Reads the conversation transcript (JSONL format) to extract the last few turns.
 *
 * Format observed:
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
 *
 * Returns an array of { role, content } entries with extracted text content.
 */
function readTranscriptContext(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!raw) return [];

    const lines = raw.split('\n').filter(Boolean);
    const entries = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        // Only extract user and assistant messages
        if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
        if (!parsed.message || !parsed.message.content) continue;

        // Extract: text blocks as-is, tool_use blocks simplified to [Tool: name]
        const textContent = parsed.message.content
          .map(block => {
            if (block.type === 'text') return block.text;
            if (block.type === 'tool_use') return `[Tool: ${block.name || 'unknown'}]`;
            return null;
          })
          .filter(Boolean)
          .join('\n');

        if (!textContent) continue;

        entries.push({
          role: parsed.message.role,
          content: textContent,
        });
      } catch {
        continue;
      }
    }

    return entries.slice(-MAX_TRANSCRIPT_LINES);
  } catch {
    return [];
  }
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write(JSON.stringify({})); return; }

    const event = JSON.parse(raw);
    const userMessage = event.userMessage || '';
    const sessionId = event.sessionId || 'default';
    const transcriptPath = event.transcript_path || '';

    if (!userMessage) { process.stdout.write(JSON.stringify({})); return; }

    // Rate limit: every DETECT_INTERVAL turns
    const turn = getTurnCount(sessionId);
    saveTurnCount(sessionId, turn);
    if (turn % DETECT_INTERVAL !== 0) {
      process.stdout.write(JSON.stringify({ skipped: `turn_${turn}` }));
      return;
    }

    // Read transcript for full turn context
    const transcriptContext = readTranscriptContext(transcriptPath);

    const dir = CORRECTIONS_DIR;
    fs.mkdirSync(dir, { recursive: true });

    const payload = {
      version: 2,
      sessionId,
      turnNumber: turn,
      detectedAt: new Date().toISOString(),
      userMessage: userMessage.slice(0, 3000),
      transcriptContext, // { role, content }[] — last N entries
      transcriptPath,
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    };

    const filename = `correction-${sessionId.slice(0, 8)}-t${turn}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2));

    console.error(`[CORRECTION] Payload written at turn ${turn} (${transcriptContext.length} transcript entries)`);

    process.stdout.write(JSON.stringify({ turn, transcriptEntries: transcriptContext.length }));
  } catch (err) {
    console.error(`[CORRECTION] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
