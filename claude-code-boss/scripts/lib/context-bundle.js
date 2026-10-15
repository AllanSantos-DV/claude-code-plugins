'use strict';
/**
 * context-bundle.js — PROTOTYPE (opt-in): given a theme, the relevant excerpts of a project in ONE call, so the agent
 * does not spend a burst of read-only turns (Read, Grep, Glob, search…) finding them one by one.
 *
 * It reuses what already exists instead of searching on its own:
 *   - Smart Tool (the user's MCP server over HTTP) for code, tests and docs — `smart_search` is called through the MCP
 *     handshake, ranked hits come back as path + line range, and the excerpt is read from the file itself;
 *   - the Brain's recall (`retrieve-core.retrieve` + `formatContext`), the same one the prompt hook injects;
 *   - the project's task maps / plans (`docs/maps`, `docs/plans`, written by the task-map skill): the sections that
 *     mention the theme.
 * Each source fails on its own and says so in `notes` (a bundle that silently lacks a source would look complete).
 * Pure core + injected deps → unit-tested; `scripts/context-bundle.js` is the CLI.
 */
const fs = require('fs');
const path = require('path');
const { parseRpcBody, estTokens } = require('./fixed-cost.js');

const DEFAULT_LIMITS = { codeHits: 6, testHits: 2, docHits: 3, maxLinesPerHit: 40, maxTokens: 6000, mapFiles: 2, mapLines: 30 };

/** One MCP tool call over streamable HTTP (initialize → initialized → tools/call). Returns the first text content. */
async function mcpCallTool(url, name, args, { timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const call = async (body, extra) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      return { status: res.status, session: res.headers.get('mcp-session-id'), msg: res.ok ? parseRpcBody(text, res.headers.get('content-type')) : null, text };
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? `${url}: no answer in ${timeoutMs}ms` : `${url}: ${err.message}`);
    } finally { clearTimeout(timer); }
  };
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code-boss-context-bundle', version: '1' } } });
  if (init.status >= 400 || !init.msg || init.msg.error) throw new Error(`initialize: HTTP ${init.status} ${init.msg && init.msg.error ? init.msg.error.message : init.text.slice(0, 120)}`);
  const sess = init.session ? { 'mcp-session-id': init.session } : {};
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, sess).catch((err) => { console.error(`[context-bundle] initialized notification: ${err.message}`); });
  const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sess);
  if (r.status >= 400 || !r.msg || r.msg.error) throw new Error(`${name}: HTTP ${r.status} ${r.msg && r.msg.error ? r.msg.error.message : r.text.slice(0, 160)}`);
  const res = r.msg.result || {};
  const text = (res.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  if (res.isError) throw new Error(`${name} returned an error: ${text.slice(0, 200)}`);
  return text;
}

/** The ranked hits of a Smart Tool `smart_search` answer (YAML-ish text) → {code, test, doc}: [{path,start,end,score}]. */
function parseSmartHits(text) {
  const out = { code: [], test: [], doc: [] };
  let kind = null;
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const k = /^(code|test|doc):\s*$/.exec(line);
    if (k) { kind = k[1]; cur = null; continue; }
    if (!kind) continue;
    const p = /^\s+-\s+path:\s*(.+?)\s*$/.exec(line);
    if (p) { cur = { path: p[1].replace(/^["']|["']$/g, ''), start: null, end: null, score: null }; out[kind].push(cur); continue; }
    if (!cur) continue;
    const l = /^\s+lines:\s*(\d+)(?:\s*-\s*(\d+))?/.exec(line);
    if (l) { cur.start = Number(l[1]); cur.end = Number(l[2] || l[1]); continue; }
    const sc = /^\s+score:\s*([\d.]+)/.exec(line);
    if (sc) cur.score = Number(sc[1]);
  }
  return out;
}

/** Smart Tool search through its HTTP MCP endpoint, polling the background job when the index is still being built. */
async function smartSearch(theme, root, { url, pollMs = 700, timeoutMs = 240000, call = mcpCallTool, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limits = DEFAULT_LIMITS } = {}) {
  if (!url) throw new Error('Smart Tool URL unknown (set contextBundle.smartToolUrl, or add the smart-tool MCP server)');
  const first = await call(url, 'smart_search', {
    project_root: root, query_identifiers: theme, query_comments: theme, group: 'all',
    top_k: { code: limits.codeHits, test: limits.testHits, doc: limits.docHits },
  });
  let doc = null;
  try { doc = JSON.parse(first); } catch (err) { void err; /* a direct (non-JSON) answer is already the result text */ }
  if (!doc || typeof doc !== 'object') return parseSmartHits(first);
  const t0 = Date.now();
  while (doc.status === 'pending') {
    if (Date.now() - t0 > timeoutMs) throw new Error(`smart_search still pending after ${Math.round(timeoutMs / 1000)}s (${doc.phase || '?'})`);
    await sleep(pollMs);
    doc = JSON.parse(await call(url, 'smart_search_result', { job_id: doc.job_id }));
  }
  if (doc.status && doc.status !== 'done') throw new Error(`smart_search ${doc.status}: ${doc.message || doc.error || ''}`);
  return parseSmartHits(typeof doc.result === 'string' ? doc.result : JSON.stringify(doc.result || ''));
}

/** `maxLines` lines of the hit's range (the start of it when longer) with a header; null when the file is gone, `{stale}` when the range is past its end. */
function readExcerpt(root, hit, maxLines) {
  const file = path.resolve(root, hit.path);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  const start = Math.max(1, hit.start || 1);
  if (start > lines.length) return { stale: `${hit.path}:${start}-${hit.end} is past the end of the file (${lines.length} lines): stale index` };
  const end = Math.min(lines.length, hit.end || start + maxLines - 1);
  const take = Math.min(end, start + maxLines - 1);
  const body = lines.slice(start - 1, take).map((l, i) => `${start + i}: ${l}`).join('\n');
  return { header: `${hit.path}:${start}-${take}${take < end ? ` (range runs to ${end})` : ''}`, text: body };
}

const keywordsOf = (theme) => [...new Set((String(theme).toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || []))];

/** Sections of the task maps / plans that mention the theme (best files first). */
function findMapSections(root, theme, { mapFiles, mapLines }) {
  const kws = keywordsOf(theme);
  if (!kws.length) return [];
  const found = [];
  for (const dir of ['docs/maps', 'docs/plans']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.md')); } catch (err) { if (err.code !== 'ENOENT') throw err; continue; }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
      const lower = lines.map((l) => l.toLowerCase());
      const score = kws.filter((k) => lower.some((l) => l.includes(k))).length;
      if (score < 2) continue;
      const first = lower.findIndex((l) => kws.some((k) => l.includes(k)));
      let from = first;
      while (from > 0 && !/^#{1,4}\s/.test(lines[from])) from--;
      found.push({ path: rel, score, start: from + 1, end: Math.min(lines.length, from + mapLines), lines });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, mapFiles).map((m) => ({ header: `${m.path}:${m.start}-${m.end}`, path: m.path, text: m.lines.slice(m.start - 1, m.end).map((l, i) => `${m.start + i}: ${l}`).join('\n') }));
}

/** The Brain's recall for the theme (what the prompt hook would inject), as text; {error} when it cannot answer. */
async function brainMemory(theme, root) {
  const projectId = require('../../engine/lib/project-id.js');
  const rc = require('../../engine/lib/retrieve-core.js');
  const project = projectId.resolveProjectId({ cwd: root });
  const r = await rc.retrieve(theme, { project });
  if (!r.entries || !r.entries.length) return { entries: 0, text: '', reason: r.reason || 'no-match' };
  return { entries: r.entries.length, text: rc.formatContext(r.entries) };
}

/**
 * @param {{theme:string, root:string, deps?:{smartSearch?:Function, memory?:Function, maps?:Function}, limits?:object}} o
 * @returns {Promise<{theme:string, tokens:number, files:string[], sections:object[], memory:object|null, notes:string[], text:string}>}
 */
async function buildBundle({ theme, root, deps = {}, limits = {} }) {
  if (typeof theme !== 'string' || theme.trim().length < 3) throw new Error('context-bundle: a theme of at least 3 characters is required');
  if (!root) throw new Error('context-bundle: root is required');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const notes = [];
  const sections = [];
  let hits = { code: [], test: [], doc: [] };
  try {
    hits = await (deps.smartSearch || ((t, r) => smartSearch(t, r, { url: deps.smartToolUrl, limits: lim })))(theme, root);
  } catch (err) { notes.push(`code/docs unavailable — ${err.message}`); }
  const seen = new Set();
  for (const kind of ['code', 'test', 'doc']) {
    for (const h of hits[kind] || []) {
      const key = `${h.path}:${h.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ex = readExcerpt(root, h, lim.maxLinesPerHit);
      if (!ex) { notes.push(`${h.path} is in the index but not on disk (stale index)`); continue; }
      if (ex.stale) { notes.push(ex.stale); continue; }
      sections.push({ kind, path: h.path.replace(/\\/g, '/'), score: h.score, header: ex.header, text: ex.text });
    }
  }
  try {
    for (const m of (deps.maps || findMapSections)(root, theme, lim)) sections.push({ kind: 'map', path: m.path, header: m.header, text: m.text });
  } catch (err) { notes.push(`task maps unavailable — ${err.message}`); }
  let memory = null;
  try { memory = await (deps.memory || brainMemory)(theme, root); } catch (err) { notes.push(`memory unavailable — ${err.message}`); }
  if (memory && memory.entries === 0) notes.push(`memory: nothing matched (${memory.reason})`);

  // Fit the budget: sections are already in relevance order per kind; drop from the tail and say so.
  const render = (secs) => [
    `# Context for: ${theme.trim().slice(0, 200)}`,
    ...secs.map((s) => `\n## [${s.kind}] ${s.header}\n${s.text}`),
    ...(memory && memory.text ? [`\n## [memory]\n${memory.text}`] : []),
    ...(notes.length ? [`\n## notes\n${notes.map((n) => `- ${n}`).join('\n')}`] : []),
  ].join('\n');
  let kept = sections.slice();
  let text = render(kept);
  while (estTokens(text) > lim.maxTokens && kept.length > 1) {
    const dropped = kept.pop();
    notes.push(`dropped ${dropped.header} to fit ${lim.maxTokens} tokens`);
    text = render(kept);
  }
  return { theme, tokens: estTokens(text), files: [...new Set(kept.map((s) => s.path))], sections: kept, memory, notes, text };
}

module.exports = { buildBundle, smartSearch, parseSmartHits, readExcerpt, findMapSections, keywordsOf, mcpCallTool, DEFAULT_LIMITS };
