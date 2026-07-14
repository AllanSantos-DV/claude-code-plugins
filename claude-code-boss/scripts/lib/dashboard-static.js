'use strict';
/**
 * dashboard-static.js — the path-traversal guard for the dashboard's static
 * file server, extracted from dashboard.js so it's unit-testable in isolation.
 */
const path = require('path');

/**
 * Resolve a request URL to a file path INSIDE `dashboardDir`, or null when the
 * normalized path would escape the directory — the anti-traversal guard.
 *
 * The `path.sep` suffix on the prefix check is load-bearing: a bare
 * `startsWith(dashboardDir)` would also accept a sibling like `<dir>-evil`.
 *
 * @param {string} dashboardDir  absolute root the server may serve from
 * @param {string} urlPath  req.url (raw, not URL-decoded — matches prior behavior)
 * @returns {string|null} safe absolute path, or null if it escapes the root
 */
function resolveStaticPath(dashboardDir, urlPath) {
  const raw = urlPath === '/'
    ? path.join(dashboardDir, 'index.html')
    : path.join(dashboardDir, urlPath);
  const filePath = path.normalize(raw);
  if (filePath !== dashboardDir && !filePath.startsWith(dashboardDir + path.sep)) return null;
  return filePath;
}

module.exports = { resolveStaticPath };
