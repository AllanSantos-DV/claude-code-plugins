# Changelog

## [1.4.0] — 2026-05-31

### Fixed — hooks correctness pass + MCP brain_store orphan bug

- **`curation-guard.js`** — hook output format was wrong: returned top-level
  `permissionDecision: "allowed"|"denied"` (silently ignored by Claude Code).
  Now returns the correct `hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "allow"|"deny", permissionDecisionReason }` per the official
  hooks reference. Auto-approve of whitelisted commands and deny of blacklisted
  ones likely never worked before. Also removed `pwsh`/`powershell`/`bash` from
  `BUILD_TOOLS` (those are shells, not build tools — were triggering false-positive
  warnings).
- **`brain-retrieve.js`** — `STOP_WORDS` was declared after its first use (TDZ).
- **`refine-research.js`** — rewritten with `EVERY=4` throttle via state file
  (matches `pattern-detect`'s pattern); removed dead ref to deleted `octopus.agent.md`;
  `stop_hook_active` anti-loop guard preserved.
- **`hook-logger.js`** — log rotation switched to probabilistic trim (~1%) instead
  of read+rewrite on every append (was O(n) per log line).
- **`hooks/hooks.json`** — explicit per-hook `timeout` (5–10s) replacing implicit
  defaults; better failure semantics.
- **`servers/brain-server/index.js` `brain_store` handler** — wrong call signatures:
  `kbIndex.index(id, keywords)` and `kbGraph.registerNode(id, type)` were silent
  no-ops (canonical signature is `(entry)`). Entries saved via MCP `brain_store`
  were **orphans** — not in the keyword index, not in the citation graph. Now
  builds embedding upfront and calls `save(entry, vector)` + `index(entry)` +
  `registerNode(entry)` in one pass. `capture_lesson` already used the correct
  signatures.
- **`README.md` (root)** — MCP tool count corrected from 5 to 7 (was omitting
  `research_query` and `research_status`).

### Tests

- `scripts/test-hooks.js` — 26/26 green, covers all hook events including
  `curation-guard` whitelist/blacklist/denyUnknown matrix and `refine-research`
  throttling.

### Added — Brain hygiene + in-loop learning (the differentiator)

- **Admission control (A-MAC)** in `brain-indexer` — admit/merge/skip gate; merge
  bumps a new `recurrence` column (migrated in place). Stops duplicate accumulation.
- **Rerank with decay** in `brain-store.search` — combined score (relevance +
  recency + frequency + confidence), Generative Agents pattern. Configurable via
  `kb.rerank`. Zero schema change.
- **Prune/eviction** (`brain-store.prune`) — graceful archive (not delete) to
  `entries_archive`; stale + over-capacity, utility = AMV-L/Priority Decay.
- **Native memory indexing** (`brain-index-native.js`) — indexes Claude's native
  Auto Memory (`~/.claude/projects/<cwd>/memory/*.md`) into the Brain for semantic
  + cross-project search the native layer lacks.
- **Skill promotion** (`brain-promote.js`) — recurring lessons → global skills
  (Voyager skill-induction); curated: scan→draft(staging)→approve. Never auto-spam.
- **`capture_lesson` MCP tool** — in-loop curated lesson capture with inline
  admission control. Replaces post-hoc transcript-parsing analyzers.

### Removed — token-villain cleanup

- **`pattern-analyzer` + `correction-analyzer` subagents** — re-read raw transcripts
  on a premium model (~50k/run, 96% noise). Replaced by in-loop `capture_lesson`
  (~200 tokens). `correction-detect`/`pattern-detect` are now lean advisory nudges
  (no transcript reading, no payloads). `brain-indexer` pinned to `haiku`.
- **`pattern-detection` skill** + its `hooks-config.json` keys (`patternDetect`,
  `correctionDetect`) — obsolete after the in-loop redesign.

### Changed — slim-down refactor (Brain + Curation focus)

O plugin foi reduzido ao que o Claude Code nativo **não** entrega. A camada de
orquestração (que reimplementava em prompt o Agent/Workflow nativo) foi removida;
ficaram **Brain KB** (busca semântica), **Curation** (anti context-bloat) e a
camada de **aprendizado** (captura advisory de padrões/correções).

- **Removidos (camada A — orquestração):** agente `octopus` (a main session volta
  ao loop nativo), `pipeline-executor`, os 7 agentes-clone (researcher, implementor,
  validator, reviewer, planner, debugger, documenter), `model-router` + `cost-tracker`
  + `ack-tracker` + `discipline-guard`, `boss-server` (MCP), configs
  `model-router.json` / `pipelines.json`, e skills `octopus-coordination`,
  `multidev-orchestration`, `pipeline-delegation`, `billing-awareness`,
  `code-review-standards`.
- **`settings.json`:** removido `"agent": "octopus"` — sem orquestrador próprio.
- **Camada B (aprendizado) — mantida e corrigida:** hooks agora são **advisory**
  (sem "MANDATORY/you MUST") com **backpressure** (cooldown + cap de contagem).
  `lesson-inject` foi fundido em `brain-retrieve-prompt` (injeção de lessons +
  advisory de pendências).
- **Dashboard:** enxugado para 4 abas (Home, Brain KB, Hooks, Logs); não auto-inicia
  mais no SessionStart (lançar sob demanda).
- **hooks.json:** de 6 eventos/15 scripts para 5 eventos/~9 scripts.

### Removed

- **`plugin-updater.js`** and **`plugin-version.json`** — custom plugin update mechanism removed.
  The root cause was a fixed `"version"` string in `plugin.json` that prevented the Claude Code
  native resolver from detecting new commits. Removing that field (D1) makes the official
  `/plugin update` command work correctly — no custom updater needed.

- **`install-local.js`** — replaced by `dev-claude.ps1` / `dev-claude.sh` wrappers that use
  the official `claude --plugin-dir <path>` flag for local development.

### Migration notes for existing installs

If you had a previous version of this plugin installed, you may have orphaned files in
`~/.claude/plugins/data/claude-code-boss/`. These are safe to delete manually:

```
~/.claude/plugins/data/claude-code-boss/updater.lock
~/.claude/plugins/data/claude-code-boss/plugin-update-check.json
~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```

To clean all at once (PowerShell):
```pwsh
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\updater.lock" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\plugin-update-check.json" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\.payload-cleaned" -ErrorAction SilentlyContinue
```

Bash/zsh:
```bash
rm -f ~/.claude/plugins/data/claude-code-boss/updater.lock \
      ~/.claude/plugins/data/claude-code-boss/plugin-update-check.json \
      ~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```
