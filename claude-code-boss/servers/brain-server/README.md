# brain-server

The MCP server behind the **Brain** knowledge base — semantic search, lesson
capture, warm per-prompt retrieval, and web research — for the `claude-code-boss`
plugin.

> **Not standalone.** This package is only the MCP shell. All KB logic
> (`brain-store` / `brain-index` / `brain-graph` / embedder / `scope-sanitizer`)
> and the embedding model live under `CLAUDE_PLUGIN_ROOT` (the plugin itself). The
> server wires those into MCP tools and selects a transport — nothing more.

## Tools

| Tool | Purpose |
| --- | --- |
| `brain_search` | Semantic (vector) search with keyword fallback. `scope`: `both` (default — project + global `__user__`), `project`, or `user`. |
| `brain_store` | Persist a structured entry; vectorized (by `title+summary`) + inverted index + citation graph. |
| `capture_lesson` | In-loop curated lesson capture with inline admission control: a near-duplicate is **merged** (bumping `recurrence`) instead of duplicated. |
| `brain_related` | Citation-graph neighbours of an entry. |
| `brain_count` | Entry count for a project. |
| `brain_retrieve_context` | **Internal.** Warm per-prompt retrieval for the `UserPromptSubmit` hook: embeds the prompt on the already-loaded model, vector-searches behind the relevance gate, federates `__user__`, returns a compact `[BRAIN]` block (or empty). |
| `research_query` | Multi-source web research fan-out → aggregated findings with citations (`depth`: `quick` \| `thorough`). |
| `research_status` | Cache status for a prior research query. |

KB-mutating tools are serialized by an async mutex (`withLock`) so concurrent HTTP
sessions can't corrupt the process-singleton DB.

### Session Graph Engine (`graph_*`) — pure REST client

Seven additional tools give **fast repository exploration** (symbols · CALLS /
CONTAINS / IMPORTS edges · PageRank) by consuming the local **native-java memory
daemon**'s Session Graph Engine (`POST /api/v1/graph/{status|ingest|symbols|search|callers|references}`).

| Tool | Purpose |
| --- | --- |
| `graph_analyze` | **Primary entry point.** Ensure the graph is ready (reuse if indexed, index if not) → top-PageRank **hubs** + an optional **ContextBundle** for a `query`. The fast way to grok a huge repo without grepping file by file. |
| `graph_search` | Semantic seeds + N-hop neighborhood (CALLS/CONTAINS/IMPORTS) — a ContextBundle. Read-only. |
| `graph_symbols` | Hubs (no `query`) or a symbol by exact name. Read-only. |
| `graph_status` | Cheap read of index state (nodes/edges) — never indexes. |
| `graph_ingest` | Index / re-index (`refresh`) with a deadline; status-first (skips if already ready). |
| `graph_callers` | Inbound CALLS of a node id. Read-only. |
| `graph_references` | All refs (CALLS + CONTAINS + IMPORTS) of a node id. Read-only. |

Architecture — **client-pure, no Java embedded** (logic in `scripts/lib/graph/`):

- **Discovery** (`graph/daemon.js`): reads the daemon's self-announced registry
  `~/.mcp-memory/run/daemon.json`, health-checks it (`200`/`503` = alive), and reuses
  the URL. It **never spawns/manages the JAR** — that is native-java's own OS-autostart
  infra.
- **Fail-open**: when the daemon is offline these tools return an actionable message,
  never throwing to the host. They touch the **external daemon**, not the KB singleton,
  so they bypass `withLock` and the local/`mcp-memory` KB backend switch.
- **Path-authoritative**: the client sends only the `path`; the daemon derives `project_id`
  from it and **returns it on every response**, which the tools display. No client-side id
  derivation — that would risk drift vs the daemon's resolver and is unnecessary since the
  path is the single source of truth (so no `expected_project_id`, no spurious `ID_MISMATCH`).
- **Status-first**: reads never auto-ingest — if the graph isn't `ready` they guide the
  user to `graph_analyze`. Ingest fires only for `not_indexed`/`failed` (or `refresh`),
  and `ensureReady` polls with backoff + a deadline (never infinite); `429` returns the
  `Retry-After`.
- **Capability probe** (cached per daemon): a `404` on `/api/v1/graph` → the daemon is
  too old; the tool tells the user to update the native-java memory daemon (Graph API
  requires ≥ 2.23; validated live on 2.24.0).
- **Caveats surfaced honestly**: root guard (refuses disk-root/UNC/home before the daemon
  walks the filesystem); CALLS is Java-only in Cut 1 (empty on other languages = "not
  extracted", not "no callers"); client-side truncation of huge caller/reference lists by
  PageRank; an honest "0 nodes" explanation.

Default `root` = the session CWD (stdio); HTTP-daemon callers pass `root` explicitly.
Zero `.mcp.json` change — the tools ride this same brain-server registration. Fully
unit-tested against a mocked `fetch`/registry (no live daemon needed) in
`scripts/test-units.js`.

## Transports

The same MCP assembly (`lib/mcp-server.js` → `createBrainServer`) is served over two
transports, selected by CLI args.

### stdio (default — unchanged)

```bash
node index.js
```

One server per host connection (`StdioServerTransport`), spawned by Claude Code via
the plugin `.mcp.json`. `project` is inferred from the process CWD. This is the
historical behavior and the only path Claude Code uses.

### HTTP daemon (opt-in, additive)

```bash
node index.js --http [--port <N>] [--plugin-data <DATA_DIR>]
```

A single long-lived **stateful** StreamableHTTP daemon shared by N
workspaces/clients (one model load, one SQLite) instead of N stdio processes.

- **Port** is deterministic per data-dir (SHA → `49152`–`65535`) so two installs on
  one machine don't collide. Override with `--port` or `BRAIN_HTTP_PORT`.
- **`project` is required per request** — there is no CWD to infer from. A request
  without `project` is rejected (`PROJECT_REQUIRED`) rather than silently falling
  back to `'default'`; the `_db` / `_project` module singletons would otherwise
  collide across workspaces.
- `EADDRINUSE` on start → another daemon already owns the port; the process exits 0.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/mcp` | POST / GET / DELETE | token | StreamableHTTP MCP channel (session via `mcp-session-id`). |
| `/health` | GET | open | `{ pluginRoot, pid, ... }` — liveness + version checks. |
| `/shutdown` | POST | token | Graceful drain + close. |

### Auth (v1.19.1+)

`127.0.0.1` bind is not authorization: any local process — or a browser page via
DNS rebinding — could otherwise read/poison the KB or kill the daemon. Same
pattern as the dashboard:

- **Token**: generated at first boot, persisted at `<DATA_DIR>/brain-http.token`
  (next to the lock file, survives upgrades). Every same-user consumer reads it
  from disk and sends `Authorization: Bearer <token>` (or `X-Brain-Token`).
  Fix/override with `BRAIN_HTTP_TOKEN`. `/health` stays open so any version's
  supervisor can probe stale-vs-current.
- **Origin guard**: requests carrying a non-localhost `Origin` header are
  rejected with 403 (DNS-rebinding defense; native clients don't send Origin).

E2E coverage: `smoke/brain-http-auth.mjs` (local-only, like the other smokes).

## Auto-start & version swap

On every spawn, the stdio launcher best-effort starts the daemon (detached, survives
the host) via `lib/daemon-supervisor.js` → `ensureDaemon`, comparing the `pluginRoot`
reported by `/health`:

- **current** (same `pluginRoot`) → no-op;
- **stale** (different `pluginRoot` = older code after a plugin upgrade) → graceful
  `POST /shutdown` (fallback `SIGTERM`), wait until gone, then start the new one;
- **absent** → start it.

It never throws into the stdio path — **the stdio server stays self-contained, so
Claude Code is never coupled to the daemon.** Disable entirely with
`BRAIN_HTTP_AUTOSTART=0`.

The lock/health file lives at `<DATA_DIR>/brain-http.lock.json` — in the persistent
data dir, **never** in the rotating plugin cache — so any version's launcher can find
the running daemon.

## Configuration

| Var / flag | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_PLUGIN_ROOT` | `../..` of `index.js` | Plugin root — where KB logic + the model live. |
| `CLAUDE_PLUGIN_DATA` / `--plugin-data <DIR>` | `~/.claude/plugins/data/claude-code-boss` | KB data dir (SQLite + models). |
| `BRAIN_HTTP_PORT` | deterministic per data-dir | Pin the daemon port (stable URL for external consumers). |
| `BRAIN_HTTP_TOKEN` | read/created at `<DATA_DIR>/brain-http.token` | Fix the auth token (containerized/remote-configured clients). |
| `BRAIN_HTTP_AUTOSTART` | `1` | `0` disables the launcher's daemon auto-start. |
| `--http` / `--port <N>` | — | Run the HTTP daemon / pin its port. |

> `${...}` env literals that some install contexts fail to expand are detected and
> replaced with sane defaults (see `valid()` in `index.js`).

## Migrating an external consumer (e.g. OpenCode)

To move a consumer off the rotating SHA cache onto a stable URL: pin
`BRAIN_HTTP_PORT`, then point the consumer at a remote MCP
`http://127.0.0.1:<port>/mcp`, passing an explicit `project` per call **and the
auth header** `Authorization: Bearer <token>` (token at
`<DATA_DIR>/brain-http.token`, or pin it via `BRAIN_HTTP_TOKEN`). Claude Code
keeps using stdio via the unchanged `.mcp.json`; both modes share the same SQLite.

## Dependencies

Only `@modelcontextprotocol/sdk` (resolved 1.29.0, ESM). The HTTP transport
(`StreamableHTTPServerTransport`) and its transitive `@hono/node-server` already ship
with the SDK — the daemon adds **zero new dependencies**.
