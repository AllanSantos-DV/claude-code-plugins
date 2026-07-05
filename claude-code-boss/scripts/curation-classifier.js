'use strict';
/**
 * curation-classifier.js — Pure function deciding whether an observed command
 * output should trigger a curation payload, and which reason applies.
 *
 * No I/O. No side effects. Fully testable in isolation.
 *
 * Reasons:
 *   'needs-curation'        — uncurated command, output exceeded raw thresholds
 *   'curated-success-noisy' — curated script ran OK but output > summary thresholds
 *   'curated-failure-noisy' — curated script failed and output > raw thresholds
 *   null                    — no action needed
 */

/** Max lines a curated script should emit on success (entries without `outputLines`). */
const CURATED_SUCCESS_MAX_LINES = 3;
/** Max chars a curated script should emit on success (entries without `outputLines`/`outputChars`). */
const CURATED_SUCCESS_MAX_CHARS = 500;
/** Chars allowed per declared output line when the entry has `outputLines` but no `outputChars`. */
const CURATED_CHARS_PER_LINE = 100;

/**
 * Success budget for a curated shell entry. Content-surfacing scripts declare
 * `outputLines` (and optionally `outputChars`) in shells.json — that declared
 * budget is enforced instead of the tight summary defaults, otherwise every
 * legitimate run of such a script gets flagged curated-success-noisy.
 *
 * @param {{ outputLines?: number, outputChars?: number }|null|undefined} shell
 * @returns {{ maxLines: number, maxChars: number }}
 */
function successBudgetFor(shell) {
  const lines = Number.isFinite(shell?.outputLines) && shell.outputLines > 0 ? shell.outputLines : null;
  const chars = Number.isFinite(shell?.outputChars) && shell.outputChars > 0 ? shell.outputChars : null;
  return {
    maxLines: lines ?? CURATED_SUCCESS_MAX_LINES,
    maxChars: chars ?? (lines !== null ? lines * CURATED_CHARS_PER_LINE : CURATED_SUCCESS_MAX_CHARS),
  };
}

/**
 * Classify a PostToolUse / PostToolUseFailure event.
 *
 * @param {{ command: string, isCurated: boolean, isSuccess: boolean,
 *            charCount: number, lineCount: number,
 *            thresholds: { maxChars: number, maxLines: number },
 *            successBudget?: { maxChars: number, maxLines: number } }} params
 *   `successBudget` — per-shell curated-success budget (from successBudgetFor);
 *   omitted → the hardcoded summary defaults apply.
 * @returns {{ reason: string, threshold: object } | { reason: null }}
 */
function classify({ command: _command, isCurated, isSuccess, charCount, lineCount, thresholds, successBudget }) {
  if (isCurated) {
    const budget = successBudget || { maxLines: CURATED_SUCCESS_MAX_LINES, maxChars: CURATED_SUCCESS_MAX_CHARS };
    if (isSuccess && (lineCount > budget.maxLines || charCount > budget.maxChars)) {
      return {
        reason: 'curated-success-noisy',
        threshold: { maxChars: budget.maxChars, maxLines: budget.maxLines },
      };
    }
    if (!isSuccess && (charCount > thresholds.maxChars || lineCount > thresholds.maxLines)) {
      return { reason: 'curated-failure-noisy', threshold: thresholds };
    }
    return { reason: null };
  }

  // Uncurated
  if (charCount > thresholds.maxChars || lineCount > thresholds.maxLines) {
    return { reason: 'needs-curation', threshold: thresholds };
  }
  return { reason: null };
}

module.exports = { classify, successBudgetFor, CURATED_SUCCESS_MAX_LINES, CURATED_SUCCESS_MAX_CHARS, CURATED_CHARS_PER_LINE };
