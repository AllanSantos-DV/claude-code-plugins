'use strict';
/**
 * project-id.js — resolve the project identity the CLIENT stamps on every
 * memory operation (the handshake `projectId`, ingestion metadata, recall scope).
 *
 * The daemon scopes/searches by whatever projectId we send (it supports metadata
 * filtering + per-call override server-side), so getting recall to work across
 * machines/clones is purely a CLIENT concern: send a STABLE, user-chosen id
 * instead of the raw folder name, which changes per machine and can collide.
 *
 * Precedence (first hit wins):
 *   1. env CCB_PROJECT_ID        — force one id for the whole session/process
 *                                  (e.g. `CCB_PROJECT_ID=positiva claude`).
 *   2. .claude-boss-project file — a chosen name that lives IN the folder, found
 *                                  by walking up from cwd. Independent of git, of
 *                                  the folder name, and of the absolute path — you
 *                                  put `positiva` in the file and every hook in that
 *                                  tree sends `positiva`. Travels with the folder.
 *   3. basename(cwd)             — unchanged legacy default, so existing users
 *                                  (and the local SQLite backend) keep the exact
 *                                  same project keys with no override present.
 *
 * Pure + dependency-injected (env/fs) so it's deterministic to test.
 */
const fsDefault = require('fs');
const path = require('path');

const MARKER_FILE = '.claude-boss-project';
const MAX_WALK_UP = 8; // cap parent traversal so a stray cwd can't scan the whole disk
const MAX_LEN = 120;

/** Trim to a single clean line; drop control chars; cap length. Empty → ''. */
function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) || '';
  return firstLine.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LEN);
}

/**
 * Read the nearest `.claude-boss-project`, walking up from `startDir`.
 * @returns {string} sanitized chosen id, or '' if none found/readable.
 */
function readMarker(startDir, fs = fsDefault) {
  let dir = startDir;
  if (!dir || typeof dir !== 'string') return '';
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = path.join(dir, MARKER_FILE);
    try {
      if (fs.existsSync(candidate)) {
        const val = sanitize(fs.readFileSync(candidate, 'utf-8'));
        if (val) return val;
      }
    } catch (err) { void err; /* unreadable marker → keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return '';
}

/**
 * Resolve the project id for a given working directory.
 * @param {object} [opts]
 * @param {string} [opts.cwd]  the session's working directory
 * @param {object} [opts.env]  environment (defaults to process.env)
 * @param {object} [opts.fs]   fs impl (for tests)
 * @returns {string} the resolved project id (never empty; falls back to 'default')
 */
function resolveProjectId({ cwd, env = process.env, fs = fsDefault } = {}) {
  const forced = sanitize(env && env.CCB_PROJECT_ID);
  if (forced) return forced;

  const marker = cwd ? readMarker(cwd, fs) : '';
  if (marker) return marker;

  if (cwd && typeof cwd === 'string') {
    const base = path.basename(cwd);
    if (base) return base;
  }
  return 'default';
}

module.exports = { resolveProjectId, readMarker, sanitize, MARKER_FILE };
