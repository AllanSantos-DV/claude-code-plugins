'use strict';
/**
 * lib/plugin-dir-heal.js — restore the plugin dirs of open sessions against the registry's install.
 * Thin wiring of session-root.healMissingPluginRoots for the hook dispatchers.
 */
const { cacheBaseOf, registryInstallPath } = require('./cache-prune.js');
const { healMissingPluginRoots } = require('./session-root.js');

/** @returns {{healed:string[], failed:{dir:string,error:string}[]}} */
function healOpenSessions(o = {}) {
  return healMissingPluginRoots({
    base: o.base,
    cacheBase: o.cacheBase || cacheBaseOf(),
    current: o.current === undefined ? registryInstallPath() : o.current,
  });
}

module.exports = { healOpenSessions };
