/**
 * router-config-path.js — the single source of truth for the model-router's
 * per-user config location, plus its one-time migration + permission hardening.
 *
 * The router user-config holds the NVIDIA API key and the per-user routing
 * toggles, so — like the brain backend choice — it must be visible to EVERY
 * process that touches it (the dashboard writer, the SessionStart ensure hook,
 * and the running proxy) regardless of which data dir each one resolved. It
 * therefore lives at a STABLE GLOBAL path — globalDir()/model-router/
 * user-config.json — rather than under the volatile per-folder data dir, so
 * switching the plugin's data folder can never orphan the saved key/toggles
 * (the split-brain KB bug, applied to the router).
 *
 * ONLY user-config.json moves. The router's per-folder RUNTIME files
 * (state.json, metrics.json, .nudge-stamp, .announced-sessions.json,
 * router.token) intentionally stay under DATA_DIR/model-router/ — they are
 * per-folder runtime, not stable config.
 *
 * Every reader/writer imports from here so they can never disagree on the path.
 */
const fs = require('fs');
const path = require('path');

// Resolved on each call (not frozen at module load) so tests can repoint HOME/
// CLAUDE_PLUGIN_DATA and observe the new location. GLOBAL (home-based, not
// data-dir-scoped) so every process agrees on one file.
function routerUserConfigPath() {
  const { globalDir } = require('./data-dir.js');
  return path.join(globalDir(), 'model-router', 'user-config.json');
}

// Pre-Phase-1.5 location of the override (under the resolved active data dir).
// Retained only so backfillRouterUserConfig() can migrate it up exactly once.
function legacyRouterUserConfigPath() {
  const { dataDir } = require('./data-dir.js');
  return path.join(dataDir(), 'model-router', 'user-config.json');
}

// Best-effort owner-only (0600) permissions on the global key file. No-op /
// harmless on Windows; real hardening on POSIX. Never throws — a filesystem
// that rejects chmod just leaves the file at its default mode.
function hardenRouterConfigPerms(p) {
  try {
    fs.chmodSync(p, 0o600);
  } catch (err) {
    void err; // best-effort: chmod is unsupported on some platforms/filesystems
  }
}

// One-time backfill: if the global override doesn't exist yet but a legacy
// per-data-dir one does, copy it up so the user's saved key/toggles survive the
// Phase-1.5 move to the global path. Guarded by !exists so an existing global is
// never overwritten; only the resolved active data dir is consulted (no sibling
// scan). Fail-open — a failed backfill just means the reader sees no override
// yet, never a thrown error at SessionStart.
function backfillRouterUserConfig() {
  try {
    const globalPath = routerUserConfigPath();
    if (fs.existsSync(globalPath)) return;
    const legacyPath = legacyRouterUserConfigPath();
    if (!fs.existsSync(legacyPath)) return;
    const { writeFileAtomic } = require('./atomic-write.js');
    writeFileAtomic(globalPath, fs.readFileSync(legacyPath));
    hardenRouterConfigPerms(globalPath);
  } catch (err) {
    console.error(`[router-config] user-config backfill skipped: ${err.message}`);
  }
}

module.exports = {
  routerUserConfigPath,
  legacyRouterUserConfigPath,
  hardenRouterConfigPerms,
  backfillRouterUserConfig,
};
