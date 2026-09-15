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

Default `root` = the daemon's per-request `project`/`cwd` argument (there is no
session CWD to infer from — see below).
Zero `.mcp.json` change — the tools ride this same brain-server registration. Fully
unit-tested against a mocked `fetch`/registry (no live daemon needed) in
`scripts/test-units.js`.

## Transport — HTTP daemon only (ADR-001 "daemon único")

There is exactly **one** mode: a single long-lived **stateful** StreamableHTTP
daemon on a **fixed port**, shared by every Claude Code session and any other
consumer on the machine (one model load, one SQLite):

```bash
node index.js [--port <N>] [--plugin-data <DATA_DIR>]
```

`.mcp.json` declares `brain-server` as a plain `"type":"http"` URL —
**no `command`, so Claude Code spawns nothing per session.** Every session is a
thin HTTP client of the one daemon:

```json
{
  "mcpServers": {
    "brain-server": { "type": "http", "url": "http://127.0.0.1:58217/mcp" }
  }
}
```

The daemon itself is ensured (found-or-started) by the `SessionStart` /
`UserPromptSubmit` hook `scripts/brain-daemon-ensure.js`, **before** Claude
Code's own MCP client tries to connect — that hook is ephemeral (runs, ensures,
exits), so it does not itself violate the daemon-único principle it exists to
serve.

- **Port is FIXED** (`58217` — override with `--port` or `BRAIN_HTTP_PORT`), not
  derived per data-dir, so `.mcp.json`'s static `url` can point at it directly.
- **`project` is required per request** — there is no CWD to infer from (the
  daemon serves every project on the machine). A request without `project` is
  rejected (`PROJECT_REQUIRED`) rather than silently falling back to `'default'`;
  the `_db` / `_project` module singletons would otherwise collide across
  workspaces.
- `EADDRINUSE` on start → another daemon already owns the port (the port itself
  is the singleton lock); the process exits 0.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/mcp` | POST / GET / DELETE | origin guard only | StreamableHTTP MCP channel (session via `mcp-session-id`). |
| `/health` | GET | open | `{ pluginRoot, pid, ... }` — liveness + version checks. |
| `/shutdown` | POST | token | Graceful drain + close (destructive — the only endpoint gated by a token). |

### Auth

`127.0.0.1` bind is not authorization on its own, but `.mcp.json`'s static
`url`/`headers` can't carry a runtime-generated secret, so `/mcp` cannot require
a token — Claude Code's own MCP HTTP client sends none. Instead:

- **`/mcp` — origin guard only**: requests carrying a non-localhost `Origin`
  header are rejected with 403 (DNS-rebinding defense — a browser page always
  sends `Origin`; Claude Code's native MCP client and other same-machine
  processes don't). `Origin: null` and host-suffix lookalikes
  (`127.0.0.1.evil.com`, `localhost.evil.com`) are also rejected.
- **`/shutdown` — token required**: this is a destructive action never invoked
  by Claude Code's own client. Token generated at first boot, persisted at
  `<DATA_DIR>/brain-http.token` (next to the lock file, survives upgrades).
  Fix/override with `BRAIN_HTTP_TOKEN`.
- `/health` stays fully open so any version's supervisor can probe
  stale-vs-current.

**Trust boundary (accepted limit):** dropping the token on `/mcp` moves it from
*same-OS-user* (token file ACL, mode 0600) to *any process that can reach
loopback* — including a different OS user, and untrusted content served from a
localhost origin (e.g. something previewed through `http://localhost:<port>` on
a dev server). Browser **cross-origin** reads stay closed: the daemon emits no
`Access-Control-Allow-Origin`, and non-simple MCP `POST`s require a CORS
preflight that fails without it. What remains is a local, loopback-only,
**machine-trust** boundary — an accepted trade, not a silent one. Do not bind
the daemon off `127.0.0.1` without re-adding a real auth layer.

E2E coverage: `smoke/brain-http-auth.mjs` (local-only, like the other smokes) —
asserts the CURRENT contract: foreign/`null` Origin → 403 on `/mcp`;
tokenless `/mcp` MCP handshake → works (origin guard only); `/shutdown`
without token → 401, with token → 200.

## Auto-start & version swap

`scripts/brain-daemon-ensure.js` (the SessionStart/UserPromptSubmit hook) calls
`lib/daemon-supervisor.js` → `ensureDaemon`, probing the fixed port's `/health`
and the shared lock file:

- **current** (same `pluginRoot`) → no-op;
- **shared** (daemon owned by a DIFFERENT install that still exists on disk) →
  no-op with a note — never shut a daemon another live install depends on
  (swapping would drop that install's live MCP sessions and make two installs
  thrash on every session start);
- **stale** (daemon's `pluginRoot` no longer exists on disk = install
  moved/removed, or the migration case: a pre-fixed-port daemon still on the old
  hash-derived port, identified by the lock file's `pid`+`port`) → graceful
  `POST /shutdown` (SIGTERM only after a live `/health` confirmed the pid),
  wait until gone, then start the new one;
- **absent** → start it (detached, survives the host);
- **port squatted by an UNKNOWN process** (something answers HTTP but not brain
  `/health`) → reported as an error (the hook surfaces an advisory), and the
  alien process is never signaled — the machine then has a loud, actionable
  failure instead of a silent outage with zero diagnostics.

Fail-open — any error just means that session's first KB tool call can fail and
retry on a later prompt; the hook must never block session start. Disable
auto-start entirely with `BRAIN_HTTP_AUTOSTART=0`.

The lock/health file lives at `<DATA_DIR>/brain-http.lock.json` — in the persistent
data dir, **never** in the rotating plugin cache — so any version's ensure-hook can
find the running daemon.

## Configuration

| Var / flag | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_PLUGIN_ROOT` | `../..` of `index.js` | Plugin root — where KB logic + the model live. |
| `CLAUDE_PLUGIN_DATA` / `--plugin-data <DIR>` | `~/.claude/plugins/data/claude-code-boss` | KB data dir (SQLite + models) — one **global** dir per machine, not per-project. |
| `BRAIN_HTTP_PORT` | `58217` | Pin the daemon port (must match `.mcp.json`'s `url`). |
| `BRAIN_HTTP_TOKEN` | read/created at `<DATA_DIR>/brain-http.token` | Fix the `/shutdown` auth token (containerized/remote-configured clients). |
| `BRAIN_HTTP_AUTOSTART` | `1` | `0` disables the ensure-hook's daemon auto-start. |
| `--port <N>` | — | Pin the daemon's listening port. |

> `${...}` env literals that some install contexts fail to expand are detected and
> replaced with sane defaults (see `valid()` in `index.js`).

## Consuming from outside Claude Code (e.g. OpenCode)

Point any other same-machine MCP client at `http://127.0.0.1:58217/mcp`
(override the port via `BRAIN_HTTP_PORT` if pinned differently), passing an
explicit `project` per call. No auth header needed for `/mcp` — only `/shutdown`
requires `Authorization: Bearer <token>` (token at `<DATA_DIR>/brain-http.token`,
or pin it via `BRAIN_HTTP_TOKEN`). Claude Code and any external consumer share
the same daemon and the same SQLite.

## Dependencies

Only `@modelcontextprotocol/sdk` (resolved 1.29.0, ESM). The HTTP transport
(`StreamableHTTPServerTransport`) and its transitive `@hono/node-server` already ship
with the SDK — the daemon adds **zero new dependencies**.
