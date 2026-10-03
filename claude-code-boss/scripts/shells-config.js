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
 *     outputLines?:  number,         // enforced curated-success line budget (curation-classifier)
 *     outputChars?:  number,         // optional char budget (default: outputLines * 100)
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

/** @type {Map<string, { stamp: string, result: { shells: object[], whitelist: string[] } }>} */
const _cache = new Map();

// The cache is keyed by the shells file's stamp (path + mtime + size), not just the
// root: hooks now run in the long-lived brain daemon (Phase G), and a root-only cache
// froze shells.json at its first read — a script/alias registered mid-session
// (curation_register_shell or a hand edit) never redirected until a daemon restart
// (seen live in the variant→alias stress). One stat per call, as refreshConfig does.
function stampOf(shellsPath) {
  if (!shellsPath) return 'none';
  try { const st = fs.statSync(shellsPath); return `${shellsPath}|${st.mtimeMs}|${st.size}`; }
  catch (err) { if (err.code !== 'ENOENT') console.error(`[SHELLS-CONFIG] stat ${shellsPath}: ${err.message}`); return `${shellsPath}|absent`; }
}

/**
 * Load (and cache until the file changes) shells config for the given project root.
 * Returns { shells: [], whitelist: [] } on any error — never throws.
 * @param {string|null} projectRoot
 * @returns {{ shells: object[], whitelist: string[] }}
 */
function loadShellsConfig(projectRoot) {
  if (!projectRoot) return { shells: [], whitelist: [] };
  const shellsPath = getShellsConfigPath(projectRoot);
  const stamp = stampOf(shellsPath);
  const hit = _cache.get(projectRoot);
  if (hit && hit.stamp === stamp) return hit.result;

  let result = { shells: [], whitelist: [] };
  try {
    if (shellsPath && fs.existsSync(shellsPath)) {
      const config = JSON.parse(fs.readFileSync(shellsPath, 'utf-8'));
      const shells = (config.shells || []).map(s => {
        // Normalize: legacy `command` (was path) becomes `script`.
        if (!s.script && s.command) return { ...s, script: s.command };
        return s;
      });
      result = { shells, whitelist: config.whitelist || [] };
    }
  } catch (err) {
    console.error(`[SHELLS-CONFIG] Failed to parse shells config: ${err.message}`);
  }
  _cache.set(projectRoot, { stamp, result });
  return result;
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
 * Tokenize a command like a shell would: separators/whitespace split tokens only
 * OUTSIDE quotes, and a quoted run is one token (its quotes removed). So
 * `node "C:/p/.vscode/scripts/x.mjs"` yields the path, while
 * `echo "running .vscode/scripts/x.ps1"` and `node -e "…x.ps1…"` yield ONE token
 * that is not the path. (The old split-then-strip-quotes version turned every
 * quoted word into its own token, so a script name inside a string counted as
 * invoking the script — backlog U11.)
 */
// A quoted argument right after one of these IS a command line (shell-in-shell:
// `pwsh -Command "& ./x.ps1"`, `bash -c "node x.mjs"`, `cmd /c "x.bat"`), so its
// content is tokenized too.
const SHELL_CMD_FLAG = /^(?:-c|-command|\/c)$/i;

function _tokenize(command) {
  const s = String(command || '');
  const out = [];
  let cur = '';
  let quoted = false;
  let q = null;
  const flush = () => {
    if (cur) {
      const prev = out[out.length - 1];
      out.push(cur);
      if (quoted && /\s/.test(cur) && prev && SHELL_CMD_FLAG.test(prev)) out.push(..._tokenize(cur));
    }
    cur = ''; quoted = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      // Only `\"` is an escape (inside double quotes); any other backslash is
      // literal — Windows paths (`C:\p\x.ps1`) must survive tokenization.
      else if (c === '\\' && q === '"' && s[i + 1] === '"') cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; quoted = true; continue; }
    if (/[\s;&|`()<>]/.test(c)) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
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

/**
 * Build the safe curated-script invocation for AUTO-REDIRECT (Parte A, Fase 1).
 *
 * Returns a command that (a) INVOKES the curated script — its path appears as a
 * token, so the guard's own `isInvokingScript` recognizes it — and (b) has no
 * pipe. I.e. the rewrite passes the guard's OWN allow-path, staying self-
 * consistent. Fase 1 is deliberately CONSERVATIVE: it reconstructs ONLY when the
 * whole command is EXACTLY one of the shell's aliases (no positional args, single
 * segment) AND the script is a `.ps1` (run via `powershell -File`). Anything else
 * (args, extra segments, non-`.ps1`) returns null so the caller keeps the proven
 * deny+instruct path — we never drop args nor guess a runner.
 *
 * @param {object} curatedShell matched entry ({ script, aliases })
 * @param {string} command the raw command that matched an alias
 * @returns {string|null} the rewritten invocation, or null when not safely rebuildable
 */
function buildCuratedInvocation(curatedShell, command) {
  const script = ((curatedShell && curatedShell.script) || '').trim();
  if (!script) return null;
  const cmd = (command || '').trim();
  const aliases = Array.isArray(curatedShell.aliases) ? curatedShell.aliases : [];
  const arglessExact = aliases.some(a => cmd === (a || '').trim());
  if (!arglessExact) return null; // args / extra segments → keep deny (Fase 2 territory)
  if (/\.ps1$/i.test(script)) return `powershell -File "${script}"`;
  return null; // non-.ps1 not supported in Fase 1
}

module.exports = { findProjectRoot, loadShellsConfig, matchCuratedShell, buildCuratedInvocation, _resetCache, _pathMatches, _tokenize };
