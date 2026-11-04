'use strict';
/**
 * lib/mcp-launcher.js — keeps the version-proof `headersHelper` launcher in the plugin data dir.
 * The copy is what `.mcp.json` runs first (see scripts/mcp-headers-launcher.cjs for why).
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../../engine/lib/atomic-write.js');

const LAUNCHER_NAME = 'mcp-headers-launcher.cjs';
const SOURCE = path.join(__dirname, '..', LAUNCHER_NAME);

/**
 * Copy the launcher into `dataDir` when it is missing or differs. Never throws: the
 * `.mcp.json` fallback still reaches the versioned helper.
 * @param {string} dataDir
 * @returns {{installed:boolean, file:string}}
 */
function installLauncher(dataDir) {
  const file = path.join(dataDir, LAUNCHER_NAME);
  try {
    const want = fs.readFileSync(SOURCE);
    let have = null;
    try { have = fs.readFileSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (have && have.equals(want)) return { installed: false, file };
    fs.mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(file, want);
    return { installed: true, file };
  } catch (err) {
    console.error(`[mcp-launcher] could not install ${file}: ${err.message}`);
    return { installed: false, file };
  }
}

module.exports = { installLauncher, LAUNCHER_NAME };
