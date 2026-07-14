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
const fs = require('fs');
const { writeJsonAtomic, writeFileAtomic } = require('./lib/atomic-write.js');
const path = require('path');
const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const oneoff = require('./lib/oneoff-store.js');
const { getCuration } = require('./lib/brain-config.js');

const { dataDir } = require('./lib/data-dir.js');
const DATA_DIR = dataDir();

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* non-JSON stdin → defaults */ }
    const cwd = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const eventName = event.hook_event_name || 'SessionStart';
    const { oneHitWindowDays } = getCuration();
    const projectKey = oneoff.resolveProjectKey(cwd);

    // Session-start stamp (U2 session summary): record the earliest ts for this
    // session so the Stop summary can count lessons captured during it. Best-effort.
    try {
      const sid = event.session_id || event.sessionId;
      if (sid) {
        const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const stamp = path.join(DATA_DIR, '.runtime', `session-start-${safe}.json`);
        if (!fs.existsSync(stamp)) {
          fs.mkdirSync(path.dirname(stamp), { recursive: true });
          writeFileAtomic(stamp, JSON.stringify({ ts: Date.now(), project: path.basename(cwd) }));
        }
      }
    } catch (e) { void e; /* stamp is best-effort */ }

    oneoff.prune(DATA_DIR, projectKey, { windowDays: oneHitWindowDays });

    // Weekly KB consolidation (F3 #5): spawn the hygiene job at most once a week
    // (fire-and-forget, like the skill-promotion trigger). Manual control lives
    // in the dashboard; this keeps the KB tidy without user action.
    try {
      const cstamp = path.join(DATA_DIR, '.runtime', 'brain-consolidate-last.json');
      let due = true;
      try {
        const last = JSON.parse(fs.readFileSync(cstamp, 'utf8')).ts;
        due = !(Number.isFinite(last) && (Date.now() - last) < 7 * 24 * 60 * 60 * 1000);
      } catch (e) { void e; }
      const root = process.env.CLAUDE_PLUGIN_ROOT;
      if (due && root && !root.includes('${')) {
        fs.mkdirSync(path.dirname(cstamp), { recursive: true });
        writeJsonAtomic(cstamp, { ts: Date.now() });
        const { spawn } = require('child_process');
        const child = spawn(process.execPath,
          [path.join(root, 'scripts', 'brain-consolidate.js'), '--project', path.basename(cwd), '--apply'],
          { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
      }
    } catch (e) { void e; }

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
