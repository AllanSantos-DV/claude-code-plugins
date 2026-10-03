'use strict';
/**
 * secret-file.js — a local secret kept in a file only its owner can read (0600):
 * the brain daemon token and the model-router identity token.
 *
 * Written with a DIRECT writeFileSync on purpose: the atomic helper (temp+rename)
 * does not carry the restrictive mode onto the final file.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The secret in `file` (trimmed), or null when absent/unreadable/empty. */
function readSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch (e) { void e; return null; }
}

/** Write `value` to `file` with mode 0600, creating its folder. Throws on failure. */
function writeSecret(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

/**
 * Read-or-create (idempotent, reused across restarts): a fresh `bytes`-byte hex
 * secret only when the file has none. A failed write still returns the secret,
 * enforced in memory for this run.
 */
function ensureSecret(file, bytes) {
  const existing = readSecret(file);
  if (existing) return existing;
  const tok = crypto.randomBytes(bytes).toString('hex');
  try { writeSecret(file, tok); } catch (e) { console.error(`[secret-file] could not persist ${file}: ${e.message}`); }
  return tok;
}

module.exports = { readSecret, writeSecret, ensureSecret };
