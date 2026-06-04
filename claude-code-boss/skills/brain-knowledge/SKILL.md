---
description: Knowledge Base — SQLite vector store with semantic search via Transformers.js (or Ollama/Voyage). Auto-indexed by hooks, auto-retrieved before every action. Scoped by project, searchable cross-project.
---

# Brain Knowledge Base

## What It Is

A **persistent knowledge base** with real semantic search (vector embeddings). All significant work (tests, builds, research, patterns, lessons) is automatically indexed and available for querying in future sessions.

## Stack

| Layer | Technology |
|-------|-----------|
| **Storage** | SQLite via better-sqlite3 |
| **Embeddings** | Transformers.js (default) — pure JS ONNX, 22MB model, 384-dim |
| **Alternatives** | Ollama (local GPU) or Voyage AI (cloud) — swap via 1 config line |
| **Vector search** | JS cosine similarity — <5ms for top-5 |
| **Hybrid search** | Vector + keyword + metadata combined |

## Flow

### Capture (in-loop, via tool)

```
user correction / reusable pattern
  → agent calls capture_lesson MCP tool (curated {title, summary, detail})
  → inline admission control (embed → cosine dedup → merge|store, recurrence++)
```
The Stop hook (`pattern-detect.js`) reminds the agent to capture; there is NO
automatic payload-scraping of command output (it was ~99% noise and burned tokens).

### Retrieval (automatic)

```
PreToolUse (Bash/Write/Edit) → brain-retrieve.js
  → command/path embedding → cosine sim on SQLite
  → hookSpecificOutput with top-5 relevant entries

UserPromptSubmit → brain-retrieve-prompt.js
  → query embedding → semantic search
  → hookSpecificOutput with relevant entries
```

## How to Use (for octopus)

### 1. When you see "Relevant entries" in hook output

The PreToolUse hook outputs something like:

```
[BRAIN-RETRIEVE] Top entries for "npm test":
1. "test:always-cleanup-mocks" (score: 0.89) — Always restore mocks in afterEach
2. "pattern:vitest-config-memory" (score: 0.72) — Increase --pool for memory
```

Read the entries. Use the knowledge without asking the user.

### 2. Capturing knowledge in-loop

When the user corrects you, or a reusable pattern/lesson emerges, call the
**`capture_lesson`** MCP tool yourself with a curated `{title, summary, detail}`.
You have full turn context — write the lesson directly (~1k tokens). The tool runs
admission control inline (dedup/merge → bumps `recurrence`, which drives skill
promotion). No subagent, no payload queue.

### 3. Manual deep search

If the hook returned nothing useful but you know knowledge exists on the topic:

1. Call the `brain_search` MCP tool directly (server: `brain-server`)
2. Pass `{ query, project, limit }`
3. Inspect the returned entries inline — no subagent hop needed

### 4. Cross-project search

To search neighboring projects, pass a different `project` to `brain_search`, or
inspect databases directly under:
```
~/.claude/projects/<project>/brain/brain.db
```

## Provider Upgrade

| Provider | Config | Dependencies |
|----------|--------|-------------|
| **Transformers.js** (default) | `"provider": "transformers"` | `npm install @xenova/transformers` |
| **Ollama** | `"provider": "ollama"` | Ollama installed + model pulled |
| **Voyage AI** | `"provider": "voyage"` | `VOYAGE_API_KEY` in environment |

To switch = edit `config/brain-config.json` → `embedder.provider`. The rest of the system doesn't change.
