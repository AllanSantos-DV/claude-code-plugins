# AGENTS.md — Project Conventions

Conventions for any agent (human or AI) working in this repo.

## Scope split: what goes in git vs. what stays local

This is a **strict convention**. Violating it pollutes the public repo with developer-specific state and breaks reproducibility for contributors.

### In git (versioned, shared)
- `claude-code-boss/` — the plugin itself (source, tests, configs)
- `.claude-plugin/marketplace.json` — marketplace metadata
- `.github/` — CI/release workflows, issue templates
- `README.md`, `LICENSE`, `AGENTS.md`, `.gitignore`
- Anything required for CI, publishing, or other contributors to build/test the plugin

### NEVER in git (always local-only, gitignored)
- **Dev tooling scripts** → `.claude/scripts/`
  - Example: `install-local.mjs` (force-installs HEAD into CC Desktop cache)
  - Anything that automates *your* dev loop, not the plugin's build/CI
- **Slash commands** → `.claude/commands/`
  - Example: `release.md` (publishes release with smoke gate)
- **Planning / analysis** → `docs/plans/`, `docs/maps/`, `docs/research/`, `planos/`, `taskmap/`, `planning/`, `TASK-MAP.md`, `PLANOS.md`
  - Task analysis maps, design notes, exploration drafts
- **Smoke tests** → `smoke/`
  - End-to-end validation scripts run manually before releases
- **Runtime artifacts** → `claude-code-boss/.runtime/`, `.mcp-memory/`
- **Editor / OS junk** → `.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`

The `.gitignore` already enforces all the above. If you add a new dev workflow tool, **drop it under `.claude/scripts/`**, never in `scripts/` at the repo root.

## Why this matters

- **Contributors don't get your half-baked plans** as merge conflicts.
- **CI doesn't run your local-only scripts** by accident.
- **Public repo stays minimal** — easy to audit, easy to understand.
- **Your dev loop is yours** — slash commands, install scripts, task maps can evolve freely without PR review.

## Release flow

Use the slash command **`/release`** (defined in `.claude/commands/release.md`). It enforces:
1. Version bump committed
2. CI green
3. **Local install + smoke validation in Claude Code Desktop** (via `.claude/scripts/install-local.mjs`)
4. Only then: `git tag` + push

CI green ≠ plugin works. Smoke in real CC Desktop is the only end-to-end gate. Skipping it = releases that break for users (and auto-update propagates the damage).

## Plugin pages (vitrine + merge guard)

Every plugin in `marketplace.json` must ship a landing page at
`pages/<plugin>/index.html`. Freshness is enforced deterministically — **no AI,
no model quota** — by `.github/scripts/pages-guard.mjs`, which hashes each
plugin's sources (`plugin.json` + `README.md` + `CHANGELOG.md`, EOL-normalized so
Windows and CI agree) against `pages/<plugin>/.source-hash`.

- **CI gate** (`.github/workflows/pages-guard.yml`) runs on every PR/push to
  `main`. Mark it **required** in branch protection to hard-block stale merges.
- **Local gate** (`.githooks/pre-merge-commit`) mirrors the CI check. Enable it
  **once per clone**:
  ```
  git config core.hooksPath .githooks
  ```
- **When it blocks**, it points at the `vitrine` agent
  (`.github/agents/vitrine.agent.md`). Run that agent to (re)draw the page(s),
  then it seals the hash:
  ```
  node .github/scripts/pages-guard.mjs stamp <plugin>
  node .github/scripts/pages-guard.mjs check   # must print OK
  ```
- Editing a plugin's `README`/`CHANGELOG`/`plugin.json` **drifts the hash** →
  merge blocked until the page is redrawn and re-stamped. Only the `vitrine`
  agent writes under `pages/`; never hand-edit `.source-hash`.

## Coding rules in the plugin

- **No empty `catch {}`** — CI greps and fails.
- **No `catch { return X; }` without logging** — CI greps and fails (use `console.error` or `void err;` before return).
- **Run `node claude-code-boss/scripts/sync-version.js --check`** before any release commit — CI enforces version alignment across `package.json`, READMEs.
- **Hooks**: see `lint-catch-brain` skill and `claude-code-boss/CHANGELOG.md` v1.4.0 entry for correct `hookSpecificOutput` format.
