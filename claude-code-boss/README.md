# claude-code-boss

Plugin para Claude Code Desktop — **v1.3.2**

Sistema multi-agente com orquestração Boss, Brain KB, dashboard local, hooks pipeline e execução curada.

---

## Pré-requisitos

- [Claude Code Desktop](https://claude.ai/download)
- Node.js 20+
- (Opcional) Java 21+ para backend MCP Memory
- (Opcional) Ollama para embeddings locais via GPU

## Instalação

```bash
cd claude-code-boss
npm install
```

Registre o plugin:

1. Abra Claude Code Desktop
2. Vá em **Settings → Plugins → Add local plugin**
3. Aponte para `.claude-plugin/plugin.json` neste diretório

Configure a variável de ambiente obrigatória para os hooks:

```bash
# ~/.bashrc, ~/.zshrc ou ~/.profile
export CLAUDE_PLUGIN_ROOT="/caminho/para/claude-code-boss"
```

## Estrutura

```text
claude-code-boss/
├── .claude-plugin/
│   └── plugin.json            # Manifesto do plugin (versão canônica)
├── .mcp.json                  # Servidores MCP: boss-server + brain-server
├── agents/                    # 16 subagentes (.agent.md)
│   ├── octopus.agent.md       # Orquestrador principal (FAST/DELEGATE/MIXED)
│   ├── brain-*.agent.md       # Indexer, Retriever, Consolidator, Source-Researcher
│   ├── pipeline-executor.agent.md
│   └── ...
├── config/
│   ├── brain-config.json      # Provider de embedding, backend (local|mcp-memory), thresholds
│   ├── model-router.json      # Tiers billing-aware, multipliers, costSensitive por agente
│   ├── pipelines.json         # 4 pipelines declarativos (implement, bugfix, refactor, research)
│   └── hooks-config.json      # Configuração dos hooks (memoryRotate, curationGuard, etc.)
├── dashboard/
│   └── index.html             # SPA — 7 abas: Home/Models/Pipelines/Brain KB/Billing/Hooks/Logs
├── hooks/
│   └── hooks.json             # 6 eventos, 16 scripts registrados
├── scripts/                   # 29 scripts Node.js (zero deps extras para hooks)
│   ├── dashboard.js           # Servidor HTTP local com ring buffer de logs
│   ├── dashboard-start.js     # SessionStart: auto-start com PID-file idempotency
│   ├── brain-*.js             # Brain KB: store, index, graph, embedder, backend, CLI
│   ├── curation-guard.js      # PreToolUse: bloqueia/redireciona comandos curados
│   ├── model-router.js        # SessionStart: resolução de modelo billing-aware
│   ├── plugin-updater.js      # SessionStart: verifica GitHub Releases a cada 24h
│   ├── hook-logger.js         # Utilitário: append a .runtime/hook-errors.jsonl
│   └── sync-version.js        # Propaga versão para todos os arquivos de versão
├── servers/
│   ├── boss-server/           # MCP server: registro de subagentes e histórico
│   └── brain-server/          # MCP server v2: brain_search/store/related/count
├── skills/                    # 10 skills do Claude Code
├── package.json               # v1.3.2, scripts: test, version:sync
└── TASK-MAP.md                # Estado real de entrega (20 features, gaps documentados)
```

## Hooks Pipeline

Todos os hooks estão declarados em `hooks/hooks.json`. Eventos e scripts ativos:

| Evento | Script | O que faz |
| --- | --- | --- |
| SessionStart | `memory-rotate.js` | Rotaciona MEMORY.md quando >150 linhas |
| SessionStart | `session-whitelist.js` | Detecta ecossistema do projeto, popula whitelist |
| SessionStart | `model-router.js` | Resolve modelo via tiers billing-aware |
| SessionStart | `plugin-updater.js` | Verifica update disponível no GitHub |
| SessionStart | `dashboard-start.js` | Inicia dashboard (idempotente via PID-file) |
| PreToolUse | `curation-guard.js` | Bloqueia/redireciona comandos curados |
| PreToolUse | `discipline-guard.js` | Guardrails comportamentais |
| PreToolUse | `brain-retrieve.js` | Busca KB antes de Write/Edit/Bash |
| PostToolUse | `brain-submit.js` | Indexa outputs relevantes (>500 chars) |
| PostToolUse | `curation-detect.js` | Detecta outputs grandes para curação |
| UserPromptSubmit | `correction-detect.js` | Detecta sinais de correção/frustração |
| UserPromptSubmit | `lesson-inject.js` | Injeta lições relevantes do KB |
| UserPromptSubmit | `curation-backlog.js` | Verifica payloads pendentes em `detect-curation/` e instrui curação automática via curation-improver; cooldown de 5 turnos entre injeções; move payloads com >7 dias para `processed/orphaned/` |
| UserPromptSubmit | `brain-retrieve-prompt.js` | Busca KB semanticamente para o prompt |
| Stop | `pattern-detect.js` | Detecta padrões a cada 4 turnos |
| Stop | `refine-research.js` | Injeta lembrete de pesquisa (sempre ativo) |
| SubagentStart/Stop | `ack-tracker.js` | Rastreia subagentes ativos |
| SubagentStop | `cost-tracker.js` | Log de custo por agente/modelo |

## Brain KB

Base de conhecimento local com 3 layers:

1. **Storage** (`brain-store.js`) — SQLite via `better-sqlite3` + fallback JSON. Busca vetorial (cosine similarity JS, suficiente para <10K entradas), FTS keyword search
2. **Index** (`brain-index.js`) — Índice invertido de palavras-chave com TF scoring
3. **Graph** (`brain-graph.js`) — Grafo de citação com 6 tipos de aresta

**Providers de embedding** (configurável em `config/brain-config.json`):

| Provider | Config | Requisito | Custo |
| --- | --- | --- | --- |
| `transformers` (padrão) | `embedder.provider: "transformers"` | Zero — ONNX puro JS | Zero |
| `ollama` | `embedder.provider: "ollama"` | Ollama rodando localmente | Zero |
| `voyage` | `embedder.provider: "voyage"` | Chave API Voyage AI | ~$0.10/1M tokens |

**Backend alternativo MCP Memory** (Java 21+): veja `docs/UPGRADE-MCP-MEMORY.md`.

## Dashboard

Auto-iniciado no `SessionStart`. Acesse via URL impressa no log da sessão.

- **Porta**: dinâmica (0 → auto-assign, sempre `127.0.0.1`)
- **Auth**: token aleatório gerado no boot (salvo em `.runtime/dashboard.json`)
- **Logs tab**: ring buffer de 500 entradas + `hook-errors.jsonl` agregado. Auto-refresh a cada 2s, Copy JSON, Clear

## Versionamento

Fonte canônica: `package.json` → propagada via `sync-version.js` para:
- `scripts/plugin-version.json`
- `.claude-plugin/plugin.json`
- `README.md` (raiz do repo)
- `claude-code-boss/README.md` (este arquivo)

```bash
# Bump de versão
node scripts/sync-version.js 1.4.0

# Validar que todos estão em sincronia
node scripts/sync-version.js --check
```

> `servers/*/package.json` têm versão independente (são pacotes MCP separados, não o plugin em si).

## Desenvolvimento

```bash
npm test           # 22 testes de hooks
npm run version:sync  # Re-sincroniza versão sem bump
```

## Licença

[MIT](../LICENSE) — licença cobre todo o monorepo, incluindo este plugin e seus sub-pacotes.
