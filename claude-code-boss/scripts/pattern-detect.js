#!/usr/bin/env node
/**
 * Pattern Detect — Stop hook that captures transcript excerpts for pattern analysis.
 *
 * Runs after each Claude response (every 4 turns). Reads the transcript JSONL
 * and extracts cleaned-up conversation context (text + tool names, no raw tool
 * call data) for the pattern-analyzer subagent.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const DETECT_DIR = path.join(DATA_DIR, 'detect');
const COUNTER_DIR = path.join(DATA_DIR, '.counters');

function loadHooksCfg() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(PLUGIN_ROOT, 'config', 'hooks-config.json'), 'utf-8'));
  } catch (err) {
    console.error(`[PATTERN-DETECT] Failed to load hooks-config.json: ${err.message}`);
    return {};
  }
}
const _hcfg = loadHooksCfg().patternDetect || {};
const DETECT_INTERVAL = _hcfg.detectInterval ?? 4;
const MAX_TRANSCRIPT_LINES = _hcfg.maxTranscriptLines ?? 10;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Reads and cleans the transcript JSONL — text blocks as-is,
 * tool_use blocks simplified to [Tool: name].
 */
function readTranscriptContext(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!raw) return [];

    const entries = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
        if (!parsed.message || !parsed.message.content) continue;

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
      } catch { continue; }
    }

    return entries.slice(-MAX_TRANSCRIPT_LINES);
  } catch {
    return [];
  }
}

// ─── Main ───

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const event = JSON.parse(raw);

    if (event.hook_event_name && event.hook_event_name !== 'Stop') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const sessionId = event.session_id || event.sessionId || 'default';
    const transcriptPath = event.transcript_path || '';

    // Turn counter
    if (!fs.existsSync(COUNTER_DIR)) fs.mkdirSync(COUNTER_DIR, { recursive: true });
    const counterFile = path.join(COUNTER_DIR, `${sessionId.slice(0, 8)}.json`);
    let turnCount = 0;
    try {
      const data = JSON.parse(fs.readFileSync(counterFile, 'utf-8'));
      turnCount = data.turn || 0;
    } catch (err) { console.error(`[PATTERN-DETECT] Turn counter read error: ${err.message}`); }
    turnCount++;
    fs.writeFileSync(counterFile, JSON.stringify({ sessionId, turn: turnCount }));

    if (turnCount % DETECT_INTERVAL !== 0) {
      process.stdout.write(JSON.stringify({ skipped: `turn_${turnCount}` }));
      return;
    }

    if (!fs.existsSync(DETECT_DIR)) {
      fs.mkdirSync(DETECT_DIR, { recursive: true });
    }

    // Read cleaned transcript context
    const transcriptContext = readTranscriptContext(transcriptPath);
    const dialog = event.dialog || [];

    const payload = {
      version: 2,
      sessionId: sessionId || `ses_${crypto.randomUUID().slice(0, 12)}`,
      turnNumber: turnCount,
      detectedAt: new Date().toISOString(),
      transcriptContext,   // cleaned: text + [Tool: name] only
      dialog,              // raw dialog from event (fallback)
      transcriptPath,
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    };

    const filename = `detect-${sessionId.slice(0, 8)}-t${turnCount}.json`;
    fs.writeFileSync(path.join(DETECT_DIR, filename), JSON.stringify(payload, null, 2));

    console.error(`[PATTERN] Detection triggered at turn ${turnCount}`);

    process.stdout.write(JSON.stringify({ turn: turnCount }));
  } catch (err) {
    console.error(`[PATTERN] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
