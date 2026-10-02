#!/usr/bin/env node
/**
 * active-research-detect.js — UserPromptSubmit hook (Plan #4 MVP).
 *
 * Heuristic detector that nudges the agent to call `research_query` BEFORE
 * answering when the prompt mentions an external lib / integration / version
 * / best-practice question. Throttled per-session + per-query cooldown.
 *
 * Hooks can't invoke MCP tools directly; we emit an `additionalContext` nudge
 * with a pre-formed query string so the agent calls research_query on the
 * SAME turn (cheaper than waiting for the next turn).
 *
 * Pure functions exported for tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { readStdin, parsePayload, emitEmpty, emitJson } = require('./lib/hook-io.js');
const hooksConfig = require('./lib/hooks-config.js');
const state = require('./lib/active-research-state.js');
const metrics = require('./lib/metrics.js');

const LIBS_FILE = path.join(__dirname, 'data', 'research-libs.json');

// ── Config defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  triggers: {
    libMention: true,
    versionMention: true,
    bestPracticeAsk: true,
    integrationMention: true,
    researchAsk: true,
  },
  maxPerSession: 3,
  cooldownMinutes: 60,
  depth: 'quick',
  fireThreshold: 1.0,
};

function loadConfig() {
  const cfg = hooksConfig.load();
  const ar = cfg.activeResearch || {};
  return {
    enabled: ar.enabled !== false,
    triggers: { ...DEFAULTS.triggers, ...(ar.triggers || {}) },
    maxPerSession: Number.isInteger(ar.maxPerSession) && ar.maxPerSession > 0 ? ar.maxPerSession : DEFAULTS.maxPerSession,
    cooldownMinutes: Number.isFinite(ar.cooldownMinutes) && ar.cooldownMinutes > 0 ? ar.cooldownMinutes : DEFAULTS.cooldownMinutes,
    depth: ar.depth === 'thorough' ? 'thorough' : 'quick',
    fireThreshold: Number.isFinite(ar.fireThreshold) && ar.fireThreshold > 0 ? ar.fireThreshold : DEFAULTS.fireThreshold,
  };
}

// ── Lib list ──────────────────────────────────────────────────────────────

let _libsCache = null;
function loadLibs() {
  if (_libsCache) return _libsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(LIBS_FILE, 'utf-8'));
    _libsCache = Array.isArray(raw.libs) ? raw.libs : [];
  } catch { _libsCache = []; }
  return _libsCache;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let _libRegexCache = null;
function buildLibRegex(libs) {
  // Cache keyed by ARRAY REFERENCE (loadLibs reassigns a fresh array on reload, so
  // this is safe); an in-place-mutated libs array would return a stale regex.
  if (_libRegexCache && _libRegexCache.k === libs) return _libRegexCache.re;
  // Empty lib list → a NEVER-matching regex, not an empty alternation `(?:)` which
  // matches almost any punctuated prompt (fail-open) and would nudge every turn.
  // A lib name that is part of a path or an identifier (`\claude-code`, `x.node`,
  // `my_docker`) is not a mention of the lib — U9: `C:\…\claude-code` fired as "Claude".
  const re = libs.length
    ? new RegExp(`(?:^|[^a-z0-9\\\\/._-])(?:${libs.map(escapeRegex).sort((a, b) => b.length - a.length).join('|')})(?=$|[^a-z0-9\\\\/._-])`, 'i')
    : /(?!x)x/; // matches nothing
  _libRegexCache = { k: libs, re };
  return re;
}

// ── Signal detectors (pure) ───────────────────────────────────────────────

const VERSION_RE = /\b(?:v\d+(?:\.\d+){0,2}|version\s+\d+(?:\.\d+){0,2}|@\d+(?:\.\d+){0,2})\b/i;
const BEST_PRACTICE_RE = /\b(?:qual a melhor|melhor forma|melhor maneira|best practice|best way|how (?:do|to|should) i|recommended way|what(?:'?s| is)? the (?:best|proper|right))\b/i;
const INTEGRATION_RE = /\b(?:integrar com|integrate with|connect(?:ing)? to|set\s?up\s+a?\s*webhook|webhook(?:s)?|api de|sdk de|wire (?:up|in))\b/i;
// An EXPLICIT research ask — the strongest signal (U9: 43 of 1,365 real prompts,
// mostly genuine). Not inside a path/identifier (`research-followup-detect.js`).
const RESEARCH_ASK_RE = /(?:^|[^a-z0-9\\/._-])(?:pesquis[ae]\w*|fa[cç]a uma pesquisa|research(?:e|ing)?|procur[ae] na (?:internet|web)|busque na (?:internet|web)|search the web|look (?:it )?up online|estado da arte)(?=$|[^a-z0-9\\/._-])/i;

// Weights (U9, measured on 1,365 real human prompts): a lib mention ALONE fired 66
// of 75 nudges and was almost never a research ask ("verifica o docker", "faz o
// fetch", "roda o claude plugin update"); lib + version was the same noise (a `v1`
// in a file name). A lib or a version is context, not a request: they only fire
// together with an ask (best-practice / integration).
function detectSignals(text, triggers) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  if (triggers.libMention) {
    const re = buildLibRegex(loadLibs());
    const m = text.match(re);
    if (m) out.push({ kind: 'libMention', weight: 0.5, match: m[0].trim() });
  }
  if (triggers.versionMention && VERSION_RE.test(text)) {
    out.push({ kind: 'versionMention', weight: 0.4 });
  }
  if (triggers.bestPracticeAsk && BEST_PRACTICE_RE.test(text)) {
    out.push({ kind: 'bestPracticeAsk', weight: 0.7 });
  }
  if (triggers.integrationMention && INTEGRATION_RE.test(text)) {
    out.push({ kind: 'integrationMention', weight: 0.8 });
  }
  if (triggers.researchAsk && RESEARCH_ASK_RE.test(text)) {
    out.push({ kind: 'researchAsk', weight: 1.0 });
  }
  return out;
}

function shouldFire(signals, threshold = 1.0) {
  const total = (signals || []).reduce((s, x) => s + (x.weight || 0), 0);
  return total >= threshold;
}

/**
 * Reduce a prompt to a stable, short research query string.
 * - strip code fences / URLs / mentions
 * - take first sentence
 * - lowercase + collapse whitespace
 * - cap 120 chars
 * Used as cooldown key AND as the query suggestion in the nudge.
 */
function normalizeQuery(prompt) {
  if (!prompt) return '';
  let t = String(prompt);
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`[^`]*`/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/@\w+/g, ' ');
  const firstSentence = t.split(/[.?!\n]/)[0] || t;
  return firstSentence
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatNudge(query, signals, depth) {
  const kinds = signals.map(s => s.kind).join(', ');
  return [
    '## Active research suggestion',
    `Your prompt has signals that external research will help (**${kinds}**).`,
    `Before answering, consider calling:`,
    '',
    '```',
    `research_query({ query: ${JSON.stringify(query)}, depth: ${JSON.stringify(depth)} })`,
    '```',
    '',
    'After researching, persist the findings so the next similar query reuses them:',
    '',
    '```',
    `capture_lesson({ type: 'research', title: <short>, summary: <one-line>, detail: <findings + sources>, tags: ['research', <area>] })`,
    '```',
    '',
    'Skip if you already know the answer cold. One trigger per turn; throttled per session.',
  ].join('\n');
}

// ── Main (hook entry) ─────────────────────────────────────────────────────

/**
 * Pure detector entry point. Returns the research-nudge text (string) when
 * warranted, or `null` otherwise. Shared by the standalone CLI (below) and
 * `user-prompt-submit-dispatcher.js`.
 * @param {object} ev
 * @returns {string|null}
 */
function run(ev) {
  if (!ev) return null;

  const cfg = loadConfig();
  if (!cfg.enabled) return null;

  const prompt = ev.prompt || ev.userMessage || ev.text || '';
  if (!prompt) return null;
  if (require('./lib/prompt-kind.js').isSyntheticPrompt(prompt)) return null; // not the user asking

  const sid = ev.session_id || ev.sessionId || 'default';

  if (state.getSessionCount(sid) >= cfg.maxPerSession) return null;

  const signals = detectSignals(prompt, cfg.triggers);
  if (!shouldFire(signals, cfg.fireThreshold)) return null;

  const query = normalizeQuery(prompt);
  if (!query) return null;

  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  if (state.isCoolingDown(query, cooldownMs)) return null;

  state.recordFire(sid, query);

  metrics.fire('nudge.emitted', {
    kind: 'research',
    signals: signals.map(s => s.kind),
    queryLen: query.length,
  }, { sessionId: sid, cwd: ev.cwd });

  return formatNudge(query, signals, cfg.depth);
}

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw);
  const text = ev ? run(ev) : null;
  if (text) {
    return emitJson({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
  }
  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[active-research-detect] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = {
  detectSignals,
  shouldFire,
  normalizeQuery,
  formatNudge,
  loadLibs,
  buildLibRegex,
  DEFAULTS,
  run,
};
