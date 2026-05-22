---
name: config-dashboard
description: "**WORKFLOW SKILL** — Local plugin configuration dashboard. USE FOR: opening the config UI, viewing/changing model-router, brain-config, pipelines, hooks, billing logs, searching the knowledge base. DO NOT USE FOR: editing config files directly via Write tool when user asks for dashboard (use the dashboard instead), non-plugin configuration."
---

# Config Dashboard — Launch & Usage

When the user asks to open the config, dashboard, or settings UI, launch the dashboard server and tell them the URL.

## Launch Command

```bash
node scripts/dashboard.js
```

- The server picks a **random port** by default and prints the URL to stdout
- To use a **fixed port**: `$env:DASHBOARD_PORT=4500; node scripts/dashboard.js`
- The browser auto-opens on supported platforms (Windows/macOS/Linux)

## What to Tell the User

After launching, read the output for the URL (pattern: `http://localhost:<port>`) and tell the user:

> **Dashboard aberto em: http://localhost:XXXX**
>
> Abas disponíveis: Home, Models, Pipelines, Brain KB, Billing, Hooks

## When the User Asks

- **"Abre a config"** / **"Open dashboard"** → Run `node scripts/dashboard.js`, show the URL
- **"Quero ver os hooks"** → Launch dashboard and mention the Hooks tab
- **"Preciso mudar o model-router"** → Launch dashboard and mention the Models tab (has save button)
- **"Quero ver o que tem no brain"** → Launch dashboard and mention the Brain KB tab
- **"Dashboard já está rodando"** → Do NOT launch a second instance — ask which port it's on or check for running `node scripts/dashboard.js` processes
- **"Porta fixa"** → Suggest `$env:DASHBOARD_PORT=4500` before launching so the URL is predictable

## Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| Home | System overview: models, pipelines, KB stats, billing, hooks status |
| Models | View/edit model-router.json tiers and per-agent config |
| Pipelines | View pipeline definitions with expandable step details |
| Brain KB | Select project, search KB, view/delete entries, backend status |
| Billing | Cost tracker logs with agent filter |
| Hooks | View all registered hooks, toggle active/inactive |

## Port Strategy

- Default: random port (`listen(0)`) — read URL from stdout
- Fixed port: set `DASHBOARD_PORT` env var before launching
- When a port is already in use, the OS will reject `listen()` and Node.js will crash with `EADDRINUSE` — use a different port
