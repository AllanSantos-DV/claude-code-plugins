---
description: Pattern for curated `.mjs` shell scripts in `.vscode/scripts/` — output contract OK/FAIL, shells.json schema, outputFilter cheatsheet. Used when Stop hook signals noisy commands need curation (in-loop, no subagent).
---

# Curation Script Pattern

## When this skill applies

The `curation-stop.js` Stop hook injects a `decision: 'block' + reason` instructing you to create or refine curated `.mjs` scripts. The reason lists comandos com output volumoso ou scripts curados vazando. **Use this skill to act on that injection — directly, in the main loop, without spawning subagents.**

You already have full context of the turn (the commands ran in front of you). Don't re-read payloads from disk; act on what you saw.

## What "curated" means here

Curated shell entries in `.vscode/shells.json` point to `.mjs` scripts in `.vscode/scripts/`. Each script wraps a raw command and **standardizes its output** so the LLM never sees raw verbose output:

- Success → exactly one line: `OK  <summary> (<N>ms)`
- Failure → relevant error lines + final line: `FAIL  <tool> (<N>ms)`

The `curation-guard.js` PreToolUse hook **blocks raw commands** when a curated entry exists, forcing the model to use the `.mjs`. Every script you create is the SOLE way Claude will run that command in this project going forward.

This means:
- The script must be **reliable** — if it fails, Claude can't fall back to the raw command
- The script must be **fast** — Claude is waiting for its output
- The OK/FAIL last line is **critical** — Claude parses it

## Reason → Action

The Stop reason references entries with these `reason` tags. Each maps to a specific action:

| `reason` tag | Meaning | What to do |
|---|---|---|
| `needs-curation` | Raw command (not curated) exceeded volume threshold | Create new `.vscode/scripts/<name>.mjs` + add entry to `shells.json` |
| `curated-success-noisy` | Curated script succeeded but output > 3 lines / 500 chars | **Refactor existing script** to emit a 1-line `OK ... (Nms)` summary. The script is buggy: success path is leaking raw output. |
| `curated-failure-noisy` | Curated script failed and dumped > threshold output | **Refactor existing script's failure path** to surface only relevant error lines + `FAIL ... (Nms)`. Don't pipe the entire stderr. |

If a command is one-shot or rarely repeated, it's fine to skip — note that in your response and move on.

## `.mjs` template (cross-platform Node.js)

Use only built-in Node modules. No npm deps.

```javascript
#!/usr/bin/env node
// .vscode/scripts/<name>.mjs — <description>
import { execSync } from 'child_process';

const start = Date.now();
try {
  const stdout = execSync('<command>', { encoding: 'utf-8', stdio: 'pipe' });
  const ms = Date.now() - start;
  // Summarize, don't dump
  const lines = stdout.trim().split('\n').filter(l => l.trim());
  const passCount = lines.filter(l => /✓|✔|pass|ok/i.test(l)).length;
  const failCount = lines.filter(l => /✗|✘|fail|error/i.test(l)).length;
  if (failCount > 0) {
    const failures = lines.filter(l => /✗|✘|fail|error/i.test(l));
    console.log(failures.join('\n'));
    console.log(`FAIL  <tool> (${ms}ms)`);
    process.exit(1);
  } else {
    console.log(`OK  ${passCount} passed (${ms}ms)`);
  }
} catch (err) {
  const ms = Date.now() - start;
  const stderr = err.stderr?.toString() || '';
  const relevant = stderr.split('\n').filter(l => /error|fail|Error|FAIL/i.test(l));
  console.log(relevant.length > 0 ? relevant.join('\n') : stderr.slice(0, 1000));
  console.log(`FAIL  <tool> (${ms}ms)`);
  process.exit(1);
}
```

### Output contract (hard rules)

- **Success** → exactly `OK  <summary> (<N>ms)` — one line
- **Failure** → relevant error lines + `FAIL  <tool> (<N>ms)`
- The `OK`/`FAIL` line is always the **last line**
- No banners, no progress bars, no pass markers on success

## `shells.json` entry format

```json
{
  "id": "<uuid or short slug>",
  "label": "<descriptive label>",
  "type": "script",
  "command": ".vscode/scripts/<name>.mjs",
  "icon": "<codicon>",
  "aliases": ["<alternative raw command forms>"],
  "outputFilter": "errors-only",
  "outputLines": 50,
  "timeoutMs": 120000
}
```

`aliases` is critical: any raw form the user might type (`npm test`, `npm run test`, `pnpm test`) must alias to this entry, so `curation-guard.js` redirects them all.

## `outputFilter` cheatsheet

| Command type | outputFilter | outputLines | timeoutMs |
|---|---|---|---|
| test (vitest, jest) | `summary` | 80 | 600000 |
| build, bundle | `summary` | 60 | 300000 |
| lint, typecheck, tsc | `errors-only` | 50 | 120000 |
| dev, serve | `summary` | 200 | 300000 |
| format | `summary` | 30 | 60000 |
| probe, check | `errors-only` | 50 | 120000 |
| release, publish | `summary` | 100 | 900000 |

## Workflow when Stop reason fires

1. **Read the Stop reason** — it lists commands + their `reason` tags + line counts.
2. **For each command:**
   - Decide: legitimate one-shot? → skip with brief note.
   - Otherwise: create/refine the `.mjs` per the template.
3. **Update `shells.json`** with the new/changed entry.
4. **Don't re-run the raw command to "verify"** — that would just trigger another curation cycle. The next time Claude needs it, `curation-guard.js` will route through the `.mjs`.
5. Be terse — this is cleanup at end of turn, not the main task.

## Hard rules

- Scripts MUST be `.mjs` (Node.js, cross-platform), NOT `.ps1` or `.sh`
- No npm dependencies — use only Node built-ins (`child_process`, `fs`, `path`)
- Never hardcode project-specific paths — let `cwd` come from execution context
- The script's job is to **filter noise**, not to change behavior
- `OK`/`FAIL` must be the **last line** of output
- Always update `shells.json` when creating a new script
- One-shot/rare commands → skip explicitly, don't curate
