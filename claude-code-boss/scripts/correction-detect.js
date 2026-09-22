#!/usr/bin/env node
/**
 * correction-detect.js — UserPromptSubmit hook (lean signal + advisory).
 *
 * DESIGN (in-loop capture): when the user's message looks like a correction, nudge
 * the in-loop agent — who has full context — to call the `capture_lesson` MCP tool
 * with a CURATED summary. We do NOT read the transcript or write bloated payloads
 * here (that was the old, expensive, lossy path). The agent writes the lesson; the
 * tool dedups/merges it (bumping recurrence). The agent is the judge — this is just
 * a cheap heuristic nudge, so false positives are harmless.
 */
'use strict';

// Cheap correction-signal cues (pt-BR + en). Errs toward nudging; the agent judges.
const SIGNALS = [
  /\bn[ãa]o\s+(é|era|faz|deveria|precisa|usa|assim)\b/i,
  /\b(na verdade|ao inv[ée]s|em vez|deveria ter|era pra|t[áa] errado|isso est[áa] errado|corrig|p[óo]e|n[ãa]o foi isso)\b/i,
  /\b(actually|you should have|that'?s wrong|incorrect|not what i|instead of|don'?t|no,|wrong)\b/i,
  /\b(espera|para,|pera|opa,)\b/i,
];

function looksLikeCorrection(msg) {
  if (!msg || msg.length < 3) return false;
  return SIGNALS.some(re => re.test(msg));
}

const { runSideEffectTextCli } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');
const hooksCfg = require('./lib/hooks-config.js');

const NUDGE_TEXT =
  'The user may be correcting you. If so — and only if a generalizable lesson ' +
  'exists — call the `capture_lesson` MCP tool with a curated {title, summary, ' +
  'detail} (what you did, what was wrong, the rule to follow next time). You have ' +
  'the full context; do not over-capture trivial back-and-forth.';

/**
 * Pure detector entry point. Returns the nudge text (string) when the prompt
 * looks like a correction, or `null` otherwise. Shared by the standalone CLI
 * (below) and `user-prompt-submit-dispatcher.js`.
 * @param {object} event
 * @returns {string|null}
 */
function run(event) {
  if (!hooksCfg.getCorrectionDetect().enabled) return null;
  const msg = (event && (event.prompt || event.userMessage || event.text)) || '';
  if (!looksLikeCorrection(msg)) return null;
  metrics.fire('nudge.emitted', { kind: 'correction' }, { sessionId: event.session_id || event.sessionId, cwd: event.cwd });
  return NUDGE_TEXT;
}

if (require.main === module) {
  runSideEffectTextCli(run, 'correction-detect', 'UserPromptSubmit');
}

module.exports = { looksLikeCorrection, run };
