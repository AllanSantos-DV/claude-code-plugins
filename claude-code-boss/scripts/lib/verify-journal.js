/**
 * verify-journal.js — append-only per-turn activity journal for the D2
 * verify-nudge (self-review).
 *
 * Records the two facts the verify detector needs at Stop:
 *   - `{ kind: 'edit', path, ts }`  — a file was edited (Edit/Write/NotebookEdit).
 *   - `{ kind: 'cmd', sig, curated, ts }` — a Bash command ran (sig = canonical
 *     signature; `curated` = matched curated-shell id/script or null).
 *
 * Same race-free pattern as turn-journal.js (one file per entry, no
 * read-modify-write, no locking), but a SEPARATE prefix so it never collides
 * with the curation turn-journal — and DIFFERENT read semantics: verify entries
 * have no (command,reason) identity, so read() keeps them all in chronological
 * order instead of deduping.
 *
 * Lifetime: the verify detector clears the journal every turn (Stop), so entries
 * describe "this turn" only.
 */
'use strict';

const { createJournal } = require('./session-journal.js');

// seqNames: same-millisecond appends keep their order (the tally is chronological);
// stampTs: every entry carries its ts.
const journal = createJournal({ prefix: 'turn-verify', label: 'verify-journal', seqNames: true, stampTs: true });
const { readEntries, clearEntries, RUNTIME_DIR } = journal;

/**
 * Record a file edit (Edit/Write/NotebookEdit).
 * @param {string} sessionId
 * @param {string} filePath
 */
function appendEdit(sessionId, filePath) {
  journal.appendEntry(sessionId, { kind: 'edit', path: String(filePath || '') });
}

/**
 * Record a Bash command that ran this turn.
 * @param {string} sessionId
 * @param {{ sig?: string, curated?: string|null }} info
 */
function appendCommand(sessionId, info = {}) {
  journal.appendEntry(sessionId, {
    kind: 'cmd',
    sig: String(info.sig || ''),
    curated: info.curated ? String(info.curated) : null,
  });
}

module.exports = { appendEdit, appendCommand, readEntries, clearEntries, RUNTIME_DIR };
