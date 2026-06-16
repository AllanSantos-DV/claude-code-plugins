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

const { readStdin } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write('{}'); return; }
    let event;
    try { event = JSON.parse(raw); } catch { /* malformed stdin → no-op */ process.stdout.write('{}'); return; }
    const msg = event.prompt || event.userMessage || event.text || '';

    if (!looksLikeCorrection(msg)) { process.stdout.write('{}'); return; }

    metrics.fire('nudge.emitted', { kind: 'correction' }, { sessionId: event.session_id || event.sessionId, cwd: event.cwd });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'The user may be correcting you. If so — and only if a generalizable lesson ' +
          'exists — call the `capture_lesson` MCP tool with a curated {title, summary, ' +
          'detail} (what you did, what was wrong, the rule to follow next time). You have ' +
          'the full context; do not over-capture trivial back-and-forth.',
      },
    }));
  } catch {
    // best-effort hook — never block the prompt
    process.stdout.write('{}');
  }
})();
