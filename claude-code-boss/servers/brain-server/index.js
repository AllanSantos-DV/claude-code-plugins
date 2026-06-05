#!/usr/bin/env node
/**
 * Brain Research MCP Server v2
 *
 * Provides:
 *   research_query   — Fan-out web research across web sources (existing)
 *   research_status  — Check cache status for a query (existing)
 *   brain_search     — Semantic + keyword search across the KB
 *   brain_store      — Manually save a structured entry to the KB
 *   brain_related    — Get related/cited/citing entries for a given entry
 *   brain_count      — Get entry count for the current project
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve plugin env vars robustly: ignore unexpanded "${...}" literals (some
// install contexts don't expand .mcp.json env), derive sane defaults, and
// normalize process.env so downstream requires (brain-store etc.) inherit them.
function valid(v) { return v && !v.includes('${') ? v : null; }
function resolveEnv(name, fallback) {
  const resolved = valid(process.env[name]) || fallback;
  process.env[name] = resolved;
  return resolved;
}
// CLI arg fallback for the buggy .mcp.json env block (Claude Code issue #9427:
// ${...} does not expand in the MCP env block, but DOES expand in args). We pass
// --plugin-data ${CLAUDE_PLUGIN_DATA} so the server gets the SAME data dir the
// hooks use (avoids a split-brain KB).
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? valid(process.argv[i + 1]) : null;
}

const PLUGIN_ROOT = resolveEnv('CLAUDE_PLUGIN_ROOT', path.resolve(__dirname, '..', '..'));
const DATA_DIR = argValue('--plugin-data')
  || resolveEnv('CLAUDE_PLUGIN_DATA',
       path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'plugins', 'data', 'claude-code-boss'));
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR; // normalize so brain-store inherits the resolved dir

const require = createRequire(import.meta.url);

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

// Plan #7 — scope helpers (sanitizer + two-pass retrieval).
const scopeSanitizer = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'scope-sanitizer.js'));
const scopeSearch = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'scope-search.js'));
const { USER_SENTINEL, inferDefaultScope, prepareForUserScope } = scopeSanitizer;
const { searchTwoPass } = scopeSearch;

// ─── Simple file-based cache ────────────────────────────────────────────────

const cache = new Map();

function getCached(query) {
  const entry = cache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.ts > 300_000) {
    cache.delete(query);
    return null;
  }
  return entry.result;
}

function setCached(query, result) {
  cache.set(query, { result, ts: Date.now() });
}

// ─── Source definitions ─────────────────────────────────────────────────────

const SOURCES = {
  web: {
    authority: 65,
    async search(query) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'ClaudeCodeBrain/0.1' }
      });
      const html = await resp.text();
      const results = [];
      const snippetRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex2 = /class="result__snippet">([\s\S]*?)<\/(?:a|span|div)/g;
      let match;
      let snippets = [];
      while ((match = snippetRegex2.exec(html)) !== null) {
        snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
      }
      let idx = 0;
      while ((match = snippetRegex.exec(html)) !== null && results.length < 5) {
        const href = match[1].replace(/^\/\/redirect\.php.*?uddg=/, '');
        const title = match[2].replace(/<[^>]*>/g, '').trim();
        const decodedUrl = decodeURIComponent(href).split('&')[0] || href;
        results.push({
          title,
          url: decodedUrl,
          snippet: snippets[idx] || '',
        });
        idx++;
      }
      return results;
    }
  }
};

// ─── Helper: extract keywords ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'from', 'was', 'are',
  'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will', 'just',
  'been', 'were', 'they', 'them', 'their', 'what', 'when', 'where',
  'which', 'who', 'how', 'about', 'into', 'over', 'such', 'each',
  'than', 'then', 'these', 'those', 'also', 'very', 'because',
  'para', 'que', 'com', 'uma', 'mais', 'mas', 'como', 'por',
  'dos', 'das', 'era', 'sao', 'seu', 'sua', 'pelo', 'pela',
]);

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s/._-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

// ─── Server setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: 'brain-server', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool list ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'research_query',
      description: 'Perform multi-source web research on a topic. Fan-out across web sources, aggregate results, and return structured findings with citations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The research query or question' },
          depth: {
            type: 'string',
            enum: ['quick', 'thorough'],
            description: 'Search depth — quick returns top 3-5 results, thorough fetches detailed content from each result'
          }
        },
        required: ['query', 'depth']
      }
    },
    {
      name: 'research_status',
      description: 'Check cache status for a query — returns cached result if available, or reports cache miss.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query to check' }
        },
        required: ['query']
      }
    },
    {
      name: 'brain_search',
      description: 'Search the Brain Knowledge Base semantically (vector) with keyword fallback. Finds stored entries relevant to the query text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query in natural language' },
          project: { type: 'string', description: 'Project name (default: auto-detect from CWD)' },
          topK: { type: 'number', description: 'Number of results (default: 5)' },
          minScore: { type: 'number', description: 'Minimum relevance score (default: 0.2)' },
          scope: { type: 'string', enum: ['both', 'project', 'user'], description: 'Plan #7: which memory scope to search. "both" (default) = two-pass merge of current project + global __user__ entries. "project" = current project only. "user" = global __user__ only.' }
        },
        required: ['query']
      }
    },
    {
      name: 'brain_store',
      description: 'Manually save a structured entry to the Brain Knowledge Base. The entry is vectorized and added to the inverted index + citation graph.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Entry title (required)' },
          summary: { type: 'string', description: 'One-line summary (required)' },
          detail: { type: 'string', description: 'Full content / body text' },
          type: {
            type: 'string',
            enum: ['note', 'pattern', 'lesson', 'research', 'code', 'reference', 'decision'],
            description: 'Entry type (default: note)'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for search filtering'
          },
          project: { type: 'string', description: 'Project name (default: auto-detect)' },
          confidence: { type: 'number', description: 'Confidence score 0.0-1.0 (default: 0.8)' },
          sourceUrl: { type: 'string', description: 'Source URL if applicable' },
          scope: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Plan #7: where to store. "auto" (default) infers from type+tags (reference/research/user-tag → user; decision/code → project). "user" routes to global __user__ DB and sanitizes user paths/emails/project name. Entries with detected secrets are rejected if scope=user.' }
        },
        required: ['title', 'summary']
      }
    },
    {
      name: 'brain_related',
      description: 'Get entries related to a given KB entry via the citation graph.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry ID from a previous brain_search result' },
          project: { type: 'string', description: 'Project name (default: auto-detect)' }
        },
        required: ['id']
      }
    },
    {
      name: 'brain_count',
      description: 'Get the number of entries in the Knowledge Base for the current (or specified) project.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name (default: auto-detect)' }
        }
      }
    },
    {
      name: 'capture_lesson',
      description: 'Capture a CURATED lesson in-loop (the agent post-mortem pattern). Call this when the user corrects you, or when a reusable pattern emerges — YOU write the clean summary + correction + generalized lesson (you have full context; do not make the KB re-read transcripts). WRITE IN ENGLISH — the KB is English-canonical so entries stay retrievable regardless of the user\'s prompt language. Runs admission control inline: a near-duplicate is MERGED (bumping recurrence, which drives skill promotion) instead of duplicated.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short lesson title in English (max 80 chars)' },
          summary: { type: 'string', description: 'One-line in English: what went wrong / the pattern, and what to do instead' },
          detail: { type: 'string', description: 'Full lesson in English: what happened + the correction + the generalized rule. Keep the valuable specifics.' },
          type: { type: 'string', enum: ['lesson', 'pattern'], description: 'lesson (correction) or pattern (reusable workflow). Default: lesson' },
          tags: { type: 'array', items: { type: 'string' }, description: '3-8 CANONICAL English concept tags, lowercase, hyphenated (e.g. "error-handling", "token-efficiency", "cross-lingual"). These are the language-neutral retrieval anchor — choose the terms a future query (in any language) would map to.' },
          confidence: { type: 'number', description: '0.0-1.0 (default 0.85)' },
          project: { type: 'string', description: 'Project name (default: auto-detect from CWD)' },
          scope: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Plan #7: where to store. "auto" (default) infers from type+tags (user-tag hints like workflow/preferences/agent-behavior → user). "user" routes to global __user__ DB and sanitizes user paths/emails/project name. Entries with detected secrets are rejected if scope=user.' }
        },
        required: ['title', 'summary']
      }
    }
  ]
}));

// ─── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── Web Research ──────────────────────────────────────────────────────
    case 'research_query': {
      const { query, depth } = args;
      const cached = getCached(query);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...cached, cached: true }, null, 2) }]
        };
      }

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
        const qualityGate = {
          passed: totalResults >= 2,
          totalResults,
          sourcesConsulted: Object.keys(sourceResults).filter(s => sourceResults[s].count > 0).length,
        };

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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            cached: !!cached,
            available: cached ? { depth: cached.depth, sources: Object.keys(cached.sources), timestamp: cached.timestamp } : null
          }, null, 2)
        }]
      };
    }

    // ── KB Search ────────────────────────────────────────────────────────
    case 'brain_search': {
      try {
        const { query, project: projectArg, topK = 5, minScore = 0.05, scope = 'both' } = args;
        const currentProject = projectArg || path.basename(process.cwd() || 'default');

        // Embed once
        let vector = null;
        try {
          const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
          await embedder.init();
          if (embedder.getStatus().ready) vector = await embedder.embed(query);
        } catch { /* embedding optional */ }

        // scope='user' → search only __user__ DB, then restore current project.
        if (scope === 'user') {
          const { store: userStore } = await getKB(USER_SENTINEL);
          let results = [];
          if (vector) results = await userStore.search(vector, { topK, minScore });
          await getKB(currentProject); // restore singleton to current project
          const text = JSON.stringify({ query, project: USER_SENTINEL, scope: 'user', count: results.length, results }, null, 2);
          return { content: [{ type: 'text', text }] };
        }

        // scope='project' or 'both'
        const { store: kbStore, index: kbIndex } = await getKB(currentProject);
        let results = [];
        if (scope === 'both' && vector) {
          results = await searchTwoPass(kbStore, currentProject, vector, { topK, minScore });
        } else if (vector) {
          results = await kbStore.search(vector, { topK, minScore });
        }

        // Keyword fallback (project scope only; singleton is restored above by searchTwoPass)
        if (results.length < 2) {
          const kw = extractKeywords(query);
          if (kw.length > 0) {
            const kwResults = await kbIndex.lookup(kw, { topK });
            for (const r of kwResults) {
              if (!results.find(e => e.id === r.id)) {
                const entry = await kbStore.get(r.id);
                if (entry) results.push({ ...entry, score: r.score, scope: entry.scope || 'project' });
              }
            }
          }
        }

        const text = results.length > 0
          ? JSON.stringify({ query, project: currentProject, scope, count: results.length, results }, null, 2)
          : JSON.stringify({ query, project: currentProject, scope, count: 0, results: [], message: 'No entries found. Try brain_store to add knowledge first.' });

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `brain_search failed: ${err.message}` }] };
      }
    }

    // ── KB Store ─────────────────────────────────────────────────────────
    case 'brain_store': {
      try {
        const { title, summary, detail, type = 'note', tags, project: projectArg, confidence = 0.8, sourceUrl, scope = 'auto' } = args;
        const currentProject = projectArg || path.basename(process.cwd() || 'default');

        // Resolve scope (auto-infer from type+tags).
        const effectiveScope = (scope === 'project' || scope === 'user')
          ? scope
          : inferDefaultScope(type, tags);

        // Sanitize + secret-check when storing to user scope.
        let safeTitle = title, safeSummary = summary, safeDetail = detail;
        if (effectiveScope === 'user') {
          const prep = prepareForUserScope({ title, summary, detail }, currentProject);
          if (prep.rejected) {
            return { isError: true, content: [{ type: 'text', text: `brain_store rejected: scope=user but ${prep.reason}. Strip the secret or use scope=project.` }] };
          }
          ({ title: safeTitle, summary: safeSummary, detail: safeDetail } = prep.safe);
        }

        const storageProject = effectiveScope === 'user' ? USER_SENTINEL : currentProject;
        const { store: kbStore, index: kbIndex, graph: kbGraph } = await getKB(storageProject);

        const entry = {
          title: safeTitle,
          summary: safeSummary,
          detail: safeDetail || safeSummary,
          content: { detail: safeDetail || safeSummary, files: [] },
          type,
          tags: Array.isArray(tags) ? tags : [],
          project: storageProject,
          scope: effectiveScope,
          confidence,
          sourceUrl: sourceUrl || '',
          created: new Date().toISOString(),
        };

        // Generate embedding upfront so we save+index in one pass (optional)
        let vector = null;
        try {
          const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
          await embedder.init();
          if (embedder.getStatus().ready) vector = await embedder.embed(safeTitle + ': ' + safeSummary);
        } catch { /* embedding optional */ }

        await kbStore.save(entry, vector);   // mutates entry.id
        await kbIndex.index(entry);          // extracts keywords/tags internally
        await kbGraph.registerNode(entry);   // registers node by entry.id

        // Restore singleton to current project so subsequent tool calls don't drift.
        if (storageProject !== currentProject) await getKB(currentProject);

        return {
          content: [{ type: 'text', text: JSON.stringify({ id: entry.id, project: storageProject, scope: effectiveScope, status: 'saved', title: safeTitle, type }, null, 2) }]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `brain_store failed: ${err.message}` }] };
      }
    }

    // ── Capture Lesson (in-loop, admission control inline) ───────────────
    case 'capture_lesson': {
      try {
        const { title, summary, detail, type = 'lesson', tags = [], confidence = 0.85, project: projectArg, scope = 'auto' } = args;
        const currentProject = projectArg || path.basename(process.cwd() || 'default');

        // Resolve scope (lessons/patterns default to project unless tags hint user-facing).
        const effectiveScope = (scope === 'project' || scope === 'user')
          ? scope
          : inferDefaultScope(type, tags);

        // Sanitize + secret-check when storing to user scope.
        let safeTitle = title, safeSummary = summary, safeDetail = detail;
        if (effectiveScope === 'user') {
          const prep = prepareForUserScope({ title, summary, detail }, currentProject);
          if (prep.rejected) {
            return { isError: true, content: [{ type: 'text', text: `capture_lesson rejected: scope=user but ${prep.reason}. Strip the secret or use scope=project.` }] };
          }
          ({ title: safeTitle, summary: safeSummary, detail: safeDetail } = prep.safe);
        }

        const storageProject = effectiveScope === 'user' ? USER_SENTINEL : currentProject;
        const { store: kbStore, index: kbIndex, graph: kbGraph } = await getKB(storageProject);

        const text = `${safeTitle} ${safeSummary} ${safeDetail || ''}`.trim();

        // Embed for dedup + storage
        let vector = null;
        try {
          const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
          await embedder.init();
          if (embedder.getStatus().ready) vector = await embedder.embed(text);
        } catch { /* embedding optional */ }

        // Admission control inline: near-duplicate → MERGE (bump recurrence)
        const DEDUP = 0.9;
        if (vector) {
          const hits = await kbStore.search(vector, { topK: 1, minScore: DEDUP, rerank: false });
          if (hits.length > 0) {
            const merged = await kbStore.merge(hits[0].id, { summary: safeSummary, content: { detail: safeDetail || safeSummary }, confidence });
            if (storageProject !== currentProject) await getKB(currentProject);
            try { kbStore.recordMetric('lesson.captured', { type, decision: 'merge', scope: effectiveScope, recurrence: merged?.recurrence }, null); } catch { /* metrics best-effort */ }
            return { content: [{ type: 'text', text: JSON.stringify({ decision: 'merge', id: hits[0].id, recurrence: merged?.recurrence, title: hits[0].title, project: storageProject, scope: effectiveScope }, null, 2) }] };
          }
        }

        // Admit: new curated entry
        const entry = {
          type, project: storageProject, scope: effectiveScope, session_id: '',
          title: String(safeTitle).slice(0, 80),
          summary: String(safeSummary).slice(0, 500),
          content: { detail: safeDetail || safeSummary, files: [] },
          tags: [...new Set(
            (Array.isArray(tags) ? tags : [])
              .map(t => String(t).toLowerCase().trim().replace(/\s+/g, '-'))
              .filter(Boolean)
          )].slice(0, 8),
          confidence,
        };
        await kbStore.save(entry, vector);
        await kbIndex.index(entry);
        await kbGraph.registerNode(entry);

        if (storageProject !== currentProject) await getKB(currentProject);
        try { kbStore.recordMetric('lesson.captured', { type, decision: 'admit', scope: effectiveScope }, null); } catch { /* metrics best-effort */ }
        return { content: [{ type: 'text', text: JSON.stringify({ decision: 'admit', id: entry.id, type, project: storageProject, scope: effectiveScope }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `capture_lesson failed: ${err.message}` }] };
      }
    }

    // ── KB Related ───────────────────────────────────────────────────────
    case 'brain_related': {
      try {
        const { id, project: projectArg } = args;
        const project = projectArg || path.basename(process.cwd() || 'default');
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

    // ── KB Count ─────────────────────────────────────────────────────────
    case 'brain_count': {
      try {
        const { project: projectArg } = args || {};
        const project = projectArg || path.basename(process.cwd() || 'default');
        const { store: kbStore } = await getKB(project);
        const count = await kbStore.count();
        return { content: [{ type: 'text', text: JSON.stringify({ project, count }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `brain_count failed: ${err.message}` }] };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
