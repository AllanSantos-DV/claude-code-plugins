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
const fs = require('fs');
const crypto = require('crypto');

// ─── Policy adjudication (Fase 3 micro-B0) — trusted evidence-bundle builder ───
// The prepare tool scans the CURRENT code for a glob/shadow policy's matches,
// deterministically samples ≤25, and writes a REDACTED evidence bundle the
// `policy-auditor` sub-agent judges. Honest framing lives in the strings below.
const ADJ_SAMPLE_CAP = 25;              // max occurrences materialized per bundle
const ADJ_CONTEXT_RADIUS = 20;          // ±lines of context per occurrence
const ADJ_MAX_FILE_BYTES = 512 * 1024;  // skip larger files (binary/minified/data)
const ADJ_MAX_LINE_CHARS = 400;         // truncate each context line (bounds bundle)
const ADJ_BUNDLE_MAX_BYTES = 1024 * 1024; // ~1MiB cap on the serialized bundle
const ADJ_MAX_FILES_WALK = 20000;       // safety bound on the workspace walk
const ADJ_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.claude', '.hg', '.svn', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode',
]);
const ADJ_SCANNER_VERSION = 'ccb-adjudicate-scan/1';
const ADJ_PROMPT_VERSION = 'policy-auditor/1';
const ADJ_NOTE = 'This sends redacted code context to your model provider when the auditor runs. Results are a best-effort LLM judgment of the CURRENT code, not a measured false-positive rate.';
const ADJ_DISCLAIMER = "Best-effort LLM judgment of CURRENT code occurrences against the policy's stated intent. NOT a measured false-positive rate, NOT human-verified, and it does not establish whether any specific edit was a violation. Local to this machine; code context was sent to your model provider.";
const ADJ_TUNING = 'This rule flags mostly-legitimate current code; consider narrowing its globs/literal.';

/** Standard MCP result envelopes for the adjudication tools. */
function adjErr(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}
function adjJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** Heuristic binary sniff: a NUL byte in the first 4KB → treat as non-text. */
function adjIsProbablyText(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) { if (buf[i] === 0) return false; }
  return true;
}

/**
 * Walk `realRoot` (already realpath'd) and return the glob-matching regular files
 * as `{rel, abs}`, sorted by `rel` for determinism. ALL symlinks are skipped — a
 * symlink is the only way a child's realpath could escape realRoot, so refusing
 * them guarantees every kept file lives inside the workspace.
 */
function adjCollectFiles(realRoot, globs, anyGlobMatches) {
  const out = [];
  const stack = [realRoot];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[adjudicate] readdir failed (${dir}): ${err.message}`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (visited >= ADJ_MAX_FILES_WALK) break;
      if (ent.isSymbolicLink()) continue; // refuse symlink escapes (and loops)
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ADJ_IGNORE_DIRS.has(ent.name)) stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      visited++;
      const rel = path.relative(realRoot, full).split(path.sep).join('/');
      if (rel && !rel.startsWith('..') && anyGlobMatches(globs, rel)) out.push({ rel, abs: full });
    }
    if (visited >= ADJ_MAX_FILES_WALK) break;
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** First non-blank line (1-based) of `lines`, or 1 if all blank. */
function adjFirstRelevantLine(lines) {
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() !== '') return i + 1; }
  return 1;
}

/** The redacted-ready ±radius context slice around 1-based `line1`, per-line capped. */
function adjContext(lines, line1) {
  const start = Math.max(0, line1 - 1 - ADJ_CONTEXT_RADIUS);
  const end = Math.min(lines.length, line1 - 1 + ADJ_CONTEXT_RADIUS + 1);
  const slice = lines.slice(start, end).map((l) => (l.length > ADJ_MAX_LINE_CHARS ? `${l.slice(0, ADJ_MAX_LINE_CHARS)}…` : l));
  return slice.join('\n');
}

/** Char offsets where each line begins (offset→line lookup support). */
function adjLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) { if (text[i] === '\n') starts.push(i + 1); }
  return starts;
}

/** 1-based line number containing char `offset` (binary search over line starts). */
function adjLineForOffset(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans + 1;
}

/** Count non-overlapping occurrences of `needle` in `hay` (case-adjusted). */
function adjCountOccurrences(hay, needle, caseSensitive) {
  if (!needle) return 0;
  const h = caseSensitive ? hay : hay.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    count++;
    from = idx + n.length;
  }
  return count;
}

/** First `cap` non-overlapping match offsets of `needle` in `hay` (case-adjusted). */
function adjFindLiteralOffsets(hay, needle, caseSensitive, cap) {
  const out = [];
  if (!needle) return out;
  const h = caseSensitive ? hay : hay.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let from = 0;
  while (out.length < cap) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + n.length;
  }
  return out;
}

/** Stable per-occurrence id from (relPath, line, ordinal). */
function adjOccId(rel, line, ord) {
  return `occ-${crypto.createHash('sha1').update(`${rel}\u0000${line}\u0000${ord}`).digest('hex').slice(0, 12)}`;
}

/** Tolerate a judge that wrapped its JSON in a ```json fence despite instructions. */
function adjStripFences(s) {
  let t = String(s == null ? '' : s).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
    if (t.endsWith('```')) t = t.slice(0, -3);
    t = t.trim();
  }
  return t;
}

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

export function createBrainServer({ pluginRoot, mode = 'stdio', _testHooks } = {}) {
  const PLUGIN_ROOT = pluginRoot;

  // ─── KB modules (lazy-loaded) ──────────────────────────────────────────────
  async function getKB(project) {
    if (_testHooks && typeof _testHooks.getKB === 'function') return _testHooks.getKB(project);
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
    if (!windowId) return false;
    try {
      const cq = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'capture-queue.js'));
      return cq.recordAck(windowId, outcome);
    } catch (err) {
      console.error(`[BRAIN-SERVER] recordCaptureAck failed: ${err.message}`);
      return false;
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
    {
      name: 'policy_activate',
      description: 'Activate a standing user policy (explicit user action only; NOT for automatic capture). THREE modes: (1) ALWAYS-mode (default, no `globs`) — injected every session/subagent start, for a persistent global constraint (e.g. "never let pre-existing code errors pass"). (2) GLOB-mode (pass `globs`) — a project-scoped POST-EDIT ADVISORY that surfaces ONLY when an edited file path matches one of the globs (e.g. globs:["src/**/*.ts"] text:"keep this layer free of console.log"). (3) SHADOW-ASSERTION mode (pass `globs` AND `assert` with `enforcement:"shadow"`) — a project-scoped, Edit-ONLY MEASUREMENT that is SILENT and NEVER blocks: it records how often an Edit WOULD add the asserted literal on a matching path, so you can size a future guard before enabling it (a "trigger" is a candidate-guard hit, not a violation). The assert literal is stored UNREDACTED (a redacted literal could not match), so a secret-bearing literal is REJECTED (reason:"sensitive-literal") — never pass a token/key as a literal. Only enforcement:"shadow" is supported now (enforce/block is a later micro). NOTE: activating a shadow-assertion policy PERSISTS your literal locally and BEGINS local, per-machine monitoring on the next matching Edit (results stay on this machine; read them with policy_shadow_report). Glob and shadow policies are ALWAYS project-scoped and never injected at session start. In all modes the non-assert `text` is redacted + capped and stored in a local registry. Surfacing/measuring ≠ enforcement — none of these modes block.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The policy / standing constraint in plain language (required). Redacted + capped before storage.' }, entryId: { type: 'string', description: 'Optional stable id (e.g. a KB entry id) so re-activating the same policy upserts instead of duplicating. Default: a hash of text+mode+project(+globs).' }, scope: { type: 'string', enum: ['project', 'user'], description: 'project (default) = applies only in this project; user = applies in every project. IGNORED when globs are given (glob/shadow policies are always project-scoped).' }, globs: { type: 'array', items: { type: 'string' }, description: 'Optional glob patterns (e.g. ["src/**/*.ts","*.md"]). When present the policy becomes a project-scoped GLOB-mode advisory (or SHADOW-ASSERTION when `assert` is also given), surfaced/measured ONLY when an edited file matches — never at session start. Must be a non-empty array of valid patterns (≤20 patterns, each ≤200 chars); otherwise activation is rejected.' }, assert: { type: 'object', description: 'Optional deterministic content assertion that turns a GLOB policy into a SHADOW-ASSERTION MEASUREMENT (requires `globs` and `enforcement:"shadow"`). Edit-only, silent, never blocks.', properties: { kind: { type: 'string', enum: ['forbid-added-literal'], description: 'The only supported assertion this micro: measure when an Edit ADDS an occurrence of `literal` (net count increase old→new).' }, literal: { type: 'string', description: 'The exact substring to watch for (≤256 chars, stored UNREDACTED). A literal that would be redacted (secret-bearing) is REJECTED.' }, caseSensitive: { type: 'boolean', description: 'Match case-sensitively (default: true).' } }, required: ['kind', 'literal'] }, enforcement: { type: 'string', enum: ['shadow'], description: 'Required when `assert` is given. Only "shadow" (measure, never block) is supported this release; anything else is rejected.' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode). Ignored for user scope.' }, cwd: { type: 'string', description: 'Working directory (for project scoping when project is omitted).' } }, required: ['text'] },
    },
    {
      name: 'policy_list',
      description: 'List the standing policies currently active for a project (user-scope always-policies always included). Returns id, mode (always | glob), scope, projectId, globs (for glob policies), and a text preview for each. Shadow-assertion (measurement) policies additionally carry enforcement:"shadow", an assert summary (kind + a short literal preview), and an activationId (the telemetry key policy_shadow_report joins on). Glob/shadow policies are surfaced here for visibility even though they only act on a matching edit.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode).' }, cwd: { type: 'string', description: 'Working directory (for project scoping when project is omitted).' } } },
    },
    {
      name: 'policy_deactivate',
      description: 'Deactivate (remove) a standing policy by id so it stops being injected immediately. Use the id returned by policy_activate or policy_list. Invalidation must deactivate right away.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The policy id to deactivate (from policy_activate / policy_list).' } }, required: ['id'] },
    },
    {
      name: 'policy_shadow_report',
      description: 'Report the LOCAL, per-machine MEASUREMENT for shadow-assertion (measurement) policies in a project: for each activationId, how many matching Edits were seen (eligible), how many WOULD have triggered a future guard (triggers), the trigger incidence (triggers / (trigger+pass)), and how many were unevaluable (too large to scan). These are CANDIDATE-guard triggers, NOT violations, and the numbers are LOCAL to this machine only. The false-positive rate is reported as "N/A" (there are no human labels yet — real FP needs human adjudication, a later micro); it is NEVER 0%. Joins the telemetry to policy_list so each row names the policy (text preview + globs).',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode).' }, cwd: { type: 'string', description: 'Working directory (for project scoping + the canonical metrics key when project is omitted).' }, rangeDays: { type: 'number', description: 'How many days back to aggregate (default: 7).' } } },
    },
    {
      name: 'policy_adjudication_prepare',
      description: 'TRUSTED evidence-bundle builder for the policy-adjudication JUDGE loop (Fase 3 micro-B0). Given a GLOB (or shadow-assertion) policyId, re-scans the CURRENT code under the workspace for the policy\'s globs (+literal if it has a shadow assert), DETERMINISTICALLY samples at most 25 occurrences, captures a REDACTED ±20-line context for each, and writes an EPHEMERAL bundle JSON the `policy-auditor` sub-agent reads. Returns { bundlePath, manifestHash, occurrenceCount, intent, note }. Does NOT judge and does NOT change the policy. HONEST: the auditor produces a best-effort LLM judgment of the CURRENT code, NOT a measured false-positive rate; running it sends redacted code context to your model provider (see `note`). ALWAYS-mode (globless) policies cannot be adjudicated.',
      inputSchema: { type: 'object', properties: { policyId: { type: 'string', description: 'The glob/shadow policy id to adjudicate (from policy_list).' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode).' }, cwd: { type: 'string', description: 'Workspace directory to scan (default: process CWD). Realpath-bound; symlink escapes are refused.' } }, required: ['policyId'] },
    },
    {
      name: 'policy_adjudication_record',
      description: 'Record the `policy-auditor` verdict for a prepared bundle and return an HONEST disposition summary (Fase 3 micro-B0). Validates the auditor JSON against the bundle: verdict ids must EXACTLY equal the bundle\'s occurrence ids (unknown / duplicate / missing → error, nothing persisted). Tallies legit/problem/uncertain/injectionSuspected and persists a "current-snapshot occurrence disposition" (counts + coverage + provenance only — NO code snippets). Returns kind:"llm-current-snapshot-occurrence-disposition" with a disclaimer (NOT a false-positive rate, not human-verified, code sent to the provider) and, when problem-share is low, an INFORMATIONAL-ONLY tuningRecommendation. NEVER mutates, deactivates, or promotes the policy.',
      inputSchema: { type: 'object', properties: { policyId: { type: 'string', description: 'The policy id that was prepared.' }, manifestHash: { type: 'string', description: 'The manifestHash returned by policy_adjudication_prepare (locates the bundle).' }, verdictsJson: { type: 'string', description: 'The policy-auditor sub-agent\'s RAW strict-JSON output: {schema:1, verdicts:[{id,label,promptInjectionSuspected,reason}]}.' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode).' }, cwd: { type: 'string', description: 'Workspace directory (for project scoping when project is omitted).' } }, required: ['policyId', 'manifestHash', 'verdictsJson'] },
    },
    {
      name: 'policy_adjudication_report',
      description: 'Read back the stored policy-adjudication dispositions for a project (Fase 3 micro-B0), newest first, optionally filtered by policyId. Each is an HONEST "current-snapshot occurrence disposition" (counts + coverage + provenance, NO snippets) — a best-effort LLM judgment of the code at adjudication time, NOT a measured false-positive rate and NOT human-verified.',
      inputSchema: { type: 'object', properties: { policyId: { type: 'string', description: 'Optional: restrict to one policy id.' }, project: { type: 'string', description: 'Project name (default: auto-detect from CWD; REQUIRED in HTTP mode).' }, cwd: { type: 'string', description: 'Working directory (for project scoping when project is omitted).' } } },
    },
  ];

  // ─── Tool handlers (faithful move from the previous index.js switch) ───────
  async function handleTool(name, args) {
    // Remote brain (Native Java daemon): route write/search/related/count KB tools
    // through the backend dispatcher. brain_retrieve_context is excluded — its case
    // calls retrieve-core, which is itself remote-aware. A test that injects a local
    // KB via _testHooks.getKB forces the LOCAL path (so it exercises the local case
    // without depending on / mutating the shared brain-backend singleton mode).
    const forceLocal = !!(_testHooks && _testHooks.getKB);
    if (!forceLocal && REMOTE_KB_TOOLS.has(name)) {
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
            const embedder = (_testHooks && _testHooks.embedder) || require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
            await embedder.init();
            if (embedder.getStatus().ready) vector = await embedder.embed(text);
          } catch { /* embedding optional */ }
          const DEDUP = 0.9;
          if (vector) {
            const hits = await kbStore.search(vector, { topK: 1, minScore: DEDUP, rerank: false });
            if (hits.length > 0) {
              const merged = await kbStore.merge(hits[0].id, { summary: safeSummary, content: { detail: safeDetail || safeSummary }, confidence });
              if (merged) {
                recordLessonMetric(storageProject, { type, decision: 'merge', scope: effectiveScope, recurrence: merged.recurrence });
                recordCaptureAck(args.windowId, 'captured');
                if (storageProject !== currentProject) await getKB(currentProject);
                return { content: [{ type: 'text', text: JSON.stringify({ decision: 'merge', id: hits[0].id, recurrence: merged.recurrence, title: hits[0].title, project: storageProject, scope: effectiveScope }, null, 2) }] };
              }
              // merge() returned null: the dedup target vanished between search and
              // merge (e.g. a concurrent detached consolidation deleted it). Do NOT
              // ack a phantom merge that persisted nothing — fall through to the admit
              // path so the lesson is actually stored before we ack.
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
        // capture_ack is the NO-LESSON path by definition, so the outcome is ALWAYS
        // 'none' — never trust a passed-through value. The schema enum is advisory
        // (dispatch does not enforce it, and the SDK accepts arbitrary args), so a
        // forged/injected capture_ack({outcome:'captured'}) must NOT mark a window
        // captured. This preserves the invariant "a 'captured' marker ⟺ a lesson
        // persisted via capture_lesson", keeping the captured metric honest.
        const ok = recordCaptureAck(args.windowId, 'none');
        return { content: [{ type: 'text', text: JSON.stringify({ status: ok ? 'acked' : 'ack-failed', ok, windowId: args.windowId || null, outcome: 'none' }, null, 2) }] };
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

      case 'policy_activate': {
        try {
          const a = args || {};
          const text = typeof a.text === 'string' ? a.text : '';
          if (!text.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'policy_activate: text is required (the standing constraint to activate).' }] };
          }
          // Glob policies are project-scoped only (this micro): force project scope
          // even if the caller passed scope:'user' alongside globs.
          const hasGlobs = a.globs !== undefined && a.globs !== null;
          const hasAssert = a.assert !== undefined && a.assert !== null;
          // A shadow assertion is a GLOB policy that ALSO carries an assert — an
          // assert without globs would be silently ignored by the store's always
          // branch, so refuse it explicitly rather than store the wrong thing.
          if (hasAssert && !hasGlobs) {
            const msg = 'policy_activate: refused — a shadow assertion (`assert`) requires `globs` (it measures matching Edits). Provide globs and enforcement:"shadow", or drop assert. Nothing was stored.';
            return { content: [{ type: 'text', text: JSON.stringify({ activated: false, reason: 'assert-requires-globs', message: msg }, null, 2) }] };
          }
          const scope = hasGlobs ? 'project' : (a.scope === 'user' ? 'user' : 'project');
          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          // user-scope policies are project-independent; only resolve a project id
          // for project-scope activations (all glob policies are project-scoped).
          const pid = scope === 'user' ? '' : resolveProject(a);
          // When an assert is present this is a shadow-assertion activation: default
          // enforcement to 'shadow' but pass the caller's value through so an
          // unsupported enforcement (e.g. 'enforce') is REJECTED, not silently coerced.
          const enforcement = hasAssert ? (typeof a.enforcement === 'string' ? a.enforcement : 'shadow') : undefined;
          const res = policyStore.activate(dataDir(), {
            entryId: a.entryId, text, scope, projectId: pid,
            globs: hasGlobs ? a.globs : undefined,
            assert: hasAssert ? a.assert : undefined,
            enforcement,
          });
          if (!res.activated) {
            let msg;
            if (res.reason === 'invalid-globs') {
              msg = 'policy_activate: refused — `globs` must be a non-empty array of valid glob patterns (≤20 patterns, each ≤200 chars, no empty patterns). Fix the patterns and retry; nothing was stored.';
            } else if (res.reason === 'bad-assert-kind') {
              msg = 'policy_activate: refused — `assert.kind` must be "forbid-added-literal" (the only supported assertion this release). Nothing was stored.';
            } else if (res.reason === 'bad-literal') {
              msg = 'policy_activate: refused — `assert.literal` must be a non-empty string. Nothing was stored.';
            } else if (res.reason === 'literal-too-long') {
              msg = 'policy_activate: refused — `assert.literal` exceeds the maximum length (256 chars). Shorten it and retry; it is NOT truncated, so nothing was stored.';
            } else if (res.reason === 'sensitive-literal') {
              msg = 'policy_activate: refused — `assert.literal` looks secret-bearing (the redactor would change it, which would break exact matching). Never store a token/key as a literal. Nothing was stored.';
            } else if (res.reason === 'unsupported-enforcement') {
              msg = 'policy_activate: refused — only enforcement:"shadow" (measure, never block) is supported this release. Nothing was stored.';
            } else if (res.reason === 'corrupt') {
              msg = 'policy_activate: refused — the local policy registry is unreadable (corrupt); activation was declined rather than overwrite it. Inspect/repair the registry and retry.';
            } else if (res.reason === 'persist') {
              msg = 'policy_activate: refused — failed to persist the policy to the local registry (write error). Nothing was reliably stored; retry.';
            } else if (res.reason === 'budget') {
              msg = hasAssert
                ? 'policy_activate: refused — activating this shadow-assertion policy would exceed the per-project measurement-policy budget (max 10). Deactivate an existing shadow policy first (policy_list / policy_deactivate).'
                : hasGlobs
                  ? 'policy_activate: refused — activating this glob policy would exceed the per-project glob-policy budget. Deactivate an existing glob policy first (policy_list / policy_deactivate).'
                  : 'policy_activate: refused — activating this policy would exceed the injected-policy budget (too many active policies or too much total text). Deactivate an existing policy first (policy_list / policy_deactivate).';
            } else {
              msg = `policy_activate: refused (${res.reason || 'invalid'}).`;
            }
            return { content: [{ type: 'text', text: JSON.stringify({ activated: false, reason: res.reason || 'invalid', message: msg }, null, 2) }] };
          }
          const isShadow = res.enforcement === 'shadow';
          const mode = res.mode || (hasGlobs ? 'glob' : 'always');
          const okMsg = isShadow
            ? 'Shadow-assertion policy activated — it MEASURES (silently) how often a matching Edit would ADD the asserted literal, and NEVER blocks. Results are LOCAL to this machine; read them with policy_shadow_report. Your literal is stored locally and monitoring begins on the next matching Edit.'
            : mode === 'glob'
              ? 'Glob policy activated — it will surface as a post-edit advisory only when an edited file matches one of its globs (never at session start).'
              : 'Policy activated — it will be injected at every session and subagent start until deactivated.';
          const out = { activated: true, id: res.id, mode, scope, projectId: pid, message: okMsg };
          if (res.activationId) out.activationId = res.activationId;
          if (res.enforcement) out.enforcement = res.enforcement;
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_activate failed: ${err.message}` }] };
        }
      }

      case 'policy_list': {
        try {
          const a = args || {};
          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const pid = resolveProject(a);
          const active = policyStore.listVisible(dataDir(), { projectId: pid });
          const policies = active.map(r => ({
            id: r.id,
            mode: r.mode || 'always',
            scope: r.scope,
            projectId: r.projectId,
            globs: Array.isArray(r.globs) ? r.globs : undefined,
            enforcement: r.enforcement || undefined,
            assert: (r.assert && r.assert.kind)
              ? { kind: r.assert.kind, literalPreview: String(r.assert.literal || '').slice(0, 40), caseSensitive: r.assert.caseSensitive !== false }
              : undefined,
            activationId: r.activationId || undefined,
            text: String(r.text || '').slice(0, 160),
          }));
          return { content: [{ type: 'text', text: JSON.stringify({ projectId: pid, count: policies.length, policies }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_list failed: ${err.message}` }] };
        }
      }

      case 'policy_deactivate': {
        try {
          const a = args || {};
          const id = typeof a.id === 'string' ? a.id : '';
          if (!id.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'policy_deactivate: id is required (from policy_activate / policy_list).' }] };
          }
          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const res = policyStore.deactivate(dataDir(), id);
          return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_deactivate failed: ${err.message}` }] };
        }
      }

      case 'policy_shadow_report': {
        try {
          const a = args || {};
          // The report reads the SAME canonical metrics key the hook writes under, so
          // the read/write agree on the metrics db regardless of marker/env/basename.
          const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : process.cwd();
          const pid = resolveProject(a);
          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const metricsStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'metrics-store.js'));
          const { metricsProjectKey } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'metrics-project.js'));

          const rangeDays = (typeof a.rangeDays === 'number' && a.rangeDays > 0) ? a.rangeDays : 7;
          const sinceTs = Date.now() - rangeDays * 86400000;
          const projKey = metricsProjectKey(cwd);
          const rows = metricsStore.getEvaluationCountsIsolated(projKey, { eventName: 'policy.shadow.evaluated', sinceTs });

          // Tally per activationId (the immutable-per-definition telemetry key).
          const byAct = new Map();
          for (const row of rows) {
            const act = row.activationId;
            if (!act) continue; // rows with no activationId (legacy/none) can't be named
            if (!byAct.has(act)) byAct.set(act, { trigger: 0, pass: 0, unevaluable: 0 });
            const t = byAct.get(act);
            if (row.outcome === 'trigger') t.trigger += row.count;
            else if (row.outcome === 'pass') t.pass += row.count;
            else if (row.outcome === 'unevaluable') t.unevaluable += row.count;
          }

          // JOIN to the registry so each activationId names its policy. A definition
          // change mints a NEW activationId, so old metrics may be orphans (known:false).
          const active = policyStore.listVisible(dataDir(), { projectId: pid });
          const byActMeta = new Map();
          for (const r of active) { if (r && r.activationId) byActMeta.set(r.activationId, r); }

          const policies = [];
          for (const [act, t] of byAct.entries()) {
            const r = byActMeta.get(act);
            const denom = t.trigger + t.pass; // unevaluable is NOT a decision → excluded from incidence
            policies.push({
              activationId: act,
              policyId: r ? r.id : null,
              known: !!r,
              globs: (r && Array.isArray(r.globs)) ? r.globs : undefined,
              textPreview: r ? String(r.text || '').slice(0, 80) : undefined,
              literalPreview: (r && r.assert) ? String(r.assert.literal || '').slice(0, 40) : undefined,
              eligible: t.trigger + t.pass + t.unevaluable,
              triggers: t.trigger,
              incidence: denom > 0 ? t.trigger / denom : 0,
              unevaluable: t.unevaluable,
              humanAdjudicated: 0,
              falsePositiveRate: 'N/A',
            });
          }
          policies.sort((x, y) => (y.triggers - x.triggers) || String(x.activationId).localeCompare(String(y.activationId)));

          const report = {
            projectId: pid,
            rangeDays,
            sinceTs,
            note: 'Results are LOCAL to this machine only. falsePositiveRate is N/A (no human labels yet — real FP needs human adjudication, a later micro; it is NEVER 0%). "triggers" are CANDIDATE-guard hits (an Edit would ADD the asserted literal), NOT violations.',
            count: policies.length,
            policies,
          };
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_shadow_report failed: ${err.message}` }] };
        }
      }

      case 'policy_adjudication_prepare': {
        try {
          const a = args || {};
          const policyId = typeof a.policyId === 'string' ? a.policyId.trim() : '';
          if (!policyId) return adjErr('policy_adjudication_prepare: policyId is required (from policy_list).');
          const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : process.cwd();
          const pid = resolveProject(a);

          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const { anyGlobMatches } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'glob-match.js'));
          const { redact } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'redact.js'));
          const { writeFileAtomic } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'atomic-write.js'));
          const adjStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'adjudication-store.js'));

          const visible = policyStore.listVisible(dataDir(), { projectId: pid });
          const policy = visible.find((r) => r && String(r.id) === policyId);
          if (!policy) return adjErr(`policy_adjudication_prepare: no active policy with id "${policyId}" in this project. Use policy_list.`);
          if (policy.mode !== 'glob' || !Array.isArray(policy.globs) || policy.globs.length === 0) {
            return adjErr('policy_adjudication_prepare: only GLOB (or shadow-assertion) policies can be adjudicated — this policy has no globs. ALWAYS-mode policies apply globally and have no code occurrences to sample.');
          }
          const intent = typeof policy.text === 'string' ? policy.text : '';
          const literal = (policy.assert && policy.assert.kind === 'forbid-added-literal' && typeof policy.assert.literal === 'string')
            ? policy.assert.literal
            : null;
          const caseSensitive = policy.assert ? policy.assert.caseSensitive !== false : true;

          let realRoot;
          try {
            realRoot = fs.realpathSync(cwd);
          } catch (err) {
            return adjErr(`policy_adjudication_prepare: workspace cwd is not accessible (${err.message}).`);
          }

          const candidates = adjCollectFiles(realRoot, policy.globs, anyGlobMatches);
          const sampled = [];
          let eligible = 0;

          if (literal != null) {
            for (const f of candidates) {
              let buf;
              try {
                buf = fs.readFileSync(f.abs);
              } catch (err) {
                console.error(`[adjudicate] read failed (${f.rel}): ${err.message}`);
                continue;
              }
              if (buf.length > ADJ_MAX_FILE_BYTES || !adjIsProbablyText(buf)) continue;
              const content = buf.toString('utf-8');
              const total = adjCountOccurrences(content, literal, caseSensitive);
              if (total === 0) continue;
              eligible += total;
              if (sampled.length < ADJ_SAMPLE_CAP) {
                const lines = content.split('\n');
                const lineStarts = adjLineStarts(content);
                const offsets = adjFindLiteralOffsets(content, literal, caseSensitive, ADJ_SAMPLE_CAP - sampled.length);
                let ord = 0;
                for (const off of offsets) {
                  const line1 = adjLineForOffset(lineStarts, off);
                  sampled.push({ id: adjOccId(f.rel, line1, ord), file: f.rel, line: line1, context: redact(adjContext(lines, line1)).text });
                  ord++;
                  if (sampled.length >= ADJ_SAMPLE_CAP) break;
                }
              }
            }
          } else {
            eligible = candidates.length; // occurrence == a matching file
            for (const f of candidates) {
              if (sampled.length >= ADJ_SAMPLE_CAP) break;
              let buf;
              try {
                buf = fs.readFileSync(f.abs);
              } catch (err) {
                console.error(`[adjudicate] read failed (${f.rel}): ${err.message}`);
                continue;
              }
              if (buf.length > ADJ_MAX_FILE_BYTES || !adjIsProbablyText(buf)) continue;
              const lines = buf.toString('utf-8').split('\n');
              const line1 = adjFirstRelevantLine(lines);
              sampled.push({ id: adjOccId(f.rel, line1, 0), file: f.rel, line: line1, context: redact(adjContext(lines, line1)).text });
            }
          }

          // Safety valve: keep the serialized bundle under ~1MiB (rarely triggers,
          // since 25 occurrences × capped lines is well under the cap).
          while (sampled.length > 1 && Buffer.byteLength(JSON.stringify(sampled)) > (ADJ_BUNDLE_MAX_BYTES - 16384)) {
            sampled.pop();
          }

          const occIds = sampled.map((o) => o.id);
          const manifestHash = crypto.createHash('sha256')
            .update(`${policyId}\n${intent}\n${literal == null ? '\u0000null' : literal}\n${caseSensitive}\n${occIds.join(',')}`)
            .digest('hex').slice(0, 16);

          const bundle = {
            schema: 1,
            policyId,
            projectId: pid,
            intent,
            literal: literal == null ? null : literal,
            caseSensitive,
            occurrences: sampled,
            eligible,
            manifestHash,
            scannerVersion: ADJ_SCANNER_VERSION,
            promptVersion: ADJ_PROMPT_VERSION,
            createdAt: Date.now(),
            ephemeral: true,
          };
          const bundlePath = path.join(adjStore.adjudicationDir(dataDir(), pid), `bundle-${manifestHash}.json`);
          try {
            writeFileAtomic(bundlePath, JSON.stringify(bundle));
          } catch (err) {
            return adjErr(`policy_adjudication_prepare: failed to write the evidence bundle (${err.message}). Nothing to adjudicate.`);
          }

          return adjJson({ bundlePath, manifestHash, occurrenceCount: sampled.length, intent, note: ADJ_NOTE });
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_adjudication_prepare failed: ${err.message}` }] };
        }
      }

      case 'policy_adjudication_record': {
        try {
          const a = args || {};
          const policyId = typeof a.policyId === 'string' ? a.policyId.trim() : '';
          const manifestHash = typeof a.manifestHash === 'string' ? a.manifestHash.trim() : '';
          const verdictsJson = typeof a.verdictsJson === 'string' ? a.verdictsJson : '';
          if (!policyId) return adjErr('policy_adjudication_record: policyId is required.');
          if (!/^[0-9a-f]{6,64}$/i.test(manifestHash)) return adjErr('policy_adjudication_record: manifestHash is missing or malformed (expect the hex hash from policy_adjudication_prepare).');
          const pid = resolveProject(a);

          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const policyStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'policy-store.js'));
          const adjStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'adjudication-store.js'));

          const bundlePath = path.join(adjStore.adjudicationDir(dataDir(), pid), `bundle-${manifestHash}.json`);
          let bundle;
          try {
            bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
          } catch (err) {
            return adjErr(`policy_adjudication_record: evidence bundle for this manifestHash was not found or is unreadable (${err.message}). Re-run policy_adjudication_prepare.`);
          }
          if (!bundle || bundle.schema !== 1 || String(bundle.policyId) !== policyId || String(bundle.manifestHash) !== manifestHash) {
            return adjErr('policy_adjudication_record: the bundle does not match this policyId/manifestHash. Re-run policy_adjudication_prepare.');
          }
          const bundleOcc = Array.isArray(bundle.occurrences) ? bundle.occurrences : [];
          const occIds = new Set(bundleOcc.map((o) => o && o.id).filter(Boolean));

          let parsed;
          try {
            parsed = JSON.parse(adjStripFences(verdictsJson));
          } catch (err) {
            return adjErr(`policy_adjudication_record: verdictsJson is not valid JSON (${err.message}). Pass the auditor's raw JSON.`);
          }
          if (!parsed || typeof parsed !== 'object' || parsed.schema !== 1 || !Array.isArray(parsed.verdicts)) {
            return adjErr('policy_adjudication_record: verdictsJson must be { "schema": 1, "verdicts": [ … ] }.');
          }

          const LABELS = new Set(['likely_legitimate', 'likely_problem', 'uncertain']);
          const seen = new Set();
          const counts = { legit: 0, problem: 0, uncertain: 0, injectionSuspected: 0, total: 0 };
          for (const v of parsed.verdicts) {
            if (!v || typeof v !== 'object') return adjErr('policy_adjudication_record: a verdict entry is not an object; nothing persisted.');
            const id = typeof v.id === 'string' ? v.id : '';
            if (!occIds.has(id)) return adjErr(`policy_adjudication_record: verdict references an unknown occurrence id "${id}" (not in the bundle); nothing persisted.`);
            if (seen.has(id)) return adjErr(`policy_adjudication_record: duplicate verdict for occurrence id "${id}"; nothing persisted.`);
            if (!LABELS.has(v.label)) return adjErr(`policy_adjudication_record: verdict for "${id}" has an invalid label "${v.label}" (expect likely_legitimate|likely_problem|uncertain); nothing persisted.`);
            seen.add(id);
            counts.total++;
            if (v.label === 'likely_legitimate') counts.legit++;
            else if (v.label === 'likely_problem') counts.problem++;
            else counts.uncertain++;
            if (v.promptInjectionSuspected === true) counts.injectionSuspected++;
          }
          const missing = [...occIds].filter((id) => !seen.has(id));
          if (missing.length > 0) {
            const shown = missing.slice(0, 5).join(', ');
            return adjErr(`policy_adjudication_record: missing verdict(s) for occurrence id(s): ${shown}${missing.length > 5 ? ', …' : ''}; nothing persisted (exactly one verdict per occurrence is required).`);
          }

          const coverage = { sampled: bundleOcc.length, eligible: Number.isFinite(bundle.eligible) ? bundle.eligible : bundleOcc.length };
          const provenance = {
            scannerVersion: typeof bundle.scannerVersion === 'string' ? bundle.scannerVersion : ADJ_SCANNER_VERSION,
            promptVersion: typeof bundle.promptVersion === 'string' ? bundle.promptVersion : ADJ_PROMPT_VERSION,
          };
          // Best-effort: name the activation for the disposition (does NOT mutate it).
          const pol = policyStore.listVisible(dataDir(), { projectId: pid }).find((r) => r && String(r.id) === policyId);
          const activationId = pol && pol.activationId ? String(pol.activationId) : undefined;

          const record = { policyId, manifestHash, ts: Date.now(), counts, coverage, provenance };
          if (activationId) record.activationId = activationId;
          adjStore.saveDisposition(dataDir(), pid, record);

          const summary = {
            kind: 'llm-current-snapshot-occurrence-disposition',
            policyId,
            manifestHash,
            projectId: pid,
            counts,
            coverage,
            provenance,
            disclaimer: ADJ_DISCLAIMER,
          };
          if (activationId) summary.activationId = activationId;
          // Informational-only nudge when the current code looks mostly legitimate.
          // TEXT ONLY — this tool NEVER narrows globs/literals or deactivates a policy.
          if (counts.total > 0 && (counts.problem / counts.total) < 0.2) {
            summary.tuningRecommendation = ADJ_TUNING;
          }
          return adjJson(summary);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_adjudication_record failed: ${err.message}` }] };
        }
      }

      case 'policy_adjudication_report': {
        try {
          const a = args || {};
          const pid = resolveProject(a);
          const policyId = typeof a.policyId === 'string' && a.policyId.trim() ? a.policyId.trim() : undefined;
          const { dataDir } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'data-dir.js'));
          const adjStore = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'adjudication-store.js'));
          const dispositions = adjStore.listDispositions(dataDir(), pid, { policyId });
          return adjJson({
            kind: 'llm-current-snapshot-occurrence-disposition',
            projectId: pid,
            policyId: policyId || null,
            count: dispositions.length,
            disclaimer: ADJ_DISCLAIMER,
            dispositions,
          });
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `policy_adjudication_report failed: ${err.message}` }] };
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

  // Test/automation seam: expose the raw tool dispatcher so the capture ACK bridge
  // (capture_ack / capture_lesson → recordCaptureAck → capture-queue) can be driven
  // end-to-end without a live MCP transport. The SDK ignores extra instance props.
  server.handleTool = handleTool;
  return server;
}
