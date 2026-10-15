#!/usr/bin/env node
/**
 * Runtime Sweep — SessionStart detector.
 *
 * `.runtime/` holds per-turn journals and per-session state. A journal is read by listing the whole directory, and the one
 * written for a Stop detector that the profile switches off is never drained: the `standard` profile left tens of thousands
 * of `turn-verify-*` files behind, and every Stop paid a directory listing of all of them. This keeps the directory bounded.
 */
const fs = require('fs');
const path = require('path');

const { sweepStaleJournals } = require('./lib/session-journal.js');
const { dataDir } = require('./lib/data-dir.js');

const DAY_MS = 86400000;
const STATE_TTL_MS = 7 * DAY_MS;
// Per-session state files nobody removes when the session ends (no timestamp in the name: age by mtime).
const STATE_PREFIXES = ['session-start-', 'session-summary-', 'skill-outcome-settled-', 'research-followup-'];

/** Delete per-session state files older than `maxAgeMs`; returns how many went. */
function sweepSessionState(dir, maxAgeMs = STATE_TTL_MS, now = Date.now()) {
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!STATE_PREFIXES.some((p) => f.startsWith(p))) continue;
    try {
      if (now - fs.statSync(path.join(dir, f)).mtimeMs > maxAgeMs) { fs.unlinkSync(path.join(dir, f)); removed++; }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[runtime-sweep] ${f}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Side effect only; the dispatcher discards the result. Never throws.
 * @returns {Promise<{journals: object, state: number}|null>}
 */
async function run() {
  const dir = path.join(dataDir(), '.runtime');
  try {
    const journals = sweepStaleJournals({ dir });
    if (journals.truncated || journals.failed) console.error(`[runtime-sweep] journals: removed ${journals.removed}, failed ${journals.failed}${journals.truncated ? ', more left for the next session' : ''}`);
    return { journals, state: fs.existsSync(dir) ? sweepSessionState(dir) : 0 };
  } catch (err) {
    console.error(`[runtime-sweep] ${err.message}`);
    return null;
  }
}

module.exports = { run, sweepSessionState };
