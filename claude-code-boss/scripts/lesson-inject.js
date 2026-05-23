#!/usr/bin/env node
/**
 * Lesson Inject + Pattern Detect — UserPromptSubmit hook that:
 * 1. Injects relevant lessons into context from pattern-analyzer's native agent memory
 * 2. Detects pending pattern-analysis payloads and signals octopus to run
 *
 * Reads from ~/.claude/agent-memory/pattern-analyzer/ — the subagent's native memory.
 * No custom storage layer, no JSON schemas. Uses Claude Code's built-in agent memory.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
function _loadHooksCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'hooks-config.json'), 'utf-8')); } catch { return {}; }
}
const _HOOKS_CFG = _loadHooksCfg();
const LESSON_MAX_RESULTS = _HOOKS_CFG.lessonInject?.maxLessons ?? 5;

// Read lessons from both pattern-analyzer and correction-analyzer agent memories
const AGENT_MEMORY_DIRS = [
  path.join(HOME, '.claude', 'agent-memory', 'pattern-analyzer'),
  path.join(HOME, '.claude', 'agent-memory', 'correction-analyzer'),
];
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');
const DETECT_DIR = path.join(PLUGIN_DATA, 'detect');
const CORRECTIONS_DIR = path.join(PLUGIN_DATA, 'detect-corrections');
const CURATION_DIR = path.join(PLUGIN_DATA, 'detect-curation');
const REFINE_DIR = path.join(PLUGIN_DATA, 'detect-refine');
const MARKER_DIR = path.join(PLUGIN_DATA, '.markers');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'also', 'and', 'but', 'or', 'if',
  'because', 'about', 'up', 'down', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Read all markdown content from all agent memory dirs.
 * Reads MEMORY.md + all topic .md files from pattern-analyzer and correction-analyzer.
 * Returns [{file, content}].
 */
function loadMemoryFiles() {
  const results = [];
  for (const dir of AGENT_MEMORY_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const agentName = path.basename(dir);
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf-8');
          results.push({ file: `${agentName}/${f}`, content });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return results;
}

/**
 * Score a memory file's content against query tokens.
 * Returns top lines (rules) that match.
 */
function findRelevantLines(query, maxResults = LESSON_MAX_RESULTS) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const files = loadMemoryFiles();
  const scored = [];

  for (const { file, content } of files) {
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
      if (score > 0) {
        scored.push({ file, line: line.trim(), score });
      }
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function countPendingDetections() {
  return countPendingFiles(DETECT_DIR, 'detect-');
}

function countPendingFiles(dir, prefix) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .length;
  } catch {
    return 0;
  }
}

function countTotalLessons() {
  let count = 0;
  for (const dir of AGENT_MEMORY_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        count += (content.match(/- \*\*Rule\*\*/g) || []).length;
      }
    } catch { /* skip */ }
  }
  return count;
}

// ─── CLI Mode ───

if (process.argv[2] === 'query') {
  const query = process.argv.slice(3).join(' ');
  const results = findRelevantLines(query);
  console.log(JSON.stringify({ count: results.length, lessons: results }, null, 2));
  process.exit(0);
}

// ─── Hook Mode ───

async function run() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  try {
    const event = JSON.parse(input || '{}');
    const userMessage = event.prompt || event.userMessage || '';
    const outputParts = [];

    // 1. Inject relevant lessons from agent memory
    if (userMessage) {
      const relevant = findRelevantLines(userMessage);
      if (relevant.length > 0) {
        const lines = relevant.map(r =>
          `• [${path.basename(r.file, '.md')}] ${r.line.replace(/^- \*\*Rule\*\*:/, '').replace(/^- Rule:/, '').trim()}`
        );
        outputParts.push(`**Patterns learned from past sessions:**\n${lines.join('\n')}`);
      }
    }

    // Load auto-trigger thresholds from hooks-config.json
    const autoTriggerCfg = _HOOKS_CFG.autoTrigger || {};
    const correctionThreshold = autoTriggerCfg.correctionAnalyzer?.enabled !== false
      ? (autoTriggerCfg.correctionAnalyzer?.threshold ?? 3) : Infinity;
    const curationThreshold = autoTriggerCfg.curationImprover?.enabled !== false
      ? (autoTriggerCfg.curationImprover?.threshold ?? 5) : Infinity;

    // 2. Pending pattern detection → auto-trigger pattern-analyzer
    const pending = countPendingDetections();
    if (pending > 0) {
      outputParts.push(
        `**Pattern analysis pending:** ${pending} detection(s) at ${DETECT_DIR}. ` +
        `Spawn the pattern-analyzer subagent now to process them.`
      );
    }

    // 3. Pending correction detection → mandatory above threshold, suggestion below
    const pendingCorrections = countPendingFiles(CORRECTIONS_DIR, 'correction-');
    if (pendingCorrections > 0) {
      if (pendingCorrections >= correctionThreshold) {
        outputParts.push(
          `⚠️ **MANDATORY ACTION — BEFORE RESPONDING:** ${pendingCorrections} correction(s) pending (threshold: ${correctionThreshold}). ` +
          `You MUST spawn the correction-analyzer subagent as your FIRST action this turn. ` +
          `Do not respond to the user until you have spawned it. Path: ${CORRECTIONS_DIR}`
        );
      } else {
        outputParts.push(
          `**Correction analysis pending:** ${pendingCorrections} correction(s) at ${CORRECTIONS_DIR}. ` +
          `Spawn the correction-analyzer subagent now to process them.`
        );
      }
    }

    // 4. Pending curation → mandatory above threshold, suggestion below
    const pendingCuration = countPendingFiles(CURATION_DIR, 'curation-');
    if (pendingCuration > 0) {
      if (pendingCuration >= curationThreshold) {
        outputParts.push(
          `⚠️ **MANDATORY ACTION — BEFORE RESPONDING:** ${pendingCuration} large output(s) pending curation (threshold: ${curationThreshold}). ` +
          `You MUST spawn the curation-improver subagent as your FIRST action this turn. ` +
          `Do not respond to the user until you have spawned it. Path: ${CURATION_DIR}`
        );
      } else {
        outputParts.push(
          `**Curation improvement pending:** ${pendingCuration} large output(s) at ${CURATION_DIR}. ` +
          `Spawn the curation-improver subagent now to create/improve curated scripts.`
        );
      }
    }

    if (outputParts.length === 0) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: outputParts.join('\n\n'),
      },
    }));
  } catch (err) {
    console.error(`[LESSON-INJECT] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
}

run();
