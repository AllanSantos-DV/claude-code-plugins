# Claude Code Plugins

Monorepo de plugins para [Claude Code Desktop](https://claude.ai/download) — desenvolvido por **Allan Santos**.

## Plugins

| Plugin | Versão | Descrição |
| --- | --- | --- |
| [claude-code-boss](./claude-code-boss) | 1.22.4 | Brain KB (busca semântica), execução curada (anti context-bloat) e aprendizado in-loop para Claude Code |

## O que é o claude-code-boss?

Plugin para Claude Code Desktop focado no que o nativo **não** entrega. A orquestração fica a cargo das ferramentas nativas (Agent/Workflow) — após o slim-down de 2026-05 a camada própria de orquestração foi removida.

O que está entregue:

- **Brain KB** — base de conhecimento local (SQLite + embeddings via Transformers.js/Ollama/Voyage), indexação automática de outputs relevantes, recuperação híbrida (vetor + keyword) com **rerank por decay** (relevância + recência + frequência + confiança), grafos de citação, servidor MCP com 7 tools — KB: `brain_search`, `brain_store`, `brain_related`, `brain_count`, `capture_lesson`; Web research: `research_query`, `research_status`
- **Aprendizado in-loop** — tool MCP `capture_lesson` para captura curada de lições no loop (sem reler transcript), com **admission control (A-MAC)** que mescla duplicatas e incrementa `recurrence`. Promoção curada de lições recorrentes a skills via `brain-promote.js`
- **Native Memory Indexing** — `brain-index-native.js` indexa a Auto Memory nativa (`~/.claude/projects/<cwd>/memory/*.md`) no Brain para busca semântica e cross-project que a camada nativa não oferece
- **Hooks pipeline (advisory)** — 5 eventos (SessionStart, PreToolUse, PostToolUse, Stop, UserPromptSubmit), ~9 scripts. Tom **informativo, não coercitivo**, com backpressure (cooldown + cap de contagem) para evitar context bloat
- **Execução curada (Shell Workbench)** — `curation-guard` bloqueia/redireciona comandos curados; `curation-detect` detecta outputs grandes; `session-whitelist` popula ecossistema no boot
- **Dashboard local** — servidor HTTP em `localhost` (porta dinâmica, token auth), **4 abas**: Home, Brain KB, Hooks, Logs. Lançado **sob demanda** (não auto-inicia mais no SessionStart). Ring buffer de 500 entradas + agregação de erros via `.runtime/hook-errors.jsonl`
- **Subagentes** — `brain-indexer` (haiku, pinned). Captura de lições/consolidação/refine/curation rodam **in-loop** via tool MCP `capture_lesson` e hooks Stop (`pattern-detect`/`curation-stop`/`refine-research`), sem subagentes dedicados

## Estrutura

```text
claude-code-plugins/
├── claude-code-boss/          # Plugin principal
│   ├── .claude-plugin/        # Manifesto do plugin (plugin.json)
│   ├── .mcp.json              # Servidor MCP: brain-server
│   ├── agents/                # subagentes (.agent.md)
│   ├── config/                # brain-config.json, hooks-config.json
│   ├── dashboard/             # index.html — SPA (4 abas)
│   ├── docs/                  # Guias de upgrade (Ollama, Voyage, MCP Memory)
│   ├── hooks/                 # hooks.json (5 eventos, ~9 scripts)
│   ├── scripts/               # Scripts Node.js (hooks + CLI + Brain + Dashboard)
│   ├── servers/brain-server/  # MCP server (Node.js ESM)
│   ├── skills/                # 5 skills do Claude Code
│   ├── package.json           # npm test, version:sync
│   └── CHANGELOG.md           # Notas de release
└── .github/workflows/ci.yml   # CI: test + lint + grep anti-patterns + version sync
```

## Instalação

> Requer Claude Code Desktop. Consulte [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code) para detalhes sobre a plataforma.
>
> **Node.js 22.13+ precisa estar no `PATH` do sistema.** O Claude Code dispara os hooks e o servidor MCP com `node` puro do **PATH do sistema**, não pelo Node embutido no Desktop ([claude-code#66183](https://github.com/anthropics/claude-code/issues/66183)). Sem Node no PATH, os hooks viram no-op e o Brain MCP fica DOWN (`spawn node ENOENT`). No Windows: instale o MSI oficial e reabra o Claude Code por completo (tray + Gerenciador de Tarefas).

```bash
# 1. Clone o repositório
git clone https://github.com/AllanSantos-DV/claude-code-plugins.git
cd claude-code-plugins/claude-code-boss

# 2. Instale dependências Node.js
npm install

# 3. Registre o plugin no Claude Code Desktop
#    No Claude Code, abra Settings → Plugins → Add local plugin
#    Aponte para: <caminho-do-repo>/claude-code-boss/.claude-plugin/plugin.json

# 4. Configure a variável de ambiente (necessária para os hooks)
#    No seu ~/.bashrc / ~/.zshrc / ~/.profile:
export CLAUDE_PLUGIN_ROOT="<caminho-do-repo>/claude-code-boss"
```

Veja [claude-code-boss/README.md](./claude-code-boss/README.md) para configuração detalhada, providers de embedding, e guias de upgrade.

## Licença

[MIT](./LICENSE)
