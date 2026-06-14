#!/usr/bin/env node
/**
 * brain-index-native.js — index Claude Code's NATIVE Auto Memory into the Brain.
 *
 * Native Auto Memory lives at ~/.claude/projects/<sanitized-cwd>/memory/*.md
 * (markdown topic files). It has NO semantic search and NO cross-project search —
 * exactly the gap the Brain fills (BRAIN-PLAN F1 / step 3).
 *
 * This reads those .md files, chunks them by "## " section headers, and indexes
 * each section as a Brain entry (type: native-memory) with a deterministic id
 * (hash of file+header) so re-runs UPDATE in place instead of duplicating.
 * A per-file hash state skips unchanged files.
 *
 * Usage:  node scripts/brain-index-native.js [--cwd <path>] [--project <key>]
 *
 * Cross-project: each project's native memory lands in its own Brain project DB;
 * `brain_search` (MCP) + `brain-retrieve-prompt.js` (hook) both support cross-project search.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const store = require('./brain-store.js');
const index = require('./brain-index.js');
const embedder = require('./brain-embedder.js');

const HOME = os.homedir();
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(HOME, '.claude', 'plugins', 'data', 'claude-code-boss');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Claude encodes the project dir by replacing path separators/drive colon with '-'
// e.g. C:\Users\allan\Desktop\Projetos\claude-code -> C--Users-allan-Desktop-Projetos-claude-code
function sanitizeCwd(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}

/** Find the native memory dir for a cwd, tolerating drive-letter case differences. */
function findNativeMemoryDir(cwd) {
  const projectsRoot = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;
  const target = sanitizeCwd(cwd).toLowerCase();
  for (const name of fs.readdirSync(projectsRoot)) {
    if (name.toLowerCase() === target) {
      const mem = path.join(projectsRoot, name, 'memory');
      if (fs.existsSync(mem)) return mem;
    }
  }
  return null;
}

/** Split markdown into { header, body } chunks by level-2 (##) headers. */
function chunkMarkdown(md) {
  const lines = md.split(/\r?\n/); // tolerate CRLF (native memory files are CRLF)
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (cur) chunks.push(cur);
      cur = { header: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) chunks.push(cur);
  // Fallback: file with no ## headers → one chunk from the # title (or filename)
  if (chunks.length === 0) {
    const titleMatch = md.match(/^#\s+(.+)$/m);
    chunks.push({ header: titleMatch ? titleMatch[1].trim() : 'memory', body: lines });
  }
  return chunks.map(c => ({ header: c.header, body: c.body.join('\n').trim() }))
    .filter(c => c.body.length > 0);
}

function detId(project, file, header) {
  return 'nat-' + crypto.createHash('sha1')
    .update(`${project}::${path.basename(file)}::${header}`).digest('hex').slice(0, 24);
}

function loadState(project) {
  const p = path.join(DATA_DIR, 'brain', project, 'native-index-state.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (err) { void err; return { files: {} }; }
}
function saveState(project, state) {
  const dir = path.join(DATA_DIR, 'brain', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'native-index-state.json'), JSON.stringify(state, null, 2));
}

async function run() {
  const cwd = arg('cwd', process.cwd());
  const project = arg('project', path.basename(cwd));
  const memDir = findNativeMemoryDir(cwd);

  if (!memDir) {
    console.log(JSON.stringify({ ok: true, skipped: 'no native memory dir', cwd }));
    return;
  }

  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log(JSON.stringify({ ok: true, skipped: 'empty native memory', memDir }));
    return;
  }

  await store.init({ project });
  await index.init({ project });
  await embedder.init();

  const state = loadState(project);
  let indexed = 0, skipped = 0, chunks = 0;

  for (const f of files) {
    const full = path.join(memDir, f);
    const md = fs.readFileSync(full, 'utf-8');
    const hash = crypto.createHash('sha1').update(md).digest('hex');
    if (state.files[f] === hash) { skipped++; continue; }

    for (const chunk of chunkMarkdown(md)) {
      const id = detId(project, f, chunk.header);
      const summary = chunk.body.split('\n').find(l => l.trim()) || chunk.header;
      const entry = {
        id,
        type: 'native-memory',
        project,
        session_id: '',
        title: chunk.header.slice(0, 80),
        summary: summary.slice(0, 500),
        content: { detail: chunk.body.slice(0, 4000), files: [`memory/${f}`] },
        tags: ['native-memory', project],
        confidence: 0.7,
      };
      const vector = await embedder.embed(`${entry.title} ${entry.summary} ${entry.content.detail}`);
      await store.save(entry, vector);     // deterministic id → INSERT OR REPLACE (no dup)
      await index.index(entry);
      chunks++;
    }
    state.files[f] = hash;
    indexed++;
  }

  saveState(project, state);
  await store.close();
  console.log(JSON.stringify({ ok: true, project, memDir, filesIndexed: indexed, filesSkipped: skipped, chunks }));
}

run().catch(err => {
  console.error(`[BRAIN-INDEX-NATIVE] ${err.message}`);
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
});
