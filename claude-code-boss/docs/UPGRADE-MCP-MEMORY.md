# UPGRADE-MCP-MEMORY — Pluggable Backend: Local SQLite \u2194 MCP Memory Server

## Overview

The Brain knowledge base supports two storage backends, configurable via **one line** in `config/brain-config.json`:

| Backend | Type | Description |
|---------|------|-------------|
| `local` (default) | SQLite + JSON fallback | Zero external deps, better-sqlite3, built-in embeddings via Transformers.js |
| `mcp-memory` | Native-java MCP Memory Server | Java 21 ONNX Runtime, multilingual (IBM Granite 107M), SIMD-optimized, 19 MCP tools |

## Switching Backends

Edit `config/brain-config.json` and change `backend.type`:

```json
{
  "version": 2,
  "backend": {
    "type": "mcp-memory",
    "mcpMemory": {
      "jarPath": "",
      "javaArgs": ["-Xmx512m"],
      "downloadUrl": "https://github.com/AllanSantos-DV/mcp-memory-server-releases/releases/download/v2.6.0/mcp-memory-server-2.6.0.jar",
      "timeout": 60000
    }
  }
}
```

Set `"type": "local"` to switch back to SQLite.

## Requirements for MCP Backend

1. **Java 21+** — check with `java -version`
2. **JAR file** — auto-downloaded on first use from `downloadUrl`, or place manually at the path specified in `jarPath`

## How It Works

**brain-backend.js** loads the config and routes all operations:

| Operation | Local Mode | MCP Mode |
|-----------|-----------|----------|
| `init()` | Inits store + index + graph + embedder | Connects to MCP server via stdio |
| `save(entry)` | Saves to SQLite + generates embedding + updates index | Calls `add_document` tool |
| `get(id)` | Reads from SQLite | Calls `get_document` tool |
| `search(text)` | Embeds text locally + vector search, fallback keyword | Calls `search_memory` tool (server embeds) |
| `delete(id)` | Removes from SQLite + index | Calls `delete_document` tool |
| `list()` | Lists from SQLite | Calls `list_documents` tool |
| `count()` | Counts in SQLite | Calls `summarize_memory` tool |
| `getRelated(id)` | Uses citation graph | Calls `get_related_documents` tool |

## MCP Client Architecture

`scripts/mcp-client.js` handles the full MCP lifecycle:

1. **Auto-download** — fetches JAR from GitHub releases if missing
2. **Java detection** — scans PATH + JAVA_HOME for Java 21+
3. **MCP handshake** — initialize \u2192 initialized notification \u2192 tools/list before first call
4. **JSON-RPC 2.0** — request/response matching via unique IDs, stdio transport
5. **Timeout handling** — configurable per-request timeout (default 60s)
6. **Graceful shutdown** — sends exit notification, kills process after 2s timeout

## Performance Considerations

| Metric | Local (SQLite) | MCP (Java+ONNX) |
|--------|---------------|-----------------|
| Embedding dims | 384 (MiniLM) | 107M (Granite) |
| Embedding quality | English-optimized | Multilingual |
| Vector search | JS cosine in loop | SIMD (AVX2/SSE) |
| First init | Instant | ~3-5s (JVM warmup) |
| KB size limit | ~10K entries | Higher (SQLite/PostgreSQL) |

## Migration Path

1. Keep `"type": "local"` for small projects and zero-dependency setup
2. Switch to `"type": "mcp-memory"` for larger KBs or multilingual needs
3. Data in one backend does NOT auto-migrate to the other
   - Use `brain-cli.js count` and `brain-cli.js list` to export from local
   - Switch backend, then re-import via `brain-cli.js save`

## Troubleshooting

- **Java not found**: Install JDK 21+, or set `JAVA_HOME` environment variable
- **JAR download fails**: Download manually from the releases URL and place at the `jarPath` location
- **MCP connection timeout**: Increase `mcpMemory.timeout` in config (default 60000ms)
- **Out of memory**: Adjust `mcpMemory.javaArgs` (e.g., `["-Xmx1g"]`)
- **SSL errors**: Ensure the download URL uses HTTPS
