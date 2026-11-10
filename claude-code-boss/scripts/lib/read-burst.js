'use strict';
/**
 * lib/read-burst.js — the ready context for an investigation burst, delivered mechanically.
 *
 * A burst is a run of read-only tool calls (Read, Grep, Glob, Smart Tool search/scout) with no
 * Edit/Write/Bash/PowerShell in between. When the run reaches `minCalls`, the context bundle
 * (lib/context-bundle.js: Smart Tool code/tests/docs + task-map sections) is built ONCE for the
 * agent's OWN first search of the run — measured as the theme that works (median hit 0.67 against
 * 0 for the user's prompt) — and handed back as additionalContext. Files already read in the run
 * are left out. Never blocks; a failure is shown once per (session, error signature).
 *
 * State per session and sub-agent under `<data>/.runtime/read-burst/`; every delivery and the
 * outcome of each delivered run (files read afterwards, how many were in the bundle) are appended
 * to `<data>/.runtime/read-burst.jsonl`, the same hit metric the replay used.
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');
const notices = require('./notice-once.js');

const ORIGIN = `[hook-origin=${require('./hook-owner.js').BOSS_ORIGIN}]`;
const READ_TOOL = /^(Read|Grep|Glob|LS)$|^mcp__smart-tool__smart_(search|search_result|scout)$/;
const RESET_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell)$/;
const BUILD_STALE_MS = 60000;

const safeId = (s) => require('../../engine/lib/session-id.js').sanitizeSessionId(s);
const stateFile = (base, key) => path.join(base || dataDir(), '.runtime', 'read-burst', `${safeId(key)}.json`);
const journalFile = (base) => path.join(base || dataDir(), '.runtime', 'read-burst.jsonl');
const mask = (s) => String(s).replace(/[A-Za-z0-9_-]{24,}/g, '<masked>');

/** The words of the agent's search, or null when the call is not a search (Read, Glob, LS). */
function themeOf(toolName, input) {
  const ti = input || {};
  let raw = null;
  if (toolName === 'Grep') raw = ti.pattern;
  else if (/smart_search$/.test(toolName)) raw = ti.query_identifiers || ti.query_comments || ti.doc_query;
  else if (/smart_scout$/.test(toolName)) raw = [ti.question, ti.terms].filter(Boolean).join(' ');
  if (!raw) return null;
  const words = String(raw).replace(/\\[bBsSwWdD]/g, ' ').replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return words.length >= 3 ? words.slice(0, 200) : null;
}

const themeKey = (t) => [...new Set(t.toLowerCase().split(' '))].sort().join(' ');

/** Repo-relative, forward-slash, lower-case — the form bundle sections are compared in. */
function relKey(root, file) {
  if (!file) return null;
  const abs = path.resolve(root || '.', String(file));
  const rel = path.relative(root || '.', abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/').toLowerCase();
}

const fresh = () => ({ calls: 0, theme: null, reads: [], building: 0, delivered: null });

function readState(base, key) {
  try { return { run: fresh(), themes: [], deliveries: 0, ...JSON.parse(fs.readFileSync(stateFile(base, key), 'utf8')) }; } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[read-burst] state unreadable (${stateFile(base, key)}): ${err.message}`);
    return { run: fresh(), themes: [], deliveries: 0 };
  }
}

function writeState(base, key, st) {
  try { writeJsonAtomic(stateFile(base, key), st); } catch (err) { console.error(`[read-burst] state write failed: ${err.message}`); }
}

function journal(base, entry) {
  try {
    fs.mkdirSync(path.dirname(journalFile(base)), { recursive: true });
    fs.appendFileSync(journalFile(base), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) { console.error(`[read-burst] journal write failed: ${err.message}`); }
}

/** A delivered run ended: how many of the files read after the delivery the bundle already had. */
function closeRun(base, ev, st) {
  const d = st.run.delivered;
  if (d) {
    const after = st.run.reads.slice(d.readsBefore);
    const hits = after.filter((f) => d.files.includes(f)).length;
    journal(base, { event: 'closed', session: ev.session_id, agent: ev.agent_id || 'main', theme: d.theme, bundleFiles: d.files.length, readAfter: after.length, hits });
  }
  st.run = fresh();
}

/**
 * @param {object} ev PostToolUse event
 * @param {{root:string, minCalls?:number, maxTokens?:number, maxPerSession?:number, base?:string,
 *          build:(o:{theme:string, root:string, exclude:Set<string>, maxTokens:number}) => Promise<{text:string, tokens:number, files:string[], notes:string[]}>}} o
 * @returns {Promise<{context:string, notice:string}>}
 */
async function onTool(ev, { root, minCalls = 3, maxTokens = 6000, maxPerSession = 5, base, build }) {
  const none = { context: '', notice: '' };
  const tool = ev.tool_name || '';
  if (!ev.session_id || !(READ_TOOL.test(tool) || RESET_TOOL.test(tool))) return none;
  const key = `${ev.session_id}-${ev.agent_id || 'main'}`;
  const st = readState(base, key);
  if (RESET_TOOL.test(tool)) {
    if (st.run.calls || st.run.delivered) { closeRun(base, ev, st); writeState(base, key, st); }
    return none;
  }
  const run = st.run;
  run.calls++;
  if (tool === 'Read') {
    const f = relKey(root, (ev.tool_input || {}).file_path);
    if (f && !run.reads.includes(f)) run.reads.push(f);
  }
  if (!run.theme) run.theme = themeOf(tool, ev.tool_input);
  const building = run.building && Date.now() - run.building < BUILD_STALE_MS;
  const due = run.theme && !run.delivered && !building && run.calls >= minCalls && st.deliveries < maxPerSession
    && !st.themes.includes(themeKey(run.theme)) && root;
  if (!due) { writeState(base, key, st); return none; }
  run.building = Date.now();
  writeState(base, key, st);

  const theme = run.theme;
  const t0 = Date.now();
  let bundle = null;
  let failure = null;
  try { bundle = await build({ theme, root, exclude: new Set(run.reads), maxTokens }); } catch (err) { failure = err && err.message ? err.message : String(err); }
  const down = (bundle && bundle.notes || []).find((n) => /^code\/docs unavailable/.test(n));
  if (!failure && down) failure = down;

  const now = readState(base, key);
  now.run.building = 0;
  now.themes = [...now.themes, themeKey(theme)].slice(-50);
  const useful = bundle && bundle.files && bundle.files.length > 0;
  if (useful) {
    now.deliveries++;
    now.run.delivered = { theme, files: bundle.files.map((f) => f.toLowerCase()), readsBefore: now.run.reads.length };
  }
  writeState(base, key, now);
  journal(base, { event: useful ? 'delivered' : 'empty', session: ev.session_id, agent: ev.agent_id || 'main', theme, calls: run.calls,
    ms: Date.now() - t0, tokens: bundle ? bundle.tokens : 0, files: useful ? bundle.files : [], failure: failure ? mask(failure).slice(0, 300) : undefined });

  const notice = failure ? notices.notice({
    key: `read-burst:${ev.session_id}`, signature: mask(failure).slice(0, 80), base,
    text: `${ORIGIN} [claude-code-boss] read-burst: the ready context for "${theme.slice(0, 60)}" came without code search — ${mask(failure).slice(0, 200)}`,
  }) || '' : '';
  if (!useful) return { context: '', notice };
  const context = [
    `${ORIGIN} [claude-code-boss] Read burst: ${run.calls} read-only calls since your search "${theme.slice(0, 80)}".`,
    `Below, gathered in one pass for that search (~${bundle.tokens} tokens; files you already read are left out). Check it before opening more files.`,
    '',
    bundle.text,
  ].join('\n');
  return { context, notice };
}

module.exports = { onTool, themeOf, themeKey, relKey, stateFile, journalFile, READ_TOOL, RESET_TOOL };
