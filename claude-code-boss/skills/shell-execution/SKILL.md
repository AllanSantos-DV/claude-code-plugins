---
name: shell-execution
description: Curated shell execution protocol — how curation-guard (PreToolUse), curation-detect (PostToolUse), and curation-stop (Stop) work together to keep raw command output out of the context window. Language-agnostic — curated scripts may be .mjs, .ps1, .sh, .py, etc.
---

# Shell Execution (Curated)

## The Problem

Build commands (`npm test`, `cargo build`, `dotnet test`, `pytest`) produce massive output — progress bars, pass markers, timestamps, banners. Raw output wastes context tokens and drowns the real signal.

## The Solution

A 3-hook system that quietly curates shell commands. **No subagent** — everything stays in the main loop.

```
┌────────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│ curation-guard     │    │ curation-detect     │    │ curation-stop        │
│ (PreToolUse/Bash)  │    │ (PostToolUse/Bash)  │    │ (Stop)               │
│                    │    │                     │    │                      │
│ Routes raw cmds to │    │ Tracks commands that│    │ At end of turn, asks │
│ their curated      │    │ produced bulky      │    │ the main agent to    │
│ script when an     │    │ output or leaked    │    │ create new scripts   │
│ alias matches.     │    │ from a curated      │    │ or refine existing   │
│                    │    │ script.             │    │ ones (in-loop).      │
└─────────┬──────────┘    └──────────┬──────────┘    └──────────┬───────────┘
          │                          │                          │
          ▼                          ▼                          ▼
   redirects to script        appends to per-turn         decision:'block' +
   when alias matches         state file                  reason listing entries
                                                          to REFINE vs CREATE
```

## The Learning Loop

```
Turn 1 — first run, no curated entry yet
  → Guard: ALLOW (warns "no curated script, Stop hook will require one if bulky")
  → Command runs, output is 200 lines, 8 KB
  → Detect: appends entry to per-turn state, reason=needs-curation
  → Stop hook: emits decision:'block' + reason →
      "1 command produced bulky output. CREATE new script for `npm test`..."
  → Main agent (with full turn context) authors the script + shells config entry
  → Turn ends

Turn 2 — same command again
  → Guard sees `npm test` matches the alias of the new entry → redirect
  → Main agent runs the curated script instead
  → Output: "OK 312 passed (4523ms)" — 1 line. No bulk.
```

## Refine vs Create (priority order)

When the Stop reason fires, it **already separates** entries into two groups:

- **REFINE existing** — the reason gives the path of the existing script. You MUST `Read` it first with the Read tool, find the actual bulk source in the script's code, then edit in place. **Never invent reasons** like "script ignores args" without reading.
- **CREATE new** — only when the reason says "no existing script". Use the language **already in use** in the project's scripts dir (don't introduce `.mjs` into a `.ps1`-only project).

Details + templates: see `curation-script-pattern` skill.

## Script Output Contract (language-agnostic)

Every curated script — regardless of language — MUST follow this contract:

```
# Success
OK  <summary> (<N>ms)

# Failure — relevant errors only, no banners/pass markers
error: TS2345: Type 'X' is not assignable to type 'Y'
  at src/app.ts:12:3
FAIL  <tool> (<N>ms)
```

- **Last line** is `OK ...` or `FAIL ...` with timing in ms
- **Preceding lines**: only relevant content (errors, summary — no noise)
- **Exit code**: 0 = OK, non-zero = FAIL
- **stderr**: captured into the output stream

## How to Use Curated Scripts

### 1. Inspect existing entries

The shells config path is configurable via `hooks-config.json` → `curation.shellsConfigPath` (default `.vscode/shells.json`). To inspect:
```
Read tool → <projectRoot>/<shellsConfigPath>
```

### 2. If the guard redirects your command

When you see hook output like:
```
[curation-guard] Command `npm test` has a curated script. Run `.vscode/scripts/test.mjs` instead — output filtered (summary, limit 80 lines).
```
**Do NOT retry the raw command.** Invoke the curated script directly (the matcher recognizes any invocation form that carries the script path — `node script.mjs`, `powershell -File script.ps1`, `bash script.sh`).

### 3. Reading the result

- `OK 312 passed (4523ms)` → read the summary, done
- `FAIL ...` → read the error lines above the FAIL marker

### 4. If a curated script is wrong or outdated

Don't try to fix it inline during the Bash call. The Stop hook will fire and instruct you to refine it. Do the refinement at end of turn (or proactively `Read` it and edit if you already see the problem).

## Shells Config Schema (per entry)

```jsonc
{
  "id": "<unique slug>",
  "script": "<path/to/script>",          // any extension
  "aliases": ["<raw form 1>", "<raw form 2>"],
  "outputFilter": "summary|errors-only",
  "outputLines": 80,
  "timeoutMs": 600000
}
```

Matcher binds a command to an entry when either:
- the command string **contains** `script` (catches `script.ps1`, `powershell -File script.ps1`, `node script.mjs`, etc.), or
- the command **starts with** any `alias` (catches `npm test`, `pnpm test`, etc., redirecting them to the script)

## The Guard's Decision Logic

```
For every Bash command:

  1. Match the shells config?
       a. Command contains the registered `script` path  → ALLOW (already curated)
       b. Command starts with a registered alias         → DENY + redirect to script
  2. Whitelisted (git/gh/code or project additions)?      → ALLOW
  3. Trivial (ls/pwd/cat/echo)?                           → ALLOW
  4. Build tool (npm/cargo/dotnet/...)?                   → ALLOW + warn (learning loop)
  5. Unknown command                                      → ALLOW
       (or DENY if curationGuard.denyUnknown=true)
```

## denyUnknown mode

Set `curationGuard.denyUnknown: true` in `config/hooks-config.json` to deny anything not whitelisted/trivial/curated. Default `false`. Useful for locked-down environments; expect more denials and more curation work up front.
