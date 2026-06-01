/**
 * session-id.js — sanitize Claude Code session IDs for use in filenames.
 *
 * Hooks receive `session_id` from CC; before interpolating into any filesystem
 * path it MUST be sanitized (path traversal + invalid chars).
 *
 * Convention: keep [a-zA-Z0-9_-], replace everything else with `_`, cap at 64.
 */

const MAX_LEN = 64;
const PATTERN = /[^a-zA-Z0-9_-]/g;

/**
 * @param {*} id  — raw session id from CC payload (any type tolerated)
 * @returns {string} — safe basename component
 */
function sanitizeSessionId(id) {
  return String(id == null ? 'default' : id).replace(PATTERN, '_').slice(0, MAX_LEN);
}

module.exports = { sanitizeSessionId };
