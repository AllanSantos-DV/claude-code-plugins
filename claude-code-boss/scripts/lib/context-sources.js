'use strict';
/**
 * context-sources.js — where each session's context goes, by source, read from the user's own transcripts
 * (~/.claude/projects/<folder>/<session>.jsonl). Read-only: it never edits a file, a setting or a transcript.
 *
 * For every request of a main session the context Claude Code measured (`usage`: input + cache read + cache write)
 * is the total. That total is split across the blocks the session carries at that point (instruction files, hook
 * injections, skill and agent listings, skill bodies, tool results, messages, the conversation), in proportion to
 * their size (4 chars ≈ 1 token). What the blocks do not explain at the first request of a stretch (session start or
 * compaction) is Claude Code's own system prompt and tool definitions; what it grows beyond that is the model's
 * thinking, which recent models keep in context and bill as input while the transcript stores it encrypted, empty
 * (platform.claude.com/docs/en/build-with-claude/extended-thinking). A compaction boundary empties the carried
 * blocks. Each request costs input-equivalent tokens: input 1×, cache read 0.1× (0.05× on Opus/Sonnet 5.5, 0.025×
 * on Fable/Mythos 5.x), cache write 1.25× (5 min) or 2× (1 h) — platform.claude.com/docs/en/build-with-claude/prompt-caching.
 *
 * Sessions are compared with the user's own median. A session is off the norm when it costs at least the median
 * session and a source in it holds at least `ratio`× that source's median, at least `floorTokens` per request and
 * at least `minShare` of the session's cost.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DAY = 86400000;
const CHARS_PER_TOKEN = 4;
const SYSTEM = 'system';
const THINKING = 'thinking';
// Not something to cut: the fixed system prompt, and what compaction itself produces.
const NOT_FLAGGED = new Set([SYSTEM, 'compaction-summary', 'session']);
const MIN_REQUESTS = 3;
const MIN_SESSIONS = 5;
// Rows Claude Code logs for the user or for itself, never sent to the model.
const NOT_IN_CONTEXT = new Set(['prompt_snapshot', 'hook_success', 'hook_system_message', 'deferred_tools_delta', 'deferred_tools_record',
  'command_permissions', 'hook_cancelled', 'goal_status', 'session_cron_carry', 'invoked_skills']);
const INCOMING = /^Another Claude session sent a message|<cross-session-message|<task-notification/;
const BUILTIN_TOOLS = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'SendMessage', 'ToolSearch', 'Skill', 'NotebookEdit', 'PowerShell']);

const len = (x) => (x == null ? 0 : typeof x === 'string' ? x.length : JSON.stringify(x).length);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Cache-read multiplier of a model id (input-equivalent). */
function readWeight(model) {
  const m = String(model || '');
  if (/fable-5|mythos-5/.test(m)) return 0.025;
  if (/(opus|sonnet)-5[-.]5/.test(m)) return 0.05;
  return 0.1;
}

/** Input-equivalent tokens of one request's usage. */
function requestCost(u, model) {
  const cc = u.cache_creation || {};
  const write = u.cache_creation_input_tokens || 0;
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : write - w1h;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * readWeight(model) + w5 * 1.25 + w1h * 2;
}

/** Short tag naming whoever injected a hook block: its leading `[TAG ...]`, else its first words. */
function hookTag(text) {
  const t = String(text).trimStart();
  const m = /^\[([A-Za-z][\w.@-]{0,30})/.exec(t);
  if (m) return m[1];
  const first = t.split('\n')[0].split(/\s+/).slice(0, 3).join(' ');
  return first.length > 30 ? `${first.slice(0, 30)}…` : first || '(empty)';
}

/** One hook context is one or more blocks: an array, or several `[TAG]` sections glued in one string. */
function hookBlocks(content) {
  if (Array.isArray(content)) return content.map(String);
  return String(content || '').split(/\n(?=\[[A-Za-z])/);
}

/** Label of an instruction file: global and memory files by role, the others by name and folder. */
function instructionLabel(file, home) {
  const p = path.resolve(String(file || ''));
  if (p.toLowerCase() === path.join(home, '.claude', 'CLAUDE.md').toLowerCase()) return 'CLAUDE.md (global)';
  if (/MEMORY\.md$/i.test(p)) return 'MEMORY.md (memory)';
  return `${path.basename(p)} (${path.basename(path.dirname(p))})`;
}

/** `skill:<name>` of a loaded skill body (first line "Base directory for this skill: <dir>"), else null. */
function skillKey(text) {
  const m = /^Base directory for this skill: ([^\n]+)/.exec(String(text));
  return m ? `skill:${path.basename(m[1].trim())}` : null;
}

/**
 * The sources one transcript row adds to the context, as `[key, chars]`. `toolNames` maps tool_use ids to names
 * (filled from assistant rows, read by tool_result rows).
 */
function rowSources(r, toolNames, home) {
  const out = [];
  const add = (k, c) => { if (c > 0) out.push([k, c]); };
  if (r.type === 'attachment') {
    const a = r.attachment || {};
    const t = a.type;
    if (NOT_IN_CONTEXT.has(t)) return out;
    if (t === 'instructions') { for (const f of a.files || []) add(`instructions:${instructionLabel(f.path, home)}`, len(f.content)); return out; }
    if (t === 'hook_additional_context') { for (const b of hookBlocks(a.content)) add(`hook:${a.hookEvent || a.hookName || '?'}:${hookTag(b)}`, b.length); return out; }
    if (t === 'hook_blocking_error' || t === 'hook_non_blocking_error') { add('hook-errors', len(a.blockingError || a.stderr || a.stdout)); return out; }
    if (t === 'skill_listing') { add('listing:skills', len(a.content)); return out; }
    if (t === 'agent_listing_delta') { add('listing:agents', len(a.addedLines)); return out; }
    if (t === 'mcp_instructions_delta') { add('listing:mcp-instructions', len(a.addedBlocks)); return out; }
    if (t === 'file' || t === 'edited_text_file' || t === 'compact_file_reference') { add('files', len(a.content || a.snippet || a.filename)); return out; }
    if (t === 'queued_command' || t === 'task_status') { add('messages', len(a.prompt || a.description || a.deltaSummary || a)); return out; }
    add('session', len(a));
    return out;
  }
  if (r.type === 'user' && r.message) {
    const c = r.message.content;
    if (typeof c === 'string') {
      if (r.isCompactSummary) add('compaction-summary', c.length);
      else if (skillKey(c)) add(skillKey(c), c.length);
      else if (INCOMING.test(c)) add('messages', c.length);
      else if (r.isMeta && /^Stop hook feedback/.test(c)) add('hook:Stop:feedback', c.length);
      else add('conversation', c.length);
      return out;
    }
    for (const p of c || []) {
      if (p.type === 'tool_result') {
        const n = toolNames.get(p.tool_use_id) || '?';
        const mcp = /^mcp__(.+?)__/.exec(n);
        add(mcp ? `tool:mcp:${mcp[1]}` : `tool:${BUILTIN_TOOLS.has(n) ? n : 'other'}`, len(p.content));
      } else if (p.type === 'text') add(skillKey(p.text) || 'conversation', p.text.length);
      else add('conversation', len(p));
    }
    return out;
  }
  if (r.type === 'assistant' && r.message) {
    for (const p of r.message.content || []) {
      if (p.type === 'tool_use') { toolNames.set(p.id, p.name); add('conversation', len(p.input)); }
      else if (p.type === 'text') add('conversation', p.text.length);
      else if (p.type === 'thinking') add('conversation', len(p.thinking));
    }
  }
  return out;
}

/** A row that starts work: a typed prompt, a message from another session, a task notification or a queued command. */
function isTurn(r) {
  if (r.type === 'attachment') return !!r.attachment && r.attachment.type === 'queued_command';
  if (r.type !== 'user' || !r.message || typeof r.message.content !== 'string' || r.isCompactSummary) return false;
  return !r.isMeta || INCOMING.test(r.message.content);
}

/**
 * Walk one transcript into a session record. Returns null when the read was cut by `deadline` (a half-read session
 * would skew the median).
 */
async function readSession(file, { home, cutoff, deadline }) {
  const s = { id: path.basename(file, '.jsonl').slice(0, 8), project: '', startedAt: 0, lastAt: 0, requests: 0, turns: 0, peak: 0, cost: 0, sources: {} };
  const src = (k) => s.sources[k] || (s.sources[k] = { held: 0, added: 0, cost: 0 });
  const toolNames = new Map();
  const seen = new Set();
  let carried = {};
  let base = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (Date.now() > deadline) { rl.close(); return null; }
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (err) { void err; continue; }
    if (r.isSidechain) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (ts && ts < cutoff) continue;
    if (!s.project && r.cwd) s.project = path.basename(r.cwd);
    if (ts) { if (!s.startedAt) s.startedAt = ts; s.lastAt = ts; }
    if (r.type === 'system' && r.subtype === 'compact_boundary') { carried = {}; base = null; continue; }
    const u = r.type === 'assistant' && r.message && r.message.usage;
    if (u && r.message.id && !seen.has(r.message.id)) {
      seen.add(r.message.id);
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) {
        const cost = requestCost(u, r.message.model);
        const est = Object.values(carried).reduce((a, b) => a + b, 0);
        const scale = est > ctx ? ctx / est : 1;
        for (const [k, t] of Object.entries(carried)) { const e = src(k); e.held += t * scale; e.cost += cost * (t * scale) / ctx; }
        const rest = Math.max(0, ctx - est * scale);
        if (base == null) base = rest;
        const parts = [[SYSTEM, Math.min(rest, base)], [THINKING, rest - Math.min(rest, base)]];
        for (const [k, t] of parts) if (t > 0) { const e = src(k); e.held += t; e.cost += cost * t / ctx; }
        s.requests++; s.cost += cost; s.peak = Math.max(s.peak, ctx);
      }
    }
    if (isTurn(r)) s.turns++;
    for (const [k, chars] of rowSources(r, toolNames, home)) {
      const t = chars / CHARS_PER_TOKEN;
      carried[k] = (carried[k] || 0) + t;
      src(k).added += t;
    }
  }
  return s;
}

/**
 * Read the main-session transcripts of the last `days`, newest first, until `budgetMs` is spent.
 * @param {{home?:string, days?:number, now?:number, budgetMs?:number}} [opts]
 * @returns {Promise<{days:number, found:number, read:number, partial:boolean, sessions:object[], errors:string[], ms:number}>}
 */
async function scanSessions({ home = os.homedir(), days = 30, now = Date.now(), budgetMs = 60000 } = {}) {
  const t0 = Date.now();
  const cutoff = now - days * DAY;
  const deadline = t0 + budgetMs;
  const root = path.join(home, '.claude', 'projects');
  const out = { days, found: 0, read: 0, partial: false, sessions: [], errors: [], ms: 0 };
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (err) { out.errors.push(`${root}: ${err.message}`); return out; }
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch (err) { out.errors.push(`${d}: ${err.message}`); continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(root, d, n);
      try { const st = fs.statSync(f); if (st.mtimeMs >= cutoff) files.push({ f, mtime: st.mtimeMs }); } catch (err) { out.errors.push(`${f}: ${err.message}`); }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  out.found = files.length;
  for (const { f } of files) {
    if (Date.now() > deadline) { out.partial = true; break; }
    let s;
    try { s = await readSession(f, { home, cutoff, deadline }); } catch (err) { out.errors.push(`${f}: ${err.message}`); continue; }
    if (!s) { out.partial = true; break; }
    out.read++;
    if (s.requests >= MIN_REQUESTS) out.sessions.push(s);
  }
  out.ms = Date.now() - t0;
  return out;
}

/** What to do about a source that is off the norm, in plain words. */
function adviceFor(key) {
  const [kind, a, b] = key.split(':');
  if (kind === 'instructions') return `${key.slice(13)} loads in every request: move the parts you rarely need into a skill or a file read on demand`;
  if (kind === 'hook') return `the "${b}" hook adds this on ${a}: shorten what it injects or turn it off in the plugin or settings that own it`;
  if (kind === 'hook-errors') return 'a hook keeps failing and its error stays in context: fix it or disable it (the error text is in the transcript)';
  if (kind === 'listing' && a === 'skills') return 'skills you do not use: `doctor --fix` lists them by name only';
  if (kind === 'listing' && a === 'agents') return 'agents you do not invoke: move their files out of ~/.claude/agents (see Agents above)';
  if (kind === 'listing') return 'MCP server instructions: remove servers you do not call (see MCP servers above)';
  if (kind === 'skill') return `the ${a} skill stays in context once loaded: split it, trim it or load it only when needed`;
  if (kind === 'tool' && a === 'Bash') return 'long command output: cap it (head/tail, a curated script) or write it to a file and read the part you need';
  if (kind === 'tool' && a === 'Read') return 'whole files read: pass offset/limit to read only the part you need';
  if (kind === 'tool' && (a === 'Grep' || a === 'Glob')) return 'wide searches: narrow the path or pattern and limit the results';
  if (kind === 'tool' && (a === 'Agent' || a === 'Task')) return 'long sub-agent reports: ask sub-agents for a short summary';
  if (kind === 'tool' && a === 'mcp') return `large results from the ${b} MCP server: ask it for less (limits, filters) or call it less`;
  if (kind === 'tool') return `large ${a} results: ask for less output`;
  if (kind === 'messages') return 'long incoming messages and task notifications: ask senders for shorter reports';
  if (kind === 'files') return 'files attached or re-read after edits: attach only what the task needs';
  if (kind === 'conversation' || kind === 'compaction-summary') return 'a long conversation: start a new session (or /clear) between unrelated tasks';
  if (kind === SYSTEM) return "Claude Code's system prompt and tool definitions: see MCP servers and skills above";
  if (kind === THINKING) return 'the model\'s thinking from earlier turns stays in context: a lower reasoning effort, or a new session (or /clear) between unrelated tasks';
  return 'session data Claude Code attaches on its own';
}

/** Human label of a source key. */
function labelOf(key) {
  const [kind, a, b] = key.split(':');
  if (kind === 'instructions') return `instruction file ${key.slice(13)}`;
  if (kind === 'hook') return `hook ${a} · ${b}`;
  if (kind === 'listing') return `${a} listing`;
  if (kind === 'skill') return `skill ${a}`;
  if (kind === 'tool') return a === 'mcp' ? `tool results · MCP ${b}` : `tool results · ${a}`;
  if (kind === SYSTEM) return 'system prompt and tool definitions';
  if (kind === THINKING) return 'model thinking kept in context (estimated)';
  return kind.replace(/-/g, ' ');
}

/**
 * Totals, the user's median session, per-source medians and the sessions off the norm.
 * @param {{sessions:object[]}} scan output of scanSessions
 * @param {{ratio?:number, floorTokens?:number, minShare?:number, top?:number, maxSessions?:number}} [opts]
 */
function summarizeSessions(scan, { ratio = 2, floorTokens = 3000, minShare = 0.1, top = 8, maxSessions = 10 } = {}) {
  const ss = scan.sessions;
  const perTurn = (s) => s.cost / Math.max(1, s.turns);
  const totals = {};
  let requests = 0; let cost = 0;
  for (const s of ss) {
    requests += s.requests; cost += s.cost;
    for (const [k, e] of Object.entries(s.sources)) { const t = totals[k] || (totals[k] = { cost: 0, held: 0 }); t.cost += e.cost; t.held += e.held; }
  }
  const bySource = Object.entries(totals).sort((x, y) => y[1].cost - x[1].cost).slice(0, top)
    .map(([k, t]) => ({ key: k, label: labelOf(k), pct: cost ? 100 * t.cost / cost : 0, heldPerRequest: requests ? t.held / requests : 0, advice: adviceFor(k) }));
  const med = {
    requests: median(ss.map((s) => s.requests)), turns: median(ss.map((s) => s.turns)), peak: median(ss.map((s) => s.peak)),
    cost: median(ss.map((s) => s.cost)), costPerTurn: median(ss.map(perTurn)),
  };
  const held = (s, k) => (s.sources[k] ? s.sources[k].held / s.requests : 0);
  const sourceMedian = {};
  for (const k of Object.keys(totals)) sourceMedian[k] = median(ss.map((s) => held(s, k)));
  const offNorm = [];
  if (ss.length >= MIN_SESSIONS) {
    for (const s of ss) {
      if (s.cost < med.cost) continue;
      const flags = [];
      for (const [k, e] of Object.entries(s.sources)) {
        const h = held(s, k);
        if (!NOT_FLAGGED.has(k) && h >= floorTokens && h >= ratio * sourceMedian[k] && e.cost >= minShare * s.cost) flags.push({ key: k, label: labelOf(k), held: h, median: sourceMedian[k], advice: adviceFor(k) });
      }
      if (!flags.length) continue;
      flags.sort((x, y) => (y.held - y.median) - (x.held - x.median));
      const costRatio = med.costPerTurn ? perTurn(s) / med.costPerTurn : 0;
      offNorm.push({ id: s.id, project: s.project, startedAt: s.startedAt, requests: s.requests, turns: s.turns, peak: s.peak, cost: s.cost, costRatio, sources: flags.slice(0, 3) });
    }
    offNorm.sort((x, y) => y.cost - x.cost);
  }
  return { days: scan.days, found: scan.found, read: scan.read, partial: scan.partial, sessions: ss.length, ms: scan.ms, errors: scan.errors,
    enough: ss.length >= MIN_SESSIONS, ratio, floorTokens, minShare, median: med, bySource, offNorm: offNorm.slice(0, maxSessions), offNormTotal: offNorm.length };
}

/** Read and summarize in one call (the doctor's entry point). */
async function analyzeContext(opts = {}) {
  return summarizeSessions(await scanSessions(opts), opts);
}

const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');
const times = (a, b) => (b > 0 ? `${(a / b).toFixed(1)}×` : 'usually absent');

/** Plain-text section for `doctor --cost`. */
function formatContext(c) {
  const L = [];
  const scope = c.partial ? `${c.read} of ${c.found} sessions read (newest first; the time budget ran out)` : `${c.read} sessions read`;
  L.push(`Context by source — last ${c.days} days, ${scope}; ${c.sessions} with ${MIN_REQUESTS}+ requests compared. Read-only: nothing is changed.`);
  L.push('  Totals are the context Claude Code measured; the split by source is an estimate (4 chars ≈ 1 token). Cost is input-equivalent tokens (cache read 0.1×, writes 1.25×/2×).');
  L.push('  A turn is a prompt you typed or a message, task notification or queued command the session received.');
  if (!c.sessions) { L.push('  No session to analyze yet.'); return L.join('\n'); }
  L.push('');
  L.push('Where your context goes (all sessions read):');
  for (const s of c.bySource) L.push(`  ${s.pct.toFixed(0).padStart(3)}%  ${s.label} — ~${tok(s.heldPerRequest)} tok per request`);
  L.push('');
  const m = c.median;
  L.push(`Your median session: ${Math.round(m.requests)} requests, ${Math.round(m.turns)} turns, peak ${tok(m.peak)} tok, ${tok(m.cost)} input-eq tokens (${tok(m.costPerTurn)} per turn).`);
  L.push('');
  if (!c.enough) { L.push(`Not enough sessions to compare (${c.sessions}; need ${MIN_SESSIONS}).`); return L.join('\n'); }
  const rule = `costing at least your median session, with a source at ${c.ratio}× your median for it and ${Math.round(c.minShare * 100)}%+ of the session's cost`;
  if (!c.offNorm.length) { L.push(`No session off your norm (${rule}).`); return L.join('\n'); }
  L.push(`Sessions off your norm (${rule}; ${c.offNormTotal} found, the ${c.offNorm.length} that cost most below):`);
  for (const s of c.offNorm) {
    L.push(`  ! ${s.id} ${day(s.startedAt)} ${s.project || '?'} — ${s.requests} requests, ${s.turns} turns, peak ${tok(s.peak)}, ${tok(s.cost)} input-eq (${s.costRatio.toFixed(1)}× your median per turn)`);
    for (const f of s.sources) L.push(`      ${f.label}: ~${tok(f.held)} tok per request (your median ${tok(f.median)}, ${times(f.held, f.median)}) → ${f.advice}`);
  }
  if (c.errors.length) { L.push(''); L.push(`Could not read (${c.errors.length}): ${c.errors.slice(0, 3).join(' | ')}`); }
  return L.join('\n');
}

module.exports = { readWeight, requestCost, hookTag, hookBlocks, rowSources, readSession, scanSessions, summarizeSessions, analyzeContext, adviceFor, labelOf, formatContext, CHARS_PER_TOKEN };
