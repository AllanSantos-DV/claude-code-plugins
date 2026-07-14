'use strict';
/**
 * data-dir.js — the ONE canonical resolver for the plugin data directory.
 *
 * Every hook/script writes runtime state under a data dir. Historically each
 * one inlined `process.env.CLAUDE_PLUGIN_DATA || <home fallback>`. That naive
 * form has a subtle split-brain bug: some hook-launch contexts do NOT expand
 * the `${CLAUDE_PLUGIN_DATA}` placeholder, so the env var arrives as the literal
 * string "${CLAUDE_PLUGIN_DATA}". The naive `env || fallback` then treats that
 * literal as a real directory — while the few scripts that already guarded
 * against `${` fell back to the home path. Result: some scripts read/write state
 * in a bogus "${CLAUDE_PLUGIN_DATA}" folder and others in the real one — the
 * plugin's state fragments across two locations.
 *
 * This module centralizes the guarded resolution so every consumer agrees.
 */
const path = require('path');
const os = require('os');

const HOME_FALLBACK = () =>
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

/**
 * A CLAUDE_PLUGIN_DATA env value is only usable when it's a non-blank string
 * that isn't an unexpanded `${...}` placeholder. Otherwise callers must fall
 * back so state doesn't scatter into a literal-placeholder / bogus directory.
 * @param {*} v
 * @returns {string|null} the value when usable, else null
 */
function validEnvDir(v) {
  return typeof v === 'string' && v.trim().length > 0 && !v.includes('${') ? v : null;
}

/**
 * Resolve the plugin data directory. Honors a real CLAUDE_PLUGIN_DATA, but
 * rejects empty / unexpanded-placeholder values in favor of the stable home
 * path — so every script resolves the SAME directory.
 * @returns {string}
 */
function dataDir() {
  return validEnvDir(process.env.CLAUDE_PLUGIN_DATA) || HOME_FALLBACK();
}

module.exports = { dataDir, validEnvDir };
