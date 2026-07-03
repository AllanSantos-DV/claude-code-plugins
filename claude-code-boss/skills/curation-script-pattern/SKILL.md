---
description: Pattern for curated shell scripts — output contract OK/FAIL, shells.json schema, refine-existing-first priority. Used when the Stop hook signals noisy commands need curation (in-loop, no subagent). Language-agnostic — scripts can be any executable (.mjs, .ps1, .sh, .py, etc.) as long as they honor the output contract.
---

# Curation Script Pattern

## When this skill applies

The `curation-stop.js` Stop hook injects `decision: 'block' + reason` when commands in the turn produced bulky output or leaked from a curated script. The reason tells you which to **refine** (existing) vs which to **create** (new). **Use this skill to act on that injection directly, in the main loop, without spawning subagents.**

You already have full turn context — don't reload payloads from disk; act on what just ran.

## Priority (in order)

1. **Refine existing**: if the Stop reason lists an existing script path, `Read` it first with the Read tool. Diagnose the actual cause of bulkiness from the script's source — never invent reasons. Then edit in place.
2. **Create new — prefer `curation_register_shell`**: when the Stop reason explicitly says "no existing script", call the `curation_register_shell({ id, scriptPath, content, aliases, ... })` MCP tool with the script's content (per the templates below) instead of using Write/Edit directly. The tool writes the script file and adds/updates its `shells.json` entry server-side in one call — this avoids the Auto Mode classifier blocking manual Write/Edit on `.vscode/scripts/**` and `shells.json` as "persistent configuration outside task scope". Calling it again with the same `id` updates the entry instead of duplicating it. Only fall back to manual Write + Edit of `shells.json` if this tool is unavailable (e.g. an older plugin install without it).
3. **Skip — one-hit**: if the command is one-shot or genuinely rare, call `curation_mark_oneoff({ sigs: [...] })` passing each `sig` shown in the Stop reason **verbatim** (exact store match — no alias guessing). The `aliases` param still works for raw command forms, but `sigs` is preferred. Marks made mid-retry are reconciled by the Stop hook and release the block immediately.

## What "curated" means here

Curated shell entries live in the shells config file (default: `.vscode/shells.json`, configurable via `hooks-config.json` → `curation.shellsConfigPath`). Each entry points to a **script** that wraps a raw command and **standardizes its output**. The LLM never sees raw verbose output: it sees the script's filtered summary.

- Success → exactly one line: `OK  <summary> (<N>ms)`
- Failure → relevant error lines + final line: `FAIL  <tool> (<N>ms)`

The `curation-guard.js` PreToolUse hook redirects raw commands (via `aliases`) to their curated script. Every script you create or refine is the **sole way** Claude will run that command in the project going forward — make it reliable and fast.

## Reason → Action

The Stop reason references entries with these `reason` tags. The reason text already separates **REFINE** entries (have an existing script path) from **CREATE** entries (no existing script). Map each tag to action:

| `reason` tag | Meaning | Action |
|---|---|---|
| `needs-curation` | Raw command (no curated match) exceeded volume threshold | **CREATE**: new script in the curated scripts dir + register in shells config |
| `curated-success-noisy` | Curated script ran OK but output > 3 lines / 500 chars | **REFINE**: Read the existing script, find the leak in its success path, fix it to emit only the `OK ... (Nms)` line |
| `curated-failure-noisy` | Curated script failed and dumped > raw threshold | **REFINE**: Read the existing script, fix its failure path to surface only relevant error lines + `FAIL ... (Nms)` |

## Output contract (hard rules — language-agnostic)

These rules apply regardless of script language:

- **Success** → exactly `OK  <summary> (<N>ms)` as the **last line**
- **Failure** → relevant error lines, then `FAIL  <tool> (<N>ms)` as the **last line**
- No banners, no progress bars, no full stdout dump on success
- Script's exit code must reflect underlying command's success/failure
- Script must be **idempotent** and **fast** — no caching, no side effects beyond the wrapped command

## Templates by language

### Node.js (`.mjs`) — use when project already uses Node

```javascript
#!/usr/bin/env node
// scripts/<name>.mjs — <description>
import { execSync } from 'child_process';

const start = Date.now();
try {
  const stdout = execSync('<command>', { encoding: 'utf-8', stdio: 'pipe' });
  const ms = Date.now() - start;
  const lines = stdout.trim().split('\n').filter(l => l.trim());
  const passCount = lines.filter(l => /✓|✔|pass|ok/i.test(l)).length;
  const failCount = lines.filter(l => /✗|✘|fail|error/i.test(l)).length;
  if (failCount > 0) {
    console.log(lines.filter(l => /✗|✘|fail|error/i.test(l)).join('\n'));
    console.log(`FAIL  <tool> (${ms}ms)`);
    process.exit(1);
  }
  console.log(`OK  ${passCount} passed (${ms}ms)`);
} catch (err) {
  const ms = Date.now() - start;
  const stderr = err.stderr?.toString() || '';
  const relevant = stderr.split('\n').filter(l => /error|fail|Error|FAIL/i.test(l));
  console.log(relevant.length > 0 ? relevant.join('\n') : stderr.slice(0, 1000));
  console.log(`FAIL  <tool> (${ms}ms)`);
  process.exit(1);
}
```

### PowerShell (`.ps1`) — use when project already uses PowerShell

```powershell
# scripts/<name>.ps1 — <description>
$start = Get-Date
try {
  $out = & <command> 2>&1 | Out-String
  $ms = [int]((Get-Date) - $start).TotalMilliseconds
  if ($LASTEXITCODE -ne 0) {
    $rel = ($out -split "`n" | Where-Object { $_ -match '(?i)error|fail' }) -join "`n"
    if ($rel) { Write-Output $rel } else { Write-Output $out.Substring(0, [Math]::Min(1000, $out.Length)) }
    Write-Output "FAIL  <tool> (${ms}ms)"
    exit 1
  }
  $passCount = ($out -split "`n" | Where-Object { $_ -match '(?i)pass|ok|✓' }).Count
  Write-Output "OK  $passCount passed (${ms}ms)"
} catch {
  $ms = [int]((Get-Date) - $start).TotalMilliseconds
  Write-Output $_.Exception.Message
  Write-Output "FAIL  <tool> (${ms}ms)"
  exit 1
}
```

### Bash (`.sh`) — use when project already uses Bash

```bash
#!/usr/bin/env bash
# scripts/<name>.sh — <description>
set -o pipefail
start=$(date +%s%3N)
out=$(<command> 2>&1)
ec=$?
ms=$(($(date +%s%3N) - start))
if [ $ec -ne 0 ]; then
  echo "$out" | grep -iE 'error|fail' | head -20
  echo "FAIL  <tool> (${ms}ms)"
  exit 1
fi
pass=$(echo "$out" | grep -ciE 'pass|ok|✓')
echo "OK  ${pass} passed (${ms}ms)"
```

### Python (`.py`) — use when project already uses Python

```python
#!/usr/bin/env python3
# scripts/<name>.py — <description>
import subprocess, sys, time, re
start = time.time()
r = subprocess.run(['<cmd>', '<args>'], capture_output=True, text=True)
ms = int((time.time() - start) * 1000)
out = r.stdout + r.stderr
if r.returncode != 0:
    rel = '\n'.join(l for l in out.splitlines() if re.search(r'error|fail', l, re.I))
    print(rel or out[:1000])
    print(f'FAIL  <tool> ({ms}ms)')
    sys.exit(1)
passes = sum(1 for l in out.splitlines() if re.search(r'pass|ok|✓', l, re.I))
print(f'OK  {passes} passed ({ms}ms)')
```

## Shells config entry format

```jsonc
{
  "id": "<short slug, unique>",
  "label": "<human label>",
  "script": "<path/to/script>",          // canonical field (any extension)
  "aliases": ["<raw command form 1>", "<raw form 2>"],
  "outputFilter": "summary|errors-only",
  "outputLines": 80,
  "timeoutMs": 600000
}
```

`aliases` is critical: any raw command form (`npm test`, `npm run test`, `pnpm test`, `npx vitest`) you want routed to this script must be listed, so `curation-guard.js` can redirect.

The matcher uses **substring containment** on `script`: any invocation that carries the script path in its command string matches automatically — `script.ps1`, `powershell -File script.ps1`, `node script.mjs`, `bash script.sh` all bind to the same entry without extra aliases.

## `outputFilter` cheatsheet

| Command type | outputFilter | outputLines | timeoutMs |
|---|---|---|---|
| test (vitest, jest, pytest) | `summary` | 80 | 600000 |
| build, bundle | `summary` | 60 | 300000 |
| lint, typecheck, tsc | `errors-only` | 50 | 120000 |
| dev, serve | `summary` | 200 | 300000 |
| format | `summary` | 30 | 60000 |
| probe, check | `errors-only` | 50 | 120000 |
| release, publish | `summary` | 100 | 900000 |

## Workflow when Stop reason fires

1. **Read the Stop reason** — it groups entries into REFINE (existing script path given) and CREATE (no script).
2. **For each REFINE entry**: `Read` the existing script. Find the actual leak source. Edit in place. **Never recreate** or invent reasons without reading.
3. **For each CREATE entry**: pick the language that matches existing scripts in the project. Author the script content per the template + contract, then call `curation_register_shell({ id, scriptPath, content, aliases, ... })` to write it and register it in one step. Only edit `shells.json` by hand if the tool is unavailable.
4. **Don't re-run the raw command to "verify"** — that would just trigger another curation cycle. Next invocation, `curation-guard.js` will route through your script.
5. Be terse — this is end-of-turn cleanup, not the main task.

## Hard rules

- **Read existing script before refining** — no fabrication
- **Match the project's existing language** — don't introduce `.mjs` into a `.ps1` project (or vice versa)
- **No npm/pip/cargo deps** for new scripts — use only the language's standard library
- **Don't hardcode project-specific paths** — let cwd come from execution context
- **`OK`/`FAIL` must be the last line** of output (success or failure)
- **Update shells config whenever** creating a new script
- **One-shot/rare commands** → skip explicitly, don't curate
