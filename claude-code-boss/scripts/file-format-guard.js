#!/usr/bin/env node
/**
 * file-format-guard.js — PreToolUse + PostToolUse hook on the `Write` tool.
 *
 * Write replaces the whole file with the text the agent produced, and that text has LF
 * line endings and no BOM: overwriting a CRLF (or BOM-prefixed) file silently flips every
 * line in git. The agent never has to know: PreToolUse records the EOL/BOM of the file
 * about to be overwritten, PostToolUse puts them back on the written file. Byte-level
 * (latin1 round trip) so no encoding is touched. Files that are binary, UTF-16, mixed
 * or newline-less are left as written; state lives in tmpdir, keyed by session + path.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const hooksConfig = require('./lib/hooks-config.js');
const metrics = require('../engine/lib/metrics.js');
const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');

const MAX_BYTES = 5 * 1024 * 1024;
const STATE_TTL_MS = 24 * 3600 * 1000;
const stateDir = () => path.join(os.tmpdir(), 'ccb-file-format-guard');

/**
 * @param {Buffer} buf
 * @returns {{text: boolean, bom: boolean, eol: 'crlf'|'lf'|'mixed'|'none'}} text=false for binary/UTF-16/oversized
 */
function formatOf(buf) {
  const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (utf16 || buf.length > MAX_BYTES || buf.subarray(0, 8192).includes(0)) return { text: false, bom: false, eol: 'none' };
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const s = buf.toString('latin1');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  const eol = crlf && !lf ? 'crlf' : lf && !crlf ? 'lf' : crlf && lf ? 'mixed' : 'none';
  return { text: true, bom, eol };
}

/** @returns {{buf: Buffer, flips: string[]}|null} corrected bytes, or null when nothing needs restoring */
function restore(buf, prior) {
  const cur = formatOf(buf);
  if (!cur.text) return null;
  let s = buf.toString('latin1');
  if (cur.bom) s = s.slice(3);
  const flips = [];
  if (prior.eol === 'crlf' && cur.eol !== 'crlf' && cur.eol !== 'none') { s = s.replace(/\r?\n/g, '\r\n'); flips.push('eol'); }
  else if (prior.eol === 'lf' && cur.eol !== 'lf' && cur.eol !== 'none') { s = s.replace(/\r\n/g, '\n'); flips.push('eol'); }
  if (prior.bom && !cur.bom) flips.push('bom');
  else if (!prior.bom && cur.bom) flips.push('bom');
  if (!flips.length) return null;
  const out = Buffer.from(s, 'latin1');
  return { buf: prior.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out]) : out, flips };
}

/** Tmp state path for one (session, file) pair. */
function stateFile(event, file) {
  const key = crypto.createHash('sha1').update(`${event.session_id || ''}\n${path.resolve(event.cwd || '', file)}`).digest('hex');
  return path.join(stateDir(), `${key}.json`);
}

/** Drops state files older than a day (a Write that was denied never reaches PostToolUse). */
function prune() {
  const now = Date.now();
  for (const f of fs.readdirSync(stateDir())) {
    const p = path.join(stateDir(), f);
    if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
  }
}

/** PreToolUse: remember the format of the file about to be overwritten. */
function capture(event, file) {
  const abs = path.resolve(event.cwd || '', file);
  fs.mkdirSync(stateDir(), { recursive: true });
  prune();
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { fs.rmSync(stateFile(event, file), { force: true }); return; }
  const prior = formatOf(fs.readFileSync(abs));
  if (prior.text) fs.writeFileSync(stateFile(event, file), JSON.stringify(prior));
  else fs.rmSync(stateFile(event, file), { force: true });
}

/** PostToolUse: put the remembered EOL/BOM back on the written file. */
function apply(event, file) {
  const sf = stateFile(event, file);
  if (!fs.existsSync(sf)) return;
  const prior = JSON.parse(fs.readFileSync(sf, 'utf8'));
  fs.rmSync(sf, { force: true });
  const abs = path.resolve(event.cwd || '', file);
  const fixed = restore(fs.readFileSync(abs), prior);
  if (!fixed) return;
  fs.writeFileSync(abs, fixed.buf);
  metrics.fire('fileformat.restored', { tool: event.tool_name, flips: fixed.flips, eol: prior.eol, bom: prior.bom }, { sessionId: event.session_id, cwd: event.cwd });
}

/**
 * @param {object} event hook payload (PreToolUse or PostToolUse on Write)
 * @returns {object} always {} — it only repairs the file on disk
 */
function run(event) {
  if (!event || event.tool_name !== 'Write' || !hooksConfig.getFileFormatGuard().enabled) return {};
  const file = event.tool_input && event.tool_input.file_path;
  if (typeof file !== 'string' || !file) return {};
  if (event.hook_event_name === 'PreToolUse') capture(event, file);
  else if (event.hook_event_name === 'PostToolUse') apply(event, file);
  return {};
}

if (require.main === module) {
  readStdin().then((raw) => {
    try { run(parsePayload(raw)); } catch (err) { console.error(`[file-format-guard] ${err.message}`); }
    emitEmpty();
  });
}

module.exports = { run, formatOf, restore };
