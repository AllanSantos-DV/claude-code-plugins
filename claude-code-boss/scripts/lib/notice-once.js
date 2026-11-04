'use strict';
/**
 * lib/notice-once.js — one on-screen notice per failure, per owner (machine-wide).
 *
 * A down brain daemon used to be reported on every prompt of every session. The ledger keeps,
 * per `key`, the signature of the failure already shown: the same signature stays silent until
 * `recovered(key)` clears it or a different failure arrives. Silence only trims the screen —
 * every call, shown or not, appends its full detail to `brain-notices.log` in the data dir
 * (size-capped, rotated by engine/lib/log-rotate.js).
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const ledgerFile = (base) => path.join(base || dataDir(), '.runtime', 'notices.json');
const logFile = (base) => path.join(base || dataDir(), 'brain-notices.log');

function readLedger(base) {
  try { return JSON.parse(fs.readFileSync(ledgerFile(base), 'utf8')) || {}; } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[notice-once] ledger unreadable (${ledgerFile(base)}): ${err.message}`);
    return {};
  }
}

/** Full detail to the log, whatever the screen shows. Never throws. */
function logDetail(line, { base } = {}) {
  try {
    require('../../engine/lib/log-rotate.js').appendRotating(logFile(base), `${new Date().toISOString()} ${line}`);
  } catch (err) { console.error(`[notice-once] log failed (${logFile(base)}): ${err.message}`); }
}

/**
 * The text to show for `key`/`signature`, or null when that exact failure was already shown.
 * @param {{key:string, signature:string, text:string, detail?:string, base?:string}} o
 * @returns {string|null}
 */
function notice({ key, signature, text, detail, base }) {
  const ledger = readLedger(base);
  const seen = ledger[key] && ledger[key].signature === String(signature);
  logDetail(`${seen ? 'repeat (silent)' : 'shown'} ${key} [${signature}]: ${detail || text}`, { base });
  if (seen) return null;
  ledger[key] = { signature: String(signature), at: Date.now() };
  try { writeJsonAtomic(ledgerFile(base), ledger); } catch (err) { console.error(`[notice-once] ledger write failed: ${err.message}`); }
  return text;
}

/** The failure of `key` is over: the next one is announced again. Returns true when an entry was cleared. */
function recovered(key, { base } = {}) {
  const ledger = readLedger(base);
  if (!ledger[key]) return false;
  delete ledger[key];
  try { writeJsonAtomic(ledgerFile(base), ledger); } catch (err) { console.error(`[notice-once] ledger write failed: ${err.message}`); }
  logDetail(`recovered ${key}`, { base });
  return true;
}

module.exports = { notice, recovered, logDetail, ledgerFile, logFile };
