'use strict';
/**
 * update-notice.js — the two VISIBLE update messages (nothing about updates is hidden):
 *   1. "new version available": SessionStart (refreshLatest) asks GitHub for the newest
 *      `v<X.Y.Z>` release at most every 6h and caches it; the next prompt (takeUpdateNotices)
 *      tells the user once per version.
 *   2. "plugin updated": the version at CLAUDE_PLUGIN_ROOT is newer than the last one this
 *      machine saw → told once. First run only records the version, silently.
 * Both ride the UserPromptSubmit `systemMessage` (the only hook channel that reaches the user).
 *
 * `claude plugin update` reads the plugin version from the local marketplace clone, and when the
 * marketplace refresh fails it still exits 0 with "already at the latest version". So the notice
 * gives both commands in order, and a clone still behind the published release STALE_MS after it
 * was first seen behind, with auto-update on, is told once as a refresh that is not arriving.
 *
 * Opt-out: CLAUDE_CODE_BOSS_AUTO_UPDATE=0|false|off|no — no auto-update switch-on
 * (marketplace-autoupdate.js) and no GitHub check. The local "updated" message still shows.
 */
const fs = require('fs');
const path = require('path');

const STATE = 'update-state.json';
// The notice is read by a person: link the public Pages site, never the repository (README / blob).
const PAGES_URL = 'https://allansantos-dv.github.io/claude-code-plugins/claude-code-boss/';
const CHANGELOG_URL = `${PAGES_URL}changelog.html`;
const CHECK_EVERY_MS = 6 * 3600 * 1000;
// Claude Code refreshes the marketplaces up to 10 min after a session's first message; an hour behind is no delay.
const STALE_MS = 3600 * 1000;
const PLUGIN = 'claude-code-boss';
const DEFAULT_MARKETPLACE = 'allansantos-plugins';
const OFF = /^(0|false|off|no)$/i;

/** The two commands that bring a release in, in the order that works. */
function updateCommands(marketplace) {
  return `\`claude plugin marketplace update ${marketplace}\` e depois \`claude plugin update ${PLUGIN}@${marketplace}\``;
}

/**
 * The local marketplace clone Claude Code updates from: its plugin version and auto-update flag.
 * @returns {{name: string, version?: string, autoUpdate?: boolean, lastUpdated?: string, location?: string, error?: string}}
 */
function marketplaceCopy(root, env) {
  const mkt = require('./marketplace-autoupdate.js');
  const name = mkt.marketplaceOf(root) || DEFAULT_MARKETPLACE;
  try {
    const known = JSON.parse(fs.readFileSync(path.join(mkt.configDir(env), 'plugins', 'known_marketplaces.json'), 'utf8'));
    const entry = known[name];
    if (!entry || !entry.installLocation) return { name, error: `marketplace ${name} não está em known_marketplaces.json` };
    const manifest = JSON.parse(fs.readFileSync(path.join(entry.installLocation, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const plugin = (manifest.plugins || []).find((p) => p && p.name === PLUGIN);
    if (!plugin) return { name, error: `${PLUGIN} não está no marketplace.json da cópia local (${entry.installLocation})` };
    let version = plugin.version;
    if (typeof plugin.source === 'string') {
      const pj = path.join(entry.installLocation, plugin.source, '.claude-plugin', 'plugin.json');
      if (fs.existsSync(pj)) version = JSON.parse(fs.readFileSync(pj, 'utf8')).version || version;
    }
    if (!version) return { name, error: `a cópia local do marketplace (${entry.installLocation}) não declara a versão de ${PLUGIN}` };
    return { name, version: String(version), autoUpdate: entry.autoUpdate === true, lastUpdated: entry.lastUpdated, location: entry.installLocation };
  } catch (err) {
    return { name, error: `cópia local do marketplace ${name} ilegível: ${err.message}` };
  }
}

function autoUpdateDisabled(env = process.env) {
  return OFF.test(String(env.CLAUDE_CODE_BOSS_AUTO_UPDATE || '').trim());
}

/**
 * The variable that switches Claude Code's whole plugin auto-update pass off, or null.
 * With one of these set and no FORCE_AUTOUPDATE_PLUGINS=1, `autoUpdate: true` on the marketplace
 * does nothing (code.claude.com/docs/en/plugins/loading, "When auto-update runs").
 */
function ccAutoUpdateBlockedBy(env = process.env) {
  const on = (v) => /^(1|true)$/i.test(String(v || '').trim());
  if (on(env.FORCE_AUTOUPDATE_PLUGINS)) return null;
  return ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'].find((k) => on(env[k])) || null;
}

function stateFile(dir) {
  return path.join(dir || require('../../engine/lib/data-dir.js').globalDir(), STATE);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`[update-notice] ${file} unreadable (${err.message}) — starting fresh`);
    return {};
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  require('../../engine/lib/atomic-write.js').writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Run fn() holding the state file's lock. Sessions of two plugin versions write this file at once: without the lock an
 * older session's stale snapshot can overwrite what a newer one just wrote. Brief retries, then null (caller defers).
 */
function withStateLock(file, fn) {
  const { acquireFileLock, releaseFileLock } = require('../../engine/lib/process-lock.js');
  const lockFile = `${file}.lock`;
  let lock = { acquired: false, reason: 'not tried' };
  for (let i = 0; i < 5 && !lock.acquired; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    lock = acquireFileLock(lockFile);
  }
  if (!lock.acquired) { console.error(`[update-notice] ${lockFile} busy (${lock.reason}) — deferred`); return null; }
  try { return fn(); } finally { releaseFileLock(lockFile, lock.owner); }
}

function installedVersion(root) {
  return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '');
}

/**
 * SessionStart: refresh the cached latest release (network, bounded by the caller's ceiling).
 * @param {{ root:string, dir?:string, env?:object, now?:number, fetchLatest?:(root:string)=>Promise<{latest:string|null}> }} o
 * @returns {Promise<{status:'disabled'|'fresh'|'checked'|'error', latest?:string, error?:string}>}
 */
async function refreshLatest({ root, dir, env = process.env, now = Date.now(), fetchLatest } = {}) {
  if (autoUpdateDisabled(env)) return { status: 'disabled' };
  const file = stateFile(dir);
  const st = readState(file);
  if (st.checkedAt && now - Date.parse(st.checkedAt) < CHECK_EVERY_MS) return { status: 'fresh', latest: st.latest };
  try {
    const r = await (fetchLatest || require('./plugin-updater.js').checkForUpdate)(root);
    if (!r || !r.latest) throw new Error('release lookup returned no version');
    const saved = withStateLock(file, () => { writeState(file, { ...readState(file), latest: r.latest, checkedAt: new Date(now).toISOString() }); return true; });
    if (!saved) throw new Error(`${file} stayed locked — latest ${r.latest} not cached, the next session checks again`);
    return { status: 'checked', latest: r.latest };
  } catch (err) {
    console.error(`[update-notice] version check failed: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

/**
 * UserPromptSubmit: the visible messages still owed to the user (each told once).
 * @param {{root: string, dir?: string, env?: object, now?: number}} o
 * @returns {string[]}
 */
function takeUpdateNotices({ root, dir, env = process.env, now = Date.now() } = {}) {
  const file = stateFile(dir);
  const installed = installedVersion(root);
  // Lock busy: another session is updating the state right now; this prompt says nothing and the next one decides.
  return withStateLock(file, () => takeLocked(file, installed, env, root, now)) || [];
}

function takeLocked(file, installed, env, root, now) {
  const { compareSemver } = require('./plugin-updater.js');
  const st = readState(file);
  const out = [];
  // A session opened before an update keeps running the previous version's hooks, and releases up to 3.14.1 write
  // { ...state, seenVersion: <their version> } with no guard. They carry unknown fields over untouched, so the
  // highest version seen lives in highestSeen too: the rewound seenVersion is ignored and never re-announced.
  const seen = st.highestSeen && (!st.seenVersion || compareSemver(st.highestSeen, st.seenVersion) > 0) ? st.highestSeen : st.seenVersion;
  if (seen && seen !== installed && compareSemver(installed, seen) > 0) {
    out.push(`claude-code-boss foi atualizado: ${seen} → ${installed}. Novidades: ${CHANGELOG_URL}`);
  }
  const top = seen && compareSemver(installed, seen) < 0 ? seen : installed;
  const next = { ...st, seenVersion: top, highestSeen: top };
  const pending = !autoUpdateDisabled(env) && st.latest && compareSemver(st.latest, installed) > 0;
  const blockedBy = ccAutoUpdateBlockedBy(env);
  const copy = pending ? marketplaceCopy(root, env) : null;
  if (pending && st.announcedLatest !== st.latest) {
    const how = blockedBy
      ? `A atualização automática NÃO vai rodar: ${blockedBy} está definido no ambiente desta sessão e desliga as atualizações de plugin do Claude Code; defina também FORCE_AUTOUPDATE_PLUGINS=1, ou atualize à mão.`
      : 'Com a atualização automática ligada ela chega sozinha numa próxima sessão.';
    out.push(`claude-code-boss: versão ${st.latest} disponível (instalada: ${installed}). ${how} Para atualizar agora, rode ${updateCommands(copy.name)}: o update lê a cópia local do marketplace e, sem o primeiro comando, responde que já está na última versão. Novidades: ${CHANGELOG_URL}. Desligar os avisos e a atualização automática: CLAUDE_CODE_BOSS_AUTO_UPDATE=0.`);
    next.announcedLatest = st.latest;
  }
  const behind = copy && (copy.error || compareSemver(st.latest, copy.version) > 0);
  if (!behind) delete next.staleSince;
  else {
    const since = st.staleSince && st.staleSince.latest === st.latest ? st.staleSince : { latest: st.latest, at: new Date(now).toISOString() };
    next.staleSince = since;
    if (copy.error && st.announcedStale !== st.latest) {
      out.push(`claude-code-boss: a versão ${st.latest} não tem como chegar: ${copy.error}. Rode ${updateCommands(copy.name)} e veja o erro.`);
      next.announcedStale = st.latest;
    } else if (!copy.error && copy.autoUpdate && !blockedBy && now - Date.parse(since.at) >= STALE_MS && st.announcedStale !== st.latest) {
      const hours = Math.floor((now - Date.parse(since.at)) / 3600_000);
      out.push(`claude-code-boss: a atualização do marketplace ${copy.name} não está trazendo a versão ${st.latest}: a cópia local (${copy.location}) continua em ${copy.version} há ${hours} h${copy.lastUpdated ? `, última atualização bem-sucedida em ${copy.lastUpdated}` : ''}, com a atualização automática ligada. Rode \`claude plugin marketplace update ${copy.name}\` para ver o erro e depois \`claude plugin update ${PLUGIN}@${copy.name}\`.`);
      next.announcedStale = st.latest;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(st)) writeState(file, next);
  return out;
}

module.exports = { refreshLatest, takeUpdateNotices, autoUpdateDisabled, ccAutoUpdateBlockedBy, marketplaceCopy, updateCommands, stateFile, STATE, CHECK_EVERY_MS, STALE_MS, PAGES_URL };
