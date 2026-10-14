'use strict';
/**
 * node-support.js — which Node runs the plugin, and with which flags.
 *
 * Tested range: Node 22.13 (first with node:sqlite) up to the 24 LTS line. Node 25 aborted
 * the Brain daemon with 0xC0000409 under parallel HTTPS calls on a second machine, and the
 * crashes stopped on Node 24 LTS — so a newer major is reported as a failure, not a nicety.
 * The daemon inherits NODE_OPTIONS from whichever hook spawns it; a JIT flag left there as a
 * workaround (--no-maglev was) keeps running in a configuration nobody tests.
 */

const MIN_NODE = [22, 13, 0];
const MAX_TESTED_MAJOR = 24;
const NODE_LTS_URL = 'https://nodejs.org/en/download';
const RANGE_TEXT = `${MIN_NODE[0]}.${MIN_NODE[1]} – ${MAX_TESTED_MAJOR}.x`;

/** @returns {{ok:boolean, version:string, reason:null|'old'|'new'|'unknown'}} */
function nodeSupport(version = process.version) {
  const raw = String(version || '').replace(/^v/, '');
  const p = raw.split('.').map((n) => parseInt(n, 10));
  if (p.length < 2 || p.some((n) => !Number.isInteger(n))) return { ok: false, version: raw, reason: 'unknown' };
  for (let i = 0; i < 3; i++) {
    if ((p[i] || 0) === MIN_NODE[i]) continue;
    if ((p[i] || 0) < MIN_NODE[i]) return { ok: false, version: raw, reason: 'old' };
    break;
  }
  if (p[0] > MAX_TESTED_MAJOR) return { ok: false, version: raw, reason: 'new' };
  return { ok: true, version: raw, reason: null };
}

/** One sentence on what is wrong and what to install; '' when the version is supported. */
function supportAdvice(s) {
  if (s.ok) return '';
  if (s.reason === 'new') {
    return `Node v${s.version} is newer than the tested range (${RANGE_TEXT}); Node 25 aborted the Brain daemon (0xC0000409) under parallel HTTPS calls. ` +
      `Install Node ${MAX_TESTED_MAJOR} LTS (${NODE_LTS_URL}), make it the \`node\` on PATH and restart Claude Code.`;
  }
  return `Node v${s.version || '?'} is older than ${MIN_NODE.join('.')} (node:sqlite). Install Node ${MAX_TESTED_MAJOR} LTS (${NODE_LTS_URL}) and restart Claude Code.`;
}

/** NODE_OPTIONS as a flag list (plain whitespace split: Node itself rejects most quoting). */
function parseNodeOptions(s) {
  return String(s || '').split(/\s+/).filter(Boolean);
}

// The only flags the supervisor itself passes (crash-evidence.reportFlags).
const OWN_FLAGS = ['--report-on-fatalerror', '--report-uncaught-exception', '--report-directory'];
const flagName = (f) => String(f).split('=')[0];

/** Flags the daemon gets that the plugin did not choose. */
function foreignFlags(flags) {
  return (flags || []).filter((f) => !OWN_FLAGS.includes(flagName(f)));
}

/** Own flags a running daemon lacks (it was started by an older version). */
function missingOwnFlags(execArgv) {
  const names = new Set((execArgv || []).map(flagName));
  return OWN_FLAGS.filter((f) => !names.has(f));
}

module.exports = { MIN_NODE, MAX_TESTED_MAJOR, NODE_LTS_URL, RANGE_TEXT, OWN_FLAGS, nodeSupport, supportAdvice, parseNodeOptions, foreignFlags, missingOwnFlags };
