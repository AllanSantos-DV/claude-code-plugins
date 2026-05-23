'use strict';
/**
 * shells-config.js — Shared module for .vscode/shells.json access.
 *
 * Consumed by:  curation-guard.js (PreToolUse)
 *               curation-detect.js (PostToolUse / PostToolUseFailure)
 *
 * Exports: findProjectRoot, loadShellsConfig, matchCuratedShell
 *
 * Cache: process-level Map keyed by projectRoot string.
 * Hot path in PreToolUse — avoid repeated fs.readFileSync on the same project.
 */
const fs   = require('fs');
const path = require('path');

/** @type {Map<string, { shells: object[], whitelist: string[] }>} */
const _cache = new Map();

/**
 * Walk up from `cwd` to find the directory that contains `.vscode/shells.json`.
 * Returns the directory path, or null if not found within 10 levels.
 * @param {string} cwd
 * @returns {string|null}
 */
function findProjectRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.vscode', 'shells.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load (and cache) shells.json for the given project root.
 * Returns { shells: [], whitelist: [] } on any error — never throws.
 * @param {string|null} projectRoot
 * @returns {{ shells: object[], whitelist: string[] }}
 */
function loadShellsConfig(projectRoot) {
  if (!projectRoot) return { shells: [], whitelist: [] };
  if (_cache.has(projectRoot)) return _cache.get(projectRoot);

  try {
    const shellsPath = path.join(projectRoot, '.vscode', 'shells.json');
    if (!fs.existsSync(shellsPath)) {
      const result = { shells: [], whitelist: [] };
      _cache.set(projectRoot, result);
      return result;
    }
    const config = JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
    const result = { shells: config.shells || [], whitelist: config.whitelist || [] };
    _cache.set(projectRoot, result);
    return result;
  } catch (err) {
    console.error(`[SHELLS-CONFIG] Failed to parse shells.json: ${err.message}`);
    const result = { shells: [], whitelist: [] };
    _cache.set(projectRoot, result);
    return result;
  }
}

/**
 * Return the first shell entry whose `command` (or alias) is a prefix of `command`.
 * @param {string} command
 * @param {object[]} shells
 * @returns {object|null}
 */
function matchCuratedShell(command, shells) {
  const trimmed = command.trim();
  for (const shell of shells) {
    if (!shell.command) continue;
    if (trimmed.startsWith(shell.command.trim())) return shell;
    if (Array.isArray(shell.aliases)) {
      for (const a of shell.aliases) {
        if (trimmed.startsWith(a.trim())) return shell;
      }
    }
  }
  return null;
}

module.exports = { findProjectRoot, loadShellsConfig, matchCuratedShell };
