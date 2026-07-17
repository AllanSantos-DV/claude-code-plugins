'use strict';
/**
 * lib/graph/tools.js — the 7 graph_* tools (thin wrappers over lib/graph/client.js). Pure
 * consumer of the Session Graph Engine (native-java). Adapted from copilot-memory's
 * lib/graphTools.mjs to the boss MCP shape: each tool is { name, description, inputSchema } and
 * handle(name,args) returns { content:[{type:'text',text}] }. FAIL-OPEN: never throws to the host.
 *
 * Rules: status-first (reads never auto-ingest — they guide the user), typed-error handling
 * (ROOT_CONFLICT reports both roots, QUEUE_SATURATED, GRAPH_API_MISSING), honest
 * 0-nodes message, CALLS-by-language caveat, root guard before the daemon walks the filesystem.
 */
const G = require('./client.js');
const { discover: realDiscover } = require('./daemon.js');

function text(s) { return { content: [{ type: 'text', text: s }] }; }

function fmtNode(n) {
  if (!n) return '';
  const loc = n.file ? ` @ ${n.file}${n.startLine ? ':' + n.startLine : ''}` : '';
  const pr = typeof n.pagerank === 'number' ? ` (pr ${n.pagerank.toFixed(4)})` : '';
  return `- ${n.type || '?'} ${n.name || '(unnamed)'}${loc}${pr}  [id: ${n.id}]`;
}
function fmtList(nodes, cap = 15) {
  const arr = Array.isArray(nodes) ? nodes : [];
  const head = arr.slice(0, cap).map(fmtNode).join('\n');
  return arr.length > cap ? `${head}\n… (+${arr.length - cap})` : (head || '(empty)');
}

/** Translate a GraphError into actionable text (never throws). */
function explainError(e) {
  if (!(e instanceof G.GraphError)) return 'Graph error: ' + (e && e.message || e);
  switch (e.code) {
    case 'ROOT_CONFLICT':
      return [
        `🚧 Root conflict (ROOT_CONFLICT): this project_id's graph is already mapped to ANOTHER root.`,
        `  • already mapped at: ${e.mappedRoot || '(?)'}`,
        `  • you requested:     ${e.requestedRoot || '(?)'}`,
        `In Cut 1 the graph is single-snapshot per project (common with worktrees of the same repo). Options:`,
        `  1) query the existing snapshot by passing root: "${e.mappedRoot || '<mapped root>'}" (may be another branch/revision);`,
        `  2) work in the session that owns that root;`,
        `  3) coexisting both roots needs multi-snapshot (Cut 2, not available yet).`,
      ].join('\n');
    case 'QUEUE_SATURATED':
      return `Indexing queue full. Try again in ${e.retryAfter || 'a few'}s (graph_status/graph_analyze).`;
    case 'GRAPH_API_MISSING':
      return e.message;
    case 'GRAPH_DISABLED':
      return 'The graph is disabled on the memory server right now.';
    default:
      return `Graph error (${e.code || e.status}): ${e.message}`;
  }
}

function scopeLine(st) {
  return `📦 ${(st && st.project_id) || '(id unresolved)'} · ${st ? st.state : ''}${st && typeof st.nodes === 'number' ? ` · ${st.nodes} nodes/${st.edges} edges` : ''}`;
}

const DEFINITIONS = [
  {
    name: 'graph_analyze',
    description:
      'Analyze a project via the semantic code graph in one step: ensure the graph is ready (reuse if it exists; index if not) and return the HUBS (top PageRank) + (if you pass "query") a ContextBundle. The FAST way to understand a HUGE repo — the open one or an external one via "root" — without grepping file by file. Backed by the native-java memory daemon; fails open if it is offline.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'External repo path (optional; default = current project / CWD).' },
        query: { type: 'string', description: 'If present, also returns the ContextBundle (semantic search) for this term.' },
        refresh: { type: 'boolean', description: 'Re-index even if already ready (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'graph_search',
    description:
      'Semantic search over the code graph: given a term, returns the seeds + their neighborhood (N-hops over CALLS/CONTAINS/IMPORTS) — the "ContextBundle" to jump straight to the point without grepping. Read-only (requires the graph to be ready — else run graph_analyze).',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'External repo path (optional; default = current project / CWD).' },
        query: { type: 'string', description: 'Search term (REQUIRED).' },
        topK: { type: 'integer', description: 'Seeds (1–25, default 8).' },
        hops: { type: 'integer', description: 'Expansion hops (1–2, default 1).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_symbols',
    description:
      'List graph symbols: no "query" = the HUBS (top PageRank, what matters most in the code); with "query" = symbol by exact name. Read-only (requires the graph ready — else run graph_analyze).',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'External repo path (optional; default = current project / CWD).' },
        query: { type: 'string', description: 'Exact name (case-insensitive); empty = top by PageRank.' },
        limit: { type: 'integer', description: 'Max symbols (1–100, default 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'graph_status',
    description:
      'State of the project\'s semantic graph (or an external repo via "root"): indexed? how many nodes/edges? Cheap and read-only — does NOT index. Use before querying; if not "ready", run graph_analyze/graph_ingest.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string', description: 'External repo path (optional; default = current project / CWD).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'graph_ingest',
    description:
      'Index (or re-index with refresh) the project/repo graph and wait until ready (with a deadline). Rule: only indexes if not already ready — if already "ready", it reuses (unless refresh=true). Async on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'External repo path (optional; default = current project / CWD).' },
        refresh: { type: 'boolean', description: 'Force re-index even if already "ready" (pays a re-walk). Default false.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'graph_callers',
    description: 'Who CALLS a node (inbound CALLS edges). Pass a symbol "id" (from graph_symbols/graph_search). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, id: { type: 'string', description: 'Node id (REQUIRED).' }, limit: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_references',
    description: 'Everything that points at a node (CALLS + CONTAINS + IMPORTS). Pass a symbol "id". Read-only.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, id: { type: 'string', description: 'Node id (REQUIRED).' }, limit: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const GRAPH_TOOL_NAMES = new Set(DEFINITIONS.map((d) => d.name));

/**
 * Build the graph tool surface. Dependency-injected (cwd/fetchImpl/discover/resolveDaemon) so tests
 * can drive the full handlers against a mock daemon without any live process.
 *
 * `resolveDaemon` is the SAME-SERVER seam (ADR-020): a discover()-shaped async fn — typically built
 * from the mcp-memory backend config (daemon.makeResolver) — so the graph rides the SAME daemon the
 * KB backend targets instead of independently discovering its own. When provided it takes precedence
 * over `discover`; otherwise `discover` (default: the plain registry discovery) is used, preserving
 * the existing behavior for any caller/test that injects only `discover`.
 * @returns {{ definitions: object[], names: Set<string>, handle(name:string, args:object): Promise<object> }}
 */
function createGraphTools({ cwd = () => process.cwd(), fetchImpl = globalThis.fetch, discover = realDiscover, resolveDaemon } = {}) {
  // Same-server resolver wins; else the injected/real discover (own-daemon registry discovery).
  const resolve = typeof resolveDaemon === 'function' ? resolveDaemon : discover;
  // prep: resolve base + capability + context, or { error } (fail-open).
  async function prep(rootArg) {
    let base;
    try { base = await G.graphBase({ discover: resolve, fetchImpl }); }
    catch (e) { return { error: explainError(e) }; }
    if (!base) return { error: '🕸️ Graph unavailable: the memory daemon is offline. (Run memory_setup / memory_status to bring it up.)' };
    const ctx = G.graphContextFor(rootArg, cwd());
    // §6.1: refuse broad/missing roots BEFORE the daemon walks the filesystem.
    const unsafe = G.assertSafeRoot(ctx.root);
    if (unsafe) return { error: '🚫 ' + unsafe };
    try { await G.ensureCapable(base, ctx, { fetchImpl }); } catch (e) { return { error: explainError(e) }; }
    return { base, ctx };
  }

  // Common read guard: prep + require the graph "ready" (does not auto-ingest; guides to graph_analyze).
  async function readGuard(args, fn) {
    const p = await prep(args.root);
    if (p.error) return text(p.error);
    try {
      const st = await G.status(p.base, p.ctx, { fetchImpl });
      if (st.state !== 'ready') {
        return text(`🕸️ The graph is not ready yet (${st.state}). Run graph_analyze${args.root ? ` root:"${args.root}"` : ''} (or graph_ingest) first.` + (st.hint ? `\nhint: ${st.hint}` : ''));
      }
      if (st.nodes === 0) return text(`${scopeLine(st)}\n⚠️ ${G.zeroNodesMessage(st)}`);
      return text(await fn(p.base, p.ctx));
    } catch (e) { return text(explainError(e)); }
  }

  async function handle(name, args) {
    const a = args || {};
    try {
      switch (name) {
        case 'graph_status': {
          const p = await prep(a.root);
          if (p.error) return text(p.error);
          const st = await G.status(p.base, p.ctx, { fetchImpl });
          const lines = [scopeLine(st), `root: ${p.ctx.root}`];
          if (st.state === 'ready' && st.nodes === 0) lines.push('⚠️ ' + G.zeroNodesMessage(st));
          if (st.state !== 'ready' && st.hint) lines.push('hint: ' + st.hint);
          if (Array.isArray(st.topHubs) && st.topHubs.length) lines.push('hubs:\n' + fmtList(st.topHubs, 8));
          return text(lines.join('\n'));
        }
        case 'graph_ingest': {
          const p = await prep(a.root);
          if (p.error) return text(p.error);
          const st = await G.ensureReady(p.base, p.ctx, { refresh: !!a.refresh, fetchImpl });
          if (st.queued) return text(`⏳ Indexing queue full. Try again in ${st.retryAfter || 'a few'}s.`);
          if (st.timedOut) return text(`⏳ Still indexing (${st.nodes || 0} nodes so far). Call graph_status shortly.`);
          if (st.state === 'failed') return text(`❌ Indexing failed: ${st.error || '(no detail)'}`);
          const extra = st.state === 'ready' && st.nodes === 0 ? '\n⚠️ ' + G.zeroNodesMessage(st) : '';
          return text(`✅ Graph ready — ${scopeLine(st)}${extra}`);
        }
        case 'graph_symbols':
          return readGuard(a, async (base, ctx) => {
            const r = await G.symbols(base, ctx, { query: a.query || '', limit: a.limit, fetchImpl });
            return `Symbols (${(r.symbols && r.symbols.length) || 0}${r.truncated ? ', truncated' : ''}):\n` + fmtList(r.symbols, 20);
          });
        case 'graph_search':
          return readGuard(a, async (base, ctx) => {
            const r = await G.search(base, ctx, { query: a.query, topK: a.topK, hops: a.hops, fetchImpl });
            return [
              `Seeds (${(r.seed && r.seed.length) || 0}):`, fmtList(r.seed, 10),
              `Neighborhood (${(r.expanded && r.expanded.length) || 0}${r.truncated ? ', truncated' : ''}):`, fmtList(r.expanded, 15),
            ].join('\n');
          });
        case 'graph_callers':
          return readGuard(a, async (base, ctx) => {
            const r = await G.callers(base, ctx, { id: a.id, limit: a.limit, fetchImpl });
            const caveat = G.callsCaveatFor(a.id); // caveat by the QUERIED node's language
            return `Callers (${(r.callers && r.callers.length) || 0}${r.truncated ? ` of ${r.totalCount}` : ''}):\n` + fmtList(r.callers, 15) + (caveat ? '\n' + caveat : '');
          });
        case 'graph_references':
          return readGuard(a, async (base, ctx) => {
            const r = await G.references(base, ctx, { id: a.id, limit: a.limit, fetchImpl });
            const caveat = G.callsCaveatFor(a.id);
            return `References (${(r.references && r.references.length) || 0}${r.truncated ? ` of ${r.totalCount}` : ''}):\n` + fmtList(r.references, 15) + (caveat ? '\n' + caveat : '');
          });
        case 'graph_analyze': {
          const p = await prep(a.root);
          if (p.error) return text(p.error);
          const st = await G.ensureReady(p.base, p.ctx, { refresh: !!a.refresh, fetchImpl });
          if (st.queued) return text(`⏳ Queue full. Try again in ${st.retryAfter || 'a few'}s.`);
          if (st.timedOut) return text(`⏳ Still indexing (${st.nodes || 0} nodes). Call graph_status/graph_analyze later.`);
          if (st.state === 'failed') return text(`❌ Indexing failed: ${st.error || '(no detail)'}`);
          if (st.state === 'ready' && st.nodes === 0) return text(`${scopeLine(st)}\n⚠️ ${G.zeroNodesMessage(st)}`);
          const out = [scopeLine(st), `root: ${p.ctx.root}`];
          const hubs = await G.symbols(p.base, p.ctx, { query: '', limit: 12, fetchImpl });
          out.push(`\n🏛️ Hubs (top PageRank):\n` + fmtList(hubs.symbols, 12));
          if (a.query && String(a.query).trim()) {
            const sr = await G.search(p.base, p.ctx, { query: a.query, fetchImpl });
            out.push(`\n🔎 ContextBundle "${a.query}": seeds ${(sr.seed && sr.seed.length) || 0} + neighborhood ${(sr.expanded && sr.expanded.length) || 0}`);
            out.push(fmtList(sr.seed, 6));
          }
          return text(out.join('\n'));
        }
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown graph tool: ${name}` }] };
      }
    } catch (e) {
      // Last-resort fail-open: never throw to the host.
      return text(explainError(e));
    }
  }

  return { definitions: DEFINITIONS, names: GRAPH_TOOL_NAMES, handle };
}

module.exports = { createGraphTools, DEFINITIONS, GRAPH_TOOL_NAMES };
