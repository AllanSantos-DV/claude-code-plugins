/**
 * text-utils.js — shared tokenization for retrievers/indexer.
 *
 * SINGLE SOURCE OF TRUTH for STOP_WORDS and extractKeywords.
 *
 * Drift between consumers was causing silent recall loss:
 * brain-index was tokenizing with `[^a-z0-9\s]` + minLen 3, but retrievers
 * used `[^a-z0-9\s/._-]` + minLen 4 — so words indexed under one regime
 * were never matched by queries under the other.
 */

const STOP_WORDS = new Set([
  // English
  'the', 'this', 'that', 'and', 'for', 'with', 'from', 'was', 'are',
  'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will', 'just',
  'been', 'were', 'they', 'them', 'their', 'what', 'when', 'where',
  'which', 'who', 'how', 'about', 'into', 'over', 'such', 'each',
  'than', 'then', 'these', 'those', 'also', 'very', 'because',
  'being', 'some', 'only',
  // Portuguese
  'para', 'que', 'com', 'uma', 'mais', 'mas', 'como', 'por',
  'dos', 'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
  // Domain noise (paths/tools that appear in nearly every command)
  'node', 'npm', 'npx', 'file', 'path', 'src', 'lib', 'test',
]);

/**
 * Extract searchable keywords from arbitrary text.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLen=3]    — minimum token length (inclusive)
 * @param {number} [opts.maxTokens=20] — cap on tokens returned
 * @param {boolean} [opts.allowPath=true] — preserve `/`, `.`, `_`, `-` inside tokens
 * @returns {string[]}
 */
function extractKeywords(text, opts = {}) {
  if (!text) return [];
  const minLen = Number.isInteger(opts.minLen) && opts.minLen > 0 ? opts.minLen : 3;
  const maxTokens = Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : 20;
  const allowPath = opts.allowPath !== false;
  const sanitizer = allowPath ? /[^a-z0-9\s/._-]/g : /[^a-z0-9\s]/g;
  return text.toLowerCase()
    .replace(sanitizer, ' ')
    .split(/\s+/)
    .filter(w => w.length >= minLen && !STOP_WORDS.has(w))
    .slice(0, maxTokens);
}

module.exports = { STOP_WORDS, extractKeywords };
