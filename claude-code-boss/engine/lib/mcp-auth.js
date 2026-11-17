'use strict';
/**
 * mcp-auth.js — the Bearer a remote memory server asks for, shared by every client of it.
 *
 * A server the user pointed to advertises `features.auth` on /api/v1/server/health. When it is on,
 * the token comes from the system vault; the MCP client and the graph client both resolve it here,
 * so the rule (probe, vault, loud error, fail open on a probe that does not answer) lives once.
 */

const bearers = new Map();

/** The Bearer token of a remote memory server, from the OS vault (data dir of the plugin). */
function tokenFromVault() {
  const vault = require('./mcp-token-vault.js');
  return vault.loadToken(require('./data-dir.js').dataDir(), vault.TOKEN_REF);
}

/**
 * @param {object} args
 * @param {string} args.baseUrl server base URL, no trailing slash
 * @param {(path: string, timeoutMs: number) => Promise<{alive: boolean, statusCode?: number, health?: object|null, error?: string}>} args.probe
 *   GET of a path under baseUrl, in the shape of McpClient.readHealth
 * @param {() => string|null} [args.loadToken]
 * @param {number} [args.timeoutMs] budget of the features probe
 * @returns {Promise<string>} the Bearer token, or '' when the server needs none or the probe did not answer
 * @throws {Error} code MCP_TOKEN_MISSING when authentication is on and no token is stored
 */
async function resolveBearer({ baseUrl, probe, loadToken = tokenFromVault, timeoutMs = 5000 }) {
  const result = await probe('/api/v1/server/health', timeoutMs);
  if (!result.alive && result.statusCode === 404) return '';
  if (!result.alive && result.statusCode !== 401) {
    console.error(`[MCP] auth probe (features.auth) at ${baseUrl} did not answer (${result.error || result.statusCode}) — continuing without a token`);
    return '';
  }
  const authOn = result.statusCode === 401 || (result.health && result.health.features && result.health.features.auth === true);
  if (!authOn) return '';
  const token = loadToken();
  if (!token) {
    throw Object.assign(new Error(`the memory server at ${baseUrl} requires a Bearer token and none is stored in the system vault — store it with: node scripts/mcp-token.js set (token on stdin)`), { code: 'MCP_TOKEN_MISSING' });
  }
  return token;
}

const keyOf = (base) => String(base || '').replace(/\/+$/, '');

/** Remember (or, with an empty token, forget) the Bearer to send to `base`. */
function rememberBearer(base, token) {
  if (token) bearers.set(keyOf(base), token); else bearers.delete(keyOf(base));
}

/** @returns {string} the Bearer remembered for `base`, '' when there is none */
function bearerFor(base) {
  return bearers.get(keyOf(base)) || '';
}

module.exports = { resolveBearer, rememberBearer, bearerFor, tokenFromVault };
