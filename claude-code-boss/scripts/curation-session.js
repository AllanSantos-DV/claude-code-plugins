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
const { runTextCli } = require('./lib/hook-io.js');
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
      const pid = require('./lib/project-id.js').tryResolveProjectId({ cwd });
      const root = process.env.CLAUDE_PLUGIN_ROOT;
      if (pid && consolidationDue(cstamp, pid, Date.now()) && root && !root.includes('${')) {
        markConsolidated(cstamp, pid, Date.now());
        const { spawn } = require('child_process');
        const child = spawn(process.execPath,
          [path.join(root, 'scripts', 'brain-consolidate.js'), '--cwd', cwd, '--apply'], // strict id resolved there (Q54)
          { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
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

function main() { return runTextCli(run, 'CURATION-SESSION', 'SessionStart'); }

if (require.main === module) {
  main();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is the weekly consolidation due for THIS project? The stamp is per project id: a single
 * stamp for the whole data dir let one project's session consume the week for every other
 * project, which then never consolidated (BACKLOG Q57). A legacy `{ts}` stamp counts as "due".
 * @param {string} stampFile
 * @param {string} projectId  strict project id
 * @param {number} nowMs
 * @returns {boolean}
 */
function consolidationDue(stampFile, projectId, nowMs) {
  let last;
  try { last = (JSON.parse(fs.readFileSync(stampFile, 'utf8')).byProject || {})[projectId]; } catch (e) { void e; /* absent/unreadable → due */ }
  return !(Number.isFinite(last) && (nowMs - last) < WEEK_MS);
}

/**
 * Record this project's consolidation run (keeps the other projects' stamps).
 * @param {string} stampFile
 * @param {string} projectId
 * @param {number} nowMs
 */
function markConsolidated(stampFile, projectId, nowMs) {
  let byProject = {};
  try { const raw = JSON.parse(fs.readFileSync(stampFile, 'utf8')); if (raw && raw.byProject && typeof raw.byProject === 'object') byProject = raw.byProject; } catch (e) { void e; }
  byProject[projectId] = nowMs;
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  writeJsonAtomic(stampFile, { byProject });
}

/**
 * Give the week back when the consolidation run failed (server/embedder down): the stamp is
 * written BEFORE spawning (so two sessions never consolidate the same project at once), and a
 * failed run must not cost the project its week (pre-release audit 3.1.1).
 * @param {string} stampFile
 * @param {string} projectId
 */
function unmarkConsolidated(stampFile, projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (!raw || !raw.byProject || !(projectId in raw.byProject)) return;
    delete raw.byProject[projectId];
    writeJsonAtomic(stampFile, { byProject: raw.byProject });
  } catch (e) { void e; /* no stamp → nothing to give back */ }
}

module.exports = { run, pendingSkillsSummary, consolidationDue, markConsolidated, unmarkConsolidated };
