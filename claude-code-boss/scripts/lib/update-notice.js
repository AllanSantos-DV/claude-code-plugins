'use strict';
/**
 * update-notice.js — the two VISIBLE update messages (nothing about updates is hidden):
 *   1. "new version available": SessionStart (refreshLatest) asks GitHub for the newest
 *      `v<X.Y.Z>` release at most every 6h and caches it; the next prompt (takeUpdateNotices)
 *      tells the user once per version.
 *   2. "plugin updated": the version at CLAUDE_PLUGIN_ROOT differs from the last one this
 *      machine saw → told once. First run only records the version (the welcome covers it).
 * Both ride the UserPromptSubmit `systemMessage` (the only hook channel that reaches the user).
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
const OFF = /^(0|false|off|no)$/i;

function autoUpdateDisabled(env = process.env) {
  return OFF.test(String(env.CLAUDE_CODE_BOSS_AUTO_UPDATE || '').trim());
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
    writeState(file, { ...readState(file), latest: r.latest, checkedAt: new Date(now).toISOString() });
    return { status: 'checked', latest: r.latest };
  } catch (err) {
    console.error(`[update-notice] version check failed: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

/**
 * UserPromptSubmit: the visible messages still owed to the user (each told once).
 * @returns {string[]}
 */
function takeUpdateNotices({ root, dir, env = process.env } = {}) {
  const { compareSemver } = require('./plugin-updater.js');
  const file = stateFile(dir);
  const st = readState(file);
  const installed = installedVersion(root);
  const out = [];
  if (st.seenVersion && st.seenVersion !== installed && compareSemver(installed, st.seenVersion) > 0) {
    out.push(`claude-code-boss foi atualizado: ${st.seenVersion} → ${installed}. Novidades: ${CHANGELOG_URL}`);
  }
  const next = { ...st, seenVersion: installed };
  if (!autoUpdateDisabled(env) && st.latest && compareSemver(st.latest, installed) > 0 && st.announcedLatest !== st.latest) {
    out.push(`claude-code-boss: versão ${st.latest} disponível (instalada: ${installed}). Com a atualização automática ligada ela chega sozinha na próxima sessão; senão, /plugin → Marketplaces → Update. Desligar os avisos e a atualização automática: CLAUDE_CODE_BOSS_AUTO_UPDATE=0.`);
    next.announcedLatest = st.latest;
  }
  if (next.seenVersion !== st.seenVersion || next.announcedLatest !== st.announcedLatest) writeState(file, next);
  return out;
}

module.exports = { refreshLatest, takeUpdateNotices, autoUpdateDisabled, stateFile, STATE, CHECK_EVERY_MS, PAGES_URL };
