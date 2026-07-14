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
const { sanitizeProjectId } = require('./lib/project-id.js');

const store = require('./brain-store.js');

const HOME = os.homedir();
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');
const STAGING_DIR = path.join(DATA_DIR, 'skills-pending');
const GLOBAL_SKILLS_DIR = path.join(HOME, '.claude', 'skills');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadPromotionCfg() {
  const out = { enabled: true, minRecurrence: 3, minConfidence: 0.8, types: ['lesson', 'pattern'] };
  try {
    const cfgPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'),
      'config', 'brain-config.json'
    );
    const sp = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))?.kb?.skillPromotion;
    if (sp) Object.assign(out, sp);
  } catch { /* defaults */ }
  return out;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'lesson';
}

function draftSkillMd(entry) {
  const detail = (entry.content && entry.content.detail) || entry.summary || '';
  const files = (entry.content && entry.content.files) || [];
  const desc = (entry.summary || entry.title).replace(/\n/g, ' ').slice(0, 280);
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

async function scan() {
  const cfg = loadPromotionCfg();
  if (!cfg.enabled) { console.log(JSON.stringify({ ok: true, skipped: 'disabled' })); return; }
  const project = sanitizeProjectId(arg('project', path.basename(process.cwd()))) || path.basename(process.cwd());
  const minRec = parseInt(arg('min-recurrence', cfg.minRecurrence), 10);
  const minConf = parseFloat(arg('min-confidence', cfg.minConfidence));

  await store.init({ project });
  const entries = await store.list(null, project);

  const candidates = [];
  for (const row of entries) {
    if (!cfg.types.includes(row.type)) continue;
    const e = store.getRaw(row.id);
    if (!e) continue;
    if ((e.recurrence || 1) >= minRec && (e.confidence || 0) >= minConf) {
      candidates.push(e);
    }
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
    const { selectCodeLessons, renderChecklist, CHECKLIST_RELPATH, CHECKLIST_MARKER } = require('./lib/review-checklist.js');
    const full = [];
    for (const row of entries) {
      const e = store.getRaw(row.id);
      if (e) full.push(e);
    }
    const lessons = selectCodeLessons(full, { minRecurrence: minRec });
    // Write into the SESSION's project root (--cwd), not the scan process cwd —
    // this must match where review-checklist-advisory.js (event.cwd) reads it.
    const projectRoot = arg('cwd', process.cwd());
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

  await store.close();
  console.log(JSON.stringify({
    ok: true, project, candidates: drafted.length,
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

const cmd = process.argv[2];
(async () => {
  if (cmd === 'scan' || !cmd) await scan();
  else if (cmd === 'list') list();
  else if (cmd === 'approve') approve(process.argv[3]);
  else { console.error(`Unknown command: ${cmd}. Use scan|list|approve.`); process.exit(1); }
})().catch(err => {
  console.error(`[BRAIN-PROMOTE] ${err.message}`);
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
});
