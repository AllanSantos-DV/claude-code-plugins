'use strict';
/**
 * mcp-token-vault.js — the Bearer token of a remote memory server, kept in the OS vault.
 *
 * Never in JSON nor in an environment variable. No native dependency:
 *   Windows: DPAPI (current-user scope) through PowerShell; the ciphertext blob lives in
 *            <dataDir>/secrets/<ref>.dpapi and only this Windows user can decrypt it.
 *   macOS:   Keychain, driven through `security -i` so the token goes on stdin.
 *   Linux:   Secret Service (`secret-tool`); without it, a clear error — nothing in plain text.
 * On every platform the token travels on stdin, never in the command line.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE = 'ClaudeCodeBoss';
const TOKEN_REF = 'mcp-memory-token';
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const PS_PROTECT = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const PS_UNPROTECT = "Add-Type -AssemblyName System.Security; $e=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser'))";

class VaultError extends Error {
  constructor(message) { super(message); this.name = 'VaultError'; }
}

function execTool(cmd, args, input) {
  try {
    return execFileSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const why = (err.stderr && String(err.stderr).trim()) || err.message;
    throw new VaultError(`the system vault is unavailable (${cmd}): ${why.split('\n')[0]}`);
  }
}

function blobPath(home, ref) {
  if (!/^[a-z0-9-]{1,64}$/.test(ref)) throw new VaultError(`invalid secret reference: ${ref}`);
  return path.join(home, 'secrets', `${ref}.dpapi`);
}

function keychainCommand(verb, ref, token) {
  const base = `${verb} -s ${SERVICE} -a ${ref}`;
  return token === undefined ? base : `${base} -U -w ${JSON.stringify(token)}`;
}

/**
 * Store `token` under `ref`.
 * @param {string} home data directory that holds the Windows blob
 * @param {string} ref secret name, [a-z0-9-]{1,64}
 * @param {string} token
 * @param {{platform?: string, execImpl?: Function}} [opts] `execImpl(cmd, args, input)` is a test seam
 * @returns {{ref: string, store: string}}
 */
function saveToken(home, ref, token, { platform = process.platform, execImpl = execTool } = {}) {
  if (!token || typeof token !== 'string') throw new VaultError('empty token');
  if (platform === 'win32') {
    const blob = execImpl('powershell.exe', [...PS, PS_PROTECT], token);
    const file = blobPath(home, ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob);
    return { ref, store: 'dpapi' };
  }
  blobPath(home, ref);
  if (platform === 'darwin') {
    execImpl('security', ['-i'], `${keychainCommand('add-generic-password', ref, token)}\n`);
    return { ref, store: 'keychain' };
  }
  execImpl('secret-tool', ['store', `--label=${SERVICE} ${ref}`, 'service', SERVICE, 'account', ref], token);
  return { ref, store: 'secret-service' };
}

/**
 * Read the token stored under `ref`.
 * @returns {string|null} null when nothing is stored
 */
function loadToken(home, ref, { platform = process.platform, execImpl = execTool } = {}) {
  if (platform === 'win32') {
    let blob;
    try { blob = fs.readFileSync(blobPath(home, ref), 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return execImpl('powershell.exe', [...PS, PS_UNPROTECT], blob) || null;
  }
  blobPath(home, ref);
  try {
    if (platform === 'darwin') return execImpl('security', ['find-generic-password', '-s', SERVICE, '-a', ref, '-w']) || null;
    return execImpl('secret-tool', ['lookup', 'service', SERVICE, 'account', ref]) || null;
  } catch (err) {
    if (/could not be found|not found|No such|exit code 1/i.test(err.message)) return null;
    throw err;
  }
}

/** Remove the token stored under `ref`; a token that is not there is not an error. */
function deleteToken(home, ref, { platform = process.platform, execImpl = execTool } = {}) {
  if (platform === 'win32') { fs.rmSync(blobPath(home, ref), { force: true }); return; }
  blobPath(home, ref);
  try {
    if (platform === 'darwin') execImpl('security', ['delete-generic-password', '-s', SERVICE, '-a', ref]);
    else execImpl('secret-tool', ['clear', 'service', SERVICE, 'account', ref]);
  } catch (err) {
    if (!/could not be found|not found|No such|exit code 1/i.test(err.message)) throw err;
  }
}

module.exports = { saveToken, loadToken, deleteToken, VaultError, TOKEN_REF };
