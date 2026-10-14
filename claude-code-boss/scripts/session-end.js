#!/usr/bin/env node
/**
 * session-end.js — SessionEnd hook: forget the ended session's root record
 * (lib/session-root.js). SessionStart records session_id → root for the daemon; without
 * this, every session's file stayed for the 7-day TTL (123 measured on 2026-10-11) and
 * each model MCP call re-read them all. Side effect only, never blocks the session end.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');

/** Remove the record of `event.session_id`. Returns true when a record was removed. */
function run(event, opts = {}) {
  const sid = event && (event.session_id || event.sessionId);
  if (!sid) return false;
  return require('./lib/session-root.js').forgetSessionRoot(sid, opts);
}

if (require.main === module) {
  require('./lib/hook-prefix.js').install('session-end');
  readStdin()
    .then((raw) => { run(parsePayload(raw) || {}); })
    .catch((err) => { console.error(`[claude-code-boss:session-end] ${err && err.message ? err.message : err}`); })
    .finally(() => emitEmpty());
}

module.exports = { run };
