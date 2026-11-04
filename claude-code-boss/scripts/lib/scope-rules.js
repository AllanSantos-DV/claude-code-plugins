'use strict';
/**
 * lib/scope-rules.js — the owner's rules, delivered by scope of work.
 *
 * Rules are documents of the single memory server whose id is `rule:<kind>:<slug>`, asked with its
 * scoped-rules lookup (lib/scoped-rules-client.js) for the files the session touched. The kind is
 * `sempre` (every session) or a trigger decided from those files: `codigo`, `teste`, `docs` or a
 * stack (`angular`, `java`, `python`, `dotnet`). Each rule is delivered once per session; a
 * compaction or /clear wipes it from the context, so SessionStart with that source calls
 * `resetInjected` and the next prompt delivers it again. The lookup runs again only when the set of
 * touched files changed.
 *
 * State per session_id under `<data>/.runtime/scope-rules/`. Each delivery (rule ids, reason, size)
 * and each refused rule is appended to `<data>/.runtime/scope-rules.jsonl`.
 */
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../engine/lib/data-dir.js');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');
const notices = require('./notice-once.js');

const RULE_ID = /^rule:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9._-]*)$/;
const TOUCHED_CAP = 50;
const TTL_MS = 7 * 86400_000;
const SET_MAX_CHARS = 4000;
const NOTICE_KEY = 'scope-rules';
const ORIGIN = `[hook-origin=${require('./hook-owner.js').BOSS_ORIGIN}]`;

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
const KIND_NAMES = [...BASE_KINDS, ...Object.keys(STACKS)].join('|');

const safeId = (sid) => (sid ? require('../../engine/lib/session-id.js').sanitizeSessionId(sid) : '');
const stateDir = (base) => path.join(base || dataDir(), '.runtime', 'scope-rules');
const journalFile = (base) => path.join(base || dataDir(), '.runtime', 'scope-rules.jsonl');
const strings = (v) => (Array.isArray(v) ? v.map(String) : []);

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

/**
 * @returns {{touched: string[], delivered: string[], lookedUp: string|null, resetBy: string, told: string[]}}
 *   delivered: rule ids in the context now; lookedUp: the touched-files key of the last complete
 *   lookup; resetBy: the SessionStart source that wiped the context; told: refused ids already shown
 */
function readState(sessionId, base) {
  const empty = { touched: [], delivered: [], lookedUp: null, resetBy: '', told: [] };
  const id = safeId(sessionId);
  if (!id) return empty;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir(base), `${id}.json`), 'utf8'));
    return {
      touched: strings(j.touched),
      delivered: strings(j.delivered),
      lookedUp: typeof j.lookedUp === 'string' ? j.lookedUp : null,
      resetBy: typeof j.resetBy === 'string' ? j.resetBy : '',
      told: strings(j.told),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scope-rules] state unreadable for ${id}: ${err.message}`);
    return empty;
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

/**
 * Forget what the session already received (compact, clear); the touched paths stay.
 * @param {string} sessionId
 * @param {{base?: string, source?: string}} [o] source: the SessionStart source, kept as the reason of the next delivery
 * @returns {boolean} true when there was something to forget
 */
function resetInjected(sessionId, { base, source } = {}) {
  if (!safeId(sessionId)) return false;
  const state = readState(sessionId, base);
  if (!state.delivered.length && state.lookedUp === null) return false;
  writeState(sessionId, { ...state, delivered: [], lookedUp: null, resetBy: String(source || 'reset') }, base);
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

/**
 * The touched paths as the lookup wants them: relative to the project root, `/`-separated, sorted.
 * A path outside the root has no project-relative form and is left out of the lookup (it still
 * switches its kind on through triggersFor).
 */
function relativeFiles(touched, root) {
  const r = root ? path.resolve(root) : '';
  const out = new Set();
  for (const p of touched || []) {
    if (!path.isAbsolute(p)) { out.add(p.replace(/\\/g, '/')); continue; }
    if (!r) continue;
    const rel = path.relative(r, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.add(rel.replace(/\\/g, '/'));
  }
  return [...out].sort();
}

/**
 * Split the lookup reply into the rules to deliver now and the ones refused. A rule whose id is not
 * `rule:<known kind>:<slug>` is refused (never silently skipped): its kind has no trigger, so it
 * would never reach any session.
 * @param {object[]} rules lookup reply
 * @param {{touched: string[], delivered: string[], hasFiles: boolean}} s
 * @returns {{deliver: Array<{id: string, kind: string, text: string}>, refused: Array<{id: string, why: string}>}}
 */
function select(rules, { touched, delivered, hasFiles }) {
  const wanted = new Set(['sempre', ...triggersFor(touched)]);
  const done = new Set(delivered);
  const deliver = [];
  const refused = [];
  for (const r of rules || []) {
    const id = String((r && r.id) || '');
    const parsed = parseRuleId(id);
    if (!parsed) { refused.push({ id, why: `unknown rule id (expected rule:<${KIND_NAMES}>:<slug>)` }); continue; }
    if (done.has(id) || !wanted.has(parsed.kind)) continue;
    // Without files the server skips its path filter: a path-scoped rule is not in scope yet.
    if (!hasFiles && Array.isArray(r.paths) && r.paths.length) continue;
    const text = String(r.text || '').trim();
    if (!text) { refused.push({ id, why: 'empty text' }); continue; }
    deliver.push({ id, kind: parsed.kind, text });
  }
  return { deliver, refused };
}

/** Declarative block for the model; each rule is cut at `maxChars` with a visible mark. */
function render(rules, maxChars) {
  const kinds = [...new Set(rules.map((r) => r.kind))];
  const cut = (r) => (r.text.length > maxChars ? `${r.text.slice(0, maxChars)}\n[regra ${r.id} cortada em ${maxChars} de ${r.text.length} caracteres]` : r.text);
  return `[BOSS regras do dono — escopo: ${kinds.join(', ')}]\n${rules.map((r) => `- (${r.id}) ${cut(r)}`).join('\n')}`;
}

async function defaultLookup({ files, projectId }) {
  if (require('../../engine/brain-backend.js').peekMode() !== 'mcp-memory') return null;
  return require('./scoped-rules-client.js').lookupScopedRules({ files, projectId, idPrefix: 'rule:' });
}

/**
 * UserPromptSubmit entry: the rules newly in scope for this session and what must be shown to the
 * owner. A lookup failure is shown once (notice-once) and retried on the next prompt; refused rule
 * ids are shown once per session.
 * @param {object} event hook payload (session_id)
 * @param {{base?: string, maxChars: number, setMaxChars?: number, root?: string, projectId?: string,
 *   lookup?: (q: {files: string[], projectId?: string}) => Promise<{rules: object[]}|null>}} opts
 *   lookup resolves null when the memory backend is not mcp-memory (no rules to ask for)
 * @returns {Promise<{context: string, notice: string}>}
 */
async function inject(event, { base, maxChars, setMaxChars = SET_MAX_CHARS, root, projectId, lookup = defaultLookup } = {}) {
  const none = { context: '', notice: '' };
  const sid = (event && (event.session_id || event.sessionId)) || '';
  if (!safeId(sid)) return none;
  const state = readState(sid, base);
  const files = relativeFiles(state.touched, root);
  const key = JSON.stringify(files);
  if (state.lookedUp === key) return none;
  let reply;
  try {
    reply = await lookup({ files, projectId });
  } catch (err) {
    console.error(`[scope-rules] lookup failed: ${err.message}`);
    const shown = notices.notice({ key: NOTICE_KEY, signature: String(err.code || 'error'), text: `${ORIGIN} regras do dono por escopo não chegaram: ${err.message}`, detail: err.stack || err.message, base });
    return { context: '', notice: shown || '' };
  }
  if (!reply) return none;
  notices.recovered(NOTICE_KEY, { base });

  const { deliver, refused } = select(reply.rules, { touched: state.touched, delivered: state.delivered, hasFiles: files.length > 0 });
  const fresh = refused.filter((r) => !state.told.includes(r.id));
  if (fresh.length) {
    journal({ event: 'refused', session: safeId(sid), refused: fresh }, base);
    console.error(`[scope-rules] refused: ${fresh.map((r) => `${r.id} (${r.why})`).join('; ')}`);
  }
  const take = [];
  for (const r of deliver) {
    if (take.length && render([...take, r], maxChars).length > setMaxChars) break;
    take.push(r);
  }
  const deferred = deliver.length - take.length;
  const context = take.length ? render(take, maxChars) : '';
  if (take.length) {
    journal({
      event: 'injected', session: safeId(sid), reason: state.resetBy ? `after-${state.resetBy}` : 'new-scope',
      ids: take.map((r) => r.id), kinds: [...new Set(take.map((r) => r.kind))], chars: context.length, ...(deferred ? { deferred } : {}),
    }, base);
  }
  // Rules past the set cap stay pending: the lookup is not marked done, so the next prompt brings them.
  writeState(sid, {
    ...state,
    delivered: [...state.delivered, ...take.map((r) => r.id)],
    lookedUp: deferred ? state.lookedUp : key,
    resetBy: deferred ? state.resetBy : '',
    told: [...state.told, ...fresh.map((r) => r.id)],
  }, base);
  const notice = fresh.length ? `${ORIGIN} regra do dono recusada: ${fresh.map((r) => `${r.id || '(sem id)'} — ${r.why}`).join('; ')}` : '';
  return { context, notice };
}

module.exports = { parseRuleId, triggersFor, recordTouched, resetInjected, forget, relativeFiles, select, render, inject, readState };
