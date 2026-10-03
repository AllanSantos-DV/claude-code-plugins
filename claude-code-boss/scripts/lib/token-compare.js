'use strict';
const crypto = require('crypto');

/**
 * Constant-time token comparison, length-guarded. `crypto.timingSafeEqual` THROWS
 * on buffers of different length, so the length check both avoids the throw and
 * short-circuits obviously wrong tokens. An empty secret never authenticates
 * anyone (two empty buffers compare "equal" under timingSafeEqual).
 *
 * @param {*} given     the token the client sent (header value; may be absent)
 * @param {*} expected  the server's secret
 * @returns {boolean}
 */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(String(expected == null ? '' : expected));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { tokenMatches };
