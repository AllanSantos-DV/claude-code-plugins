'use strict';
/**
 * fixed-cost.js — what every message pays before the user types anything.
 *
 * Everything sent to the server on each request is billed: system prompt, tool definitions (MCP servers),
 * the skill listing, plugins' agents/commands, plus messages and context. The boss already handled the
 * context; this module measures the rest from real data and plans reversible fixes:
 *
 *   - MCP servers   : configured (user/project/plugin) × calls found in recent transcripts × auth state ×
 *                     tokens of what is injected (exact tool names from the transcripts' deferred-tools
 *                     attachment; full definitions measured with a real tools/list on HTTP servers);
 *   - skills        : the listing line of each skill (name + description) × Claude Code's own `skillUsage`;
 *   - plugins       : installed/enabled × Claude Code's own `pluginUsage`.
 *
 * Pure planners (`buildAudit`, `planActions`) take plain data so they are unit-tested without a machine;
 * the gatherers do the I/O and report what they could not read (`errors`), never throw and never guess.
 * Tokens are estimated at 4 chars/token (same as compaction-core) — an estimate, labelled as such.
 *
 * Every fix is reversible and journaled in the undo file (`undoPath`): `applyActions` records how to put
 * it back, `undoActions` does. Servers are removed/re-added through Claude Code's own `claude mcp` CLI
 * (it locks ~/.claude.json, which a running session rewrites all the time); settings.json edits are
 * read-modify-write of one key, published atomically.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

/** Every spawn here is hidden (no console window flashing on Windows); also the default `run` seam of the functions below. */
function hiddenSpawnSync(cmd, args, opts) { return spawnSync(cmd, args, { ...opts, windowsHide: true }); }
const { writeFileAtomic } = require('./atomic-write.js');

const estTokens = (s) => Math.ceil(String(s == null ? '' : s).length / 4);

// USD per million tokens at the user's gateway (Opus 5.5): cache read, cache write 1h. Overridable by opts.pricing.
const PRICING = { read: 0.22, write: 8.8 };
// Claude Code caps `description` + `when_to_use` of a skill at this many chars in its listing (docs: skills, "Skill descriptions").
const SKILL_LISTING_CHARS = 1536;

const sanitize = (n) => String(n).replace(/[^a-zA-Z0-9_-]/g, '_');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const DAY = 86400000;

function _readJsonOrNull(p, errors) {
  try { return readJson(p); } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`${p}: ${err.message}`);
    return null;
  }
}

// ── MCP: configured servers ──────────────────────────────────────────────────

/** Installed plugins' roots from installed_plugins.json (entries may be an array: the last one is current). */
function installedPluginRoots(home, errors) {
  const ip = _readJsonOrNull(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), errors);
  const out = [];
  for (const [id, entries] of Object.entries((ip && ip.plugins) || {})) {
    const e = Array.isArray(entries) ? entries[entries.length - 1] : entries;
    if (e && e.installPath) out.push({ id, name: id.split('@')[0], installPath: e.installPath, version: e.version || '' });
  }
  return out;
}

/**
 * Every MCP server Claude Code would connect to for `cwd`: user (~/.claude.json), the project's own
 * (~/.claude.json projects[cwd] and <cwd>/.mcp.json) and the ones bundled by enabled plugins.
 * `prefix` is how its tools are named in transcripts (`mcp__<prefix>__<tool>`).
 * @returns {{servers: Array<{name:string,prefix:string,scope:string,type:string,config:object,disabled:boolean}>, errors:string[]}}
 */
function listMcpServers({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const errors = [];
  const servers = [];
  const cj = _readJsonOrNull(path.join(home, '.claude.json'), errors) || {};
  const settings = _readJsonOrNull(path.join(home, '.claude', 'settings.json'), errors) || {};
  const proj = (cj.projects && cj.projects[cwd]) || {};
  const disabled = new Set([...(proj.disabledMcpjsonServers || []), ...(proj.disabledMcpServers || [])]);
  const add = (name, scope, config, prefix, pluginRoot) => servers.push({
    name, prefix: prefix || sanitize(name), scope, type: config.type || 'stdio', config, disabled: disabled.has(name), pluginRoot: pluginRoot || '',
  });
  for (const [n, c] of Object.entries(cj.mcpServers || {})) add(n, 'user', c);
  for (const [n, c] of Object.entries(proj.mcpServers || {})) add(n, 'local', c);
  const mj = _readJsonOrNull(path.join(cwd, '.mcp.json'), errors);
  for (const [n, c] of Object.entries((mj && mj.mcpServers) || {})) add(n, 'project', c);
  const enabled = settings.enabledPlugins || {};
  for (const p of installedPluginRoots(home, errors)) {
    if (enabled[p.id] === false) continue;
    const pj = _readJsonOrNull(path.join(p.installPath, '.mcp.json'), errors);
    for (const [n, c] of Object.entries((pj && (pj.mcpServers || pj)) || {})) {
      if (c && typeof c === 'object' && (c.url || c.command)) add(`plugin:${p.name}:${n}`, 'plugin', c, `plugin_${sanitize(p.name)}_${sanitize(n)}`, p.installPath);
    }
  }
  return { servers, errors };
}

/** Names (never tokens) of the MCP servers that have stored OAuth credentials; keys are "<name>|<hash>". */
function oauthNames(home, errors) {
  const c = _readJsonOrNull(path.join(home, '.claude', '.credentials.json'), errors);
  return new Set(Object.keys((c && c.mcpOAuth) || {}).map((k) => k.split('|')[0]));
}

// ── MCP: real usage + injected tool names from the transcripts ───────────────

const NAME_RE = /"name":"mcp__([^"]+?)__([^"]+)"/g;
const tsOf = (line) => { const m = /"timestamp":"([^"]+)"/.exec(line); return m ? (Date.parse(m[1]) || 0) : 0; };

/**
 * Scan the transcripts (~/.claude/projects/<project>/*.jsonl) modified in the last `days` days:
 *   - `byPrefix`: MCP tool calls per server prefix (count, last call);
 *   - `assistantMessages` / `sessions`: how many billed requests each session really makes;
 *   - `oldestMs`: how far back the history actually reaches (evidence that "no calls" means something);
 *   - `delta`: the newest `deferred_tools_delta` attachment (the exact tool names injected into a session and
 *     the servers that failed or were pending), preferring the transcripts of `cwd`'s own project.
 * Streams line by line and only parses the few lines that matter.
 * @param {{home?:string, cwd?:string, days?:number, now?:number}} [opts]
 * @returns {Promise<{byPrefix:object, sessions:number, assistantMessages:number, oldestMs:number, delta:(object|null), errors:string[], ms:number}>}
 */
async function scanUsage({ home = os.homedir(), cwd = process.cwd(), days = 30, now = Date.now() } = {}) {
  const t0 = Date.now();
  const cutoff = now - days * DAY;
  const root = path.join(home, '.claude', 'projects');
  const own = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const out = { byPrefix: {}, byBackend: {}, sessions: 0, assistantMessages: 0, oldestMs: now, delta: null, errors: [], ms: 0 };
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (err) { out.errors.push(`${root}: ${err.message}`); return out; }
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch (err) { out.errors.push(`${d}: ${err.message}`); continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(root, d, n);
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs >= cutoff) files.push({ f, dir: d, birth: st.birthtimeMs || st.mtimeMs });
      } catch (err) { out.errors.push(`${f}: ${err.message}`); }
    }
  }
  let bestOwn = { ts: 0, line: '' };
  let bestAny = { ts: 0, line: '' };
  for (const { f, dir, birth } of files) {
    out.sessions++;
    out.oldestMs = Math.min(out.oldestMs, birth);
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.includes('"type":"assistant"') && !line.includes('"isSidechain":true')) out.assistantMessages++;
        if (line.includes('"deferred_tools_delta"') && line.includes('"addedNames"')) {
          const t = tsOf(line);
          if (t >= bestAny.ts) bestAny = { ts: t, line };
          if (dir === own && t >= bestOwn.ts) bestOwn = { ts: t, line };
          continue;
        }
        if (!line.includes('"name":"mcp__')) continue;
        const ts = tsOf(line);
        if (ts && ts < cutoff) continue;
        NAME_RE.lastIndex = 0;
        let x;
        while ((x = NAME_RE.exec(line))) {
          const e = out.byPrefix[x[1]] || (out.byPrefix[x[1]] = { calls: 0, lastAt: 0 });
          e.calls++;
          if (ts > e.lastAt) e.lastAt = ts;
          const bk = backendKey(x[1], x[2]);
          if (bk) {
            const b = out.byBackend[bk] || (out.byBackend[bk] = { calls: 0, lastAt: 0 });
            b.calls++;
            if (ts > b.lastAt) b.lastAt = ts;
          }
        }
      }
    } catch (err) { out.errors.push(`${f}: ${err.message}`); }
  }
  const win = bestOwn.line ? bestOwn : bestAny;
  if (win.line) {
    try {
      const a = JSON.parse(win.line).attachment || {};
      out.delta = { at: win.ts, names: a.addedNames || [], failed: a.failedMcpServers || [], pending: a.pendingMcpServers || [], own: win === bestOwn };
    } catch (err) { out.errors.push(`deferred_tools_delta: ${err.message}`); }
  }
  out.ms = Date.now() - t0;
  return out;
}

/**
 * An aggregator (the MCP Bridge gateway) names its tools `<backend>__<tool>`, so one Claude-side server hides several
 * backends: `mcp__mcp-gateway__action__doctor` is backend "action". Key "<server>/<backend>", or null for a plain tool.
 */
function backendKey(server, tool) {
  const i = tool.indexOf('__');
  return i > 0 ? `${server}/${tool.slice(0, i)}` : null;
}

/** Group the injected tool names by server prefix: { prefix: { count, tokens } } (tokens = the name lines as listed). */
function toolNamesByServer(names) {
  const out = {};
  for (const n of names || []) {
    const m = /^mcp__(.+?)__(.+)$/.exec(n);
    if (!m) continue;
    const e = out[m[1]] || (out[m[1]] = { count: 0, tokens: 0 });
    e.count++;
    e.tokens += estTokens(`${n}\n`);
    const bk = backendKey(m[1], m[2]);
    if (bk) {
      const b = (e.backends || (e.backends = {}))[bk.slice(m[1].length + 1)] || (e.backends[bk.slice(m[1].length + 1)] = { count: 0, tokens: 0 });
      b.count++;
      b.tokens += estTokens(`${n}\n`);
    }
  }
  return out;
}

// ── MCP: real tools/list of an HTTP server (full definitions) ────────────────

function expandEnv(s, env) {
  return String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : (d !== undefined ? d : '')));
}

function parseRpcBody(text, contentType) {
  if (String(contentType).includes('text/event-stream')) {
    const msgs = [];
    for (const l of text.split(/\r?\n/)) if (l.startsWith('data:')) { try { msgs.push(JSON.parse(l.slice(5).trim())); } catch (err) { void err; } }
    return msgs.find((m) => m && (m.result !== undefined || m.error)) || null;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Real `initialize` + `tools/list` against an HTTP MCP server (no side effects; the same handshake Claude Code does).
 * stdio servers are NOT started: that would launch arbitrary programs (a WhatsApp session adapter, a browser) just to
 * count tokens — for those the exact injected names from the transcripts are used instead.
 * @returns {Promise<{ok:true,toolCount:number,defTokens:number}|{ok:false,needsAuth:boolean,error:string}>}
 */
async function probeHttpTools(server, { env = process.env, timeoutMs = 8000, fetchImpl = globalThis.fetch, run = hiddenSpawnSync } = {}) {
  const c = server.config || {};
  if (!c.url) return { ok: false, needsAuth: false, error: 'no url' };
  // A plugin's server config refers to its own root/data dir (${CLAUDE_PLUGIN_ROOT}), which only the plugin's process has set.
  env = { ...env, CLAUDE_PLUGIN_ROOT: server.pluginRoot || env.CLAUDE_PLUGIN_ROOT || '', CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA || require('./data-dir.js').dataDir() };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const [k, v] of Object.entries(c.headers || {})) headers[k.toLowerCase()] = expandEnv(v, env);
  if (c.headersHelper) {
    const r = run(expandEnv(c.headersHelper, env), [], { shell: true, windowsHide: true, timeout: 8000, encoding: 'utf8', env });
    if (r.status !== 0) return { ok: false, needsAuth: false, error: `headersHelper failed: ${String(r.stderr || r.error || '').trim().split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 1).join('') || 'exit ' + r.status}` };
    try { for (const [k, v] of Object.entries(JSON.parse(r.stdout))) headers[k.toLowerCase()] = String(v); } catch (err) { return { ok: false, needsAuth: false, error: `headersHelper output is not JSON: ${err.message}` }; }
  }
  const url = expandEnv(c.url, env);
  const call = async (body, extra) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      return { status: res.status, session: res.headers.get('mcp-session-id'), msg: res.ok ? parseRpcBody(text, res.headers.get('content-type')) : null, text };
    } finally { clearTimeout(timer); }
  };
  try {
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code-boss-doctor', version: '1' } } });
    if (init.status === 401 || init.status === 403) return { ok: false, needsAuth: true, error: `HTTP ${init.status}` };
    if (init.status >= 400 || !init.msg || init.msg.error) return { ok: false, needsAuth: false, error: `initialize: HTTP ${init.status} ${init.msg && init.msg.error ? init.msg.error.message : init.text.slice(0, 120)}` };
    const sess = init.session ? { 'mcp-session-id': init.session } : {};
    await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, sess).catch((err) => { void err; });
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await call({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} }, sess);
      if (r.status >= 400 || !r.msg || r.msg.error) return { ok: false, needsAuth: r.status === 401, error: `tools/list: HTTP ${r.status} ${r.msg && r.msg.error ? r.msg.error.message : r.text.slice(0, 120)}` };
      tools.push(...((r.msg.result && r.msg.result.tools) || []));
      cursor = r.msg.result && r.msg.result.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, toolCount: tools.length, defTokens: estTokens(JSON.stringify(tools)) };
  } catch (err) {
    return { ok: false, needsAuth: false, error: err.name === 'AbortError' ? `no answer in ${timeoutMs}ms` : err.message };
  }
}

// ── skills and plugins ───────────────────────────────────────────────────────

/** `key: value` frontmatter of a SKILL.md / command (quoted values, `>`/`|` blocks); {} when there is none. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) parts.push(lines[++i].trim());
      v = parts.join(' ').trim();
    } else if (/^(['"])[\s\S]*\1$/.test(v)) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

function _skillEntry(name, source, file, errors) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const desc = `${fm.description || ''} ${fm.when_to_use || ''}`.trim().slice(0, SKILL_LISTING_CHARS);
    const n = fm.name || name;
    return { name: n, source, file, listedTokens: estTokens(`- ${n}: ${desc}`), nameOnlyTokens: estTokens(`- ${n}`) };
  } catch (err) { errors.push(`${file}: ${err.message}`); return null; }
}

function _skillsIn(dir, source, prefix, errors, entries) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') errors.push(`${dir}: ${err.message}`); return; }
  for (const n of names) {
    const sk = path.join(dir, n, 'SKILL.md');
    if (fs.existsSync(sk)) { const e = _skillEntry(n, source, sk, errors); if (e) entries.push({ ...e, name: prefix + e.name }); }
  }
}

function _commandsIn(dir, source, prefix, errors, entries) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') errors.push(`${dir}: ${err.message}`); return; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const e = _skillEntry(n.slice(0, -3), source, path.join(dir, n), errors);
    if (e) entries.push({ ...e, name: prefix + n.slice(0, -3) });
  }
}

/**
 * Everything Claude Code lists as a skill for `cwd`: user and project skills/commands (hideable through
 * settings `skillOverrides`) and enabled plugins' skills/commands (NOT affected by skillOverrides — per the docs the
 * only lever on those is the plugin itself).
 */
function listSkills({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const errors = [];
  const skills = [];
  _skillsIn(path.join(home, '.claude', 'skills'), 'user', '', errors, skills);
  _commandsIn(path.join(home, '.claude', 'commands'), 'user', '', errors, skills);
  _skillsIn(path.join(cwd, '.claude', 'skills'), 'project', '', errors, skills);
  _commandsIn(path.join(cwd, '.claude', 'commands'), 'project', '', errors, skills);
  const settings = _readJsonOrNull(path.join(home, '.claude', 'settings.json'), errors) || {};
  const enabled = settings.enabledPlugins || {};
  for (const p of installedPluginRoots(home, errors)) {
    if (enabled[p.id] === false) continue;
    _skillsIn(path.join(p.installPath, 'skills'), `plugin:${p.name}`, `${p.name}:`, errors, skills);
    _commandsIn(path.join(p.installPath, 'commands'), `plugin:${p.name}`, `${p.name}:`, errors, skills);
  }
  return { skills, overrides: settings.skillOverrides || {}, errors };
}

/** Claude Code's own counters in ~/.claude.json: skillUsage / pluginUsage ({ name: {usageCount,lastUsedAt} }). */
function readUsageCounters(home) {
  const errors = [];
  const cj = _readJsonOrNull(path.join(home, '.claude.json'), errors) || {};
  return { skillUsage: cj.skillUsage || {}, pluginUsage: cj.pluginUsage || {}, errors };
}

function listPlugins({ home = os.homedir() } = {}) {
  const errors = [];
  const settings = _readJsonOrNull(path.join(home, '.claude', 'settings.json'), errors) || {};
  const enabled = settings.enabledPlugins || {};
  const plugins = installedPluginRoots(home, errors).map((p) => ({ id: p.id, name: p.name, version: p.version, enabled: enabled[p.id] !== false }));
  return { plugins, errors };
}

/**
 * The instruction files Claude Code loads on every request (user CLAUDE.md, the project's CLAUDE.md/AGENTS.md, the
 * project's auto-memory index): size only. They are the user's own text — reported, never edited.
 */
function listInstructionFiles({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const own = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const candidates = [
    path.join(home, '.claude', 'CLAUDE.md'), path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md'),
    path.join(cwd, 'AGENTS.md'), path.join(home, '.claude', 'projects', own, 'memory', 'MEMORY.md'),
  ];
  const out = [];
  const errors = [];
  for (const p of candidates) {
    try { out.push({ path: p, tokens: estTokens(fs.readFileSync(p, 'utf8')) }); } catch (err) { if (err.code !== 'ENOENT') errors.push(`${p}: ${err.message}`); }
  }
  return { files: out, errors };
}

// ── the audit (pure) ─────────────────────────────────────────────────────────

const usedRecently = (u, cutoff) => !!(u && u.usageCount > 0 && u.lastUsedAt >= cutoff);

/**
 * Turn the gathered facts into verdicts, token numbers and the list of reversible actions.
 * @param {object} f facts: {days, now, servers, usage, probes, oauth, toolSearch, skills, overrides, counters, plugins, keep, pricing}
 */
function buildAudit(f) {
  const days = f.days || 30;
  const now = f.now || Date.now();
  const cutoff = now - days * DAY;
  const price = { ...PRICING, ...(f.pricing || {}) };
  const keep = new Set(f.keep || []);
  const usage = f.usage || { byPrefix: {}, sessions: 0, assistantMessages: 0, oldestMs: now, delta: null };
  const historyDays = Math.max(0, (now - usage.oldestMs) / DAY);
  // Evidence rule: "no calls" only means "unused" when the scanned history covers at least half the window.
  const enoughHistory = usage.sessions > 0 && historyDays >= days / 2;
  const msgsPerSession = usage.sessions > 0 ? Math.max(1, Math.round(usage.assistantMessages / usage.sessions)) : 100;
  const injected = toolNamesByServer(usage.delta && usage.delta.names);
  const failed = new Set((usage.delta && usage.delta.failed) || []);
  const toolSearch = f.toolSearch !== false;
  const actions = [];

  const mcp = (f.servers || []).map((s) => {
    const u = usage.byPrefix[s.prefix] || { calls: 0, lastAt: 0 };
    const inj = injected[s.prefix] || { count: 0, tokens: 0 };
    const probe = (f.probes || {})[s.name] || null;
    const hasHeaders = !!(s.config.headers && Object.keys(s.config.headers).length) || !!s.config.headersHelper;
    const authenticated = (f.oauth && f.oauth.has(s.name)) || false;
    const needsAuth = s.type !== 'stdio' && !authenticated && !hasHeaders && !!(probe && probe.needsAuth);
    const row = {
      name: s.name, scope: s.scope, type: s.type, calls: u.calls, lastAt: u.lastAt,
      toolCount: inj.count || (probe && probe.ok ? probe.toolCount : null),
      injectedTokens: inj.tokens,
      defTokens: probe && probe.ok ? probe.defTokens : null,
      probeError: probe && !probe.ok ? probe.error : null,
      needsAuth, failedToStart: failed.has(s.name),
      // What this server costs per message with the current Tool Search setting: names only, or full definitions.
      perMessageTokens: toolSearch ? inj.tokens : (probe && probe.ok ? probe.defTokens : inj.tokens),
      verdict: 'keep', reason: `${u.calls} call(s) in ${days}d`,
      // Backends behind an aggregator (MCP Bridge gateway): reported only — removing one is the gateway's own config.
      backends: Object.entries(inj.backends || {}).map(([b, v]) => {
        const bu = (usage.byBackend || {})[`${s.prefix}/${b}`] || { calls: 0, lastAt: 0 };
        return { name: b, tools: v.count, tokens: v.tokens, calls: bu.calls, lastAt: bu.lastAt, unused: bu.calls === 0 && enoughHistory };
      }).sort((x, y) => y.tokens - x.tokens),
    };
    if (s.disabled) { row.verdict = 'disabled'; row.reason = 'already disabled for this project'; row.perMessageTokens = 0; return row; }
    if (keep.has(s.name)) { row.reason = 'kept by fixedCost.keep'; return row; }
    // A project .mcp.json server only loads after the user approves it; absent from the injected tools = not loaded, costs nothing.
    if (s.scope === 'project' && usage.delta && usage.delta.own && !inj.count && !u.calls) {
      row.verdict = 'not-loaded'; row.reason = 'declared in the project .mcp.json but not loaded in the last session (not approved): costs nothing'; row.perMessageTokens = 0;
      return row;
    }
    // Only what lives in the user's own config is ours to remove: a project .mcp.json is a versioned file of that repo, a plugin's server is the plugin's.
    const removable = s.scope === 'user' || s.scope === 'local';
    if (needsAuth) { row.verdict = 'needs-auth'; row.reason = 'asks for authentication (HTTP 401) and was never authenticated: it cannot work'; }
    else if (u.calls === 0 && enoughHistory) { row.verdict = 'unused'; row.reason = `no calls in the last ${days} days (${usage.sessions} sessions, ${historyDays.toFixed(0)} days of history)`; }
    else if (u.calls === 0) { row.reason = `no calls found, but only ${historyDays.toFixed(0)} day(s) of history: not enough to call it unused`; }
    if (row.verdict !== 'keep' && removable) {
      actions.push({ kind: 'mcp-remove', target: s.name, scope: s.scope, config: s.config, tokens: row.perMessageTokens, why: row.reason });
    } else if (row.verdict !== 'keep') {
      row.reason += s.scope === 'plugin' ? ' (bundled by a plugin: disable the plugin to drop it)' : " (from the project's .mcp.json: edit that file if you want it gone)";
    }
    return row;
  });

  const counters = f.counters || { skillUsage: {}, pluginUsage: {} };
  const overrides = f.overrides || {};
  const skills = (f.skills || []).map((s) => {
    const used = usedRecently(counters.skillUsage[s.name], cutoff);
    const ov = overrides[s.name] || 'on';
    const listed = ov === 'on' ? s.listedTokens : (ov === 'name-only' ? s.nameOnlyTokens : 0);
    return { ...s, used, override: ov, listedNow: listed };
  });
  for (const s of skills) {
    if (s.used || s.override !== 'on' || keep.has(s.name)) continue;
    if (s.source === 'user' || s.source === 'project') {
      actions.push({ kind: 'skill-name-only', target: s.name, tokens: s.listedTokens - s.nameOnlyTokens, why: `never used in the last ${days} days (Claude Code's own skillUsage)` });
    }
  }

  const plugins = (f.plugins || []).map((p) => {
    const hits = Object.entries(counters.pluginUsage).filter(([k]) => k === p.id || k.split('@')[0] === p.name);
    const usedP = hits.some(([, u]) => usedRecently(u, cutoff));
    return { ...p, used: usedP };
  });
  for (const p of plugins) {
    if (!p.enabled || p.used || p.name === 'claude-code-boss' || keep.has(p.id) || keep.has(p.name)) continue;
    const owned = skills.filter((s) => s.source === `plugin:${p.name}`);
    actions.push({ kind: 'plugin-disable', target: p.id, tokens: owned.reduce((n, s) => n + s.listedNow, 0), why: `installed but not used in the last ${days} days (Claude Code's own pluginUsage)` });
  }

  const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const perMessage = (tokens) => (tokens * price.read) / 1e6;
  const perSession = (tokens) => (tokens * (price.write + (msgsPerSession - 1) * price.read)) / 1e6;
  const saveTokens = sum(actions, 'tokens');
  return {
    days, now, historyDays, sessions: usage.sessions, msgsPerSession, enoughHistory, toolSearch,
    mcp, skills, plugins, actions, instructions: f.instructions || [],
    totals: {
      mcpTokens: sum(mcp, 'perMessageTokens'), skillTokens: sum(skills, 'listedNow'), instructionTokens: sum(f.instructions || [], 'tokens'),
      mcpServers: mcp.length, mcpUsed: mcp.filter((r) => r.calls > 0).length,
      skillsTotal: skills.length, skillsUsed: skills.filter((s) => s.used).length, skillsHidden: skills.filter((s) => s.override !== 'on').length,
      pluginsTotal: plugins.length, pluginsUsed: plugins.filter((p) => p.used).length,
    },
    savings: { tokens: saveTokens, perMessageUsd: perMessage(saveTokens), perSessionUsd: perSession(saveTokens) },
    price,
  };
}

// ── the boss's own settings (pure) ───────────────────────────────────────────

const WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const TOOL_SEARCH_KEY = 'ENABLE_TOOL_SEARCH';

/**
 * Is the boss itself configured the way that does not cost the user money? A wrong value here hurts every
 * session: a fixed auto-compact window (153000 made the engine compact at ~120k with a warm cache, 15 times in one
 * session), compaction off, the plugin disabled, Tool Search off (every MCP definition sent on every message).
 * @param {{settings:object, compaction:{enabled:boolean,thresholdPercent:number}, costTuning:{autoCompactWindow:(number|null)}, pluginId:(string|null)}} f
 * @returns {{items:Array<{id:string,label:string,status:'ok'|'warn'|'fail',detail:string,fix:string}>, actions:object[]}}
 */
function auditBossConfig(f) {
  const env = (f.settings && f.settings.env) || {};
  const items = [];
  const actions = [];
  const c = f.compaction || {};
  const pct = c.thresholdPercent;
  items.push(c.enabled === false
    ? { id: 'boss-compaction', label: 'Compaction (boss)', status: 'warn', detail: 'controlled compaction is OFF: the engine alone compacts, with a warm cache and mid-turn', fix: 'What to do: turn it on in the dashboard (Compaction) or set compaction.enabled=true in hooks/user-config.json. (The `free` profile turns it off on purpose.)' }
    : { id: 'boss-compaction', label: 'Compaction (boss)', status: 'ok', detail: `on, at ${pct}% of the model window (${Math.round(200000 * pct / 100)} tokens of 200k, ${Math.round(1000000 * pct / 100)} of 1M) — a percent, never a fixed number`, fix: '' });
  const w = env[WINDOW_KEY];
  const optedIn = f.costTuning && f.costTuning.autoCompactWindow != null && String(f.costTuning.autoCompactWindow) === String(w);
  // 1,000,000 = the largest window of any model: compaction at 967k is the engine default for a 1M model, not a squeeze.
  const squeezes = w !== undefined && !(Number(w) >= 1000000);
  if (squeezes && !optedIn) {
    items.push({ id: 'boss-fixed-window', label: 'Fixed auto-compact window', status: 'warn', detail: `settings.json env has ${WINDOW_KEY}=${w}: the engine compacts at ${Number(w) ? Number(w) - 33000 : '?'} tokens whatever the model window, mid-turn, with a warm cache (the 153000 case)`, fix: 'Run `node scripts/doctor.js --fix` to remove it (saved to the undo journal; `--undo` puts it back), or delete the key by hand. Compaction then follows the percent above.' });
    actions.push({ kind: 'env-set', target: WINDOW_KEY, value: undefined, tokens: 0, why: 'fixed window instead of a percent of the model window' });
  } else items.push({ id: 'boss-fixed-window', label: 'Fixed auto-compact window', status: 'ok', detail: w === undefined ? 'none set (the engine follows the model window)' : (optedIn ? `${w}, opted in through costTuning.autoCompactWindow` : `${w}: not below the largest model window, so it does not force earlier compaction`), fix: '' });
  const ts = env[TOOL_SEARCH_KEY];
  if (ts === undefined || String(ts).toLowerCase() === 'false') {
    items.push({ id: 'boss-tool-search', label: 'Tool Search (ENABLE_TOOL_SEARCH)', status: 'warn', detail: ts === undefined ? 'not set: MCP tool definitions may be sent in full on every message' : 'set to false: every MCP tool definition is sent in full on every message', fix: 'Run `node scripts/doctor.js --fix` to set it to true (undo with `--undo`); Claude Code reads it at launch, so restart it afterwards.' });
    actions.push({ kind: 'env-set', target: TOOL_SEARCH_KEY, value: 'true', tokens: 0, why: 'Tool Search off' });
  } else items.push({ id: 'boss-tool-search', label: 'Tool Search (ENABLE_TOOL_SEARCH)', status: 'ok', detail: `${TOOL_SEARCH_KEY}=${ts}`, fix: '' });
  const on = !f.pluginId || !f.settings || !f.settings.enabledPlugins || f.settings.enabledPlugins[f.pluginId] !== false;
  if (!on) {
    items.push({ id: 'boss-plugin', label: 'Plugin enabled', status: 'fail', detail: `${f.pluginId} is disabled in settings.json: no hooks, no compaction control, no memory`, fix: 'Run `node scripts/doctor.js --fix` to enable it (undo with `--undo`), then restart Claude Code.' });
    actions.push({ kind: 'plugin-enable', target: f.pluginId, tokens: 0, why: 'the boss plugin is disabled' });
  } else items.push({ id: 'boss-plugin', label: 'Plugin enabled', status: 'ok', detail: f.pluginId ? `${f.pluginId} enabled` : 'running from a plugin directory', fix: '' });
  return { items, actions };
}

// ── gather + audit (I/O) ─────────────────────────────────────────────────────

/** Gather everything and build the audit. `probe:false` skips the HTTP tools/list (offline / hooks). */
async function runAudit({ home = os.homedir(), cwd = process.cwd(), days = 30, keep = [], probe = true, env = process.env, now = Date.now(), probeFn = probeHttpTools, scan = scanUsage } = {}) {
  const errors = [];
  const ms = listMcpServers({ home, cwd });
  const sk = listSkills({ home, cwd });
  const pl = listPlugins({ home });
  const ins = listInstructionFiles({ home, cwd });
  const counters = readUsageCounters(home);
  const usage = await scan({ home, cwd, days, now });
  const oauth = oauthNames(home, errors);
  const settings = _readJsonOrNull(path.join(home, '.claude', 'settings.json'), errors) || {};
  const ts = String((settings.env || {}).ENABLE_TOOL_SEARCH ?? env.ENABLE_TOOL_SEARCH ?? '').toLowerCase();
  const probes = {};
  if (probe) {
    // Only streamable HTTP: an SSE server needs a long-lived GET stream, which is not worth opening just to count.
    await Promise.all(ms.servers.filter((s) => s.type === 'http' || s.type === 'streamable-http').map(async (s) => {
      probes[s.name] = await probeFn(s, { env });
    }));
  }
  errors.push(...ms.errors, ...sk.errors, ...pl.errors, ...ins.errors, ...counters.errors, ...usage.errors);
  const audit = buildAudit({ days, now, servers: ms.servers, usage, probes, oauth, toolSearch: ts !== 'false', skills: sk.skills, overrides: sk.overrides, counters, plugins: pl.plugins, instructions: ins.files, keep });
  audit.errors = errors;
  audit.scanMs = usage.ms;
  return audit;
}

// ── actions: apply / undo (reversible, journaled) ────────────────────────────

function undoPath(home = os.homedir()) { return path.join(home, '.claude', 'claude-code-boss', 'fixed-cost-undo.json'); }

function readUndo(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`undo journal ${file} is unreadable (${err.message}) — fix or remove it before applying more changes`);
  }
}
// The journal can hold a removed MCP server's whole config (headers, env): owner-only where the OS has modes.
const writeUndo = (file, list) => {
  writeFileAtomic(file, JSON.stringify(list, null, 2) + '\n');
  try { fs.chmodSync(file, 0o600); } catch (err) { console.error(`[fixed-cost] could not restrict ${file} to the owner: ${err.message}`); }
};

/** The claude CLI as an exe we can spawn without a shell (quoting a JSON argument through cmd.exe is a trap). */
function resolveClaudeBin(env = process.env, run = hiddenSpawnSync) {
  if (env.CLAUDE_CODE_EXECPATH && fs.existsSync(env.CLAUDE_CODE_EXECPATH)) return env.CLAUDE_CODE_EXECPATH;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = run(finder, ['claude'], { encoding: 'utf8', windowsHide: true, env });
  for (const p of String(r.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (/\.exe$/i.test(p) || process.platform !== 'win32') return p;
    const exe = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('cannot find the claude executable (set CLAUDE_CODE_EXECPATH to its path)');
}

function _claude(args, { env = process.env, run = hiddenSpawnSync, bin } = {}) {
  const r = run(bin || resolveClaudeBin(env, run), args, { encoding: 'utf8', windowsHide: true, env, timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`claude ${args.slice(0, 3).join(' ')} failed: ${(r.error && r.error.message) || String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return String(r.stdout || '').trim();
}

function _settingsRMW(file, mutate) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file} is unreadable (${err.message}) — not touching it`);
  }
  mutate(s);
  writeFileAtomic(file, JSON.stringify(s, null, 2) + '\n');
}

// settings.json-backed actions: which top-level object holds the value, what is written, what is said.
const SETTINGS_KINDS = {
  'skill-name-only': { root: 'skillOverrides', value: () => 'name-only', msg: (a) => `"${a.target}" now lists by name only (loaded on demand)` },
  'plugin-disable': { root: 'enabledPlugins', value: () => false, msg: (a) => `plugin ${a.target} disabled` },
  'plugin-enable': { root: 'enabledPlugins', value: () => true, msg: (a) => `plugin ${a.target} enabled` },
  // value undefined = remove the key
  'env-set': { root: 'env', value: (a) => a.value, msg: (a) => (a.value === undefined ? `${a.target} removed from settings.json env` : `${a.target}=${a.value} set in settings.json env`) },
};

/**
 * Apply the actions, journaling how to undo each one BEFORE changing anything.
 * One failing action is reported and does not stop the others.
 * Kinds: mcp-remove (via `claude mcp remove`), skill-name-only, plugin-disable, env-set (settings.json).
 * @param {object[]} actions from buildAudit().actions (or built by the doctor's config checks)
 * @param {{home?:string, env?:object, run?:Function, only?:string[]}} [opts]
 * @returns {Array<{kind:string,target:string,ok:boolean,message:string,undo:string}>}
 */
function applyActions(actions, { home = os.homedir(), env = process.env, run = hiddenSpawnSync, only = null } = {}) {
  const jf = undoPath(home);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const claudeEnv = { ...env, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') };
  const results = [];
  for (const a of actions) {
    if (only && !only.includes(a.kind)) continue;
    const entry = { id: `${Date.now().toString(36)}-${results.length}`, at: new Date().toISOString(), kind: a.kind, target: a.target };
    try {
      if (a.kind === 'mcp-remove') {
        Object.assign(entry, { scope: a.scope, config: a.config });
        const journal = readUndo(jf); journal.push(entry); writeUndo(jf, journal);
        try {
          _claude(['mcp', 'remove', a.target, '-s', a.scope], { env: claudeEnv, run });
        } catch (err) {
          // Nothing was removed: a journal entry for it would make --undo "re-add" a server that is still there (duplicate → stuck entry).
          writeUndo(jf, readUndo(jf).filter((x) => x.id !== entry.id));
          throw err;
        }
        results.push({ kind: a.kind, target: a.target, ok: true, message: `removed the "${a.target}" server (${a.scope} scope); its config is saved in ${jf}`, undo: 'node scripts/doctor.js --undo' });
      } else if (SETTINGS_KINDS[a.kind]) {
        const k = SETTINGS_KINDS[a.kind];
        _settingsRMW(settingsFile, (s) => {
          const bag = s[k.root] || {};
          entry.had = Object.prototype.hasOwnProperty.call(bag, a.target);
          entry.previous = bag[a.target];
          const journal = readUndo(jf); journal.push(entry); writeUndo(jf, journal);
          const v = k.value(a);
          if (v === undefined) delete bag[a.target]; else bag[a.target] = v;
          if (Object.keys(bag).length) s[k.root] = bag; else delete s[k.root];
        });
        results.push({ kind: a.kind, target: a.target, ok: true, message: k.msg(a), undo: 'node scripts/doctor.js --undo' });
      } else throw new Error(`unknown action kind ${a.kind}`);
    } catch (err) {
      results.push({ kind: a.kind, target: a.target, ok: false, message: err.message, undo: '' });
    }
  }
  return results;
}

/** Put back what `applyActions` changed (all of it, newest first); an entry that cannot be restored stays in the journal. */
function undoActions({ home = os.homedir(), env = process.env, run = hiddenSpawnSync } = {}) {
  const jf = undoPath(home);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const claudeEnv = { ...env, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') };
  const journal = readUndo(jf);
  const left = [];
  const results = [];
  for (const e of journal.slice().reverse()) {
    try {
      if (e.kind === 'mcp-remove') {
        _claude(['mcp', 'add-json', e.target, JSON.stringify(e.config), '-s', e.scope], { env: claudeEnv, run });
        results.push({ target: e.target, kind: e.kind, ok: true, message: `re-added the "${e.target}" server (${e.scope} scope)` });
      } else if (SETTINGS_KINDS[e.kind]) {
        const root = SETTINGS_KINDS[e.kind].root;
        _settingsRMW(settingsFile, (s) => {
          const bag = s[root] || {};
          if (e.had) bag[e.target] = e.previous; else delete bag[e.target];
          if (Object.keys(bag).length) s[root] = bag; else delete s[root];
        });
        results.push({ target: e.target, kind: e.kind, ok: true, message: `${e.target}: back to ${e.had ? JSON.stringify(e.previous) : 'the default'}` });
      } else throw new Error(`unknown journal kind ${e.kind}`);
    } catch (err) {
      left.unshift(e);
      results.push({ target: e.target, kind: e.kind, ok: false, message: err.message });
    }
  }
  writeUndo(jf, left);
  return results;
}

// ── report ───────────────────────────────────────────────────────────────────

const usd = (n) => `US$ ${n.toFixed(n < 0.01 ? 4 : 2)}`;
const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / DAY))}d ago` : 'never');

function formatAudit(a) {
  const L = [];
  const t = a.totals;
  L.push(`Fixed cost per message — measured over ${a.days} days: ${a.sessions} sessions, ~${a.msgsPerSession} requests per session (tokens are estimates, 4 chars/token).`);
  L.push('');
  L.push(`MCP servers: ${t.mcpServers} configured, ${t.mcpUsed} called in ${a.days}d — ${t.mcpTokens} tokens per message (${a.toolSearch ? 'Tool Search on: tool names only' : 'Tool Search OFF: full definitions'}).`);
  for (const r of a.mcp) {
    const defs = r.defTokens != null ? `, full definitions ${r.defTokens} tok` : (r.probeError ? `, definitions not measured (${r.probeError})` : ', definitions not measured (stdio server not started)');
    L.push(`  ${['keep', 'not-loaded', 'disabled'].includes(r.verdict) ? ' ' : '!'} ${r.name} [${r.scope}/${r.type}] ${r.calls} calls, last ${ago(r.lastAt)}, ${r.toolCount == null ? '? tools' : `${r.toolCount} tools`}, names ${r.injectedTokens} tok${defs} → ${r.verdict}: ${r.reason}`);
    for (const b of r.backends) L.push(`      ${b.unused ? '!' : ' '} backend ${b.name}: ${b.tools} tools, ${b.tokens} tok, ${b.calls} calls, last ${ago(b.lastAt)}${b.unused ? ` → unused in ${a.days}d: remove it from the gateway's own config (not done here)` : ''}`);
  }
  L.push('');
  L.push(`Skills: ${t.skillsTotal} listed (${t.skillsHidden} already hidden/name-only), ${t.skillsUsed} used in ${a.days}d — ${t.skillTokens} tokens per message.`);
  const bySource = {};
  for (const s of a.skills) { const e = bySource[s.source] || (bySource[s.source] = { n: 0, used: 0, tokens: 0 }); e.n++; e.used += s.used ? 1 : 0; e.tokens += s.listedNow; }
  for (const [src, e] of Object.entries(bySource)) L.push(`    ${src}: ${e.n} skills, ${e.used} used, ${e.tokens} tok`);
  L.push('');
  L.push(`Instruction files (yours, never edited): ${a.instructions.map((i) => `${path.basename(i.path)} ${i.tokens} tok`).join(', ') || 'none'} — ${t.instructionTokens} tokens per message.`);
  L.push('');
  L.push(`Plugins: ${t.pluginsTotal} installed, ${t.pluginsUsed} used in ${a.days}d.`);
  for (const p of a.plugins) L.push(`    ${p.id} ${p.enabled ? 'enabled' : 'disabled'} ${p.used ? 'used' : 'NOT used'}`);
  L.push('');
  if (a.actions.length) {
    L.push(`Reversible fixes available (${a.actions.length}): saves ~${a.savings.tokens} tokens per message = ${usd(a.savings.perMessageUsd)} per message, ${usd(a.savings.perSessionUsd)} per session (${a.msgsPerSession} requests; cache read ${usd(a.price.read)}/MTok, write ${usd(a.price.write)}/MTok).`);
    for (const x of a.actions) L.push(`    - ${x.kind} ${x.target}: ${x.why} (~${x.tokens} tok)`);
    L.push('  Apply: node scripts/doctor.js --fix    Undo: node scripts/doctor.js --undo');
  } else L.push('No fixed-cost fix to apply.');
  if (a.errors && a.errors.length) { L.push(''); L.push(`Could not read (${a.errors.length}): ${a.errors.slice(0, 5).join(' | ')}`); }
  return L.join('\n');
}

module.exports = {
  estTokens, PRICING, SKILL_LISTING_CHARS, sanitize, DAY,
  installedPluginRoots, listMcpServers, oauthNames, scanUsage, backendKey, toolNamesByServer, probeHttpTools, expandEnv,
  auditBossConfig, parseFrontmatter, listSkills, listInstructionFiles, readUsageCounters, listPlugins, buildAudit, runAudit,
  undoPath, resolveClaudeBin, applyActions, undoActions, formatAudit,
};
