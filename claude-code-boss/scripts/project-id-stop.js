#!/usr/bin/env node
/**
 * project-id-stop.js — Stop detector (strict project-id gate, 2.29.1).
 *
 * Pairs with the SessionStart notice (project-identity-advisory.js): while the
 * session's folder has no project id, EVERY Stop blocks once with the same notice,
 * so the agent keeps asking the user to define the id instead of working with memory
 * silently off. `stop_hook_active` (the agent is already continuing because of a Stop
 * block) lets the stop through — one nag per turn, never a loop.
 *
 * Runs in-process via stop-dispatcher.js (highest merge priority). The dispatcher also
 * skips the detectors that ask for capture_lesson/brain_store, and the KB-recalling
 * self-review, while there is no id (see NO_ID_SKIP there). Opt-out: `onboarding.projectIdentity: false`.
 */
'use strict';

const { tryResolveProjectId } = require('./lib/project-id.js');
const { getOnboarding } = require('./lib/brain-config.js');
const { buildNotice } = require('./project-identity-advisory.js');

/**
 * @param {object} event  Stop payload (`cwd`, `stop_hook_active`)
 * @param {{resolve?:Function}} [opts]  test seam for the id resolver
 * @returns {{block:true, reason:string}|null}
 */
function run(event, { resolve = tryResolveProjectId } = {}) {
  if (!getOnboarding().projectIdentity) return null;
  const cwd = event && typeof event.cwd === 'string' ? event.cwd : '';
  if (!cwd || (event && event.stop_hook_active)) return null;
  if (resolve({ cwd })) return null;
  return { block: true, reason: buildNotice(cwd) };
}

module.exports = { run };
