# mcp-bootstrap

Brings up the local **mcp-memory** server for a plugin: finds Java 21+, downloads the
server jar (checksum verified), installs the launcher and starts the server through it
(native-java ADR-023 — never `java -jar` to serve). Node core only; no config, state or
lock of any plugin.

| File | What it does |
|---|---|
| `install.js` | `ensureLocalDaemon(mcpCfg, emit)` — the whole local bring-up; also `checkJava`, `downloadServerJar`, `ensureJar` |
| `launcher.js` | runs / installs / kicks the launcher `~/.mcp-memory/bin/mcp-memory-daemon` |
| `release-resolver.js` | newest `mcp-memory-server-X.Y.Z.jar` + its sha256 from the public releases repo |
| `registry.js` | daemon URL from `~/.mcp-memory/run/daemon.json` |
| `file-hash.js` | streamed sha256 of a file |
| `run-hidden.vbs` | windowless launcher start on Windows |
| `sync.js` + `MANIFEST.json` | keep copies identical to upstream |

```js
const { ensureLocalDaemon } = require('./mcp-bootstrap/install.js');
const { url, version } = await ensureLocalDaemon({}, (step, status, detail) => console.log(step, status, detail));
```

## Upstream and copies

Upstream is `claude-code-boss/scripts/lib/mcp-bootstrap/` in
`AllanSantos-DV/claude-code-plugins`. Another plugin **copies the whole folder** as-is
and never edits it in place — a change goes upstream first, then is copied again.

- **Upstream**, after editing any file here: `node sync.js stamp` (the claude-code-boss
  unit tests fail while `MANIFEST.json` is stale).
- **A copy**, in its CI:
  ```
  node <path>/mcp-bootstrap/sync.js check --upstream https://raw.githubusercontent.com/AllanSantos-DV/claude-code-plugins/main/claude-code-boss/scripts/lib/mcp-bootstrap/MANIFEST.json
  ```
  Fails (exit 1, files listed) if the copy was edited or is behind upstream `main`.
