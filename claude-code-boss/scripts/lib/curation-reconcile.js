'use strict';
/**
 * curation-reconcile.js — reconcile a Stop-hook blocked-entry set against the
 * project's CURRENT curation state (one-hit store + shells.json).
 *
 * WHY: curation-stop's retry path used to compare only turn-journal signatures.
 * The two actions its own reason text asks for — `curation_mark_oneoff` and
 * `curation_register_shell` — are MCP tool calls: they produce no Bash
 * PostToolUse entry, so they were invisible to progress detection and the agent
 * stayed blocked for all retries doing exactly what was asked (observed live,
 * v1.19.0). This module makes those resolutions visible.
 *
 * Pure given its inputs (store + shells are loaded by the caller) → hermetic
 * unit tests in test-units.js.
 */
const oneoff = require('./oneoff-store.js');

/**
 * Split entries into resolved vs pending against the current curation state.
 * An entry is RESOLVED when:
 *   - a valid one-hit marking covers it (matched by the journaled `sig` when
 *     present, else by re-deriving from `command`), or
 *   - it was uncurated (`needs-curation`) but now matches a curated shell —
 *     i.e. the agent registered a script for it mid-turn.
 *
 * @param {object[]} entries  turn-journal / blockedEntries items ({ command, sig, curatedScript, ... })
 * @param {object} state      { store, matchShell?, now?, windowDays?, maxRecurrence? }
 *   - store: oneoff-store payload (oneoff.load(...))
 *   - matchShell: (command) => entry|null — usually shells-config.matchCuratedShell bound to loaded shells
 * @returns {{ pending: object[], resolved: object[] }}
 */
function reconcileEntries(entries, { store, matchShell = () => null, now = Date.now(), windowDays = 90, maxRecurrence = 3 } = {}) {
  const pending = [];
  const resolved = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const covered = store && oneoff.isOneHit(store, { command: e.command, sig: e.sig }, { now, windowDays, maxRecurrence });
    const nowCurated = !e.curatedScript && !!matchShell(e.command || '');
    (covered || nowCurated ? resolved : pending).push(e);
  }
  return { pending, resolved };
}

module.exports = { reconcileEntries };
