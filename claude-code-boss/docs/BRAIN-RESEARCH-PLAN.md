# Brain Research — Execution Plan

> Port of VS Code copilot-delegate Brain Research to Claude Code.
> Base: `skills/brain-research/`, `agents/brain-*`, `servers/brain-server/`
> Date: 2026-05-22

---

## 1. Overview

### Problem
Knowledge generated during sessions (research, patterns, lessons, tasks) is lost between sessions. Claude Code has no persistent memory beyond `agent-memory/` (volatile, 200 lines).

### Solution
**Knowledge base with semantic search via embeddings** — scoped by project, auto-fed by hooks, auto-queried before every relevant action.

### Default Stack (Option A)
- **Storage**: SQLite via `better-sqlite3` (prebuilt binaries, zero compilation)
- **Embeddings**: `@xenova/transformers` with `all-MiniLM-L6-v2` (~22MB, 384-dim, pure JS ONNX)
- **Vector search**: JS cosine similarity against vectors stored as BLOB in SQLite
- **Re-rank**: LLM (`brain-retriever` subagent) for complex queries
- **Fallback**: Inverted keyword index when Transformers.js fails

---

## 2. Provider Abstraction — Embedding Engine

The system core is the **embedding interface**, which allows swapping providers via config without changing anything else:

```
┌──────────────────────────────────────────────────────────────────┐
│                    EmbeddingEngine (interface)                      │
│  embed(text: string) → number[]                                    │
│  embedBatch(texts: string[]) → number[][]                         │
│  getDimensions() → number                                          │
│  getStatus() → { provider, model, ready, error? }                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
            ┌────────────┐ ┌──────────┐ ┌──────────┐
            │ Option A   │ │ Option B │ │ Option C │
            │ Transformers │ │ Ollama   │ │ Voyage   │
            │ .js         │ │ (local)  │ │ (API)    │
            └────────────┘ └──────────┘ └──────────┘
```

### Option A: Transformers.js (DEFAULT — zero config)

```javascript
// scripts/brain-embedder.js (mode A)
import { pipeline } from '@xenova/transformers';

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction',
      'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

export async function embed(text) {
  const e = await getExtractor();
  const result = await e(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data); // [384 floats]
}
```

- **Setup**: `npm install @xenova/transformers` + auto model download on first run (~22MB, once only)
- **Performance**: ~50ms per embedding after warm cache
- **Offline**: 100% local, no API key, no internet required

### Option B: Ollama (manual upgrade — better quality)

```javascript
// scripts/brain-embedder.js (mode B)
import { execSync } from 'child_process';

export async function embed(text) {
  const result = execSync(
    `ollama run nomic-embed-text "${text}"`,
    { encoding: 'utf-8', timeout: 10000 }
  );
  return JSON.parse(result.trim());
}
```

- **Setup**: Install Ollama + `ollama pull nomic-embed-text`
- **Performance**: ~20ms via subprocess (GPU if available)
- **Offline**: Yes (Ollama runs locally)

### Option C: Voyage AI (manual upgrade — maximum quality)

```javascript
// scripts/brain-embedder.js (mode C)
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

export async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      model: 'voyage-4-lite',  // or voyage-code-2 for code
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}
```

- **Setup**: Get free API key at voyageai.com, set `VOYAGE_API_KEY`
- **Performance**: ~100ms (network)
- **Offline**: No (requires internet)

### Config — swap via 1 line

```json
// config/brain-config.json
{
  "embedder": {
    "provider": "transformers",   // "transformers" | "ollama" | "voyage"
    "model": "all-MiniLM-L6-v2",  // or "nomic-embed-text", "voyage-4-lite"
    "dimensions": 384             // changes per model
  }
}
```

The hook reads `config/brain-config.json` and loads the correct provider. **No other file needs to change.**

---

## 3. Final Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             Session                                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────────┐          │
│  │ Research  │  │ Task Done │  │ Pattern  │  │ Correction    │          │
│  │ (subagent)│  │ (octopus) │  │ Detected │  │ Detected      │          │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └──────┬────────┘          │
│       │              │              │               │                    │
│       ▼              ▼              ▼               ▼                    │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │                brain-submit.js (PostToolUse/Stop)          │           │
│  │  Writes payload to brain-pending/                         │           │
│  └─────────────────────────┬─────────────────────────────────┘           │
│                            │                                              │
│                            ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │                brain-indexer (subagent)                    │           │
│  │  1. Read payload                                           │           │
│  │  2. Generate: summary, tags, keywords, relations          │           │
│  │  3. Generate embedding via brain-embedder.js               │           │
│  │  4. Save entry + vector to SQLite                          │           │
│  │  5. Update inverted index + graph                          │           │
│  └─────────────────────────┬─────────────────────────────────┘           │
└────────────────────────────┼─────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Knowledge Store (SQLite)                           │
│                                                                           │
│  ~/.claude/projects/<project>/brain/brain.db                              │
│                                                                           │
│  Tables:                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ entries      │  │ embeddings   │  │ keywords     │  │ graph        │ │
│  │──────────────│  │──────────────│  │──────────────│  │──────────────│ │
│  │ id (PK)      │  │ entry_id (FK)│  │ entry_id (FK)│  │ from_id (FK) │ │
│  │ type         │  │ vector BLOB  │  │ keyword      │  │ to_id (FK)   │ │
│  │ project      │  │ dimensions   │  │ weight       │  │ type         │ │
│  │ session_id   │  │ model        │  │              │  │ weight       │ │
│  │ title        │  └──────────────┘  └──────────────┘  └──────────────┘ │
│  │ summary      │                                                       │
│  │ content JSON │                                                       │
│  │ tags JSON    │                                                       │
│  │ confidence   │                                                       │
│  │ created_at   │                                                       │
│  │ access_count │                                                       │
│  │ last_access  │                                                       │
│  └──────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────┼───────────────────────────────────────────┐
│                     Future Session                                        │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │                brain-retrieve.js (PreToolUse)              │           │
│  │  1. Get context (command, path, user question)           │           │
│  │  2. Generate embedding via brain-embedder.js             │           │
│  │  3. Cosine similarity against SQLite vectors (<5ms)      │           │
│  │  4. Top-5 entries → hookSpecificOutput                    │           │
│  └─────────────────────────┬─────────────────────────────────┘           │
│                            │                                              │
│                            ▼                                              │
│  Octopus sees relevant entries in context:                               │
│  → better decisions, no re-searching, no asking the user                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Semantic Search Flow

### Fast Search (inside hook — no LLM)

```
Input: context (Bash command, file path, user question)

1. Generate embedding via brain-embedder.js
2. SQLite: SELECT e.id, e.title, e.summary, e.type, e.confidence
          FROM embeddings em
          JOIN entries e ON e.id = em.entry_id
          WHERE e.project = ?
3. JS: cosine similarity between context vector and each entry vector
4. Sort by score, take top-5
5. Return as hookSpecificOutput

Total time: ~55ms (50ms embedding + 5ms similarity)
```

### Deep Search (with brain-retriever subagent)

```
When the hook returns >5 high-score candidates:

1. Octopus spawns brain-retriever
2. brain-retriever:
   a. Reads full entries (not just summaries)
   b. Re-ranks with LLM: "which of these is most relevant to X?"
   c. Returns top-3 with justification
3. Octopus uses entries in context
```

### Hybrid Search (vector + keyword + metadata)

```sql
-- Vector search (semantic)
SELECT e.id, cosine_sim(em.vector, ?query_embedding) AS score
FROM embeddings em
JOIN entries e ON e.id = em.entry_id

UNION

-- Keyword search (inverted index)
SELECT e.id, 0.5 AS score
FROM keywords k
JOIN entries e ON e.id = k.entry_id
WHERE k.keyword IN (?keywords)

UNION

-- Metadata filter (type + project)
SELECT e.id, 0.3 AS score
FROM entries e
WHERE e.type = 'pattern' AND e.project = ?project

-- Final: aggregate scores, top-N
ORDER BY score DESC
LIMIT 5
```

---

## 5. Provider Upgrade Path (documentation included)

The plan includes **3 upgrade documents** the user follows when switching providers:

| Provider | Upgrade doc | What to do |
|----------|-----------|------------|
| **A → B** (Transformers → Ollama) | `docs/UPGRADE-OLLAMA.md` | `npm uninstall @xenova/transformers`, install Ollama, change 1 config line |
| **A → C** (Transformers → Voyage) | `docs/UPGRADE-VOYAGE.md` | `npm uninstall @xenova/transformers`, get API key, set env var, change 1 line |
| **B ↔ C** (Ollama ↔ Voyage) | `docs/UPGRADE-VOYAGE.md` | Just change config — no installation needed |

Each document contains:
- **Prerequisites**: what to install/configure
- **Migration steps**: step by step
- **Re-index**: whether KB re-index is needed (dimension change → yes)
- **Rollback**: how to go back
- **Performance comparison**: expected latency vs previous

**Auto re-index**: if the provider changes dimensions (e.g., 384 → 1024), `brain-indexer` detects and **re-embeds** old entries on next run. No manual action needed.

---

## 6. Embedding Dimension Handling

Each embedding model has different dimensions. The system handles this automatically:

| Provider | Model | Dimension | Vector size |
|----------|--------|----------|-------------|
| Transformers.js | all-MiniLM-L6-v2 | 384 | 1.5KB |
| Ollama | nomic-embed-text | 768 | 3KB |
| Ollama | mxbai-embed-large | 1024 | 4KB |
| Voyage | voyage-4-lite | 1024 | 4KB |
| Voyage | voyage-code-2 | 1536 | 6KB |

The `embeddings` table in SQLite stores:
- `vector` (BLOB) — serialized Float32Array
- `dimensions` (INT) — vector dimension
- `model` (TEXT) — generating model

On search, the hook:
1. Loads vectors matching the current model's dimension
2. If dimension changed, notifies that re-index is pending
3. `brain-indexer` re-embeds on next run

---

## 7. SQLite Schema

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,           -- uuid
  type TEXT NOT NULL,            -- 'research' | 'pattern' | 'lesson' | 'task'
  project TEXT NOT NULL,         -- project name
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,         -- JSON: { detail, files, code? }
  source TEXT NOT NULL,          -- JSON: { agent, tool?, url? }
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  confidence REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT NOT NULL,
  -- Index
  FOREIGN KEY (project) REFERENCES projects(name)
);

CREATE TABLE embeddings (
  entry_id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,          -- Float32Array serialized
  dimensions INTEGER NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries(id)
);

CREATE TABLE keywords (
  entry_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (entry_id, keyword),
  FOREIGN KEY (entry_id) REFERENCES entries(id)
);

CREATE TABLE graph_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'references' | 'related' | 'contradicts' | 'supersedes'
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, type),
  FOREIGN KEY (from_id) REFERENCES entries(id),
  FOREIGN KEY (to_id) REFERENCES entries(id)
);

-- Indexes
CREATE INDEX idx_entries_type ON entries(type);
CREATE INDEX idx_entries_project ON entries(project);
CREATE INDEX idx_entries_created ON entries(created_at);
CREATE INDEX idx_keywords_keyword ON keywords(keyword);
```

---

## 8. Detailed Components

### Phase 1 — Embedding Engine + Storage (~2 days)

| # | File | Description |
|---|------|-------------|
| 1.1 | `scripts/brain-embedder.js` | Provider abstraction: init(), embed(text), embedBatch(), getDimensions(). Default: Transformers.js. Supports A/B/C via config. |
| 1.2 | `scripts/brain-store.js` | SQLite wrapper: init(), save(entry, vector), get(id), search(queryEmbedding, topN), delete(id), list(type, project) |
| 1.3 | `scripts/brain-index.js` | Inverted index management: index(entry, keywords), deindex(id), lookup(keywords) |
| 1.4 | `scripts/brain-graph.js` | Graph management: addEdge(from, to, type), getRelated(id), getCites(id), getCitedBy(id) |
| 1.5 | `config/brain-config.json` | Provider config + KB settings |
| 1.6 | Test: storage + embedding | Smoke test: embed → save → search → verify cosine score |

### Phase 2 — Submission Pipeline (~1 day)

| # | File | Trigger | Description |
|---|------|---------|-------------|
| 2.1 | `scripts/brain-submit.js` | PostToolUse (Bash) | After significant work, writes payload to `brain-pending/` |
| 2.2 | `agents/brain-indexer.agent.md` | Triggered by octopus | Reads payloads, generates summary+tags via LLM, calls embedder, saves to SQLite |
| 2.3 | `scripts/brain-embedder.js` (revisit) | Called by subagent | Generates embedding of content + summary |
| 2.4 | `skills/brain-knowledge/SKILL.md` | Skill | Teaches Claude the complete KB flow |

### Phase 3 — Retrieval Pipeline (~1 day)

| # | File | Trigger | Description |
|---|------|---------|-------------|
| 3.1 | `scripts/brain-retrieve.js` | PreToolUse (Write/Edit/Bash) | Generates embedding of command/path, cosine sim vs SQLite, top-5 → hookSpecificOutput |
| 3.2 | `scripts/brain-retrieve-prompt.js` | UserPromptSubmit | Generates embedding of query, searches KB, injects relevant entries |
| 3.3 | `agents/brain-retriever.agent.md` | Triggered by octopus | Deep search: LLM re-rank, multi-entry synthesis, top-3 with justification |
| 3.4 | `skills/brain-knowledge/SKILL.md` (update) | Skill | Adds retrieval section |

### Phase 4 — Final Integration (~1 day)

| # | File | Description |
|---|------|-------------|
| 4.1 | `hooks/hooks.json` | Add brain-submit (PostToolUse), brain-retrieve (PreToolUse), brain-retrieve-prompt (UserPromptSubmit) |
| 4.2 | `agents/octopus.agent.md` | Auto-trigger brain-indexer when payloads pending, brain-retriever route, skill reference |
| 4.3 | `agents/brain-consolidator.agent.md` (update) | Integrate with KB: read existing entries before consolidating |
| 4.4 | `agents/brain-source-researcher.agent.md` (update) | Integrate with KB: save findings as entries |
| 4.5 | `agents/pattern-analyzer.agent.md` (update) | Save detected patterns as KB entries |
| 4.6 | `agents/correction-analyzer.agent.md` (update) | Save lessons as KB entries |
| 4.7 | `docs/UPGRADE-OLLAMA.md` | Upgrade doc A → B |
| 4.8 | `docs/UPGRADE-VOYAGE.md` | Upgrade doc A → C |
| 4.9 | `servers/brain-server/index.js` (update) | MCP server uses brain-store instead of in-memory cache |
| 4.10 | `TASK-MAP.md` | Update |

---

## 9. npm Dependencies

```json
// Default (Option A)
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "@xenova/transformers": "^2.17.0"
  }
}
```

**better-sqlite3** has prebuilt binaries for Windows (x64/arm64), macOS (x64/arm64), Linux (x64/arm64) — zero compilation. `@xenova/transformers` is pure JS.

### Option B (Ollama)
```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
    // no @xenova/transformers
  }
}
// + Ollama installed on system
```

### Option C (Voyage)
```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
    // no @xenova/transformers
  }
}
// + VOYAGE_API_KEY in environment
```

---

## 10. Embedding Pipeline (inside brain-indexer subagent)

The embedding is NOT generated in the hook (which is pure Node.js without LLM). The hook writes payloads, and the **brain-indexer subagent** does the embedding:

```
1. Hook PostToolUse writes:
   brain-pending/submit-<ts>.json
   { command, output, files, sessionId }

2. lesson-inject.js detects payload, signals "Brain indexing pending"

3. Octopus spawns brain-indexer

4. brain-indexer:
   a. Read payload
   b. Generate summary + tags + keywords (LLM)
   c. Call brain-embedder.js (Node.js) to generate vector of content
   d. Call brain-store.js to save entry + vector
   e. Update inverted index
   f. Move payload to brain-pending/processed/

5. Octopus continues what it was doing
```

The embedding is generated **outside the hook**, in the subagent. The hook only writes/reads files. This keeps hooks lightweight (file I/O only, no LLM call).

---

## 11. What Will NOT Be Done (for now)

- **Cross-encoder reranker** — overkill for CLI. LLM re-rank is sufficient.
- **Citation graph visualization** — CLI has no UI.
- **Real-time embedding** — embedding is batch (subagent), not in the hook.
- **External vector index** (Pinecone, Weaviate) — SQLite + JS cosine similarity scales to ~10K entries.

---

## 12. Implementation Plan

| Phase | Duration | Files | Dependencies |
|-------|----------|-------|-------------|
| **Phase 1** — Embedding Engine + Storage | 2 days | 6 files | npm install |
| **Phase 2** — Submission Pipeline | 1 day | 4 files | Phase 1 |
| **Phase 3** — Retrieval Pipeline | 1 day | 4 files | Phase 1 |
| **Phase 4** — Final Integration | 1 day | 10 files | Phase 2 + 3 |
| **Total** | **~5 days** | **~24 files** | |

---

## 13. Risks and Mitigations

| Risk | Prob | Impact | Mitigation |
|------|------|--------|-----------|
| Transformers.js fails on Windows without GPU | Medium | Slow embedding (~200ms) | Fallback to inverted index; user can migrate to Ollama/Voyage |
| better-sqlite3 prebuilt doesn't work | Low | Broken setup | Fallback to JSON storage + full scan (slower but works) |
| KB grows >10K entries | Medium | Cosine sim becomes slow | Paginate search (top-100 at a time); archive entries >90 days |
| Knowledge duplication | High | Polluted KB | brain-indexer deduplicates by hash + cosine similarity >0.95 |
| User doesn't know KB exists | High | Underutilized system | skills + octopus auto-trigger; hookSpecificOutput reports "N entries indexed" |

---

## 14. Upgrade Docs (outline)

### UPGRADE-OLLAMA.md

```markdown
# Upgrade: Transformers.js → Ollama

Why switch? Ollama models (nomic-embed-text, mxbai-embed-large)
produce higher quality embeddings (~768-1024 dim vs 384).

## Prerequisites
- Ollama installed: https://ollama.com
- Model pulled: `ollama pull nomic-embed-text`

## Steps
1. `npm uninstall @xenova/transformers` (frees ~100MB)
2. Edit `config/brain-config.json`:
   ```json
   { "embedder": { "provider": "ollama", "model": "nomic-embed-text", "dimensions": 768 } }
   ```
3. Optional: `ollama pull mxbai-embed-large` (1024 dim, better quality)

## Re-index
Provider changed dimensions (384 → 768). brain-indexer detects
automatically and re-embeds old entries on next run.
No manual action needed.

## Rollback
1. `npm install @xenova/transformers`
2. Config → `"provider": "transformers"`
```

### UPGRADE-VOYAGE.md

```markdown
# Upgrade: Transformers.js → Voyage AI

Why switch? Voyage offers specialized models for code
(voyage-code-2) and multilingual support.

## Prerequisites
- API key: https://dash.voyageai.com (free tier: 50M tokens/month)

## Steps
1. `npm uninstall @xenova/transformers`
2. `export VOYAGE_API_KEY="your-token-here"`
3. Edit `config/brain-config.json`:
   ```json
   { "embedder": { "provider": "voyage", "model": "voyage-4-lite", "dimensions": 1024 } }
   ```

## Re-index
Provider changed dimensions (384 → 1024). Automatic.

## Rollback
1. `npm install @xenova/transformers`
2. Config → `"provider": "transformers"`
```
