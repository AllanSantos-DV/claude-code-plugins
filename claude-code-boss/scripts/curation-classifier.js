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

/** Max lines a curated script should emit on success. */
const CURATED_SUCCESS_MAX_LINES = 3;
/** Max chars a curated script should emit on success. */
const CURATED_SUCCESS_MAX_CHARS = 500;

/**
 * Classify a PostToolUse / PostToolUseFailure event.
 *
 * @param {{ command: string, isCurated: boolean, isSuccess: boolean,
 *            charCount: number, lineCount: number,
 *            thresholds: { maxChars: number, maxLines: number } }} params
 * @returns {{ reason: string, threshold: object } | { reason: null }}
 */
function classify({ command: _command, isCurated, isSuccess, charCount, lineCount, thresholds }) {
  if (isCurated) {
    if (isSuccess && (lineCount > CURATED_SUCCESS_MAX_LINES || charCount > CURATED_SUCCESS_MAX_CHARS)) {
      return {
        reason: 'curated-success-noisy',
        threshold: { maxChars: CURATED_SUCCESS_MAX_CHARS, maxLines: CURATED_SUCCESS_MAX_LINES },
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

module.exports = { classify, CURATED_SUCCESS_MAX_LINES, CURATED_SUCCESS_MAX_CHARS };
