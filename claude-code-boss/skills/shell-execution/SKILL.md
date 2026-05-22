---
description: Curated shell execution protocol — blocking mode, redirect flow, script output contract, and the learning loop from raw command to curated script. How the guard, detector, and improver work together.
---

# Shell Execution (Curated)

## The Problem

Build commands (npm test, cargo build, dotnet test) produce massive output — progress bars, pass markers, timestamps, banners. This wastes context tokens and distracts the LLM from real work.

## The Solution

A 3-layer system that automatically curates shell commands:

```
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│ curation-guard  │    │ curation-detect│    │ curation-improver  │
│ (PreToolUse)    │    │ (PostToolUse)  │    │ (subagent)         │
│ BLOCKS raw cmd  │    │ detects large  │    │ creates .mjs script│
│ when curated    │    │ output >5K/80L │    │ updates shells.json│
│ entry exists    │    │ writes payload │    │                    │
└──────┬──────────┘    └──────┬─────────┘    └────────┬─────────┘
       │                      │                       │
       │ denied + redirect    │ exceeds threshold      │ creates/updates
       ▼                      ▼                       ▼
   You run curated      detect-curation/         .vscode/scripts/*.mjs
   .mjs script          gets payload              + shells.json entry
```

## The Learning Loop

```
Step 1: You run "npm test" (raw, first time)
  → Guard: ALLOWED (no curated entry yet, but warned)
  → Script runs, output is 200 lines
  → Detect: writes payload "200 lines, npm test"
  → Improver: creates .vscode/scripts/test.mjs + shells.json entry

Step 2: You run "npm test" (next time)
  → Guard: DENIED + "use .vscode/scripts/test.mjs" 
  → You: run the .mjs script
  → Output: "OK 312 passed, 3 failed (4523ms)" — 1 line

Step 3: Test output changes (more failures)
  → Guard: ALLOWS .mjs script (it's the curated one)
  → Detect: output still under threshold → fine
```

## Script Output Contract

Every curated `.mjs` script MUST follow this contract:

```
# Success case
OK  <summary>  (<N>ms)

# Failure case — relevant errors only, no banners/pass markers
error: TS2345: Type 'X' is not assignable to type 'Y'
  at src/app.ts:12:3
FAIL  <tool>  (<N>ms)
```

- **Last line** is `OK ...` or `FAIL ...` with timing in ms
- **Preceding lines**: only relevant content (errors, summary — no noise)
- **Exit code**: 0 = OK, 1 = FAIL
- **stderr**: captured into error output, never printed separately

## How to Use Curated Scripts

### 1. Check if a curated entry exists

Look at `shells.json`:
```bash
cat .vscode/shells.json 2>/dev/null
```

### 2. If the guard denies your command

When you see hook output like:
```
[CURATION-GUARD] 🔒 Command "npm test" has a curated script. Run ".vscode/scripts/test.mjs" instead
```

**Do NOT retry the raw command.** Switch to the curated script:
```
bash "node .vscode/scripts/test.mjs"
```

### 3. Reading the result

- `OK 312 passed, 3 failed (4523ms)` → read the summary, check count
- `FAIL ...` → read the error lines above, understand the failure

### 4. If the curated script is wrong or outdated

- Do NOT try to fix it in the current Bash call
- The curation-improver subagent handles this when payloads exceed threshold
- Or you can manually spawn curation-improver: "Improve the curated test script"
- Or edit the .mjs file directly

## Common Curated Commands

| Raw command | Curated script | outputFilter |
|------------|----------------|-------------|
| `npm test`, `npx vitest ...` | `.vscode/scripts/test.mjs` | `summary` |
| `npx tsc --noEmit` | `.vscode/scripts/typecheck.mjs` | `errors-only` |
| `npx eslint .` | `.vscode/scripts/lint.mjs` | `errors-only` |
| `npm run build` | `.vscode/scripts/build.mjs` | `summary` |
| `cargo test` | `.vscode/scripts/cargo-test.mjs` | `summary` |
| `dotnet test` | `.vscode/scripts/dotnet-test.mjs` | `summary` |
| `go test ./...` | `.vscode/scripts/go-test.mjs` | `summary` |

## The Guard's Decision Logic

```
For every Bash command:

  1. Is it a .mjs script?                → ALLOW (already curated)
  2. Is there a shells.json entry?        → DENY + redirect to curated script
  3. Is it whitelisted (git/gh/code)?     → ALLOW
  4. Is it trivial (ls/pwd/cat/echo)?     → ALLOW
  5. Is it a build tool?                  → ALLOW + warn (learning loop)
  6. Unknown command                      → ALLOW
```

The blocking is intentional and safe:
- If a curated script exists, you SHOULD use it (that's why it was created)
- If no curated script exists, the command runs freely
- After the first run, if output was large, the system creates a script automatically
