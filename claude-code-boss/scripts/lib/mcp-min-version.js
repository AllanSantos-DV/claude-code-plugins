'use strict';
/**
 * The OFFICIAL minimum mcp-memory-server version that claude-code-boss — and the clients that
 * bootstrap the server through `scripts/mcp-memory-bootstrap.js` (e.g. the whatsapp-bridge) —
 * declare they work with. ONE place: raise it here when a client starts needing a newer
 * server; `mcp-memory-bootstrap.js ensure` brings a machine up to it.
 *
 * 2.49.0 = the version the whatsapp-bridge validated (2026-10-13).
 */
const MIN_SERVER_VERSION = '2.49.0';

module.exports = { MIN_SERVER_VERSION };
