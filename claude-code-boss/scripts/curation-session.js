#!/usr/bin/env node
'use strict';
/**
 * curation-session.js — SessionStart maintenance + orientation for the
 * curated-script / one-hit loop:
 *   - PRUNE cold one-hit entries (D5) so the per-project store doesn't grow
 *     unbounded and stale counts don't distort recurrence;
 *   - inject a short PANORAMA (O3): how many curated scripts + one-hit commands
 *     this project tracks, so the agent reuses existing curation instead of
 *     re-deriving it from scratch.
 *
 * Best-effort and silent when there's nothing to report.
 */
const path = require('path');
const os = require('os');
const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const oneoff = require('./lib/oneoff-store.js');
const { getCuration } = require('./lib/brain-config.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* non-JSON stdin → defaults */ }
    const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const eventName = event.hook_event_name || 'SessionStart';
    const { oneHitWindowDays } = getCuration();
    const projectKey = oneoff.resolveProjectKey(cwd);

    oneoff.prune(DATA_DIR, projectKey, { windowDays: oneHitWindowDays });
    const { oneHits } = oneoff.summary(DATA_DIR, projectKey);

    let curated = 0;
    try {
      const { findProjectRoot, loadShellsConfig } = require('./shells-config.js');
      curated = (loadShellsConfig(findProjectRoot(cwd)).shells || []).length;
    } catch (e) { void e; }

    if (oneHits === 0 && curated === 0) return emitEmpty();
    emitJson({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: `[CURATION] This project tracks ${curated} curated script(s) and ${oneHits} one-hit command(s). Prefer existing curated scripts; mark genuine single-use commands with curation_mark_oneoff instead of re-curating.`,
      },
    });
  } catch (err) {
    console.error(`[CURATION-SESSION] ${err.message}`);
    emitEmpty();
  }
})();
