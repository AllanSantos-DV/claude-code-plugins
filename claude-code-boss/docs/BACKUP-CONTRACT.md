# Backup contract — claude-code-boss ⇄ mcp-memory server

The dashboard's **Backup** card saves the plugin's local data into one `.tar.gz`
(`scripts/lib/backup.js`). When the plugin runs on the **mcp-memory** backend, the
server's own database must go into the same archive — and only the server can snapshot
it consistently (it owns the DB, WAL and all). The plugin side is ready
(`scripts/lib/backup-remote.js`); it lights up as soon as the server exposes the two MCP
tools below. Until then the archive says, explicitly, `remote.included: false` with the
reason, and the dashboard shows it.

## `backup_export`

Writes a consistent, self-contained snapshot of the server's data to a file the plugin
names (same machine).

Arguments:

| field | type | required | meaning |
|---|---|---|---|
| `destPath` | string | yes | absolute path of the file to create (the plugin's temp dir) |

Reply (JSON in the text content):

```json
{ "path": "<destPath>", "bytes": 123456, "sha256": "<hex>", "serverVersion": "2.46.0", "schemaVersion": 7 }
```

- Must be consistent while the daemon serves requests (e.g. `VACUUM INTO`).
- `sha256` of the file as written — the plugin verifies it before packing.
- On failure: `{ "error": "<message>" }` and no file (or a removed partial one).

## `backup_import`

Replaces the server's data with a snapshot produced by `backup_export` (possibly on
another machine).

Arguments:

| field | type | required | meaning |
|---|---|---|---|
| `srcPath` | string | yes | absolute path of the snapshot file |
| `mode` | string | yes | `"replace"` (only mode the plugin uses today) |

Reply:

```json
{ "restored": true, "documents": 1234, "serverVersion": "2.46.0" }
```

- Validate before touching anything (format, schema version — refuse a newer schema
  with a clear message), keep a pre-import copy, swap atomically, and roll back on error.
- On failure: `{ "error": "<message>" }`; the current data stays as it was.

## Archive layout (for reference)

```
backup.json                     manifest: format, version, items[] (path, kind, size, sha256), remote
data/...                        plugin data dir (SQLite stores snapshotted with VACUUM INTO)
global/user-config.json         brain backend settings
global/hooks/user-config.json   hooks profile
remote/mcp-memory.snapshot      the backup_export file, when included
```
