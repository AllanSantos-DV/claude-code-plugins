'use strict';
const fs = require('fs');
const path = require('path');

/**
 * The mcp-memory daemon's registry (`<runDir>/daemon.json`) → its base URL, or null
 * when missing/unreadable/incomplete (logged under `label`). `requirePort` also
 * demands the `port` field (the MCP client's stricter check).
 */
function readDaemonUrl(runDir, { label = 'mcp-registry', requirePort = false } = {}) {
  const reg = path.join(runDir, 'daemon.json');
  try {
    const raw = JSON.parse(fs.readFileSync(reg, 'utf8'));
    if (raw && raw.url && (!requirePort || raw.port)) return String(raw.url);
    console.error(`[${label}] daemon.json at ${reg} missing url${requirePort ? '/port' : ''}`);
    return null;
  } catch (err) {
    console.error(`[${label}] daemon registry not found/readable (${reg}): ${err.message}`);
    return null;
  }
}

module.exports = { readDaemonUrl };
