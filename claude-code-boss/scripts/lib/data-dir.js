'use strict';
/**
 * data-dir.js — the ONE canonical resolver for the plugin data directory.
 *
 * Every hook/script writes runtime state under a data dir. Historically each
 * one inlined `process.env.CLAUDE_PLUGIN_DATA || <home fallback>`. That naive
 * form has a subtle split-brain bug: some hook-launch contexts do NOT expand
 * the `${CLAUDE_PLUGIN_DATA}` placeholder, so the env var arrives as the literal
 * string "${CLAUDE_PLUGIN_DATA}". The naive `env || fallback` then treats that
 * literal as a real directory — while the few scripts that already guarded
 * against `${` fell back to the home path. Result: some scripts read/write state
 * in a bogus "${CLAUDE_PLUGIN_DATA}" folder and others in the real one — the
 * plugin's state fragments across two locations.
 *
 * This module centralizes the guarded resolution so every consumer agrees.
 *
 * Phase 1 ("follow the app's active folder"): the env var alone is not enough —
 * many SessionStart hooks are launched WITHOUT a resolved CLAUDE_PLUGIN_DATA, so
 * a pure `env || fallback` still fragments (env-aware processes land in the real
 * folder, env-less ones in the bare home fallback). To close that, the ONE
 * process that always receives the real active folder (the brain-server, via
 * `--plugin-data`) publishes it to a stable GLOBAL pointer, and every env-less
 * caller FOLLOWS that pointer. Resolution order: real env → published pointer →
 * cheap most-recently-written bootstrap → bare home fallback.
 *
 * Contract: this module is required at module-load by many hooks, so it must
 * stay CHEAP (no SQLite, no network, no heavy deps — path/os/fs only) and MUST
 * NOT throw (every filesystem touch is fail-open).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME_FALLBACK = () =>
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

/**
 * The stable GLOBAL home for cross-folder-invariant state (the backend-choice
 * config + the active-data-dir pointer). Unlike the data dir — which varies per
 * install folder / marketplace suffix — this is a single "top-zero" location
 * every process agrees on regardless of how it was launched.
 * @returns {string}
 */
function globalDir() {
  return path.join(os.homedir(), '.claude', 'claude-code-boss');
}

/**
 * A CLAUDE_PLUGIN_DATA env value is only usable when it's a non-blank string
 * that isn't an unexpanded `${...}` placeholder. Otherwise callers must fall
 * back so state doesn't scatter into a literal-placeholder / bogus directory.
 * @param {*} v
 * @returns {string|null} the value when usable, else null
 */
function validEnvDir(v) {
  return typeof v === 'string' && v.trim().length > 0 && !v.includes('${') ? v : null;
}

/** Path of the JSON pointer that records the app's currently-active data dir. */
function activePointerPath() {
  return path.join(globalDir(), 'active-data-dir.json');
}

// Tear-free write: unique temp sibling + rename. Inlined here (not lib/atomic-
// write.js) so this hot, module-load-critical resolver stays dependency-light
// (path/os/fs only). rename(2) can fail TRANSIENTLY on Windows under the
// SessionStart hook fan-out (MoveFileEx sharing violation → EPERM/EACCES/EBUSY);
// retry those a bounded number of times so a contended pointer publish isn't
// dropped. Never called on the read path.
const _TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function _writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try {
    for (let attempt = 1; ; attempt++) {
      try { fs.renameSync(tmp, file); return; }
      catch (err) {
        if (attempt >= 20 || !_TRANSIENT_RENAME.has(err && err.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(2 * attempt, 25));
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { void e; /* orphan temp already gone */ }
    throw err;
  }
}

/**
 * SQLite-free proxy for "how much KB data lives under `dir`": the total bytes of
 * every `dir/brain/<*>/brain.db`. A richer store (more entries + their embeddings)
 * is a materially bigger file, so this cheaply distinguishes the live folder from
 * a near-empty stray WITHOUT opening SQLite (this module must stay dependency-light
 * — path/os/fs only). Fail-open: any error → 0 (treated as "no data here").
 * @param {string} dir
 * @returns {number} total brain.db bytes under dir/brain
 */
function pointerWeight(dir) {
  let total = 0;
  try {
    const brain = path.join(dir, 'brain');
    for (const n of fs.readdirSync(brain)) {
      try {
        const st = fs.statSync(path.join(brain, n, 'brain.db'));
        if (st.isFile()) total += st.size;
      } catch (err) { void err; /* no brain.db in this shard */ }
    }
  } catch (err) { void err; /* no brain/ dir → weightless */ }
  return total;
}

/**
 * Best-effort publish of the active data dir so env-less callers (SessionStart
 * hooks that don't receive CLAUDE_PLUGIN_DATA) can FOLLOW the SAME folder the
 * env-aware processes (brain-server / hooks that DO get it) resolved. Atomic and
 * fail-open — never throws, never blocks the caller.
 *
 * ANTI-REGRESSION GUARD (kills the "apparent memory loss"): never move the pointer
 * from a HEAVIER live folder to a LIGHTER one. When two install identities race to
 * publish (each brain-server republishes on startup), the one whose brain.db
 * actually holds the data wins, so env-less callers (brain_count / brain_search)
 * always resolve the rich KB instead of a near-empty stray — the exact split-brain
 * symptom where the pointer flipped to a 1-entry folder and recall read "1".
 * @param {string} dir
 */
function writeActivePointer(dir) {
  if (typeof dir !== 'string' || dir.trim().length === 0) return;
  try {
    const existing = readActivePointer(); // resolved dir that STILL EXISTS, or null
    if (existing && path.resolve(existing) !== path.resolve(dir)
        && pointerWeight(existing) > pointerWeight(dir)) {
      return; // don't regress the pointer onto a lighter (near-empty) folder
    }
    _writeJsonAtomic(activePointerPath(), { dir, ts: Date.now() });
  } catch (err) {
    // Advisory pointer only: another concurrent writer publishing the SAME dir
    // will have won, so a lost race is harmless. Log once, never propagate.
    console.error(`[data-dir] could not publish active-data-dir pointer: ${err.message}`);
  }
}

/**
 * Read the active-data-dir pointer. Returns the recorded dir ONLY when it is a
 * usable non-empty string pointing at a directory that still exists; otherwise
 * null (missing file / corrupt JSON / stale dir). Never throws.
 * @returns {string|null}
 */
function readActivePointer() {
  const p = activePointerPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    void err; // no pointer file yet — the common cold-start case (ENOENT)
    return null;
  }
  let dir;
  try {
    const parsed = JSON.parse(raw);
    dir = parsed && parsed.dir;
  } catch (err) {
    console.error(`[data-dir] ignoring corrupt active-data-dir pointer (${p}): ${err.message}`);
    return null;
  }
  if (typeof dir !== 'string' || dir.trim().length === 0) return null;
  try {
    if (!fs.existsSync(dir)) return null; // stale pointer → ignore, let bootstrap re-pick
  } catch (err) {
    void err; // unreadable path → treat as absent
    return null;
  }
  return dir;
}

/**
 * Cheap bootstrap (NO SQLite): among `~/.claude/plugins/data/claude-code-boss*`
 * dirs that already contain a `brain/` subdir, pick the one whose `brain/` was
 * written MOST recently (mtime) — i.e. the live install. Only names matching
 * `^claude-code-boss` are considered, so unrelated siblings (codex-inline,
 * rf-reviewer-*, other plugins) never win. Returns null when nothing qualifies.
 * @returns {string|null}
 */
function bootstrapMostRecent() {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'data');
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (err) {
    void err; // base doesn't exist yet — fresh machine
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const n of entries) {
    if (!/^claude-code-boss/.test(n)) continue;
    const brainDir = path.join(base, n, 'brain');
    try {
      const st = fs.statSync(brainDir);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = path.join(base, n); }
    } catch (err) {
      void err; // no brain/ here → not a live data dir, skip
    }
  }
  return best;
}

/**
 * Resolve the plugin data directory so EVERY entry point agrees on ONE folder.
 * Order (all steps fail-open, never throw):
 *   1. a real CLAUDE_PLUGIN_DATA — also publish it so env-less callers follow;
 *   2. the published active-data-dir pointer (the app's live folder);
 *   3. a cheap most-recently-written `claude-code-boss*` bootstrap (then pin it);
 *   4. the stable bare home fallback.
 * @returns {string}
 */
function dataDir() {
  const env = validEnvDir(process.env.CLAUDE_PLUGIN_DATA);
  if (env) { writeActivePointer(env); return env; }
  const ptr = readActivePointer();
  if (ptr) return ptr;
  const boot = bootstrapMostRecent();
  if (boot) { writeActivePointer(boot); return boot; }
  return HOME_FALLBACK();
}

module.exports = {
  dataDir,
  validEnvDir,
  globalDir,
  activePointerPath,
  readActivePointer,
  writeActivePointer,
  bootstrapMostRecent,
};
