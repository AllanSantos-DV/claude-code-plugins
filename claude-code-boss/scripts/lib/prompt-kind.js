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

module.exports = { isSyntheticPrompt, SYNTHETIC_PREFIXES };
