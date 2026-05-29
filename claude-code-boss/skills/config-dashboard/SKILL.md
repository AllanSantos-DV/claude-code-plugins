---
name: config-dashboard
description: "**WORKFLOW SKILL** — Local plugin configuration dashboard. USE FOR: opening the config UI, viewing/changing brain-config, hooks, searching the knowledge base. DO NOT USE FOR: editing config files directly via Write tool when user asks for dashboard (use the dashboard instead), non-plugin configuration."
---

# Config Dashboard — Launch & Usage

When the user asks to open the config, dashboard, or settings UI, launch the dashboard server and tell them the URL.

## Launch Command

**ALWAYS use the PowerShell tool (not Bash) on Windows to launch the dashboard.**

```powershell
cd "<plugin_root>"; $env:DASHBOARD_PORT=4500; Start-Process -NoNewWindow node -ArgumentList "scripts/dashboard.js" -PassThru; Start-Sleep 2; Write-Host "http://localhost:4500"
```

- Fixed port 4500 is recommended — random port requires reading stdout which is unreliable with background processes
- `Start-Process -NoNewWindow` keeps the server running detached from the current shell session
- **Do NOT use Bash `&` on Windows** — the process exits immediately (exit 0) and the server never starts
- **Do NOT use `$env:` syntax in the Bash tool** — that is PowerShell syntax, it will fail silently in Bash

## What to Tell the User

After launching, read the output for the URL (pattern: `http://localhost:<port>`) and tell the user:

> **Dashboard aberto em: http://localhost:XXXX**
>
> Abas disponíveis: Home, Brain KB, Hooks, Logs

## When the User Asks

- **"Abre a config"** / **"Open dashboard"** → Run `node scripts/dashboard.js`, show the URL
- **"Quero ver os hooks"** → Launch dashboard and mention the Hooks tab
- **"Quero ver o que tem no brain"** → Launch dashboard and mention the Brain KB tab
- **"Dashboard já está rodando"** → Do NOT launch a second instance — ask which port it's on or check for running `node scripts/dashboard.js` processes
- **"Porta fixa"** → Suggest `$env:DASHBOARD_PORT=4500` before launching so the URL is predictable

## Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| Home | System overview: KB stats, hooks status, uptime |
| Brain KB | Select project, search KB, view/delete entries, backend status |
| Hooks | View all registered hooks, toggle active/inactive; edit hooks-config + brain-config |
| Logs | Dashboard + hook error logs (ring buffer) |

## Port Strategy

- Default: random port (`listen(0)`) — read URL from stdout
- Fixed port: set `DASHBOARD_PORT` env var before launching
- When a port is already in use, the OS will reject `listen()` and Node.js will crash with `EADDRINUSE` — use a different port
