#!/usr/bin/env node
/**
 * brain-promote.js — Skill Promotion (BRAIN-PLAN step 4 / the "pulo do gato").
 *
 * Recurring lessons (high `recurrence`, bumped by admission-control merges) are
 * promoted to GLOBAL skills — the apex of the learning pillar. Validated paradigm:
 * Voyager / Agent Skill Induction (promote after self-verification).
 *
 * GUARDRAIL — curated, never auto-spam (skills are always-loaded context):
 *   scan  → writes DRAFT SKILL.md to staging (CLAUDE_PLUGIN_DATA/skills-pending/),
 *           NON-destructive. The user is the self-verification gate.
 *   list  → show pending drafts.
 *   approve <slug> → move staging draft → ~/.claude/skills/<slug>/ (user-global).
 *
 * Usage:
 *   node scripts/brain-promote.js scan   [--project <k>] [--min-recurrence N] [--min-confidence F]
 *   node scripts/brain-promote.js list
 *   node scripts/brain-promote.js approve <slug>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeProjectId, tryResolveProjectId } = require('./lib/project-id.js');

const store = require('./brain-store.js');

const HOME = os.homedir();
const { dataDir } = require('./lib/data-dir.js');
const DATA_DIR = dataDir();
const STAGING_DIR = path.join(DATA_DIR, 'skills-pending');
const GLOBAL_SKILLS_DIR = path.join(HOME, '.claude', 'skills');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Shipped ⊕ user override (BACKLOG Q44) — one reader shared with the dashboard.
function loadPromotionCfg() {
  return require('./lib/brain-config.js').getSkillPromotion();
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'lesson';
}

/**
 * Truncate a description to `maxLen` chars WITHOUT cutting mid-word/mid-sentence.
 * A naive `.slice(0, maxLen)` (the old behavior) produces a frontmatter
 * `description` that ends abruptly ("...makes the test green while") — every
 * staged draft on disk had this. Cuts at the last space before `maxLen` (falls
 * back to a hard cut only for a single word longer than the whole budget) and
 * marks the cut with an ellipsis so a truncated description reads as truncated,
 * not as the whole thought.
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function truncateDescription(s, maxLen) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  // Only back off to the last space if that doesn't throw away most of the
  // budget (a pathological single long word) — else keep the hard cut.
  const safe = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${safe.trimEnd()}…`;
}

function draftSkillMd(entry) {
  const detail = (entry.content && entry.content.detail) || entry.summary || '';
  const files = (entry.content && entry.content.files) || [];
  const desc = truncateDescription(entry.summary || entry.title, 280);
  return `---
description: "${desc.replace(/"/g, "'")}"
---

# ${entry.title}

> ⚠️ DRAFT promoted from a recurring Brain lesson (recurrence: ${entry.recurrence || 1},
> confidence: ${entry.confidence}). Review/refine via the \`skill-creator\` skill,
> then approve: \`node scripts/brain-promote.js approve ${slugify(entry.title)}\`.

## Lesson

${detail}

${files.length ? `## Related\n${files.map(f => `- \`${f}\``).join('\n')}\n` : ''}
## Source
Promoted from Brain entry \`${entry.id}\` (project: ${entry.project}).
`;
}

/**
 * Every entry the scan looks at, full (recurrence, confidence, content). On the mcp-memory
 * backend the lessons live on the SERVER — the local store stopped receiving them when the
 * backend switched, so reading it made promotion and the review checklist blind (BACKLOG Q53).
 * @param {string} project  the strict project id
 * @param {string[]} types  entry types to read (promotion types ∪ the checklist's)
 * @returns {Promise<{entries: object[], source: string, close: Function}>}
 */
async function loadScanEntries(project, types) {
  const backend = require('./brain-backend.js');
  if (backend.peekMode() === 'mcp-memory') {
    await backend.init({ project, skipEmbedder: true });
    const entries = [];
    for (const type of types) entries.push(...await backend.listDocuments({ type, projectId: project }));
    // full(): the listing carries a ~200-char content PREVIEW — a draft must be written from the
    // whole document (get_document), or the skill's lesson text is truncated (audit 3.1.1).
    return { entries: entries.map((e) => ({ ...e, project })), source: 'mcp-memory', close: () => backend.close(), full: (id) => backend.get(id) };
  }
  await store.init({ project });
  const entries = [];
  for (const row of await store.list(null, project)) {
    const e = store.getRaw(row.id);
    if (e) entries.push(e);
  }
  return { entries, source: 'local', close: () => store.close() };
}

/**
 * Draft SKILL.md files for recurring lessons (recurrence ≥ min, confidence ≥ min) into staging, and
 * (re)generate the project review checklist from recurring code lessons. Prints a JSON report.
 * @returns {Promise<void>}
 */
async function scan() {
  const cfg = loadPromotionCfg();
  if (!cfg.enabled) { console.log(JSON.stringify({ ok: true, skipped: 'disabled' })); return; }
  // The STRICT project id of the session's folder (lib/project-id.js) — not the folder name: the
  // KB has been keyed by that id since 2.29.1, so basename(cwd) read an empty or stale project.
  const projectRoot = arg('cwd', process.cwd());
  // An explicit --project (the dashboard's picker) is still sanitized (S5: traversal sink).
  const project = arg('project', '') ? sanitizeProjectId(arg('project', '')) : tryResolveProjectId({ cwd: projectRoot });
  if (!project) {
    console.log(JSON.stringify({ ok: true, skipped: 'no-project-id', cwd: projectRoot, note: 'This folder has no project id — memory is off here, nothing to promote.' }));
    return;
  }
  const minRec = parseInt(arg('min-recurrence', cfg.minRecurrence), 10);
  const minConf = parseFloat(arg('min-confidence', cfg.minConfidence));

  const { selectCodeLessons, renderChecklist, CHECKLIST_RELPATH, CHECKLIST_MARKER } = require('./lib/review-checklist.js');
  const kb = await loadScanEntries(project, [...new Set([...cfg.types, 'lesson', 'pattern'])]);
  const entries = kb.entries;

  let candidates = entries.filter((e) => cfg.types.includes(e.type)
    && (e.recurrence || 1) >= minRec && (e.confidence || 0) >= minConf);
  if (kb.full) {
    candidates = await Promise.all(candidates.map(async (c) => {
      const f = await kb.full(c.id);
      if (!f) throw new Error(`candidate ${c.id} vanished between the listing and the read`);
      return { ...c, title: f.title || c.title, summary: f.summary || c.summary, content: f.content || c.content };
    }));
  }

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const drafted = [];
  for (const e of candidates) {
    const slug = slugify(e.title);
    const dir = path.join(STAGING_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), draftSkillMd(e));
    drafted.push({ slug, title: e.title, recurrence: e.recurrence, confidence: e.confidence });
  }

  // D3: (re)generate the project review checklist from recurring CODE lessons.
  // Piggybacks on the scan (no new hook); best-effort so it never fails the scan.
  let checklist = null;
  try {
    const lessons = selectCodeLessons(entries, { minRecurrence: minRec });
    // Write into the SESSION's project root (--cwd), not the scan process cwd —
    // this must match where review-checklist-advisory.js (event.cwd) reads it.
    const target = path.join(projectRoot, ...CHECKLIST_RELPATH);
    if (lessons.length > 0) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderChecklist(lessons, { project }));
      checklist = { path: target, items: lessons.length };
    } else if (fs.existsSync(target)) {
      // No code lessons anymore → remove, but ONLY our own auto-generated file
      // (never a hand-written one at the same path).
      let owned = false;
      try { owned = fs.readFileSync(target, 'utf8').includes(CHECKLIST_MARKER); } catch (e) { void e; }
      if (owned) { fs.rmSync(target); checklist = { path: target, items: 0, removed: true }; }
    }
  } catch (err) { console.error(`[brain-promote] checklist: ${err.message}`); }

  await kb.close();
  console.log(JSON.stringify({
    ok: true, project, source: kb.source, scanned: entries.length, candidates: drafted.length,
    thresholds: { minRecurrence: minRec, minConfidence: minConf },
    drafts: drafted, stagingDir: STAGING_DIR, checklist,
    note: drafted.length ? 'Review drafts, then `approve <slug>` to install globally.' : 'No recurring lessons cleared the threshold yet.',
  }, null, 2));
}

function list() {
  if (!fs.existsSync(STAGING_DIR)) { console.log(JSON.stringify({ ok: true, pending: [] })); return; }
  const pending = fs.readdirSync(STAGING_DIR)
    .filter(d => fs.existsSync(path.join(STAGING_DIR, d, 'SKILL.md')));
  console.log(JSON.stringify({ ok: true, pending, stagingDir: STAGING_DIR }, null, 2));
}

function approve(slug) {
  if (!slug) { console.error('approve requires <slug>'); process.exit(1); }
  const src = path.join(STAGING_DIR, slug);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    console.error(`No staged draft for "${slug}". Run scan first or check \`list\`.`);
    process.exit(1);
  }
  const dest = path.join(GLOBAL_SKILLS_DIR, slug);
  fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  if (fs.existsSync(dest)) {
    console.error(`Skill "${slug}" already exists at ${dest} — refusing to overwrite.`);
    process.exit(1);
  }
  fs.renameSync(src, dest);
  console.log(JSON.stringify({ ok: true, approved: slug, installedAt: dest }));
}

module.exports = { truncateDescription, draftSkillMd, slugify, loadPromotionCfg, scan };

const cmd = process.argv[2];
if (require.main === module) (async () => {
  if (cmd === 'scan' || !cmd) await scan();
  else if (cmd === 'list') list();
  else if (cmd === 'approve') approve(process.argv[3]);
  else { console.error(`Unknown command: ${cmd}. Use scan|list|approve.`); process.exit(1); }
})().catch(err => {
  console.error(`[BRAIN-PROMOTE] ${err.message}`);
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
});
