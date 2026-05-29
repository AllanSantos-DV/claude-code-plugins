#!/usr/bin/env node
/**
 * brain-retrieve-prompt.js — UserPromptSubmit hook
 *
 * Single retrieval/advisory hook for the prompt step. Does:
 *   1. Brain: advisory if payloads pending indexing (capped count).
 *   2. Brain: semantic retrieval of relevant knowledge for the user message.
 *   3. Lessons: inject relevant rules from the analyzers' NATIVE agent memory
 *      (pattern-analyzer / correction-analyzer) — keyword match.
 *   4. Triggers: ADVISORY (never coercive) note when pattern/correction
 *      payloads are pending, gated by a cooldown for backpressure.
 *
 * Folds in the former lesson-inject.js. Tone is advisory: the hook informs,
 * the agent decides. No "MANDATORY"/"you MUST"/"FIRST action" language.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const backend = require('./brain-backend.js');

const HOME = os.homedir();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');
const DETECT_DIR = path.join(DATA_DIR, 'detect');
const CORRECTIONS_DIR = path.join(DATA_DIR, 'detect-corrections');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
const TRIGGER_STATE_FILE = path.join(RUNTIME_DIR, 'trigger-advisory-state.json');

// Backpressure: don't repeat trigger advisories every turn, and never display
// an unbounded backlog count.
const TRIGGER_COOLDOWN_TURNS = 3;
const COUNT_CAP = 20;

const AGENT_MEMORY_DIRS = [
  path.join(HOME, '.claude', 'agent-memory', 'pattern-analyzer'),
  path.join(HOME, '.claude', 'agent-memory', 'correction-analyzer'),
];

function _loadHooksCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'hooks-config.json'), 'utf-8'));
  } catch {
    return {};
  }
}
const LESSON_MAX_RESULTS = _loadHooksCfg().lessonInject?.maxLessons ?? 5;

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

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function countPendingFiles(dir, prefix) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function checkPendingPayloads() {
  if (!fs.existsSync(PENDING_DIR)) return 0;
  try {
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// ── Lessons: keyword match over the analyzers' native agent memory ────────────

function loadMemoryFiles() {
  const results = [];
  for (const dir of AGENT_MEMORY_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const agentName = path.basename(dir);
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
        try {
          results.push({ file: `${agentName}/${f}`, content: fs.readFileSync(path.join(dir, f), 'utf-8') });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return results;
}

function findRelevantLessons(query, maxResults = LESSON_MAX_RESULTS) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const scored = [];
  for (const { file, content } of loadMemoryFiles()) {
    const lines = content.split('\n').filter(l => {
      const t = l.trim();
      return t.startsWith('- **Rule**') || t.startsWith('- Rule') || t.startsWith('**Rule**');
    });
    for (const line of lines) {
      const lineTokens = tokenize(line);
      let score = 0;
      for (const qt of tokens) {
        for (const lt of lineTokens) {
          if (lt === qt) score += 3;
          else if (lt.startsWith(qt) || qt.startsWith(lt)) score += 1;
        }
      }
      if (score > 0) scored.push({ file, line: line.trim(), score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// ── Trigger advisory cooldown (backpressure) ──────────────────────────────────

function loadTriggerState() {
  try {
    if (!fs.existsSync(TRIGGER_STATE_FILE)) return { turnsSinceLast: TRIGGER_COOLDOWN_TURNS };
    return JSON.parse(fs.readFileSync(TRIGGER_STATE_FILE, 'utf-8'));
  } catch {
    return { turnsSinceLast: TRIGGER_COOLDOWN_TURNS };
  }
}

function saveTriggerState(state) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = TRIGGER_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, TRIGGER_STATE_FILE);
  } catch { /* best effort */ }
}

function fmtCount(n) {
  return n > COUNT_CAP ? `${COUNT_CAP}+` : String(n);
}

// ── main ──────────────────────────────────────────────────────────────────────

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

    // 2. Brain: semantic retrieval
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

    // 3. Lessons: inject relevant rules from native agent memory
    if (userMessage) {
      const relevant = findRelevantLessons(userMessage);
      if (relevant.length > 0) {
        const lines = relevant.map(r =>
          `• [${path.basename(r.file, '.md')}] ${r.line.replace(/^- \*\*Rule\*\*:?/, '').replace(/^- Rule:?/, '').trim()}`
        );
        outputs.push(`**Lessons from past sessions:**\n${lines.join('\n')}`);
      }
    }

    // 4. Triggers: ADVISORY only, gated by cooldown for backpressure
    const triggerState = loadTriggerState();
    if (triggerState.turnsSinceLast < TRIGGER_COOLDOWN_TURNS) {
      saveTriggerState({ ...triggerState, turnsSinceLast: (triggerState.turnsSinceLast || 0) + 1 });
    } else {
      const triggerNotes = [];
      const pendingPatterns = countPendingFiles(DETECT_DIR, 'detect-');
      if (pendingPatterns > 0) {
        triggerNotes.push(`${fmtCount(pendingPatterns)} workflow pattern(s) captured — run pattern-analyzer via Task if relevant.`);
      }
      const pendingCorrections = countPendingFiles(CORRECTIONS_DIR, 'correction-');
      if (pendingCorrections > 0) {
        triggerNotes.push(`${fmtCount(pendingCorrections)} user correction(s) captured — run correction-analyzer via Task if relevant.`);
      }
      if (triggerNotes.length > 0) {
        outputs.push(`**Learning (optional, your call):**\n${triggerNotes.map(n => `• ${n}`).join('\n')}`);
        saveTriggerState({ lastInjectedAt: new Date().toISOString(), turnsSinceLast: 0 });
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
