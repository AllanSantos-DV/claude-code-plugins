'use strict';
/**
 * lib/scope-rules.js — the owner's rules, delivered by scope of work.
 *
 * Rules live in mcp-memory as global documents whose id is `rule:<kind>:<slug>`. The kind is
 * `sempre` (every session) or a trigger decided from the files the session touched:
 * `codigo`, `teste`, `docs` or a stack (`angular`, `java`, `python`, `dotnet`). A kind is
 * injected once per session; a compaction or /clear wipes it from the context, so SessionStart
 * with that source calls `resetInjected` and the next prompt delivers it again.
 *
 * State per session_id under `<data>/.runtime/scope-rules/`: the touched paths (evidence, survives
 * a reset) and the kinds already injected. Deliveries and rejected documents go to
 * `<data>/.runtime/scope-rules.jsonl`.
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const RULE_ID = /^rule:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9._-]*)$/;
const TOUCHED_CAP = 50;
const TTL_MS = 7 * 86400_000;
const CACHE_TTL_MS = 10 * 60_000;
const USER_PROJECT = '__user__';

const TEST_PATH = /(^|[\\/])(tests?|__tests__|specs?)[\\/]|\.(test|spec)\.[a-z0-9]+$/i;
const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|java|kt|py|cs|go|rs|rb|php|swift|c|cc|cpp|h|hpp|vue|svelte|ps1|sh)$/i;
const DOC_EXT = /\.(md|mdx|rst|adoc|txt)$/i;
const STACKS = {
  angular: /(^|[\\/])angular\.json$|\.(component|service|module|directive|pipe|guard|resolver)\.(ts|html|scss|css)$/i,
  java: /\.(java|kt)$|(^|[\\/])(pom\.xml|build\.gradle(\.kts)?)$/i,
  python: /\.py$|(^|[\\/])(pyproject\.toml|requirements\.txt)$/i,
  dotnet: /\.(cs|csproj|sln)$/i,
};
const BASE_KINDS = new Set(['sempre', 'codigo', 'teste', 'docs']);

const safeId = (sid) => (sid ? require('../../engine/lib/session-id.js').sanitizeSessionId(sid) : '');
const stateDir = (base) => path.join(base || dataDir(), '.runtime', 'scope-rules');
const journalFile = (base) => path.join(base || dataDir(), '.runtime', 'scope-rules.jsonl');

/**
 * Parse a rule document id.
 * @param {string} id
 * @returns {{kind: string, slug: string}|null} null when the id is not `rule:<kind>:<slug>` or the kind has no trigger
 */
function parseRuleId(id) {
  const m = RULE_ID.exec(String(id || ''));
  if (!m) return null;
  const kind = m[1];
  if (!BASE_KINDS.has(kind) && !STACKS[kind]) return null;
  return { kind, slug: m[2] };
}

/** @returns {Set<string>} the scope kinds the touched paths switch on (never includes `sempre`). */
function triggersFor(paths) {
  const kinds = new Set();
  for (const p of paths || []) {
    const s = String(p || '');
    if (!s) continue;
    if (TEST_PATH.test(s)) kinds.add('teste');
    if (CODE_EXT.test(s)) kinds.add('codigo');
    if (DOC_EXT.test(s)) kinds.add('docs');
    for (const [stack, re] of Object.entries(STACKS)) if (re.test(s)) kinds.add(stack);
  }
  return kinds;
}

function readState(sessionId, base) {
  const id = safeId(sessionId);
  if (!id) return { touched: [], injected: [] };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir(base), `${id}.json`), 'utf8'));
    return {
      touched: Array.isArray(j.touched) ? j.touched.map(String) : [],
      injected: Array.isArray(j.injected) ? j.injected.map(String) : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scope-rules] state unreadable for ${id}: ${err.message}`);
    return { touched: [], injected: [] };
  }
}

function writeState(sessionId, state, base) {
  const id = safeId(sessionId);
  if (!id) return;
  const dir = stateDir(base);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, `${id}.json`), { ...state, at: Date.now() });
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch (err) { void err; /* raced with another prune */ }
    }
  } catch (err) {
    console.error(`[scope-rules] state not saved (${dir}): ${err.message}`);
  }
}

/** Remember a file the session read or edited (newest last, capped). */
function recordTouched(sessionId, filePath, { base } = {}) {
  const p = String(filePath || '').replace(/\\/g, '/');
  if (!p || !safeId(sessionId)) return;
  const state = readState(sessionId, base);
  if (state.touched.includes(p)) return;
  state.touched = [...state.touched, p].slice(-TOUCHED_CAP);
  writeState(sessionId, state, base);
}

/** Forget what the session already received (compact, clear); the touched paths stay. */
function resetInjected(sessionId, { base } = {}) {
  if (!safeId(sessionId)) return false;
  const state = readState(sessionId, base);
  if (!state.injected.length) return false;
  writeState(sessionId, { touched: state.touched, injected: [] }, base);
  return true;
}

/** Remove the whole record of an ended session. */
function forget(sessionId, { base } = {}) {
  const id = safeId(sessionId);
  if (!id) return;
  try {
    fs.unlinkSync(path.join(stateDir(base), `${id}.json`));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scope-rules] forget failed for ${id}: ${err.message}`);
  }
}

function journal(entry, base) {
  try {
    fs.mkdirSync(path.dirname(journalFile(base)), { recursive: true });
    fs.appendFileSync(journalFile(base), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    console.error(`[scope-rules] journal write failed: ${err.message}`);
  }
}

let cache = null;

/**
 * The rule documents of the owner's global space, parsed and cached in the daemon's memory.
 * A document whose id looks like a rule but does not parse is reported in `rejected`, never dropped silently.
 * @param {{fetch?: () => Promise<object[]>, base?: string, now?: number, ttlMs?: number}} [opts]
 * @returns {Promise<{rules: Array<{id: string, kind: string, text: string}>, rejected: Array<{id: string, why: string}>}>}
 */
async function loadRules({ fetch, base, now = Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  if (cache && now - cache.at < ttlMs) return cache.value;
  const docs = await (fetch || defaultFetch)();
  const rules = [];
  const rejected = [];
  for (const d of docs) {
    const id = String(d.id || '');
    if (!id.startsWith('rule:')) continue;
    const parsed = parseRuleId(id);
    if (!parsed) { rejected.push({ id, why: 'id is not rule:<sempre|codigo|teste|docs|stack>:<slug>' }); continue; }
    const text = String((d.content && d.content.text) || d.summary || '').trim();
    if (!text) { rejected.push({ id, why: 'empty content' }); continue; }
    rules.push({ id, kind: parsed.kind, text });
  }
  const value = { rules, rejected };
  if (rejected.length) journal({ event: 'rejected', rejected }, base);
  cache = { at: now, value };
  return value;
}

/** Drop the cached rules (tests, and a rule edit the owner wants seen at once). */
function clearCache() { cache = null; }

async function defaultFetch() {
  const backend = require('../../engine/brain-backend.js');
  if (backend.peekMode() !== 'mcp-memory') return [];
  if (backend.getMode() !== 'mcp-memory') throw Object.assign(new Error('brain backend not connected yet'), { code: 'NOT_READY' });
  return backend.listDocuments({ projectId: USER_PROJECT });
}

/**
 * Pick the rules to deliver now: `sempre` plus the kinds the touched paths trigger, minus what
 * the session already received.
 * @returns {{kinds: string[], rules: Array<{id: string, kind: string, text: string}>}}
 */
function decide({ rules, touched, injected }) {
  const done = new Set(injected || []);
  const wanted = ['sempre', ...triggersFor(touched)].filter((k) => !done.has(k));
  const withRules = wanted.filter((k) => rules.some((r) => r.kind === k));
  return { kinds: withRules, rules: rules.filter((r) => withRules.includes(r.kind)) };
}

/** Declarative block for the model; each rule is cut at `maxChars` with a visible mark. */
function render(rules, kinds, maxChars) {
  const cut = (r) => (r.text.length > maxChars ? `${r.text.slice(0, maxChars)}\n[regra ${r.id} cortada em ${maxChars} de ${r.text.length} caracteres]` : r.text);
  const body = rules.map((r) => `- (${r.id}) ${cut(r)}`).join('\n');
  return `[BOSS regras do dono — escopo: ${kinds.join(', ')}]\n${body}`;
}

/**
 * UserPromptSubmit entry: the block of rules newly in scope for this session, or '' when none.
 * @param {object} event hook payload (session_id)
 * @param {{base?: string, maxChars: number, fetch?: () => Promise<object[]>}} opts
 * @returns {Promise<string>}
 */
async function inject(event, { base, maxChars, fetch } = {}) {
  const sid = (event && (event.session_id || event.sessionId)) || '';
  if (!safeId(sid)) return '';
  const state = readState(sid, base);
  let rules;
  try {
    ({ rules } = await loadRules({ fetch, base }));
  } catch (err) {
    if (err.code === 'NOT_READY') return '';
    throw err;
  }
  const picked = decide({ rules, touched: state.touched, injected: state.injected });
  if (!picked.kinds.length) return '';
  const text = render(picked.rules, picked.kinds, maxChars);
  writeState(sid, { touched: state.touched, injected: [...state.injected, ...picked.kinds] }, base);
  journal({ session: safeId(sid), kinds: picked.kinds, ids: picked.rules.map((r) => r.id), chars: text.length }, base);
  return text;
}

module.exports = { parseRuleId, triggersFor, recordTouched, resetInjected, forget, loadRules, clearCache, decide, render, inject, readState };
