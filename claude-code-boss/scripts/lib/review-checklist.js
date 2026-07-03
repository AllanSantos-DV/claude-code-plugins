/**
 * review-checklist.js — pure helpers for the D3 review checklist.
 *
 * Recurring CODE lessons become a short `.claude/brain-review-checklist.md` that
 * the native `/code-review` reads as project context. Generation piggybacks on
 * the existing promotion scan (brain-promote.js) — no new hook for writing.
 *
 * "Code lesson" = a lesson/pattern whose recurrence cleared the threshold AND
 * which carries at least one code-ish tag (so we surface durable engineering
 * mistakes, not prose/preferences).
 */
'use strict';

// Tags that mark a lesson as engineering-relevant (lowercased match).
const CODE_TAGS = new Set([
  'code', 'bug', 'fix', 'refactor', 'api', 'test', 'testing', 'security', 'perf',
  'performance', 'race', 'concurrency', 'async', 'sql', 'regex', 'build', 'ci',
  'lint', 'types', 'typescript', 'memory', 'leak', 'error-handling', 'validation',
  'architecture', 'design', 'dependency', 'config', 'hooks', 'cache', 'migration',
]);

function _isCodeLesson(entry, codeTags) {
  if (!entry) return false;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return tags.some(t => codeTags.has(String(t || '').toLowerCase()));
}

/**
 * Select recurring code lessons from a list of full entries.
 * @param {object[]} entries  full KB entries (with tags + recurrence + type)
 * @param {{minRecurrence?:number, types?:string[], codeTags?:Set<string>, limit?:number}} [opts]
 * @returns {object[]} sorted by recurrence desc, capped at limit
 */
function selectCodeLessons(entries, opts = {}) {
  const minRec = Number.isInteger(opts.minRecurrence) ? opts.minRecurrence : 3;
  const types = opts.types || ['lesson', 'pattern'];
  const codeTags = opts.codeTags || CODE_TAGS;
  const limit = Number.isInteger(opts.limit) ? opts.limit : 25;
  const out = (entries || []).filter(e =>
    e && types.includes(e.type) && (e.recurrence || 1) >= minRec && _isCodeLesson(e, codeTags));
    // Deterministic: recurrence desc, then id asc so equal-recurrence ties don't
    // reorder between runs (avoids churny checklist rewrites).
    out.sort((a, b) => (b.recurrence || 1) - (a.recurrence || 1) || String(a.id).localeCompare(String(b.id)));
    return out.slice(0, limit);
}

/**
 * Render the checklist markdown. Deterministic (no timestamp in the body so the
 * file only changes when the lessons change — avoids churny rewrites).
 * @param {object[]} lessons
 * @param {{project?:string}} [opts]
 * @returns {string}
 */
// Marker embedded in the rendered body — lets consumers/cleanup verify a file
// was auto-generated (not hand-written) before deleting it.
const CHECKLIST_MARKER = 'Auto-generated from recurring Brain lessons';

function renderChecklist(lessons, opts = {}) {
  const proj = opts.project ? ` — ${opts.project}` : '';
  const lines = [
    `# Brain review checklist${proj}`,
    '',
    `> ${CHECKLIST_MARKER}. \`/code-review\` reads this as`,
    '> project context. Each item is a mistake that recurred — check the diff against it.',
    '',
  ];
  if (!lessons || lessons.length === 0) {
    lines.push('_No recurring code lessons yet._');
    return lines.join('\n') + '\n';
  }
  for (const l of lessons) {
    const title = String(l.title || 'untitled').replace(/\s+/g, ' ').trim();
    const rec = l.recurrence || 1;
    const id = l.id ? ` <!-- kb:${l.id} -->` : '';
    lines.push(`- [ ] **${title}** (recurred ${rec}×)${id}`);
  }
  return lines.join('\n') + '\n';
}

const CHECKLIST_RELPATH = ['.claude', 'brain-review-checklist.md'];

module.exports = { selectCodeLessons, renderChecklist, CODE_TAGS, CHECKLIST_RELPATH, CHECKLIST_MARKER };
