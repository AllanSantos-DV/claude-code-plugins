'use strict';
/**
 * curation-paths.js — Central helper for curation file locations.
 *
 * All paths configurable via config/hooks-config.json `curation` block:
 *   {
 *     "scriptsDir": ".vscode/scripts",
 *     "shellsConfigPath": ".vscode/shells.json",
 *     "scriptsDirSearch": [".vscode/scripts", ".curation/scripts", "scripts"],
 *     "shellsConfigSearch": [".vscode/shells.json", ".curation/shells.json", "shells.json"]
 *   }
 *
 * Probe strategy: walk up from `cwd` looking for the first directory that
 * contains ANY of the search paths. Explicit override (`scriptsDir` /
 * `shellsConfigPath`) wins if set and the path exists.
 *
 * Exports:
 *   loadCurationConfig()      — config block from hooks-config.json
 *   findProjectRoot(cwd)      — walk-up to dir containing shellsConfig
 *   getScriptsDir(projectRoot)— absolute scripts dir for project (may not exist)
 *   getShellsConfigPath(root) — absolute shells config file for project
 */
const fs   = require('fs');
const path = require('path');


const DEFAULTS = {
  scriptsDir: '.vscode/scripts',
  shellsConfigPath: '.vscode/shells.json',
  scriptsDirSearch: ['.vscode/scripts', '.curation/scripts', 'scripts'],
  shellsConfigSearch: ['.vscode/shells.json', '.curation/shells.json', 'shells.json'],
};

let _cfgCache = null;
function loadCurationConfig() {
  if (_cfgCache) return _cfgCache;
  const user = require('./lib/hooks-config.js').getCuration();
  _cfgCache = {
    scriptsDir: user.scriptsDir || DEFAULTS.scriptsDir,
    shellsConfigPath: user.shellsConfigPath || DEFAULTS.shellsConfigPath,
    scriptsDirSearch: Array.isArray(user.scriptsDirSearch) ? user.scriptsDirSearch : DEFAULTS.scriptsDirSearch,
    shellsConfigSearch: Array.isArray(user.shellsConfigSearch) ? user.shellsConfigSearch : DEFAULTS.shellsConfigSearch,
  };
  return _cfgCache;
}

/** Reset cache — only for tests. */
function _resetConfigCache() { _cfgCache = null; }

/**
 * Walk up from `cwd` to find the directory that contains the shells config
 * (any of `shellsConfigSearch` paths). Returns the directory path, or null.
 * @param {string} cwd
 * @returns {string|null}
 */
function findProjectRoot(cwd) {
  if (!cwd) return null;
  const cfg = loadCurationConfig();
  const candidates = [cfg.shellsConfigPath, ...cfg.shellsConfigSearch];
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    for (const rel of candidates) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the scripts dir for a given project root.
 * Tries explicit `scriptsDir` first, then `scriptsDirSearch` (first existing).
 * Falls back to explicit `scriptsDir` even if it doesn't exist yet (creation target).
 * @param {string|null} projectRoot
 * @returns {string|null} absolute path, or null when projectRoot is null
 */
function getScriptsDir(projectRoot) {
  if (!projectRoot) return null;
  const cfg = loadCurationConfig();
  const explicit = path.join(projectRoot, cfg.scriptsDir);
  if (fs.existsSync(explicit)) return explicit;
  for (const rel of cfg.scriptsDirSearch) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return explicit; // fallback (creation target)
}

/**
 * Resolve the shells config path for a given project root.
 * Tries explicit `shellsConfigPath` first, then `shellsConfigSearch`.
 * @param {string|null} projectRoot
 * @returns {string|null} absolute path, or null when projectRoot is null
 */
function getShellsConfigPath(projectRoot) {
  if (!projectRoot) return null;
  const cfg = loadCurationConfig();
  const explicit = path.join(projectRoot, cfg.shellsConfigPath);
  if (fs.existsSync(explicit)) return explicit;
  for (const rel of cfg.shellsConfigSearch) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return explicit; // fallback (creation target)
}

module.exports = {
  loadCurationConfig,
  findProjectRoot,
  getScriptsDir,
  getShellsConfigPath,
  _resetConfigCache,
  DEFAULTS,
};
