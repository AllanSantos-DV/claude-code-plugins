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
 * A real Smart Tool search takes 8–14 s, so the build runs in the background of the daemon (the
 * module stays loaded there): the hook waits at most `waitMs` for it, and when it is not ready the
 * bundle goes out with the next read-only call of the same run. A run that ends first drops it.
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
/** Claude Code caps a hook's additionalContext at 10,000 characters; past it the model only gets a file path. */
const CONTEXT_CAP = 10000;
const HEADER_RESERVE = 400;

/** Builds still running, by state file: `{theme, done, bundle, failure, ms}`. */
const inflight = new Map();

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

const fresh = () => ({ calls: 0, theme: null, reads: [], delivered: null });

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

/** A finished build: record it, and the context (or the once-per-signature notice) for this call. */
function deliver(ev, base, key, job) {
  const { theme, bundle } = job;
  let failure = job.failure;
  const down = (bundle && bundle.notes || []).find((n) => /^code\/docs unavailable/.test(n));
  if (!failure && down) failure = down;

  const now = readState(base, key);
  const useful = bundle && bundle.files && bundle.files.length > 0;
  if (useful) {
    now.deliveries++;
    now.run.delivered = { theme, files: bundle.files.map((f) => f.toLowerCase()), readsBefore: now.run.reads.length };
  }
  writeState(base, key, now);
  journal(base, { event: useful ? 'delivered' : 'empty', session: ev.session_id, agent: ev.agent_id || 'main', theme, calls: now.run.calls,
    ms: job.ms, tokens: bundle ? bundle.tokens : 0, files: useful ? bundle.files : [], failure: failure ? mask(failure).slice(0, 300) : undefined });

  const notice = failure ? notices.notice({
    key: `read-burst:${ev.session_id}`, signature: mask(failure).slice(0, 80), base,
    text: `${ORIGIN} [claude-code-boss] read-burst: the ready context for "${theme.slice(0, 60)}" came without code search — ${mask(failure).slice(0, 200)}`,
  }) || '' : '';
  if (!useful) return { context: '', notice };
  const context = [
    `${ORIGIN} [claude-code-boss] Read burst: ${now.run.calls} read-only calls since your search "${theme.slice(0, 80)}".`,
    `Below, gathered in one pass for that search (~${bundle.tokens} tokens; files you already read are left out). Check it before opening more files.`,
    '',
    bundle.text,
  ].join('\n');
  return { context, notice };
}

/**
 * @param {object} ev PostToolUse event
 * @param {{root:string, minCalls?:number, maxTokens?:number, maxPerSession?:number, base?:string, waitMs?:number,
 *          build:(o:{theme:string, root:string, exclude:Set<string>, maxTokens:number, maxChars:number}) => Promise<{text:string, tokens:number, files:string[], notes:string[]}>}} o
 * @returns {Promise<{context:string, notice:string}>}
 */
async function onTool(ev, { root, minCalls = 3, maxTokens = 6000, maxPerSession = 5, base, build, waitMs = 1500 }) {
  const none = { context: '', notice: '' };
  const tool = ev.tool_name || '';
  if (!ev.session_id || !(READ_TOOL.test(tool) || RESET_TOOL.test(tool))) return none;
  const key = `${ev.session_id}-${ev.agent_id || 'main'}`;
  const slot = stateFile(base, key);
  const st = readState(base, key);
  if (RESET_TOOL.test(tool)) {
    const pending = inflight.get(slot);
    if (pending) {
      inflight.delete(slot);
      journal(base, { event: 'abandoned', session: ev.session_id, agent: ev.agent_id || 'main', theme: pending.theme, calls: st.run.calls });
    }
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
  const pending = inflight.get(slot);
  if (pending) {
    writeState(base, key, st);
    if (!pending.done) return none;
    inflight.delete(slot);
    return deliver(ev, base, key, pending);
  }
  const due = run.theme && !run.delivered && run.calls >= minCalls && st.deliveries < maxPerSession
    && !st.themes.includes(themeKey(run.theme)) && root;
  if (!due) { writeState(base, key, st); return none; }
  st.themes = [...st.themes, themeKey(run.theme)].slice(-50);
  writeState(base, key, st);

  const job = { theme: run.theme, done: false, bundle: null, failure: null, ms: 0 };
  const t0 = Date.now();
  inflight.set(slot, job);
  const settled = Promise.resolve()
    .then(() => build({ theme: job.theme, root, exclude: new Set(run.reads), maxTokens, maxChars: CONTEXT_CAP - HEADER_RESERVE }))
    .then((b) => { job.bundle = b; }, (err) => { job.failure = err && err.message ? err.message : String(err); })
    .then(() => { job.ms = Date.now() - t0; job.done = true; });
  let timer;
  await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, waitMs); })]);
  clearTimeout(timer);
  if (!job.done || inflight.get(slot) !== job) return none;
  inflight.delete(slot);
  return deliver(ev, base, key, job);
}

module.exports = { onTool, themeOf, themeKey, relKey, stateFile, journalFile, READ_TOOL, RESET_TOOL, CONTEXT_CAP };
