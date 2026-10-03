'use strict';
const http = require('http');
const https = require('https');

/**
 * GET `<baseUrl>/health`. Never rejects: { status, body } on an answer, or
 * { status: 0, error } (bad URL / timeout / connection error). Callers decide what
 * counts as healthy (the wizard wants 200; the config tester also accepts 503).
 */
function probeHealth(baseUrl, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(baseUrl).replace(/\/+$/, '') + '/health'); }
    catch (err) { return resolve({ status: 0, error: `bad URL: ${err.message}` }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

module.exports = { probeHealth };
