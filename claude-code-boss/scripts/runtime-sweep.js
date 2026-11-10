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
const { dataDir } = require('../engine/lib/data-dir.js');

const DAY_MS = 86400000;
const STATE_TTL_MS = 7 * DAY_MS;
// Per-session state files nobody removes when the session ends (no timestamp in the name: age by mtime).
const STATE_PREFIXES = ['session-start-', 'session-summary-', 'skill-outcome-settled-', 'research-followup-', 'held-prompt-'];
// Folders of per-session state where every file is one session's (a session that ended without SessionEnd leaves it).
const STATE_DIRS = ['read-burst'];

function removeIfOld(file, maxAgeMs, now) {
  try {
    if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); return 1; }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[runtime-sweep] ${file}: ${err.message}`);
  }
  return 0;
}

/** Delete per-session state files older than `maxAgeMs`; returns how many went. */
function sweepSessionState(dir, maxAgeMs = STATE_TTL_MS, now = Date.now()) {
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (STATE_PREFIXES.some((p) => f.startsWith(p))) removed += removeIfOld(path.join(dir, f), maxAgeMs, now);
  }
  for (const d of STATE_DIRS) {
    const sub = path.join(dir, d);
    let names = [];
    try { names = fs.readdirSync(sub); } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[runtime-sweep] ${sub}: ${err.message}`);
    }
    for (const f of names) if (f.endsWith('.json')) removed += removeIfOld(path.join(sub, f), maxAgeMs, now);
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
