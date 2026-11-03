'use strict';
/**
 * cache-prune.js — keep only the CURRENT version of this plugin in Claude Code's plugin cache.
 *
 * Every update (Claude Code's own marketplace auto-update, the dashboard's "Update now", a dev
 * install) writes a new `<cache>/<marketplace>/<plugin>/<version>` dir and leaves the previous
 * ones behind — each with its own node_modules, so a machine with little free disk filled up.
 * Going back is a download from GitHub; no old copy is worth keeping.
 *
 * Safety (a delete must never hurt a working install):
 *  - nothing is removed unless the CURRENT install is verified: the registry's installPath is a
 *    direct child of `cacheBase`, exists, and has a package.json. Otherwise → nothing deleted.
 *  - the current install, the dir Claude Code resolves for its version (a reload reads
 *    <cache>/<package.json version>, which differs from the registry path for a dev build),
 *    the running session's own root and the root of the live brain daemon
 *    (deleting the dir a daemon runs from crashed it on 2026-10-05) are always kept.
 *  - only directories directly under `cacheBase` are touched; a dir that cannot be removed
 *    (in use on Windows) is reported and retried by the next run — never fatal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKETPLACE = 'allansantos-plugins';
const PLUGIN = 'claude-code-boss';

function cacheBaseOf(env = process.env) {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(cfg, 'plugins', 'cache', MARKETPLACE, PLUGIN);
}

function registryInstallPath(env = process.env) {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(cfg, 'plugins', 'installed_plugins.json');
  try {
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const e = reg.plugins && reg.plugins[`${PLUGIN}@${MARKETPLACE}`] && reg.plugins[`${PLUGIN}@${MARKETPLACE}`][0];
    return e && e.installPath ? String(e.installPath) : null;
  } catch (err) {
    console.error(`[cache-prune] cannot read ${file}: ${err.message}`);
    return null;
  }
}

/** Root of the live brain daemon (its lock lives in the data dir, outside the cache), or null. */
function daemonRoot(dataDir) {
  if (!dataDir || String(dataDir).includes('${')) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(path.resolve(String(dataDir)), 'brain-http.lock.json'), 'utf8'));
    return lock && typeof lock.pluginRoot === 'string' ? lock.pluginRoot : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[cache-prune] cannot read daemon lock: ${err.message}`);
    return null;
  }
}

const norm = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };

/** The dir a reload resolves for the install at `current`: <cacheBase>/<its package.json version>, or null. */
function versionDir(cacheBase, current) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v ? path.join(cacheBase, v) : null;
  } catch (err) { console.error('[cache-prune] cannot read version of ' + current + ': ' + err.message); return null; }
}

/** Pure: which entries of `names` (children of cacheBase) go, given the dirs to keep. */
function planPrune(cacheBase, names, keepPaths) {
  const keep = new Set((keepPaths || []).filter(Boolean).map(norm));
  return (names || []).filter((n) => !keep.has(norm(path.join(cacheBase, n))));
}

/**
 * @param {{cacheBase?:string, current?:string|null, keep?:string[], rm?:Function}} o
 * @returns {Promise<{ok:boolean, skipped?:string, removed:string[], failed:{name:string,error:string}[]}>}
 */
async function pruneOldVersions(o = {}) {
  const cacheBase = o.cacheBase || cacheBaseOf();
  const current = o.current === undefined ? registryInstallPath() : o.current;
  // A restored plugin dir (session-root.healMissingPluginRoots) is a junction: unlink it, never recurse into the install it points at.
  const rm = o.rm || (async (p) => {
    if (fs.lstatSync(p).isSymbolicLink()) return fs.promises.unlink(p);
    return fs.promises.rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  });
  const out = { ok: true, removed: [], failed: [] };

  if (!current) return { ...out, ok: false, skipped: 'no current install recorded in the registry' };
  if (norm(path.dirname(current)) !== norm(cacheBase)) {
    return { ...out, ok: false, skipped: `current install ${current} is not directly under ${cacheBase}` };
  }
  if (!fs.existsSync(path.join(current, 'package.json'))) {
    return { ...out, ok: false, skipped: `current install ${current} has no package.json (not a verified install)` };
  }

  let entries;
  try { entries = fs.readdirSync(cacheBase, { withFileTypes: true }); }
  catch (err) { return { ...out, ok: false, skipped: `cannot list ${cacheBase}: ${err.message}` }; }

  const resolved = versionDir(cacheBase, current);
  const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  for (const name of planPrune(cacheBase, dirs, [current, resolved, ...(o.keep || [])])) {
    try { await rm(path.join(cacheBase, name)); out.removed.push(name); }
    catch (err) {
      out.failed.push({ name, error: err.message });
      console.error(`[cache-prune] could not remove ${name}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { pruneOldVersions, planPrune, cacheBaseOf, registryInstallPath, daemonRoot, MARKETPLACE, PLUGIN };
