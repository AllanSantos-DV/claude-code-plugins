'use strict';
/**
 * lib/mcp-server.js — transport-agnostic assembly of the Brain MCP Server.
 *
 * `createBrainServer({ pluginRoot, mode })` returns a configured @modelcontextprotocol
 * `Server` (tools + handlers) with NO transport attached, so the same assembly is
 * reused by both transports (index.js):
 *   - stdio  (default, unchanged): one server per host connection.
 *   - http   (--http daemon): one long-lived server per HTTP session.
 *
 * Two cross-cutting concerns live here so both transports inherit them:
 *   1. resolveProject(args): stdio infers project from CWD (as before); HTTP has
 *      no per-client CWD, so it REQUIRES an explicit project/cwd and rejects
 *      otherwise (never dumps into 'default').
 *   2. withLock(): an async mutex serializing the KB tools. The KB modules are
 *      process-singletons (_db/_project swapped on init); serializing keeps each
 *      getKB(project)→ops atomic across concurrent HTTP sessions. Transparent
 *      under stdio (already sequential).
 *
 * The tool LOGIC below is a faithful move of the previous index.js handlers — no
 * behavioral change for stdio.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

/** Tools that touch the shared KB singleton — serialized by the per-server mutex. */
const KB_TOOLS = new Set([
  'brain_search', 'brain_store', 'capture_lesson', 'brain_related', 'brain_count', 'brain_retrieve_context',
]);

/**
 * KB tools routed to the external daemon when backend.type === 'mcp-memory'.
 * brain_retrieve_context is excluded on purpose: its handler calls retrieve-core,
 * which is itself remote-aware, so routing it twice would be redundant.
 */
const REMOTE_KB_TOOLS = new Set([
  'brain_search', 'brain_store', 'capture_lesson', 'brain_related', 'brain_count',
]);

export function createBrainServer({ pluginRoot, mode = 'stdio' } = {}) {
  const PLUGIN_ROOT = pluginRoot;

  // ─── KB modules (lazy-loaded) ──────────────────────────────────────────────
  async function getKB(project) {
    const store = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-store.js'));
    const index = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-index.js'));
    const graph = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-graph.js'));
    await store.init({ project });
    await index.init({ project });
    await graph.init({ project });
    return { store, index, graph };
  }

  // Metrics are a per-machine concern, independent of backend.type (local vs
  // mcp-memory) — lib/metrics-store.js owns its own SQLite file and is never
  // routed through the KB backend switch. Used by BOTH the local and remote
  // capture_lesson paths below, so telemetry doesn't silently disappear for
  // mcp-memory users (it previously did: the remote path never recorded
  // lesson.captured at all).
  function recordLessonMetric(project, payload) {
    try {
      const metricsStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'metrics-store.js'));
      if (metricsStore.init({ project })) metricsStore.recordMetric('lesson.captured', payload, null);
    } catch (err) {
      console.error(`[BRAIN-SERVER] recordLessonMetric failed: ${err.message}`);
    }
  }

  // Phase 1.5 capture ACK: when the offered block carried a windowId, the agent's
  // capture_lesson(windowId) / capture_ack(windowId) tool call writes the explicit
  // ack marker the Stop-hook reconcile reads — so the deterministic side never has
  // to guess from the transcript. Keyed by windowId (filesystem-shared across the
  // brain-server and Stop-hook processes).
  function recordCaptureAck(windowId, outcome) {
    if (!windowId) return;
    try {
      const cq = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'capture-queue.js'));
      cq.recordAck(windowId, outcome);
    } catch (err) {
      console.error(`[BRAIN-SERVER] recordCaptureAck failed: ${err.message}`);
    }
  }

  /**
   * Remote-backend KB handler: when backend.type === 'mcp-memory', write/search/
   * related/count tools delegate to the dispatcher (which talks to the external
   * Native Java daemon) instead of the local SQLite store. The local-only scope
   * sentinel + graph dedup are NOT modeled remotely — the daemon scopes by the
   * projectId stamped at the MCP handshake.
   */
  async function handleRemoteKbTool(backend, name, args) {
    const a = args || {};
    const asText = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
    let project;
    try { project = resolveProject(a); }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `${name} failed: ${err.message}` }] }; }
    try {
      await backend.init({ project, skipEmbedder: true });
      switch (name) {
        case 'brain_search': {
          const hits = await backend.search(a.query, { topK: a.topK || 5, minScore: typeof a.minScore === 'number' ? a.minScore : 0 });
          return asText({ query: a.query, project, scope: a.scope || 'both', count: hits.length, results: hits, backend: 'mcp-memory' });
        }
        case 'brain_store': {
          const id = await backend.save({ title: a.title, summary: a.summary, content: { detail: a.detail || a.summary }, type: a.type || 'note', tags: Array.isArray(a.tags) ? a.tags : [], confidence: typeof a.confidence === 'number' ? a.confidence : 0.8, scope: a.scope || 'auto', source: a.sourceUrl ? { url: a.sourceUrl } : {} });
          return asText({ id, project, scope: a.scope || 'auto', status: 'saved', title: a.title, type: a.type || 'note', backend: 'mcp-memory' });
        }
        case 'capture_lesson': {
          const id = await backend.save({ title: a.title, summary: a.summary, content: { detail: a.detail || a.summary }, type: a.type || 'lesson', tags: Array.isArray(a.tags) ? a.tags : [], confidence: typeof a.confidence === 'number' ? a.confidence : 0.85, scope: a.scope || 'auto' });
          // No dedup/merge tool on the mcp-memory daemon's contract (unlike the
          // local path below) — every capture here is an 'admit'. Recorded
          // locally regardless: metrics are per-machine, not part of the KB.
          recordLessonMetric(project, { type: a.type || 'lesson', decision: 'admit', scope: a.scope || 'auto' });
          recordCaptureAck(a.windowId, 'captured');
          return asText({ decision: 'admit', id, type: a.type || 'lesson', project, scope: a.scope || 'auto', backend: 'mcp-memory' });
        }
        case 'brain_related': {
          const related = await backend.getRelated(a.id);
          return asText({ id: a.id, project, count: related.length, related, backend: 'mcp-memory' });
        }
        case 'brain_count': {
          const count = await backend.count();
          return asText({ project, count, backend: 'mcp-memory' });
        }
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown remote KB tool: ${name}` }] };
      }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `${name} failed (remote): ${err.message}` }] };
    }
  }

  const scopeSanitizer = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'scope-sanitizer.js'));
  const scopeSearch = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'scope-search.js'));
  const { USER_SENTINEL, inferDefaultScope, prepareForUserScope } = scopeSanitizer;
  const { searchTwoPass } = scopeSearch;

  // ─── Simple file-based cache (research) ────────────────────────────────────
  const cache = new Map();
  function getCached(query) {
    const entry = cache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.ts > 300_000) { cache.delete(query); return null; }
    return entry.result;
  }
  function setCached(query, result) { cache.set(query, { result, ts: Date.now() }); }

  // ─── Source definitions ────────────────────────────────────────────────────
  const SOURCES = {
    web: {
      authority: 65,
      async search(query) {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'ClaudeCodeBrain/0.1' } });
        const html = await resp.text();
        const results = [];
        const snippetRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex2 = /class="result__snippet">([\s\S]*?)<\/(?:a|span|div)/g;
        let match;
        const snippets = [];
        while ((match = snippetRegex2.exec(html)) !== null) {
          snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
        }
        let idx = 0;
        while ((match = snippetRegex.exec(html)) !== null && results.length < 5) {
          const href = match[1].replace(/^\/\/redirect\.php.*?uddg=/, '');
          const title = match[2].replace(/<[^>]*>/g, '').trim();
          const decodedUrl = decodeURIComponent(href).split('&')[0] || href;
          results.push({ title, url: decodedUrl, snippet: snippets[idx] || '' });
          idx++;
        }
        return results;
      },
    },
  };

  const _textUtils = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'text-utils.js'));
  function extractKeywords(text) {
    return _textUtils.extractKeywords(text, { minLen: 4, maxTokens: 1000, allowPath: true });
  }

  // ─── Project scoping (stdio = CWD; http = explicit-or-reject) ──────────────
  // Client-chosen identity: an explicit `project` arg wins, then the shared
  // resolver (env CCB_PROJECT_ID → .claude-boss-project marker → basename(cwd)),
  // so the id we stamp on the daemon is stable across machines/clones instead of
  // the raw folder name. Default (no override) stays basename(cwd) — unchanged.
  const projectId = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'project-id.js'));
  function resolveProject(args) {
    const a = args || {};
    if (a.project) {
      // Explicit caller id → sanitize to a single path segment (no `..`/separators
      // that could escape brainDir via path.join). Empty (pure traversal) falls
      // through to the safe resolution below rather than trusting the raw value.
      const safe = projectId.sanitizeProjectId(a.project);
      if (safe) return safe;
    }
    const forced = projectId.sanitize(process.env.CCB_PROJECT_ID);
    if (forced) return forced;
    if (a.cwd) return projectId.resolveProjectId({ cwd: a.cwd });
    if (mode === 'http') {
      throw Object.assign(
        new Error('project is required in HTTP mode (a long-lived service has no CWD to infer the workspace from)'),
        { code: 'PROJECT_REQUIRED' },
      );
    }
    return projectId.resolveProjectId({ cwd: process.cwd() });
  }

  // ─── Async mutex (serialize KB ops over the process-singleton DB) ──────────
  let _chain = Promise.resolve();
  function withLock(fn) {
    const result = _chain.then(fn, fn);
    _chain = result.then(() => undefined, () => undefined);
    return result;
  }

  // ─── Tool list ──────────────────────────────────────────────────────────────
  const TOOLS = [
    {
      name: 'research_query',
      description: 'Perform multi-source web research on a topic. Fan-out across web sources, aggregate results, and return structured findings with citations.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The research query or question' }, depth: { type: 'string', enum: ['quick', 'thorough'], description: 'Search depth — quick returns top 3-5 results, thorough fetches detailed content from each result' } }, required: ['query', 'depth'] },
    },
    {
      name: 'research_status',
      description: 'Check cache status for a query — returns cached result if available, or reports cache miss.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The query to check' } }, required: ['query'] },
    },
    {
      name: 'brain_search',
      description: 'Search the Brain Knowledge Base semantically (vector) with keyword fallback. Finds stored entries relevant to the query text.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The search query in natural language' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode)' }, topK: { type: 'number', description: 'Number of results (default: 5)' }, minScore: { type: 'number', description: 'Minimum relevance score (default: 0.2)' }, scope: { type: 'string', enum: ['both', 'project', 'user'], description: 'Which memory scope to search. "both" (default) = two-pass merge of current project + global __user__ entries. "project" = current project only. "user" = global __user__ only.' } }, required: ['query'] },
    },
    {
      name: 'brain_store',
      description: 'Manually save a structured entry to the Brain Knowledge Base. The entry is vectorized and added to the inverted index + citation graph.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Entry title (required)' }, summary: { type: 'string', description: 'One-line summary (required)' }, detail: { type: 'string', description: 'Full content / body text' }, type: { type: 'string', enum: ['note', 'pattern', 'lesson', 'research', 'code', 'reference', 'decision'], description: 'Entry type (default: note)' }, tags: { type: 'array', items: { type: 'string' }, description: 'Tags for search filtering' }, project: { type: 'string', description: 'Project name (default: auto-detect; REQUIRED in HTTP mode)' }, confidence: { type: 'number', description: 'Confidence score 0.0-1.0 (default: 0.8)' }, sourceUrl: { type: 'string', description: 'Source URL if applicable' }, scope: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Where to store. "auto" (default) infers from type+tags (reference/research/user-tag → user; decision/code → project). "user" routes to global __user__ DB and sanitizes user paths/emails/project name. Entries with detected secrets are rejected if scope=user.' } }, required: ['title', 'summary'] },
    },
    {
      name: 'brain_related',
      description: 'Get entries related to a given KB entry via the citation graph.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Entry ID from a previous brain_search result' }, project: { type: 'string', description: 'Project name (default: auto-detect; REQUIRED in HTTP mode)' } }, required: ['id'] },
    },
    {
      name: 'brain_count',
      description: 'Get the number of entries in the Knowledge Base for the current (or specified) project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name (default: auto-detect; REQUIRED in HTTP mode)' } } },
    },
    {
      name: 'capture_lesson',
      description: 'Capture a CURATED lesson in-loop (the agent post-mortem pattern). Call this when the user corrects you, or when a reusable pattern emerges — YOU write the clean summary + correction + generalized lesson (you have full context; do not make the KB re-read transcripts). WRITE IN ENGLISH — the KB is English-canonical so entries stay retrievable regardless of the user\'s prompt language. Runs admission control inline: a near-duplicate is MERGED (bumping recurrence, which drives skill promotion) instead of duplicated.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Short lesson title in English (max 80 chars)' }, summary: { type: 'string', description: 'One-line in English: what went wrong / the pattern, and what to do instead' }, detail: { type: 'string', description: 'Full lesson in English: what happened + the correction + the generalized rule. Keep the valuable specifics.' }, type: { type: 'string', enum: ['lesson', 'pattern', 'decision', 'research'], description: 'lesson (correction), pattern (reusable workflow), decision (architectural choice + rationale — plugin Stop hooks nudge this type), or research (external findings worth reusing — plugin Stop hooks nudge this type too). Default: lesson' }, tags: { type: 'array', items: { type: 'string' }, description: '3-8 CANONICAL English concept tags, lowercase, hyphenated (e.g. "error-handling", "token-efficiency", "cross-lingual"). These are the language-neutral retrieval anchor — choose the terms a future query (in any language) would map to.' }, confidence: { type: 'number', description: '0.0-1.0 (default 0.85)' }, windowId: { type: 'string', description: 'When the plugin offered a review block, pass its windowId to close (ack) that capture window as captured.' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode)' }, scope: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Where to store. "auto" (default) infers from type+tags (decision/code → project; reference/research/user-tag hints like workflow/preferences/agent-behavior → user). "user" routes to global __user__ DB and sanitizes user paths/emails/project name. Entries with detected secrets are rejected if scope=user.' } }, required: ['title', 'summary'] },
    },
    {
      name: 'capture_ack',
      description: 'Close a lesson-capture review window when there is NO lesson to capture. When the plugin offers a review block and nothing is worth capturing, call this with the block\'s windowId to release the Stop. (Capturing via capture_lesson with the same windowId already closes it — you do not need both.)',
      inputSchema: { type: 'object', properties: { windowId: { type: 'string', description: 'The windowId from the offered review block' }, outcome: { type: 'string', enum: ['none'], description: 'Always "none" (no lesson to capture).' } }, required: ['windowId'] },
    },
    {
      name: 'brain_retrieve_context',
      description: 'Internal — adaptive KB retrieval for the UserPromptSubmit hook (runs with the embedder warm in this server). Embeds the prompt, vector-searches the project KB behind a relevance gate, and returns a short formatted context block (or empty). Prefer brain_search for explicit lookups.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'The user prompt text' }, cwd: { type: 'string', description: 'Working directory (project = its basename)' }, session_id: { type: 'string', description: 'Session id (for the retrieval journal)' } }, required: ['prompt'] },
    },
    {
      name: 'curation_mark_oneoff',
      description: 'Mark a volume-heavy command the curation Stop hook flagged as ONE-HIT (single-use), so it stops asking to curate it. PREFERRED: pass `sigs` with each `sig` string from the Stop-hook reason VERBATIM (exact match, no guessing). Alternatively provide alias forms of the command via `aliases` (e.g. ["npm test","npm run test"]). Refused if the command already recurs past the configured ceiling — then create a curated script instead. Aliases/sigs must name the subcommand (e.g. "git log", not "git").',
      inputSchema: { type: 'object', properties: { sigs: { type: 'array', items: { type: 'string' }, description: 'Canonical signatures copied VERBATIM from the Stop-hook reason (the `sig \\`...\\`` field). Preferred over aliases — matches the store exactly.' }, aliases: { type: 'array', items: { type: 'string' }, description: 'Raw command forms identifying this one-hit command (>=2 significant tokens each, e.g. ["git log","git lg"])' }, cwd: { type: 'string', description: 'Working directory (for project scoping)' }, session_id: { type: 'string', description: 'Session id' } } },
    },
    {
      name: 'curation_register_shell',
      description: 'Create a curated shell script and register it in shells.json in one atomic operation — bypasses the need for direct Write/Edit on .vscode/scripts and shells.json (which the Auto Mode classifier gates as persistent config outside a task\'s stated scope). Use this instead of manually writing the script file when the curation Stop hook asks you to CREATE a curated script. The script content must follow the OK/FAIL output contract from the curation-script-pattern skill. Calling it twice with the same id updates the existing entry instead of duplicating it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique slug for the shells.json entry (e.g. "grep-file")' },
          scriptPath: { type: 'string', description: 'Relative path to the script file, e.g. ".vscode/scripts/grep-file.mjs" — must resolve inside the project\'s curated scripts dir' },
          content: { type: 'string', description: 'Full script source (must honor the OK/FAIL output contract from the curation-script-pattern skill)' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Raw command forms that should redirect to this script (>=2 significant tokens each, e.g. ["npm test","npm run test"])' },
          label: { type: 'string', description: 'Human-readable label for the shells.json entry (default: id)' },
          icon: { type: 'string', description: 'Optional icon hint (e.g. "search", "beaker")' },
          outputFilter: { type: 'string', enum: ['summary', 'errors-only'], description: 'Output filter hint (default: "summary")' },
          outputLines: { type: 'number', description: 'Enforced curated-success line budget — output beyond it is flagged noisy (default: 30)' },
          outputChars: { type: 'number', description: 'Optional curated-success char budget (default: outputLines * 100)' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default: 60000)' },
          cwd: { type: 'string', description: 'Working directory (for project root resolution)' },
        },
        required: ['id', 'scriptPath', 'content', 'aliases'],
      },
    },
  ];

  // ─── Tool handlers (faithful move from the previous index.js switch) ───────
  async function handleTool(name, args) {
    // Remote brain (Native Java daemon): route write/search/related/count KB tools
    // through the backend dispatcher. brain_retrieve_context is excluded — its case
    // calls retrieve-core, which is itself remote-aware.
    if (REMOTE_KB_TOOLS.has(name)) {
      const backend = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-backend.js'));
      if (backend.peekMode() === 'mcp-memory') {
        return handleRemoteKbTool(backend, name, args);
      }
    }
    switch (name) {
      case 'research_query': {
        const { query, depth } = args;
        const cached = getCached(query);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, cached: true }, null, 2) }] };
        try {
          const sourceResults = {};
          const errors = [];
          for (const [sourceId, source] of Object.entries(SOURCES)) {
            try {
              const results = await source.search(query);
              sourceResults[sourceId] = { results, authority: source.authority, count: results.length };
            } catch (err) {
              errors.push({ source: sourceId, error: err.message });
              sourceResults[sourceId] = { results: [], authority: source.authority, count: 0, error: err.message };
            }
          }
          const totalResults = Object.values(sourceResults).reduce((sum, s) => sum + s.count, 0);
          const qualityGate = { passed: totalResults >= 2, totalResults, sourcesConsulted: Object.keys(sourceResults).filter(s => sourceResults[s].count > 0).length };
          const output = { query, depth, sources: sourceResults, qualityGate, errors: errors.length > 0 ? errors : undefined, timestamp: new Date().toISOString() };
          setCached(query, output);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Research failed: ${err.message}` }] };
        }
      }

      case 'research_status': {
        const { query } = args;
        const cached = getCached(query);
        return { content: [{ type: 'text', text: JSON.stringify({ query, cached: !!cached, available: cached ? { depth: cached.depth, sources: Object.keys(cached.sources), timestamp: cached.timestamp } : null }, null, 2) }] };
      }

      case 'brain_search': {
        try {
          const { query, topK = 5, minScore = 0.05, scope = 'both' } = args;
          const currentProject = resolveProject(args);
          let vector = null;
          try {
            const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
            await embedder.init();
            if (embedder.getStatus().ready) vector = await embedder.embed(query);
          } catch { /* embedding optional */ }

          if (scope === 'user') {
            const { store: userStore } = await getKB(USER_SENTINEL);
            let results = [];
            try { if (vector) results = await userStore.search(vector, { topK, minScore }); }
            finally { await getKB(currentProject); }
            const text = JSON.stringify({ query, project: USER_SENTINEL, scope: 'user', count: results.length, results }, null, 2);
            return { content: [{ type: 'text', text }] };
          }

          const { store: kbStore, index: kbIndex } = await getKB(currentProject);
          let results = [];
          if (scope === 'both' && vector) results = await searchTwoPass(kbStore, currentProject, vector, { topK, minScore });
          else if (vector) results = await kbStore.search(vector, { topK, minScore });

          if (results.length < 2) {
            const kw = extractKeywords(query);
            if (kw.length > 0) {
              const kwResults = await kbIndex.lookup(kw, { topK });
              for (const r of kwResults) {
                if (!results.find(e => e.id === r.id)) {
                  const entry = await kbStore.get(r.id);
                  if (entry) results.push({ ...entry, score: r.score, scope: entry.scope });
                }
              }
            }
          }

          const text = results.length > 0
            ? JSON.stringify({ query, project: currentProject, scope, count: results.length, results }, null, 2)
            : JSON.stringify({ query, project: currentProject, scope, count: 0, results: [], message: 'No entries found. Try brain_store to add knowledge first.' }, null, 2);
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `brain_search failed: ${err.message}` }] };
        }
      }

      case 'brain_store': {
        try {
          const { title, summary, detail, type = 'note', tags, confidence = 0.8, sourceUrl, scope = 'auto' } = args;
          const currentProject = resolveProject(args);
          const effectiveScope = (scope === 'project' || scope === 'user') ? scope : inferDefaultScope(type, tags);
          let safeTitle = title, safeSummary = summary, safeDetail = detail;
          if (effectiveScope === 'user') {
            const prep = prepareForUserScope({ title, summary, detail }, currentProject);
            if (prep.rejected) return { isError: true, content: [{ type: 'text', text: `brain_store rejected: scope=user but ${prep.reason}. Strip the secret or use scope=project.` }] };
            ({ title: safeTitle, summary: safeSummary, detail: safeDetail } = prep.safe);
          }
          const storageProject = effectiveScope === 'user' ? USER_SENTINEL : currentProject;
          const { store: kbStore, index: kbIndex, graph: kbGraph } = await getKB(storageProject);
          const entry = { title: safeTitle, summary: safeSummary, detail: safeDetail || safeSummary, content: { detail: safeDetail || safeSummary, files: [] }, type, tags: Array.isArray(tags) ? tags : [], project: storageProject, scope: effectiveScope, confidence, sourceUrl: sourceUrl || '', created: new Date().toISOString() };
          let vector = null;
          try {
            const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
            const { buildEmbedText } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'embed-text.js'));
            await embedder.init();
            if (embedder.getStatus().ready) vector = await embedder.embed(buildEmbedText({ title: safeTitle, summary: safeSummary }));
          } catch { /* embedding optional */ }
          await kbStore.save(entry, vector);
          await kbIndex.index(entry);
          await kbGraph.registerNode(entry);
          if (storageProject !== currentProject) await getKB(currentProject);
          return { content: [{ type: 'text', text: JSON.stringify({ id: entry.id, project: storageProject, scope: effectiveScope, status: 'saved', title: safeTitle, type }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `brain_store failed: ${err.message}` }] };
        }
      }

      case 'capture_lesson': {
        try {
          const { title, summary, detail, type = 'lesson', tags = [], confidence = 0.85, scope = 'auto' } = args;
          const currentProject = resolveProject(args);
          const effectiveScope = (scope === 'project' || scope === 'user') ? scope : inferDefaultScope(type, tags);
          let safeTitle = title, safeSummary = summary, safeDetail = detail;
          if (effectiveScope === 'user') {
            const prep = prepareForUserScope({ title, summary, detail }, currentProject);
            if (prep.rejected) return { isError: true, content: [{ type: 'text', text: `capture_lesson rejected: scope=user but ${prep.reason}. Strip the secret or use scope=project.` }] };
            ({ title: safeTitle, summary: safeSummary, detail: safeDetail } = prep.safe);
          }
          const storageProject = effectiveScope === 'user' ? USER_SENTINEL : currentProject;
          const { store: kbStore, index: kbIndex, graph: kbGraph } = await getKB(storageProject);
          const { buildEmbedText } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'embed-text.js'));
          const text = buildEmbedText({ title: safeTitle, summary: safeSummary });
          let vector = null;
          try {
            const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
            await embedder.init();
            if (embedder.getStatus().ready) vector = await embedder.embed(text);
          } catch { /* embedding optional */ }
          const DEDUP = 0.9;
          if (vector) {
            const hits = await kbStore.search(vector, { topK: 1, minScore: DEDUP, rerank: false });
            if (hits.length > 0) {
              const merged = await kbStore.merge(hits[0].id, { summary: safeSummary, content: { detail: safeDetail || safeSummary }, confidence });
              recordLessonMetric(storageProject, { type, decision: 'merge', scope: effectiveScope, recurrence: merged?.recurrence });
              recordCaptureAck(args.windowId, 'captured');
              if (storageProject !== currentProject) await getKB(currentProject);
              return { content: [{ type: 'text', text: JSON.stringify({ decision: 'merge', id: hits[0].id, recurrence: merged?.recurrence, title: hits[0].title, project: storageProject, scope: effectiveScope }, null, 2) }] };
            }
          }
          const entry = { type, project: storageProject, scope: effectiveScope, session_id: '', title: String(safeTitle).slice(0, 80), summary: String(safeSummary).slice(0, 500), content: { detail: safeDetail || safeSummary, files: [] }, tags: [...new Set((Array.isArray(tags) ? tags : []).map(t => String(t).toLowerCase().trim().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 8), confidence };
          await kbStore.save(entry, vector);
          await kbIndex.index(entry);
          await kbGraph.registerNode(entry);
          recordLessonMetric(storageProject, { type, decision: 'admit', scope: effectiveScope });
          recordCaptureAck(args.windowId, 'captured');
          if (storageProject !== currentProject) await getKB(currentProject);
          return { content: [{ type: 'text', text: JSON.stringify({ decision: 'admit', id: entry.id, type, project: storageProject, scope: effectiveScope }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `capture_lesson failed: ${err.message}` }] };
        }
      }

      case 'capture_ack': {
        recordCaptureAck(args.windowId, args.outcome || 'none');
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'acked', windowId: args.windowId || null, outcome: args.outcome || 'none' }, null, 2) }] };
      }

      case 'brain_related': {
        try {
          const { id } = args;
          const project = resolveProject(args);
          const { store: kbStore, graph: kbGraph } = await getKB(project);
          const related = await kbGraph.getRelated(id);
          const full = [];
          for (const r of related) {
            const entry = await kbStore.get(r.id);
            if (entry) full.push({ ...entry, edgeType: r.edgeType });
          }
          return { content: [{ type: 'text', text: JSON.stringify({ id, project, count: full.length, related: full }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `brain_related failed: ${err.message}` }] };
        }
      }

      case 'brain_count': {
        try {
          const project = resolveProject(args);
          const { store: kbStore } = await getKB(project);
          const count = await kbStore.count();
          return { content: [{ type: 'text', text: JSON.stringify({ project, count }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `brain_count failed: ${err.message}` }] };
        }
      }

      case 'brain_retrieve_context': {
        try {
          const { prompt, session_id } = args || {};
          const project = resolveProject(args);
          const retrieveCore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'retrieve-core.js'));
          const { entries, capabilities } = await retrieveCore.retrieve(prompt || '', { project });
          if (entries.length) {
            try {
              const journal = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'retrieval-journal.js'));
              const sid = session_id || 'default';
              journal.appendEntry(sid, { retrievalId: journal.newRetrievalId(), ts: Date.now(), sid, tool: 'UserPromptSubmit', project, returnedIds: entries.map(e => e.id), returnedTitles: entries.map(e => e.title) });
            } catch (err) { console.error(`[brain_retrieve_context] journal: ${err.message}`); }
          }
          // mcp_tool hooks on UserPromptSubmit only inject when the tool returns a
          // JSON output with hookSpecificOutput.additionalContext; empty → no inject.
          // Journal above measures the REAL retrieval (full entries); injection
          // respects the config-driven exclude filter (e.g. drop lessons).
          const injectable = retrieveCore.filterInjectableEntries(entries);
          const text = retrieveCore.formatContext(injectable, capabilities);
          const payload = text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) : '';
          return { content: [{ type: 'text', text: payload }] };
        } catch (err) {
          console.error(`[brain_retrieve_context] ${err.message}`);
          return { content: [{ type: 'text', text: '' }] }; // fail-open: never break the prompt
        }
      }

      case 'curation_mark_oneoff': {
        try {
          const a = args || {};
          const aliases = Array.isArray(a.aliases) ? a.aliases.map(x => String(x || '').trim()).filter(Boolean) : [];
          const sigs = Array.isArray(a.sigs) ? a.sigs.map(x => String(x || '').trim()).filter(Boolean) : [];
          if (aliases.length === 0 && sigs.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'curation_mark_oneoff: sigs[] or aliases[] required — pass the `sig` values from the Stop-hook reason verbatim (preferred), or raw command forms, e.g. ["npm test","npm run test"].' }] };
          }
          const cmdSig = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'command-signature.js'));
          const tooBroad = [...aliases, ...sigs].filter(x => cmdSig.isGenericAlias(x));
          if (tooBroad.length) {
            return { isError: true, content: [{ type: 'text', text: `curation_mark_oneoff: alias/sig too broad: ${tooBroad.join(', ')}. A 1-token form (e.g. "git") would silence unrelated subcommands — name the subcommand (e.g. "git log").` }] };
          }
          const oneoff = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'oneoff-store.js'));
          const cfg = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'brain-config.js')).getCuration();
          const projectKey = oneoff.resolveProjectKey(a.cwd || process.cwd());
          const res = oneoff.mark(process.env.CLAUDE_PLUGIN_DATA, projectKey, { aliases, sigs, sessionId: a.session_id || null, maxRecurrence: cfg.oneHitMaxRecurrence, windowDays: cfg.oneHitWindowDays });
          if (res.decision === 'rejected') {
            return { content: [{ type: 'text', text: JSON.stringify({ decision: 'rejected', signature: res.sig, count: res.count, ceiling: cfg.oneHitMaxRecurrence, message: `"${res.sig}" already recurs ${res.count}x in this project (>= ceiling ${cfg.oneHitMaxRecurrence}). Create a curated script instead of marking one-hit.` }, null, 2) }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify({ decision: res.decision, signature: res.sig, count: res.count, aliases: res.aliases, message: 'Marked one-hit — the Stop hook will not ask to curate it again until it recurs past the ceiling.' }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `curation_mark_oneoff failed: ${err.message}` }] };
        }
      }

      case 'curation_register_shell': {
        try {
          const registerShell = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'shell-register.js'));
          const res = registerShell.register(args || {});
          if (res.isError) return { isError: true, content: [{ type: 'text', text: res.message }] };
          return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `curation_register_shell failed: ${err.message}` }] };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ─── Server wiring ──────────────────────────────────────────────────────────
  const server = new Server({ name: 'brain-server', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return KB_TOOLS.has(name) ? withLock(() => handleTool(name, args)) : handleTool(name, args);
  });

  return server;
}
