'use strict';
/**
 * dashboard-auth.js — pure auth predicates for the localhost dashboard server.
 *
 * Extracted from dashboard.js so they're unit-testable: dashboard.js starts its
 * HTTP server at module load, so the auth logic could never be exercised in
 * isolation. `checkAuth` in dashboard.js wires these to the live req/res.
 */
const { tokenMatches } = require('./token-compare.js');

/**
 * The Host header must name the loopback interface on the bound port. Rejecting
 * anything else is the anti-DNS-rebinding guard: a malicious page that resolves
 * its own hostname to 127.0.0.1 still can't talk to the dashboard because the
 * forged Host header won't match.
 * @param {string} host  req.headers.host
 * @param {number|string} port  the port the server is bound to
 * @returns {boolean}
 */
function isValidHost(host, port) {
  if (!host) return false;
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

module.exports = { isValidHost, tokenMatches };
