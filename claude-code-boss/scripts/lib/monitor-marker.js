'use strict';
/**
 * lib/monitor-marker.js — tells the Bash-matcher hooks that a command is really a Monitor call.
 *
 * Claude Code runs the PreToolUse hooks of the `Bash` matcher for a Monitor call too, with
 * tool_name "Bash" and only `command` + `description`; the Monitor matcher gets the true name in a
 * second, concurrent invocation. That second invocation records a short-lived marker keyed by the
 * session and a hash of the command; the Bash-side rule asks for it before refusing a wait.
 * Only a Monitor invocation writes a marker, so nothing a Bash command says can fake one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sanitizeSessionId } = require('../../engine/lib/session-id.js');
const { dataDir } = require('../../engine/lib/data-dir.js');

const FRESH_MS = 30 * 1000;
const WAIT_MS = 600;
const STEP_MS = 25;
const PREFIX = 'monitor-marker-';

const runtimeDir = () => path.join(dataDir(), '.runtime');

function markerPath(dir, sessionId, command) {
  const hash = crypto.createHash('sha1').update(`${sanitizeSessionId(sessionId)}\0${command}`).digest('hex');
  return path.join(dir, `${PREFIX}${hash}.json`);
}

function sweep(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(PREFIX)) continue;
    const file = path.join(dir, name);
    let at = 0;
    try { at = JSON.parse(fs.readFileSync(file, 'utf8')).at; } catch (err) { if (!(err instanceof SyntaxError) && err.code !== 'ENOENT') throw err; }
    if (now - at > FRESH_MS * 4) fs.rmSync(file, { force: true });
  }
}

/**
 * Records that `command` is being started by the Monitor tool in this session.
 * @param {string} sessionId
 * @param {string} command
 * @param {{dir?:string, now?:number}} [opts] test seams
 * @returns {string} the marker file
 */
function record(sessionId, command, opts = {}) {
  const dir = opts.dir || runtimeDir();
  const now = opts.now ?? Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const file = markerPath(dir, sessionId, command);
  fs.writeFileSync(file, JSON.stringify({ at: now }));
  sweep(dir, now);
  return file;
}

/**
 * Is there a fresh Monitor marker for this command? Both hooks fire together, so it waits a
 * moment for the Monitor side to land before answering no.
 * @param {string} sessionId
 * @param {string} command
 * @param {{dir?:string, waitMs?:number, now?:()=>number}} [opts] test seams
 * @returns {Promise<boolean>}
 */
async function seen(sessionId, command, opts = {}) {
  const dir = opts.dir || runtimeDir();
  const now = opts.now || Date.now;
  const waitMs = opts.waitMs ?? WAIT_MS;
  const file = markerPath(dir, sessionId, command);
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const { at } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now() - at <= FRESH_MS) return true;
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    if (now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
}

module.exports = { record, seen, FRESH_MS, WAIT_MS };
