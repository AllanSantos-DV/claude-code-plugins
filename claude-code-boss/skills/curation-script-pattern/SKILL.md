---
description: Pattern for curated shell scripts — output contract OK/FAIL, shells.json schema, refine-existing-first priority. Used when the Stop hook signals noisy commands need curation (in-loop, no subagent). Language-agnostic — scripts can be any executable (.mjs, .ps1, .sh, .py, etc.) as long as they honor the output contract.
---

# Curation Script Pattern

## When this skill applies

The `curation-stop.js` Stop hook injects `decision: 'block' + reason` when commands in the turn produced bulky output or leaked from a curated script. The reason tells you which to **refine** (existing) vs which to **create** (new). **Use this skill to act on that injection directly, in the main loop, without spawning subagents.**

You already have full turn context — don't reload payloads from disk; act on what just ran.

## Priority (in order)

1. **Refine existing**: if the Stop reason lists an existing script path, `Read` it first with the Read tool. Diagnose the actual cause of bulkiness from the script's source — never invent reasons. Then rewrite it with `curation_register_shell` (same `id`, `scriptPath` and `aliases`, new `content`): the script lives in the user's curation folder, outside the project, where a direct Write/Edit raises permission prompts.
2. **Create new — use `curation_register_shell`**: when the Stop reason explicitly says "no existing script", call the `curation_register_shell({ id, scriptPath, content, aliases, passthrough, ... })` MCP tool with the script's content (per the templates below). `scriptPath` is just the file name (`npm-test.mjs`). The tool writes the script and its `shells.json` entry in one call; calling it again with the same `id` updates the entry instead of duplicating it.
3. **Skip — one-hit**: if the command is one-shot or genuinely rare, call `curation_mark_oneoff({ sigs: [...] })` passing each `sig` shown in the Stop reason **verbatim** (exact store match — no alias guessing). The `aliases` param still works for raw command forms, but `sigs` is preferred. Marks made mid-retry are reconciled by the Stop hook and release the block immediately.

## What "curated" means here

Curated scripts and their `shells.json` live **outside the project**, in the user's curation folder for it: `~/.claude/claude-code-boss/curation/<owner>/<repo>/` (keyed by the project id; `curation/local/<name>-<hash>/` for a folder without one). Nothing is written in the repo. A project that still has the old `.vscode/shells.json` + `.vscode/scripts/` is moved there automatically (backup kept, git-tracked scripts left in place and reported; a git-TRACKED shells.json is the team's, branch-scoped file — never moved, read in place). Each entry points to a **script** that wraps a raw command and **standardizes its output**. The LLM never sees raw verbose output: it sees the script's filtered summary.

The redirect runs the script with `CCB_PROJECT_ROOT` set to the project root: **find the project through that variable** (fallback `process.cwd()`), never through the script's own location (`__dirname/../..` now points into the curation folder).

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
- **Report the raw size** (success AND failure): when `CCB_RAW_REPORT` is set (the redirect sets it), append one JSON line `{"rawChars": <chars of the full raw output>, "rawLines": <lines>}` to that file. It is how the dashboard shows the EXACT tokens the script saved (raw − shown); without it only an estimate is possible. It never goes to stdout.

## Templates by language

### Node.js (`.mjs`) — use when project already uses Node

A **passthrough** script (register it with `passthrough: true`) runs `<command>` with whatever
arguments the redirect hands it, so every variant (`npm test -- --grep "a b"`) is covered by the
same script. The arguments must reach the command **exactly** — that is the whole safety premise:
- spawn WITHOUT a shell (`shell: false`): with `shell: true` Node joins the args unescaped and
  cmd.exe re-reads them (`"a b"` splits, `%h` expands);
- on Windows, a program that is a `.cmd`/`.bat` shim (`npm`, `npx`, `mvn`, `gradle`) cannot be
  spawned without a shell — write that passthrough in **Bash** instead (`"$@"` forwards each arg
  verbatim; see the Bash template).

```javascript
#!/usr/bin/env node
// <name>.mjs — <description> (passthrough: `<program> <subcommand> ...args`; <program> is a real
// executable such as git/node/python — for a Windows .cmd shim use the Bash template)
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';

const root = process.env.CCB_PROJECT_ROOT || process.cwd();
// Raw size for the dashboard's exact savings (never printed).
const report = (raw) => { if (process.env.CCB_RAW_REPORT) appendFileSync(process.env.CCB_RAW_REPORT, JSON.stringify({ rawChars: raw.length, rawLines: raw.split('\n').length }) + '\n'); };
const start = Date.now();
try {
  const stdout = execFileSync('<program>', ['<subcommand>', ...process.argv.slice(2)], { cwd: root, encoding: 'utf-8', stdio: 'pipe', shell: false });
  report(stdout);
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
  report((err.stdout?.toString() || '') + stderr);
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
  if ($env:CCB_RAW_REPORT) { Add-Content -Path $env:CCB_RAW_REPORT -Value (@{ rawChars = $out.Length; rawLines = ($out -split "`n").Count } | ConvertTo-Json -Compress) }
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
# <name>.sh — <description> (passthrough: `<command> "$@"` forwards every argument verbatim)
set -o pipefail
cd "${CCB_PROJECT_ROOT:-$PWD}" || exit 1
start=$(date +%s%3N)
out=$(<command> "$@" 2>&1)
ec=$?
[ -n "$CCB_RAW_REPORT" ] && printf '{"rawChars":%d,"rawLines":%d}\n' "${#out}" "$(printf '%s\n' "$out" | wc -l)" >> "$CCB_RAW_REPORT"
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
import subprocess, sys, time, re, os, json
start = time.time()
r = subprocess.run(['<cmd>', '<args>'], capture_output=True, text=True)
ms = int((time.time() - start) * 1000)
out = r.stdout + r.stderr
if os.environ.get('CCB_RAW_REPORT'):
    with open(os.environ['CCB_RAW_REPORT'], 'a', encoding='utf-8') as f:
        f.write(json.dumps({'rawChars': len(out), 'rawLines': out.count('\n') + 1}) + '\n')
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
  "outputChars": 8000,                   // optional; default = outputLines * 100
  "timeoutMs": 600000,
  "passthrough": true                    // optional: the script forwards its argv to the command
}
```

`script` is relative to the curation folder (`scripts/<name>.mjs`).

**`passthrough: true`** — the safe way to cover variants: a script that hands its arguments to
the command it curates receives every command that **starts with** one of its aliases, with the
remaining arguments and flags (`mvn test -Dtest=X -q` → `node mvn-test.mjs -Dtest=X -q`). The
same command runs, so nothing changes but the output. It never matches by similarity: `git -C
other log` is not `git log` + args, and a script that pins a flag (a "dry-run" wrapper) must
NOT be passthrough — forwarding `--ci` would change what it does. Leading `VAR=value`
assignments are kept on the rewritten command.

`outputLines` is **enforced**, not just a hint: on a successful run, output beyond
`outputLines` lines (or `outputChars` chars, default `outputLines * 100`) is flagged
`curated-success-noisy` by `curation-classifier.js`. Entries without `outputLines`
fall back to the tight summary budget (3 lines / 500 chars) — content-surfacing
scripts (log miners, `--full` dumps) must declare a realistic `outputLines` or every
legitimate run gets flagged.

`aliases` is critical: any raw command form (`npm test`, `npm run test`, `pnpm test`, `npx vitest`) you want routed to this script must be listed, so `curation-guard.js` can redirect.

**Aliases that add arguments** to the entry's shortest alias (`git stash list` over `git stash`) are only redirected when the entry has `"acceptsArgs": true`, and then the extra tokens are passed to the script (`node git-stash.mjs list`). Set it only if the script reads its argv; otherwise leave it out and the variant runs raw. Redirecting a variant to an argless call changed what the command did: `git stash list` once ran `git stash` and hid local changes.

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
