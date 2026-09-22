#!/usr/bin/env node
'use strict';
/**
 * curation-session.js — SessionStart maintenance + orientation for the
 * curated-script / one-hit loop:
 *   - PRUNE cold one-hit entries (D5) so the per-project store doesn't grow
 *     unbounded and stale counts don't distort recurrence;
 *   - inject a short PANORAMA (O3): how many curated scripts + one-hit commands
 *     this project tracks, so the agent reuses existing curation instead of
 *     re-deriving it from scratch;
 *   - inject a skill-promotion backlog notice (drafts staged by
 *     `brain-promote.js scan` sit in `skills-pending/` forever if nothing
 *     surfaces them — this is the only nudge that does).
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

/**
 * Cheap, no-LLM observability for the skill-promotion staging backlog
 * (`brain-promote.js scan` writes drafts here; nothing else ever surfaced them,
 * so they piled up unreviewed — one draft on this machine sat 51 days). Pure
 * `fs`/`path`, no store/network, so it's safe to run on every SessionStart.
 * @param {string} dataDir
 * @returns {{count: number, oldestDays: number} | null} null when nothing pending
 */
function pendingSkillsSummary(dataDir) {
  const stagingDir = path.join(dataDir, 'skills-pending');
  let dirs;
  try {
    dirs = fs.readdirSync(stagingDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(stagingDir, d.name, 'SKILL.md')));
  } catch (e) { void e; return null; } // no staging dir yet
  if (dirs.length === 0) return null;
  const oldestMs = Math.min(...dirs.map(d => fs.statSync(path.join(stagingDir, d.name, 'SKILL.md')).birthtimeMs));
  const oldestDays = Math.max(0, Math.floor((Date.now() - oldestMs) / 86400000));
  return { count: dirs.length, oldestDays };
}

/**
 * Pure detector entry point. Returns the panorama advisory text (string) or
 * `null` when nothing to report. Never throws.
 * @param {object} event
 * @returns {Promise<string|null>}
 */
async function run(event) {
  try {
    const cwd = (event && event.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { oneHitWindowDays } = getCuration();
    const projectKey = oneoff.resolveProjectKey(cwd);

    // Session-start stamp (U2 session summary): record the earliest ts for this
    // session so the Stop summary can count lessons captured during it. Best-effort.
    try {
      const sid = event && (event.session_id || event.sessionId);
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

    const pending = pendingSkillsSummary(DATA_DIR);

    const lines = [];
    if (oneHits > 0 || curated > 0) {
      lines.push(`[CURATION] This project tracks ${curated} curated script(s) and ${oneHits} one-hit command(s). Prefer existing curated scripts; mark genuine single-use commands with curation_mark_oneoff instead of re-curating.`);
    }
    if (pending) {
      lines.push(`[SKILLS] ${pending.count} promoted-skill draft(s) awaiting review (oldest: ${pending.oldestDays}d). Run \`node scripts/brain-promote.js list\` or open /dashboard -> Skills to approve/discard.`);
    }
    if (lines.length === 0) return null;
    return lines.join('\n');
  } catch (err) {
    console.error(`[CURATION-SESSION] ${err.message}`);
    return null;
  }
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { /* non-JSON stdin → defaults */ }
  const eventName = event.hook_event_name || 'SessionStart';
  const text = await run(event);
  if (text) {
    emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
    return;
  }
  emitEmpty();
}

if (require.main === module) {
  main();
}

module.exports = { run, pendingSkillsSummary };
