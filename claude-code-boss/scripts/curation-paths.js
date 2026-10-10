'use strict';
/**
 * curation-paths.js — Central helper for curation file locations.
 *
 * The curated scripts and their shells.json live OUTSIDE the project, in the user's
 * own folder, one directory per project (the CURATION HOME):
 *
 *   ~/.claude/claude-code-boss/curation/<owner>/<repo>/        (project with an id)
 *   ~/.claude/claude-code-boss/curation/local/<name>-<hash>/   (folder without one)
 *     shells.json
 *     scripts/
 *
 * The key is the strict project id (lib/project-id.js — the same id that scopes the
 * memory), so every clone/worktree/subfolder of a repo shares one home; a folder
 * without an id gets a path-hash key (never its bare name: two folders named alike
 * must not run each other's scripts). Nothing is written inside the repo anymore —
 * the old `.vscode/shells.json` + `.vscode/scripts/` filled every project with files
 * the user had to gitignore (and SessionStart created a shells.json in EVERY folder).
 *
 * LEGACY (in-repo) locations are only read to MIGRATE them, once, into the home. The
 * config/hooks-config.json `curation` block names them:
 *   {
 *     "scriptsDir": ".vscode/scripts",
 *     "shellsConfigPath": ".vscode/shells.json",
 *     "scriptsDirSearch": [".vscode/scripts", ".curation/scripts", "scripts"],
 *     "shellsConfigSearch": [".vscode/shells.json", ".curation/shells.json", "shells.json"]
 *   }
 * Migration moves the dedicated curation scripts dir (never a repo's own `scripts/`),
 * rewrites the entries' paths, keeps a backup in the home, and removes the legacy files
 * that git does not track (a tracked one is the team's file — copied, left, reported).
 * A failed migration keeps reading the legacy file (no curation is lost) and says why.
 *
 * Exports:
 *   loadCurationConfig()        — config block from hooks-config.json
 *   findProjectRoot(cwd)        — the project root (git root, else nearest marker)
 *   curationHome(projectRoot)   — absolute home dir of that project's curation
 *   getScriptsDir(projectRoot)  — <home>/scripts (may not exist yet)
 *   getShellsConfigPath(root)   — <home>/shells.json (legacy path only if migration failed)
 *   resolveScriptPath(root, p)  — absolute path of an entry's script
 *   takeMigrationNotice(root)   — one-shot report of a migration (SessionStart shows it)
 */
const fs   = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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
function _resetConfigCache() { _cfgCache = null; _rootMemo.clear(); _homeMemo.clear(); _migrated.clear(); }

// The walk-up below is up to 10 levels × 17 existsSync — ~1 ms per call on
// Windows, paid by every curation hook call in the shared daemon. Same 30 s memo
// rule as lib/project-id.js's git lookups: a shells.json created mid-session is
// picked up within 30 s.
const ROOT_TTL_MS = 30_000;
const ROOT_MEMO_MAX = 256;
const _rootMemo = new Map();

/**
 * Walk up from `cwd` to the project root: a directory still holding a LEGACY in-repo
 * shells config (so it gets migrated), else the git root, else the nearest project
 * marker. Returns null when none is found below the home folder.
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
    // The repo root, not a subfolder that happens to hold a package.json: the scripts
    // run against the project, and CCB_PROJECT_ROOT must name the same dir from anywhere in it.
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (!nearestMarker && hasProjectMarker) nearestMarker = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestMarker;
}

// ── Curation home ────────────────────────────────────────────────────────────

const _homeMemo = new Map();

/**
 * The directory key of a project's curation home: `<owner>/<repo>` from the strict
 * project id, else `local/<name>-<sha1(path)[:10]>`.
 * @param {string} projectRoot
 * @returns {string}
 */
function curationKeyOf(projectRoot) {
  const pid = require('./lib/project-id.js');
  const id = pid.sanitizeLogicalProjectId(pid.tryResolveProjectId({ cwd: projectRoot }) || '');
  if (id) return id;
  const abs = path.resolve(projectRoot);
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const name = (path.basename(abs) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40);
  return `local/${name}-${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10)}`;
}

/**
 * Absolute curation home of a project (may not exist yet).
 * @param {string|null} projectRoot
 * @returns {string|null}
 */
function curationHome(projectRoot) {
  if (!projectRoot) return null;
  const hit = _homeMemo.get(projectRoot);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.home;
  const { globalDir } = require('./lib/data-dir.js');
  const home = path.join(globalDir(), 'curation', ...curationKeyOf(projectRoot).split('/'));
  if (_homeMemo.size >= ROOT_MEMO_MAX) _homeMemo.delete(_homeMemo.keys().next().value);
  _homeMemo.set(projectRoot, { home, at: Date.now() });
  return home;
}

/**
 * Resolve the scripts dir for a given project root: `<home>/scripts`.
 * @param {string|null} projectRoot
 * @returns {string|null} absolute path, or null when projectRoot is null
 */
function getScriptsDir(projectRoot) {
  if (!projectRoot) return null;
  ensureMigrated(projectRoot);
  return path.join(curationHome(projectRoot), 'scripts');
}

/**
 * Resolve the shells config path for a given project root: `<home>/shells.json`. Only
 * when a legacy in-repo config could NOT be migrated is that legacy file returned, so
 * the project keeps its curation while the failure is reported.
 * @param {string|null} projectRoot
 * @returns {string|null} absolute path, or null when projectRoot is null
 */
function getShellsConfigPath(projectRoot) {
  if (!projectRoot) return null;
  const m = ensureMigrated(projectRoot);
  if (m && m.error && m.legacyShells) return m.legacyShells;
  return path.join(curationHome(projectRoot), 'shells.json');
}

/**
 * Absolute path of an entry's script. New entries are relative to the curation home
 * (`scripts/x.mjs`); an absolute path (a repo-owned script, kept in place) stays as is.
 * @param {string|null} projectRoot
 * @param {string} scriptPath
 * @returns {string|null}
 */
function resolveScriptPath(projectRoot, scriptPath) {
  const rel = String(scriptPath || '').trim();
  if (!rel) return null;
  if (path.isAbsolute(rel)) return path.resolve(rel);
  const home = curationHome(projectRoot);
  return home ? path.resolve(home, rel) : null;
}

// ── Migration (legacy in-repo → curation home) ──────────────────────────────

const _migrated = new Map(); // projectRoot → { at, result }
const LOCK_STALE_MS = 60_000;
const SELF_LOCATING = /__dirname|import\.meta\.url|\$PSScriptRoot|BASH_SOURCE|dirname\s+["']?\$0/;
const CLIMBS_UP = /\.\.[/\\'"]/;

/** The legacy in-repo shells configs of this root that are curation configs (`shells: []`). */
function _legacyShellsFiles(projectRoot) {
  const cfg = loadCurationConfig();
  const out = [];
  for (const rel of [...new Set([cfg.shellsConfigPath, ...cfg.shellsConfigSearch])]) {
    if (!rel || path.isAbsolute(rel)) continue;
    const p = path.join(projectRoot, rel);
    if (!fs.existsSync(p)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { throw new Error(`legacy ${rel} is not valid JSON: ${err.message}`); }
    if (json && Array.isArray(json.shells)) out.push({ rel, path: p, json });
  }
  return out;
}

/**
 * Dedicated in-repo curation script dirs (never the repo's own `scripts/`). `existing: false`
 * lists them all — an entry pointing into one maps to the home even when its file is missing.
 */
function _legacyScriptDirs(projectRoot, { existing = true } = {}) {
  const cfg = loadCurationConfig();
  return [...new Set([cfg.scriptsDir, ...cfg.scriptsDirSearch])]
    .filter((rel) => rel && !path.isAbsolute(rel) && rel.replace(/\\/g, '/').replace(/\/+$/, '') !== 'scripts')
    .map((rel) => ({ rel, path: path.join(projectRoot, rel) }))
    .filter((d) => !existing || (fs.existsSync(d.path) && fs.statSync(d.path).isDirectory()));
}

function _walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) _walkFiles(p, base, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Repo-relative paths (forward slashes) of `files` that git tracks; [] outside a repo. */
function _trackedByGit(projectRoot, files) {
  if (!files.length) return [];
  try {
    const rels = files.map((f) => path.relative(projectRoot, f).split(path.sep).join('/'));
    const out = execFileSync('git', ['ls-files', '-z', '--', ...rels], { cwd: projectRoot, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch (err) {
    void err; // not a git repo / git missing → nothing is tracked
    return [];
  }
}

/** Entry path rewritten for the home: inside a moved dir → `scripts/<rel>`; else absolute. */
function _rewriteEntryPath(projectRoot, rel, movedDirs) {
  const abs = path.resolve(projectRoot, String(rel || '').trim());
  for (const d of movedDirs) {
    const inside = path.relative(d.path, abs);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return `scripts/${inside.split(path.sep).join('/')}`;
  }
  return abs.split(path.sep).join('/');
}

function _withEntryPath(entry, newPath) {
  const out = { ...entry };
  if (out.script !== undefined) out.script = newPath;
  if (out.command !== undefined || out.script === undefined) out.command = newPath;
  if (out.path !== undefined) out.path = newPath;
  return out;
}

/**
 * Move a project's legacy in-repo curation into its home. Idempotent; runs at most once
 * per root every 30 s per process; a lock keeps concurrent hooks from migrating twice.
 * @param {string} projectRoot
 * @returns {{migrated?:boolean, merged?:boolean, error?:string, legacyShells?:string}|null}
 */
function ensureMigrated(projectRoot) {
  const hit = _migrated.get(projectRoot);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.result;
  let result = null;
  let legacy = [];
  try {
    legacy = _legacyShellsFiles(projectRoot);
    if (legacy.length) result = _migrate(projectRoot, legacy);
  } catch (err) {
    const legacyShells = legacy[0] ? legacy[0].path : _firstExistingLegacy(projectRoot);
    result = { error: err.message, legacyShells };
    console.error(`[curation] could not move the curated scripts of ${projectRoot} out of the project: ${err.message} — still using ${legacyShells || 'nothing'}`);
    _writeNotice(projectRoot, { error: err.message, from: legacyShells });
  }
  // Another process holding the lock is about to finish: re-check on the next call.
  if (!(result && result.transient)) _migrated.set(projectRoot, { at: Date.now(), result });
  return result;
}

function _firstExistingLegacy(projectRoot) {
  const cfg = loadCurationConfig();
  for (const rel of [cfg.shellsConfigPath, ...cfg.shellsConfigSearch]) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _writeNotice(projectRoot, notice) {
  try {
    const home = curationHome(projectRoot);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'migration-notice.json'), JSON.stringify({ at: new Date().toISOString(), projectRoot, ...notice }, null, 2));
  } catch (err) {
    console.error(`[curation] could not write the migration notice: ${err.message}`);
  }
}

function _migrate(projectRoot, legacy) {
  const home = curationHome(projectRoot);
  fs.mkdirSync(path.dirname(home), { recursive: true });
  const lock = `${home}.lock`;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < LOCK_STALE_MS) return { error: 'another process is migrating this project right now', legacyShells: legacy[0].path, transient: true };
    fs.writeFileSync(lock, String(process.pid)); // stale lock (crashed migration) → take it over
  }
  try {
    const dirs = _legacyScriptDirs(projectRoot);
    const files = dirs.flatMap((d) => _walkFiles(d.path));
    const existed = fs.existsSync(path.join(home, 'shells.json'));
    const target = existed ? home : `${home}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });

    const selfLocating = [];
    for (const d of dirs) {
      for (const f of _walkFiles(d.path)) {
        const dest = path.join(target, 'scripts', path.relative(d.path, f));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) fs.copyFileSync(f, dest); // a merge never overwrites the home's own copy
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (err) { void err; }
        if (SELF_LOCATING.test(text) && CLIMBS_UP.test(text)) selfLocating.push(`scripts/${path.relative(d.path, f).split(path.sep).join('/')}`);
      }
    }

    const base = existed ? JSON.parse(fs.readFileSync(path.join(home, 'shells.json'), 'utf8')) : { version: 1, shells: [], whitelist: [] };
    if (!Array.isArray(base.shells)) base.shells = [];
    const ids = new Set(base.shells.map((s) => s && s.id).filter(Boolean));
    let added = 0;
    const whitelist = new Set(Array.isArray(base.whitelist) ? base.whitelist : []);
    for (const lf of legacy) {
      for (const s of lf.json.shells) {
        if (!s || (s.id && ids.has(s.id))) continue;
        const p = s.script || s.command || s.path;
        base.shells.push(p ? _withEntryPath(s, _rewriteEntryPath(projectRoot, p, _legacyScriptDirs(projectRoot, { existing: false }))) : s);
        if (s.id) ids.add(s.id);
        added++;
      }
      for (const w of lf.json.whitelist || []) whitelist.add(w);
    }
    base.whitelist = [...whitelist];

    // Backup of what is about to leave the repo, inside the home (never in the repo).
    const backup = path.join(target, 'legacy-backup', new Date().toISOString().replace(/[:.]/g, '-'));
    for (const lf of legacy) {
      const dest = path.join(backup, lf.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(lf.path, dest);
    }
    for (const d of dirs) fs.cpSync(d.path, path.join(backup, d.rel), { recursive: true });

    fs.writeFileSync(path.join(target, 'shells.json'), JSON.stringify(base, null, 2) + '\n');
    if (!existed) {
      try {
        fs.renameSync(target, home);
      } catch (err) {
        fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(path.join(home, 'shells.json'))) return _migrate(projectRoot, legacy); // lost a race → merge into the winner
        throw err;
      }
    }

    // Remove from the repo only what git does not track: a tracked file is the team's.
    const legacyFiles = [...legacy.map((l) => l.path), ...files];
    const tracked = new Set(_trackedByGit(projectRoot, legacyFiles));
    const keptTracked = [];
    for (const f of legacyFiles) {
      const rel = path.relative(projectRoot, f).split(path.sep).join('/');
      if (tracked.has(rel)) { keptTracked.push(rel); continue; }
      fs.rmSync(f, { force: true });
    }
    for (const d of dirs) _removeEmptyDirs(d.path, projectRoot);
    for (const lf of legacy) _removeEmptyDirs(path.dirname(lf.path), projectRoot);

    _writeNotice(projectRoot, {
      migrated: true, merged: existed, home, entries: added, scripts: files.length,
      from: legacy.map((l) => l.rel), keptTracked, selfLocating,
    });
    return { migrated: true, merged: existed };
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch (err) { console.error(`[curation] could not release ${lock}: ${err.message}`); }
  }
}

/** Remove `dir` and its now-empty parents, never the project root itself. */
function _removeEmptyDirs(dir, projectRoot) {
  let d = path.resolve(dir);
  const stop = path.resolve(projectRoot);
  while (d !== stop && d.startsWith(stop)) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) _removeEmptyDirs(path.join(d, e.name), projectRoot);
      }
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[curation] could not remove ${d}: ${err.message}`);
      return;
    }
    d = path.dirname(d);
  }
}

/**
 * The migration report of this project, ONCE (renamed after reading), or null.
 * @param {string|null} projectRoot
 * @returns {object|null}
 */
function takeMigrationNotice(projectRoot) {
  if (!projectRoot) return null;
  const file = path.join(curationHome(projectRoot), 'migration-notice.json');
  try {
    const notice = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.renameSync(file, `${file}.shown`);
    return notice;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[curation] migration notice unreadable: ${err.message}`);
    return null;
  }
}

module.exports = {
  loadCurationConfig,
  findProjectRoot,
  curationHome,
  curationKeyOf,
  getScriptsDir,
  getShellsConfigPath,
  resolveScriptPath,
  ensureMigrated,
  takeMigrationNotice,
  _resetConfigCache,
  DEFAULTS,
};
