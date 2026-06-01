'use strict';
/**
 * shells-config.js — Shared module for curated shells config access.
 *
 * Path resolution delegated to curation-paths.js (configurable via
 * config/hooks-config.json `curation` block).
 *
 * Schema (per shell entry):
 *   {
 *     id:          string,           // unique identity
 *     script:      string,           // path to the script file (any extension)
 *     aliases?:    string[],         // raw command forms that should route to this script
 *     outputFilter?: string,         // hint for the script's filter mode
 *     outputLines?:  number,
 *     timeoutMs?:    number,
 *     ...                            // arbitrary extras tolerated
 *   }
 *
 * BACKWARD: entries with legacy `command` field (no `script`) are normalized
 * to `script = command` at load time so older shells.json continues to work.
 *
 * Matcher (matchCuratedShell) uses substring containment on `script`:
 *   ANY invocation of the script (raw path, via wrapper like `powershell -File X`,
 *   via `node X`, via `bash X`, with flags appended) carries the script path
 *   inside the command string → matches.
 * Aliases stay as prefix matches for raw→curated routing (e.g. `npm test` → vitest script).
 *
 * Cache: process-level Map keyed by projectRoot.
 *
 * Consumed by: curation-guard.js, curation-detect.js, dashboard.js
 */
const fs   = require('fs');

const {
  findProjectRoot,
  getShellsConfigPath,
} = require('./curation-paths.js');

/** @type {Map<string, { shells: object[], whitelist: string[] }>} */
const _cache = new Map();

/**
 * Load (and cache) shells config for the given project root.
 * Returns { shells: [], whitelist: [] } on any error — never throws.
 * @param {string|null} projectRoot
 * @returns {{ shells: object[], whitelist: string[] }}
 */
function loadShellsConfig(projectRoot) {
  if (!projectRoot) return { shells: [], whitelist: [] };
  if (_cache.has(projectRoot)) return _cache.get(projectRoot);

  try {
    const shellsPath = getShellsConfigPath(projectRoot);
    if (!shellsPath || !fs.existsSync(shellsPath)) {
      const result = { shells: [], whitelist: [] };
      _cache.set(projectRoot, result);
      return result;
    }
    const config = JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
    const shells = (config.shells || []).map(s => {
      // Normalize: legacy `command` (was path) becomes `script`.
      if (!s.script && s.command) return { ...s, script: s.command };
      return s;
    });
    const result = { shells, whitelist: config.whitelist || [] };
    _cache.set(projectRoot, result);
    return result;
  } catch (err) {
    console.error(`[SHELLS-CONFIG] Failed to parse shells config: ${err.message}`);
    const result = { shells: [], whitelist: [] };
    _cache.set(projectRoot, result);
    return result;
  }
}

/**
 * Return the first shell entry whose `script` path appears in the command
 * (substring match) or whose alias is a prefix of the command.
 *
 * Examples that all match script=".vscode/scripts/vitest.ps1":
 *   - ".vscode/scripts/vitest.ps1"
 *   - "powershell -File .vscode/scripts/vitest.ps1 tests/foo.test.ts"
 *   - "node .vscode/scripts/vitest.ps1"
 *
 * Examples that match alias="npm test":
 *   - "npm test"
 *   - "npm test -- --watch"
 *
 * @param {string} command
 * @param {object[]} shells
 * @returns {object|null}
 */
/**
 * Tokenize a command by shell separators/whitespace.
 * Strips surrounding quotes from each token so quoted forms still tokenize cleanly.
 * Quoted tokens NOT containing the literal scriptPath (e.g. `"running x.ps1"`)
 * won't equal scriptPath after stripping, defeating naive substring bypass.
 */
function _tokenize(command) {
  return command
    .split(/[\s;&|`()<>]+/)
    .map(t => t.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

/**
 * Path-aware match: a token "points at" a script when it is either equal to
 * the script's path (after slash + case normalization), or ends with `/` +
 * the script path (so an absolute token like `c:/proj/.vscode/scripts/x.ps1`
 * matches a relative script `.vscode/scripts/x.ps1`).
 *
 * The leading `/` requirement prevents `ax.ps1` from matching `x.ps1`.
 */
function _pathMatches(token, scriptPath) {
  if (!token || !scriptPath) return false;
  const t = token.replace(/\\/g, '/').toLowerCase();
  const s = scriptPath.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
  return t === s || t.endsWith('/' + s);
}

/**
 * Return the first shell entry whose `script` path appears as a whole token
 * in the command (token-aware, not raw substring), or whose alias is a prefix.
 *
 * Token-aware match prevents bypass like `echo "running x.ps1" && rm -rf`
 * being mis-recognized as "invoking the curated script x.ps1".
 *
 * Examples matched (script=".vscode/scripts/vitest.ps1"):
 *   - ".vscode/scripts/vitest.ps1"
 *   - "powershell -File .vscode/scripts/vitest.ps1 tests/foo.test.ts"
 *   - "node .vscode/scripts/vitest.ps1"
 *
 * Examples NOT matched:
 *   - "echo \"running .vscode/scripts/vitest.ps1\""   (path inside quoted arg)
 *   - "git log -- .vscode/scripts/vitest.ps1.bak"     (different token)
 *
 * @param {string} command
 * @param {object[]} shells
 * @returns {object|null}
 */
function matchCuratedShell(command, shells) {
  const trimmed = (command || '').trim();
  if (!trimmed) return null;
  const tokens = _tokenize(trimmed);
  // Split by shell command separators (&&, ||, ;) so that aliases match when
  // they appear after `cd x && ...`, `setup; ...`, etc. Pipe (`|`) is NOT a
  // separator here — `cmd | filter` is a single invocation of `cmd`.
  const segments = trimmed.split(/\s*(?:&&|\|\|)\s*|\s*;\s*/).map(s => s.trim()).filter(Boolean);
  for (const shell of shells) {
    const scriptPath = (shell.script || '').trim();
    if (scriptPath && tokens.some(t => _pathMatches(t, scriptPath))) return shell;
    if (Array.isArray(shell.aliases)) {
      for (const a of shell.aliases) {
        const al = (a || '').trim();
        if (!al) continue;
        for (const seg of segments) {
          if (seg === al || seg.startsWith(al + ' ')) return shell;
        }
      }
    }
  }
  return null;
}

/** Test-only cache reset. */
function _resetCache() { _cache.clear(); }

module.exports = { findProjectRoot, loadShellsConfig, matchCuratedShell, _resetCache, _pathMatches, _tokenize };
