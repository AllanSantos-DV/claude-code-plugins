'use strict';
/**
 * test-egress-guard.cjs — TEST-ONLY: refuse any network request to a non-loopback
 * host, so a unit test (or a child it spawns, via NODE_OPTIONS --require) fails
 * locally and by host instead of silently reaching the internet.
 * Loaded by scripts/test-units.js; never by plugin runtime code.
 */
const http = require('http');
const https = require('https');
const net = require('net');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '']);

function hostOf(input, options) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(String(input)).hostname;
    const o = input && typeof input === 'object' ? input : (options || {});
    return String(o.hostname || o.host || 'localhost').replace(/:\d+$/, '');
  } catch (err) { void err; return 'localhost'; }
}

function refuse(host) {
  const err = new Error(`network egress forbidden in unit tests: ${host} (set CCB_TEST_ALLOW_NET=1 for a deliberate online run)`);
  err.code = 'ECCB_EGRESS';
  return err;
}

for (const mod of [http, https]) {
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function guarded(input, options, cb) {
      const host = hostOf(input, typeof options === 'object' ? options : undefined);
      if (!LOOPBACK.has(host)) throw refuse(host);
      return orig.apply(this, arguments);
    };
  }
}

const origConnect = net.connect;
const guardSocket = function guardedConnect(...args) {
  const a = args[0];
  const host = a && typeof a === 'object' ? (a.host || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!(a && typeof a === 'object' && a.path) && !LOOPBACK.has(String(host))) throw refuse(host);
  return origConnect.apply(this, args);
};
net.connect = guardSocket;
net.createConnection = guardSocket;

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
    let host = 'localhost';
    try { host = new URL(url).hostname; } catch (err) { void err; }
    if (!LOOPBACK.has(host)) return Promise.reject(refuse(host));
    return origFetch.call(this, input, init);
  };
}
