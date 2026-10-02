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
const os = require('os');


const DEFAULTS = {
  scriptsDir: '.vscode/scripts',
  shellsConfigPath: '.vscode/shells.json',
  scriptsDirSearch: ['.vscode/scripts', '.curation/scripts', 'scripts'],
  shellsConfigSearch: ['.vscode/shells.json', '.curation/shells.json', 'shells.json'],
};
const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'pom.xml',
  'build.gradle', 'Dockerfile', 'docker-compose.yml',
];

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

/** Reset caches — tests, and the daemon when hooks-config changes on disk. */
function _resetConfigCache() { _cfgCache = null; _rootMemo.clear(); }

// The walk-up below is up to 10 levels × 17 existsSync — ~1 ms per call on
// Windows, paid by every curation hook call in the shared daemon. Same 30 s memo
// rule as lib/project-id.js's git lookups: a shells.json created mid-session is
// picked up within 30 s.
const ROOT_TTL_MS = 30_000;
const ROOT_MEMO_MAX = 256;
const _rootMemo = new Map();

/**
 * Walk up from `cwd` to find the directory that contains the shells config
 * (any of `shellsConfigSearch` paths). Returns the directory path, or null.
 * @param {string} cwd
 * @returns {string|null}
 */
function findProjectRoot(cwd) {
  if (!cwd) return null;
  const hit = _rootMemo.get(cwd);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.root;
  const root = _walkProjectRoot(cwd);
  if (_rootMemo.size >= ROOT_MEMO_MAX) _rootMemo.delete(_rootMemo.keys().next().value);
  _rootMemo.set(cwd, { root, at: Date.now() });
  return root;
}

function _walkProjectRoot(cwd) {
  const cfg = loadCurationConfig();
  const candidates = [cfg.shellsConfigPath, ...cfg.shellsConfigSearch];
  let dir = cwd;
  let nearestMarker = null;
  // Never adopt the HOME folder (or anything above it) as a project: a stray
  // ~/.vscode/shells.json (seen in the field) made every folder without its own
  // config inherit the home's curated scripts — and ~/.claude/settings.json read as
  // "project settings". Same stop rule as the project-id climb.
  const home = path.resolve(os.homedir()).toLowerCase();
  for (let i = 0; i < 10; i++) {
    if (path.resolve(dir).toLowerCase() === home) break;
    const hasProjectMarker = PROJECT_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
    for (const rel of candidates) {
      if (fs.existsSync(path.join(dir, rel)) && (!nearestMarker || hasProjectMarker)) return dir;
    }
    if (!nearestMarker && hasProjectMarker) nearestMarker = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestMarker;
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
