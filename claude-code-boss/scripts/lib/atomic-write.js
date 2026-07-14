'use strict';
/**
 * atomic-write.js — tear-free file publication (unique-temp + rename).
 *
 * Many state stores are written with a plain `fs.writeFileSync(dest, JSON…)`.
 * That is NOT atomic: if the process dies mid-write, or two hook processes
 * write the same file at once (SessionStart fans out ~10 hooks in parallel, and
 * PostToolUse-Bash fans out 2 — see hooks.json), a reader can observe a
 * truncated/partial file. `JSON.parse` then throws and the store's catch resets
 * to empty — silent state loss.
 *
 * The fix is the classic write-to-unique-temp-then-rename dance:
 *   - rename(2) is atomic within a filesystem, so a concurrent reader sees
 *     EITHER the old file OR the fully-written new one — never a partial;
 *   - a per-(pid, monotonic counter, random) temp name means concurrent writers
 *     never clobber each other's TEMP file;
 *   - on ANY failure the destination is left untouched (old content survives);
 *   - on Windows a contended rename can throw EPERM/EACCES/EBUSY (MoveFileEx
 *     sharing violation); we retry those transient errors with a tiny backoff so
 *     a contended commit isn't silently dropped (see _renameWithRetry).
 *
 * SCOPE — what this does NOT do: it guarantees tear-free *publication*, not
 * serialized *read-modify-write*. Two writers that each `load → mutate → save`
 * the same file can still lose an update (both read the old state, the later
 * rename wins). For the snapshot stores that RMW a single file (oneoff-store,
 * cooldown-store, recall-health, active-research-state) this is a best-effort,
 * last-writer-wins residual — acceptable for advisory state, but a true fix
 * would need cross-process locking or a per-entry journal (as the turn/verify/
 * failure/retrieval journals already use). No fsync: not power-loss durable.
 */
const fs = require('fs');
const path = require('path');

let _counter = 0;

/**
 * Unique temp sibling path for an atomic write. Sibling (same dir) guarantees
 * the rename stays on the same filesystem, which is what makes it atomic.
 * @param {string} file destination path
 * @returns {string}
 */
function tempPathFor(file) {
  _counter = (_counter + 1) >>> 0;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${_counter.toString(36)}-${rnd}`;
}

// rename(2) can fail TRANSIENTLY on Windows when a concurrent writer/reader briefly
// holds the destination (MoveFileEx sharing violation → EPERM/EACCES/EBUSY). Under
// the SessionStart hook fan-out this is common; without a retry, a swallow-catch
// store would silently DROP the update. Retry a bounded number of times with a tiny
// synchronous backoff; a non-transient error (e.g. ENOSPC) surfaces immediately.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 20;

function _sleepMs(ms) {
  // Synchronous sleep without a busy-spin: block the thread on an unshared futex.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function _renameWithRetry(rename, tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try { rename(tmp, file); return; }
    catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME.has(err && err.code)) throw err;
      _sleepMs(Math.min(2 * attempt, 25));
    }
  }
}

/**
 * Atomically write `data` to `file` via a unique temp sibling + rename.
 * @param {string} file destination path
 * @param {string|Buffer} data payload
 * @param {{mkdirSync?:Function,writeFileSync?:Function,renameSync?:Function,unlinkSync?:Function}} [io]
 *        optional fs seam for tests (defaults to node `fs`)
 */
function writeFileAtomic(file, data, io) {
  const mkdir = (io && io.mkdirSync) || fs.mkdirSync;
  const write = (io && io.writeFileSync) || fs.writeFileSync;
  const rename = (io && io.renameSync) || fs.renameSync;
  const unlink = (io && io.unlinkSync) || fs.unlinkSync;

  mkdir(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  write(tmp, data);
  try {
    _renameWithRetry(rename, tmp, file);
  } catch (err) {
    // Commit failed: the destination is untouched. Best-effort cleanup of the
    // orphan temp, then surface the error to the caller.
    try { unlink(tmp); } catch { /* temp already gone */ }
    throw err;
  }
}

/**
 * `writeFileAtomic` with JSON serialization — the common case for state stores.
 * @param {string} file
 * @param {*} obj JSON-serializable value
 * @param {object} [io] optional fs seam (see writeFileAtomic)
 */
function writeJsonAtomic(file, obj, io) {
  writeFileAtomic(file, JSON.stringify(obj), io);
}

module.exports = { writeFileAtomic, writeJsonAtomic, tempPathFor };
