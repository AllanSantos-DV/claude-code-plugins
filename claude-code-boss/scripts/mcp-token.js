#!/usr/bin/env node
/**
 * mcp-token.js — keep the Bearer token of a remote memory server in the system vault.
 *
 *   node scripts/mcp-token.js set      token read from stdin (never from the command line)
 *   node scripts/mcp-token.js status   says whether a token is stored; never prints it
 *   node scripts/mcp-token.js delete
 */
'use strict';

const fs = require('fs');
const vault = require('../engine/lib/mcp-token-vault.js');
const { dataDir } = require('../engine/lib/data-dir.js');

/**
 * @param {string} command set | status | delete
 * @param {{home?: string, readStdin?: () => string}} [deps] test seams
 * @returns {string} the line to print
 */
function run(command, { home = dataDir(), readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (command === 'set') {
    const token = readStdin().trim();
    if (!token) throw new Error('no token on stdin');
    const { store } = vault.saveToken(home, vault.TOKEN_REF, token);
    return `token stored in the system vault (${store})`;
  }
  if (command === 'status') return vault.loadToken(home, vault.TOKEN_REF) ? 'token stored' : 'no token stored';
  if (command === 'delete') { vault.deleteToken(home, vault.TOKEN_REF); return 'token removed'; }
  throw new Error('usage: node scripts/mcp-token.js set|status|delete   (token for "set" on stdin)');
}

if (require.main === module) {
  try { console.log(run(process.argv[2])); } catch (err) { console.error(`[mcp-token] ${err.message}`); process.exit(1); }
}

module.exports = { run };
