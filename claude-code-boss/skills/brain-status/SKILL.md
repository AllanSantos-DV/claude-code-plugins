---
description: Report real-time backend integration status — mode, connection, project, latency. USE FOR: checking if mcp-memory is connected, diagnosing backend issues, verifying which KB backend is active, understanding the current brain integration state. DO NOT USE FOR: general brain queries, changing backend configuration, embedding model selection.
---

# Brain Status — Backend Integration Monitor

## Purpose

Reports the real-time status of the backend integration between claude-code-boss and the MCP Memory Server (or local SQLite).

## Invocation

Run the command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/brain-status.js
```

Or read the dashboard endpoint:

```bash
curl -s http://127.0.0.1:<DASHBOARD_PORT>/api/brain/health
```

## Output Interpretation

| Field | Meaning |
|-------|---------|
| `mode` | `local` (SQLite) or `mcp-memory` (Java daemon) |
| `connected` | Whether the backend is reachable |
| `project` | Active project ID |
| `backend` | `sqlite` or `mcp-memory` |
| `details.transport` | `stdio` or `http` |
| `details.latency` | Round-trip ms to daemon (0 for local) |
| `details.error` | Failure reason when `connected: false` |

## Common Diagnostics

- **`connected: false` on mcp-memory** → Daemon is down or URL wrong. Check `~/.mcp-memory/run/daemon.json`.
- **`mode: local` when expecting mcp-memory** → User hasn't switched backend in the Dashboard. Verify `~/.claude/claude-code-boss/user-config.json` has `backend.type: "mcp-memory"`.
- **High latency** → Network delay to daemon, check if running remote.
- **`mode: unknown`** → brain-status.js failed to load config. Check file permissions.

## Related

- `brain-health.js` — Liveness probe (SessionStart/UserPromptSubmit hooks).
- `brain-backend.js` — Core backend facade (local ↔ mcp-memory routing).
- Dashboard → Brain → Backend Configuration tab.
