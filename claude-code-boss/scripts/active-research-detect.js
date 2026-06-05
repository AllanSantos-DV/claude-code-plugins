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

const LIBS_FILE = path.join(__dirname, 'data', 'research-libs.json');

// ── Config defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  triggers: {
    libMention: true,
    versionMention: true,
    bestPracticeAsk: true,
    integrationMention: true,
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
  if (_libRegexCache && _libRegexCache.k === libs) return _libRegexCache.re;
  const alts = libs.map(escapeRegex).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?:^|[^a-z0-9])(?:${alts.join('|')})(?=$|[^a-z0-9])`, 'i');
  _libRegexCache = { k: libs, re };
  return re;
}

// ── Signal detectors (pure) ───────────────────────────────────────────────

const VERSION_RE = /\b(?:v\d+(?:\.\d+){0,2}|version\s+\d+(?:\.\d+){0,2}|@\d+(?:\.\d+){0,2})\b/i;
const BEST_PRACTICE_RE = /\b(?:qual a melhor|melhor forma|melhor maneira|best practice|best way|how (?:do|to|should) i|recommended way|what(?:'?s| is)? the (?:best|proper|right))\b/i;
const INTEGRATION_RE = /\b(?:integrar com|integrate with|connect(?:ing)? to|set\s?up\s+a?\s*webhook|webhook(?:s)?|api de|sdk de|wire (?:up|in))\b/i;

function detectSignals(text, triggers) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  if (triggers.libMention) {
    const re = buildLibRegex(loadLibs());
    const m = text.match(re);
    if (m) out.push({ kind: 'libMention', weight: 1.0, match: m[0].trim() });
  }
  if (triggers.versionMention && VERSION_RE.test(text)) {
    out.push({ kind: 'versionMention', weight: 0.5 });
  }
  if (triggers.bestPracticeAsk && BEST_PRACTICE_RE.test(text)) {
    out.push({ kind: 'bestPracticeAsk', weight: 0.7 });
  }
  if (triggers.integrationMention && INTEGRATION_RE.test(text)) {
    out.push({ kind: 'integrationMention', weight: 0.8 });
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
    'Skip if you already know the answer cold. One trigger per turn; throttled per session.',
  ].join('\n');
}

// ── Main (hook entry) ─────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  if (!raw) return emitEmpty();
  const ev = parsePayload(raw);
  if (!ev) return emitEmpty();

  const cfg = loadConfig();
  if (!cfg.enabled) return emitEmpty();

  const prompt = ev.prompt || ev.userMessage || ev.text || '';
  if (!prompt) return emitEmpty();

  const sid = ev.session_id || ev.sessionId || 'default';

  if (state.getSessionCount(sid) >= cfg.maxPerSession) return emitEmpty();

  const signals = detectSignals(prompt, cfg.triggers);
  if (!shouldFire(signals, cfg.fireThreshold)) return emitEmpty();

  const query = normalizeQuery(prompt);
  if (!query) return emitEmpty();

  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  if (state.isCoolingDown(query, cooldownMs)) return emitEmpty();

  state.recordFire(sid, query);

  return emitJson({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: formatNudge(query, signals, cfg.depth),
    },
  });
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
};
