'use strict';
/**
 * graph-guard-core.js — pure helpers + decision ladder for the graph-guard.
 *
 * Intent (owner's model, validated live): the Session Graph is a SCOPING ORACLE.
 * A query on a READY graph is structural, embedding-free and cheap (~300ms
 * measured on a 135k-node graph), and returns the NARROW paths where a symbol
 * lives — so a broad recursive text search (native Grep/Glob, or bash
 * grep -r/rg/find at the repo root) should first ask the graph WHERE to look,
 * then re-run the text search SCOPED to that subtree. The guard enforces that
 * ordering with a DENY-ONCE: the first broad search is denied with the exact
 * two-step instruction; retrying the identical call passes (per-session sig
 * stamp), so there is never a deadlock and free-text searches lose at most one
 * round-trip.
 *
 * What the guard must NEVER do (measured constraint): wait for indexing. A
 * 20k-file repo took ~4.6min to index (one-time, async 202) — so `not_indexed`
 * NEVER blocks; it only surfaces a one-shot advisory suggesting graph_analyze.
 *
 * Everything here is DI-friendly (probe/now/fs injected) → hermetic tests.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic-write.js');

// ── Broadness heuristics (pure) ──────────────────────────────────────────────

/**
 * Native Grep/Glob: any explicit scoping field means the agent already
 * narrowed the search — only the "whole tree, no filter" shape is broad.
 *   Grep  broad ⇔ no `path` AND no `glob` AND no `type`
 *   Glob  broad ⇔ no `path` AND pattern starts with `**` (recursive from root)
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {boolean}
 */
function isBroadNativeSearch(toolName, toolInput) {
  const ti = toolInput || {};
  if (toolName === 'Grep') {
    return !ti.path && !ti.glob && !ti.type && !!ti.pattern;
  }
  if (toolName === 'Glob') {
    return !ti.path && /^\*\*[\\/]/.test(String(ti.pattern || ''));
  }
  return false;
}

// A path-ish token that narrows a bash search below the repo root.
function isNarrowTarget(tok) {
  if (!tok) return false;
  const t = tok.replace(/^["']|["']$/g, '');
  if (t === '.' || t === './' || t === '/' || /^[a-zA-Z]:[\\/]?$/.test(t)) return false;
  // a subdir/file (contains a path separator or a dot-extension) = narrowed
  return /[\\/]/.test(t) || /\.[a-zA-Z0-9]+$/.test(t);
}

/**
 * Bash: conservative detection of the machine-hurting shapes ONLY.
 *   - `grep` with a recursive flag (-r/-R, possibly combined: -rn) whose target
 *     is `.`/absent/a root — a scoped `grep -r src/lib` is NOT flagged;
 *   - `rg` (recursive by default) with no narrowing path argument;
 *   - `find` starting at `.`/a root (find in a subdir is NOT flagged).
 * Anything piped FROM a curated flow or non-search commands never match.
 * @param {string} command
 * @returns {null | {tool: 'grep'|'rg'|'find', pattern: string}}
 */
function matchBroadBashSearch(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  // Only inspect the FIRST pipeline segment — `foo | grep x` filters foo's
  // output in-memory; it never walks the filesystem.
  const first = cmd.split(/(?<!\|)\|(?!\|)/)[0].trim();
  const toks = first.split(/\s+/);
  const bin = (toks[0] || '').replace(/^.*[\\/]/, '');

  if (bin === 'grep') {
    const hasRecursive = toks.some(t => /^-[a-zA-Z]*[rR]/.test(t) && t.startsWith('-') && !t.startsWith('--')) ||
      toks.includes('--recursive');
    if (!hasRecursive) return null;
    const positional = toks.slice(1).filter(t => !t.startsWith('-'));
    // positional = [pattern, target?...]; broad when no narrowing target given
    const targets = positional.slice(1);
    if (targets.length === 0 || targets.every(t => !isNarrowTarget(t))) {
      return { tool: 'grep', pattern: (positional[0] || '').replace(/^["']|["']$/g, '') };
    }
    return null;
  }

  if (bin === 'rg') {
    const positional = toks.slice(1).filter(t => !t.startsWith('-'));
    const targets = positional.slice(1);
    if (targets.length === 0 || targets.every(t => !isNarrowTarget(t))) {
      return { tool: 'rg', pattern: (positional[0] || '').replace(/^["']|["']$/g, '') };
    }
    return null;
  }

  if (bin === 'find') {
    const start = (toks[1] || '').replace(/^["']|["']$/g, '');
    if (start === '.' || start === '/' || /^[a-zA-Z]:[\\/]?$/.test(start)) {
      const nameIdx = toks.findIndex(t => t === '-name' || t === '-iname');
      return { tool: 'find', pattern: nameIdx >= 0 ? (toks[nameIdx + 1] || '').replace(/^["']|["']$/g, '') : '' };
    }
    return null;
  }

  return null;
}

// ── Reason text (pure) ───────────────────────────────────────────────────────

/** Identifier-ish tokens from a pattern, for the graph_search suggestion. */
function extractQueryTokens(pattern) {
  return String(pattern || '')
    .split(/[^a-zA-Z0-9_]+/)
    .filter(t => t.length >= 3)
    .slice(0, 3);
}

/**
 * The deny reason IS the product: it must teach the exact two-step and make the
 * escape hatch explicit (retry passes / scope the search).
 */
function buildRedirectReason({ kind, pattern, tokens }) {
  const t = tokens && tokens.length ? tokens.join(' ') : (pattern || '<term>');
  return [
    `[graph-guard] Broad recursive search intercepted (${kind}). The Session Graph is READY for this repo — it answers structural queries in ~300ms with no filesystem walk.`,
    `1. Call \`graph_search({ query: "${t}" })\` (or \`graph_symbols\`) to get the NARROW file paths where this lives.`,
    `2. Re-run the text search SCOPED to those paths (Grep \`path:\`/\`glob:\`, or \`grep -r <dir>\`), only if you still need raw text matches.`,
    'Retrying this exact same call passes through (deny-once).',
  ].join('\n');
}

/**
 * not_indexed deny-once reason. The economics (owner's call): indexing is a
 * ONE-TIME cost, a broad grep is a PER-QUERY cost (re-walks the fs every time),
 * so the first broad search is denied to push the agent to index NOW — but
 * deny-once means the retry passes, so nothing is ever blocked waiting for the
 * (async) index to finish.
 */
function buildNotIndexedReason({ pattern, tokens }) {
  const t = tokens && tokens.length ? tokens.join(' ') : (pattern || '<term>');
  return [
    '[graph-guard] Broad recursive search intercepted, and this repo\'s Session Graph is NOT indexed yet. Indexing is a ONE-TIME cost; a broad grep re-walks the whole tree on EVERY call — so index once, then every later symbol search is the cheap structural path.',
    '1. Call `graph_analyze` to build the graph (async — seconds on small repos, minutes on large ones; it returns immediately).',
    `2. Once ready, \`graph_search({ query: "${t}" })\` gives the NARROW paths — then re-run the text search SCOPED to them.`,
    'Retrying this exact same call passes through NOW (deny-once) if you need the raw text search before the index is ready.',
  ].join('\n');
}

// ── Readiness cache + deny-once stamps (DATA_DIR/.runtime) ───────────────────

function rootKey(projectRoot) {
  return crypto.createHash('sha1').update(String(projectRoot || '').toLowerCase()).digest('hex').slice(0, 12);
}

function cachePath(dataDir, projectRoot) {
  return path.join(dataDir, '.runtime', `graph-ready-${rootKey(projectRoot)}.json`);
}

/** {state, nodes, ts} when fresh, else null. Never throws. */
function readReadyCache(file, ttlMs, nowMs = Date.now()) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c.state === 'string' && Number.isFinite(c.ts) && nowMs - c.ts < ttlMs) {
      return { state: c.state, nodes: Number.isFinite(c.nodes) ? c.nodes : 0 };
    }
    return null;
  } catch (e) { void e; /* absent/corrupt → treat as stale */ return null; }
}

/** state: string; nodes: number (needed to tell a USEFUL ready graph from a 0-node one). */
function writeReadyCache(file, state, nodes = 0, nowMs = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { state, nodes: Number.isFinite(nodes) ? nodes : 0, ts: nowMs });
  } catch (e) { void e; /* best effort — worst case we probe again */ }
}

function stampPath(dataDir, sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(dataDir, '.runtime', `graph-guard-${safe}.json`);
}

function readStamp(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { sigs: Array.isArray(s.sigs) ? s.sigs : [] };
  } catch (e) { void e; return { sigs: [] }; }
}

function writeStamp(file, stamp) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { sigs: (stamp.sigs || []).slice(-100) });
  } catch (e) { void e; /* best effort */ }
}

function searchSig(kind, raw) {
  return crypto.createHash('sha1').update(`${kind} ${String(raw || '').trim()}`).digest('hex').slice(0, 16);
}

// ── Decision ladder (DI: probe injected) ─────────────────────────────────────

/**
 * Decide what to do with an already-classified BROAD search.
 * Never throws; any internal failure resolves to {action:'allow'}.
 *
 * @param {object} a
 * @param {'native-grep'|'native-glob'|'bash'} a.kind
 * @param {string} a.raw       raw command / pattern (sig source)
 * @param {string} a.pattern   the search pattern for the reason text
 * @param {string} a.projectRoot
 * @param {string} a.sid
 * @param {string} a.dataDir
 * @param {{cacheTtlMs:number}} a.cfg
 * @param {() => Promise<{state:'ready'|'not_indexed'|'indexing'|'offline', nodes:number}>} a.probe
 *        resolves graph state + node count (short timeout, caller-provided);
 *        ONLY called on a stale cache.
 * @returns {Promise<{action:'allow'|'deny', reason?:string}>}
 */
async function decideBroadSearch({ kind, raw, pattern, projectRoot, sid, dataDir, cfg, probe }) {
  try {
    const cFile = cachePath(dataDir, projectRoot);
    let cached = readReadyCache(cFile, cfg.cacheTtlMs);
    if (!cached) {
      let res = { state: 'offline', nodes: 0 };
      try {
        const r = await probe();
        // Back-compat: a probe may still resolve a bare state string.
        res = typeof r === 'string' ? { state: r, nodes: 0 } : { state: (r && r.state) || 'offline', nodes: (r && r.nodes) || 0 };
      } catch (e) { void e; /* unreachable → offline */ }
      writeReadyCache(cFile, res.state, res.nodes);
      cached = res;
    }

    // READY but EMPTY (0 nodes): a repo with no graph-supported code. Redirecting
    // to graph_search would return nothing — so get out of the way (allow).
    if (cached.state === 'ready' && (cached.nodes || 0) === 0) {
      return { action: 'allow' };
    }

    // not_indexed → DENY-ONCE with the "index now" redirect (owner's economics:
    // one-time index vs per-query fs walk). deny-once → the retry passes, so the
    // agent is NEVER blocked waiting for the async index to finish. indexing /
    // offline → silent pass (don't punish an already-triggered index / fail-open).
    if (cached.state === 'not_indexed') {
      const sFile = stampPath(dataDir, sid);
      const stamp = readStamp(sFile);
      const sig = searchSig(kind, raw);
      if (stamp.sigs.includes(sig)) return { action: 'allow' };
      writeStamp(sFile, { ...stamp, sigs: [...stamp.sigs, sig] });
      return {
        action: 'deny',
        reason: buildNotIndexedReason({ pattern, tokens: extractQueryTokens(pattern) }),
      };
    }

    if (cached.state !== 'ready') {
      return { action: 'allow' }; // indexing / offline → pass
    }

    // Graph READY (with nodes) → deny-once per unique search per session.
    const sFile = stampPath(dataDir, sid);
    const stamp = readStamp(sFile);
    const sig = searchSig(kind, raw);
    if (stamp.sigs.includes(sig)) return { action: 'allow' };
    writeStamp(sFile, { ...stamp, sigs: [...stamp.sigs, sig] });
    return {
      action: 'deny',
      reason: buildRedirectReason({ kind, pattern, tokens: extractQueryTokens(pattern) }),
    };
  } catch (e) {
    void e; // any ladder failure → fail-open
    return { action: 'allow' };
  }
}

// ── Live state probe (same-server resolution, mirrors the graph_* tools) ─────

/**
 * Factory for the readiness probe the ladder calls on a stale cache. Resolves
 * the SAME daemon the mcp-memory backend targets (explicit serverUrl wins, else
 * the registry) — never an independently-discovered one — then reads
 * /api/v1/graph/status for the project root. Lazy requires keep hook cold-start
 * cheap on the fast path (fresh cache → this is never constructed/called).
 * Returns {state, nodes} — the node count lets the ladder tell a USEFUL ready
 * graph from a 0-node one (repo with no graph-supported code → don't redirect).
 * @param {{cwd:string, timeoutMs:number}} opts
 * @returns {() => Promise<{state:'ready'|'not_indexed'|'indexing'|'offline', nodes:number}>}
 */
function makeGraphStateProbe({ cwd, timeoutMs }) {
  return async () => {
    const brainCfg = require('./brain-config.js').load();
    const mcp = (brainCfg.backend && brainCfg.backend.mcpMemory) || {};
    const daemon = require('./graph/daemon.js');
    const client = require('./graph/client.js');
    const resolver = daemon.makeResolver({ serverUrl: mcp.serverUrl || '', runDir: mcp.runDir || '' });
    const base = await client.graphBase({ discover: resolver });
    if (!base) return { state: 'offline', nodes: 0 };
    const ctx = client.graphContextFor('', cwd);
    const { json } = await client.post(base, 'status', ctx, {}, { timeoutMs });
    const state = json && json.state;
    const nodes = json && Number.isFinite(json.nodes) ? json.nodes : 0;
    if (state === 'ready' || state === 'not_indexed' || state === 'indexing') return { state, nodes };
    return { state: 'offline', nodes: 0 };
  };
}

module.exports = {
  isBroadNativeSearch,
  matchBroadBashSearch,
  makeGraphStateProbe,
  extractQueryTokens,
  buildRedirectReason,
  buildNotIndexedReason,
  cachePath,
  readReadyCache,
  writeReadyCache,
  stampPath,
  readStamp,
  writeStamp,
  searchSig,
  decideBroadSearch,
};
