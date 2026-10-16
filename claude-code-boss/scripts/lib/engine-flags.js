'use strict';
/**
 * engine-flags.js — what Claude Code itself is doing about idle compaction on this machine.
 *
 * Since 2.1.286 the engine can compact a long session while it is idle, at ~90% of the 1 h cache TTL — the cache
 * is still warm, so the summary is read from it instead of re-written. The feature is rolled out by a remote
 * flag (`tengu_sunny_locket`: mode off | log | compact | compact_on_return, cached by the engine in `.claude.json`)
 * and needs the 1 h TTL; the user's `idleCompaction: false` switches it off, and so do DISABLE_COMPACT /
 * DISABLE_AUTO_COMPACT (read from the engine binary, 2.1.300).
 *
 * The plugin's folder-ttl switches a folder to the 5 m TTL so its cache goes cold and its own cut can come; that
 * would turn the engine's idle compaction OFF for exactly the sessions it would help. When the engine does it, the
 * plugin steps aside. The flag lives in the engine's private cache, not in a documented setting, so every read
 * that fails is reported (never guessed): an unreadable cache is "unknown" and the plugin keeps its own behaviour.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FLAG = 'tengu_sunny_locket';
const ACTIVE_MODES = ['compact', 'compact_on_return'];

function configDir(env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

/**
 * Is the engine's idle compaction going to run for this user?
 * @param {{env?:object, home?:string}} [opts]  env/home injectable for tests
 * @returns {{active:boolean, mode:(string|null), known:boolean, reason:string}}
 *   known=false: the cache could not be read — `active` is false and `reason` says why.
 */
function idleCompaction({ env = process.env, home = os.homedir() } = {}) {
  if (truthy(env.DISABLE_COMPACT) || truthy(env.DISABLE_AUTO_COMPACT)) return { active: false, mode: null, known: true, reason: 'compaction disabled by environment' };
  const dir = env.CLAUDE_CONFIG_DIR ? configDir(env) : path.join(home, '.claude');
  try {
    const settings = readJson(path.join(dir, 'settings.json'));
    if (settings && (settings.idleCompaction === false || settings.autoCompactEnabled === false)) return { active: false, mode: null, known: true, reason: 'switched off in settings.json' };
    // `.claude.json` sits next to the config dir for the default location and inside it for CLAUDE_CONFIG_DIR.
    const cache = readJson(env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'));
    const flag = cache && cache.cachedGrowthBookFeatures && cache.cachedGrowthBookFeatures[FLAG];
    if (!flag) return { active: false, mode: null, known: true, reason: 'the engine has no idle-compaction flag cached (off)' };
    const mode = typeof flag.mode === 'string' ? flag.mode : 'off';
    return { active: ACTIVE_MODES.includes(mode), mode, known: true, reason: `engine flag ${FLAG} mode=${mode}` };
  } catch (err) {
    return { active: false, mode: null, known: false, reason: `could not read the engine's cached flag: ${err.message}` };
  }
}

module.exports = { idleCompaction, FLAG, ACTIVE_MODES };
