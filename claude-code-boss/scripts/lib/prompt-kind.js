'use strict';
/**
 * lib/prompt-kind.js — tell a prompt the USER typed from one the harness made up.
 *
 * Claude Code delivers background-agent results as a UserPromptSubmit whose
 * prompt is a `<task-notification>…</task-notification>` block. The prompt
 * detectors treated it as the user talking: "the user may be correcting you",
 * research_query({query:"<task-notification>"}), and a KB recall over the agent's
 * report — noise injected once per finished background agent.
 */

const SYNTHETIC_PREFIXES = ['<task-notification>'];

/** @param {string} prompt @returns {boolean} true when the harness, not the user, wrote it */
function isSyntheticPrompt(prompt) {
  const p = String(prompt || '').trimStart();
  return SYNTHETIC_PREFIXES.some(prefix => p.startsWith(prefix));
}

// Turns a lesson must not be learned from: the orchestrator delegating work to a session
// (`<cross-session-message from-name="…orquestrador…">`) and the WhatsApp channel/mirror
// envelopes. They carry the orchestrator's instructions and the owner's relayed chat, not a
// correction this session received — captured as lessons they only pollute recall.
// Matched in the head of the turn (the envelope tag leads it, after at most a one-line preface).
const NON_LESSON_HEAD_CHARS = 600;
const NON_LESSON_PATTERNS = [
  /<cross-session-message\b[^>]*\bfrom-name="[^"]*(?:orquestrador|orchestrator|jarvis)/i,
  /<channel\b[^>]*\bsource="[^"]*whatsapp/i,
  /<whatsapp[-_ ]?mirror\b/i,
  /^\s*\[(?:whatsapp[-_ ])?mirror\]/i,
];

/** @param {string} text a user turn @returns {boolean} true when it is an orchestrator turn or a WhatsApp mirror/channel envelope */
function isOrchestratorOrMirrorTurn(text) {
  const head = String(text || '').slice(0, NON_LESSON_HEAD_CHARS);
  return NON_LESSON_PATTERNS.some(re => re.test(head));
}

module.exports = { isSyntheticPrompt, SYNTHETIC_PREFIXES, isOrchestratorOrMirrorTurn };
