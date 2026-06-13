---
name: plugin-install
description: "**WORKFLOW SKILL** — Install, set up, and troubleshoot the claude-code-boss plugin on any machine. USE FOR: installing the plugin, fixing 'plugin only works on the author's machine', missing node_modules, better-sqlite3 / node-gyp / 'gyp ERR' / Visual Studio Build Tools errors, 'brain not working', SQLite backend issues, embedding model not downloaded, patterns not becoming skills / recurrence stuck, semantic search not working, checking Node version, CLAUDE_PLUGIN_ROOT setup, verifying the install. DO NOT USE FOR: opening the config dashboard (use config-dashboard), switching the embedder model (use embedder-switch), authoring new skills."
---

# Plugin Install & Troubleshooting — machine-agnostic

This plugin runs on **any machine with a modern Node on the system `PATH`** —
**no C/C++ build toolchain, no native compilation**. If someone reports "it only
works on your machine", it is almost always one of these, in order of frequency:

1. **No system Node on `PATH`** — Claude Code spawns plugin hooks and the Brain
   MCP server with bare `node`, resolved from your **system PATH**, *not* from the
   Node bundled inside Claude Desktop (anthropics/claude-code#66183, #35175). With
   no system Node, hooks silently no-op and the MCP server is DOWN (`spawn node
   ENOENT`).
2. **Missing `node_modules`** — the plugin was copied without its deps.
3. **Old Node without built-in `node:sqlite`** — Brain degrades to a JSON store.

All three are fixed below.

## Requirements

- **Node.js >= 22.13.0, installed on your system `PATH`** — the #1 cause of "it
  doesn't work on my machine". Claude Code does **not** use the Node bundled inside
  Claude Desktop to run plugin hooks or local MCP servers; it spawns bare `node`
  from your **system PATH** (anthropics/claude-code#66183, #35175). With no system
  Node: every hook silently no-ops and the Brain MCP server is **DOWN** (`spawn node
  ENOENT` in the host log; Settings → Extensions shows `Node.js: Not found`).
  - **Verify:** run `node --version` in a **fresh** terminal — expect `v22.13`+.
  - **Windows:** install the official Node MSI (it adds Node to PATH), then **fully
    quit Claude Code** (tray icon → Quit, and end any lingering process in Task
    Manager) **and reopen it** so it inherits the updated PATH.
  - The Brain KB also uses Node's built-in `node:sqlite` (no flag since 22.13 /
    23.4). On older Node the plugin still runs, but the Brain degrades to a slower
    JSON store (no metrics / dashboard count = 0).
- **Internet at install** — `npm install` (postinstall) downloads the embedding
  model (~100-200 MB, one-time) into a durable cache (`<CLAUDE_PLUGIN_DATA>/models/`).
  This is REQUIRED for semantic search **and** the pattern→skill learning loop
  (dedup→recurrence needs vectors). Keyword search works without it, but the loop
  will not advance.
- Claude Code Desktop.
- **No build toolchain / native compiler needed.** `better-sqlite3` is **not**
  required (only an optional legacy fallback). The embedder is pure JS/WASM.

## Install (clean path)

```bash
cd claude-code-boss
npm install
```

Then register the plugin and set the hooks env var.

**Set `CLAUDE_PLUGIN_ROOT`** (required by the hooks):

- **bash/zsh** (`~/.bashrc`, `~/.zshrc`, `~/.profile`):
  ```bash
  export CLAUDE_PLUGIN_ROOT="/absolute/path/to/claude-code-boss"
  ```
- **Windows PowerShell** (persisted for the user):
  ```powershell
  [Environment]::SetEnvironmentVariable("CLAUDE_PLUGIN_ROOT", "C:\path\to\claude-code-boss", "User")
  ```

Register in Claude Code Desktop: **Settings → Plugins → Add local plugin** →
point to `.claude-plugin/plugin.json`. Restart Desktop.

## Verify the install

Check which SQLite backend is active (run from `claude-code-boss/`):

```bash
node -e "console.log('sqlite backend =', require('./scripts/lib/sqlite-compat').getSqliteBackend())"
```

- `node:sqlite` → ideal (built-in, Node >= 22.13).
- `better-sqlite3` → fine (legacy native fallback is installed).
- `none` → no SQLite backend; the KB will use the JSON fallback. **Upgrade Node to >= 22.13** to fix.

Then confirm the Brain backend boots:

```bash
node scripts/brain-cli.js status
```

Verify the embedding model (powers semantic search + the learning loop):

```bash
npm run setup:brain   # downloads if missing, then verifies; a cache hit is fast
```

Expect `[brain-warm] OK — <model> (384-dim) ready`. If it fails, there is no
internet / HuggingFace is blocked — fix connectivity and re-run.

## Troubleshooting (the exact failures users hit)

| Symptom | Cause | Fix |
| --- | --- | --- |
| **All hooks silently no-op** and the Brain MCP server is **DOWN** (no `brain_search` / `capture_lesson`); host log shows `spawn node ENOENT`; Settings → Extensions shows `Node.js: Not found` | **No system Node on `PATH`.** Claude Code spawns hooks & MCP servers with bare `node` from the system PATH, not the Node bundled in Claude Desktop (anthropics/claude-code#66183, #35175) | Install **Node ≥ 22.13** so it lands on PATH (Windows: official MSI). Verify `node --version` in a **new** terminal. Then **fully quit Claude Code (tray + Task Manager) and reopen** so it inherits the new PATH. |
| **Windows:** a hook fails on a plugin path with spaces, or `${CLAUDE_PLUGIN_ROOT}` looks mangled / "No such file" | Old **shell-form** hooks were tokenized by a shell (on Windows, Claude Code runs shell-form hook commands through Git Bash, or PowerShell if Git Bash is absent) | Update the plugin to **>= 1.8.3** — hooks now use **exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/…"]`), which passes each path as one argument with **no shell tokenization on any platform**. |
| `Cannot find module …` / hooks do nothing | `node_modules` missing (e.g. plugin copied without deps) | `cd claude-code-boss && npm install` |
| `gyp ERR!`, `node-gyp`, `better-sqlite3 … not ok`, "needs Visual Studio Build Tools" | An **old** install pinned the native `better-sqlite3`. It is no longer required. | **Do NOT install Build Tools.** Update the plugin to the current version (uses `node:sqlite`) and/or upgrade Node to >= 22.13. The native module is optional. |
| "brain works but the dashboard/sqlite feature is off" | Node < 22.13 → no `node:sqlite` → JSON fallback (no metrics, dashboard count = 0) | Upgrade Node to >= 22.13, then restart. |
| Patterns never become skills / recurrence stuck at 1 / no semantic search | Embedding model not downloaded (offline at install, or the model cache was wiped with `node_modules`) | `npm run setup:brain` to fetch it. The model now lives in a **durable cache outside node_modules**, so it survives reinstalls. |
| `[plugin-setup] Embedding model warm FAILED` during install | No internet / HuggingFace blocked at install time | Non-fatal — keyword search still works. Fix connectivity, then `npm run setup:brain`. The model also fetches on first capture. |
| `Cannot find module '…/sharp-….node'` / embedder init fails with a `sharp` error | `@xenova/transformers` pulls a **native `sharp`** (hard, eager import in **all** versions — v2/v3/v4) and its prebuilt is missing — usually because deps were installed with `--ignore-scripts`, or the platform has no sharp prebuilt | `npm rebuild sharp` (re-fetches the prebuilt) or `npm install --include=optional`. **Never install with `--ignore-scripts`.** If your platform genuinely has no sharp prebuilt, set `embedder.provider` to `"ollama"` or `"voyage"` in `config/brain-config.json` — those need no native deps. |
| `ExperimentalWarning: SQLite is an experimental feature` on stderr | `node:sqlite` is a release candidate in current Node | Benign — it is suppressed internally for hooks; safe to ignore. |

## Key principle

Two hard prerequisites, both **runtime** (not build-time): **(1) Node ≥ 22.13 on
the system `PATH`** — Claude Code spawns hooks and MCP servers with bare `node`
from PATH, not its bundled runtime (anthropics/claude-code#66183); **(2) internet
once at install** for the embedding model. Neither requires a compiler.

The plugin must never require a **compiler or build toolchain** — SQLite is built
into Node, nothing is compiled. The embedding model **is** required (it powers
semantic search and the pattern→skill learning loop) and is downloaded
automatically at install; internet at install is a safe assumption since the
plugin itself was fetched online. When diagnosing, **prefer upgrading Node and
running `npm run setup:brain` over installing build tooling**.
