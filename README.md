# Claude Code Plugins

Monorepo de plugins para [Claude Code Desktop](https://claude.ai/download) — desenvolvido por **Allan Santos**.

## Plugins

| Plugin | Versão | Descrição |
|--------|--------|-----------|
| [claude-code-boss](./claude-code-boss) | 1.3.2 | Sistema multi-agente: orquestração Boss, Brain KB, dashboard, hooks pipeline, execução curada |

## O que é o claude-code-boss?

Plugin para Claude Code Desktop que transforma o Claude num sistema multi-agente orquestrado. O que está **efetivamente entregue** (v1.3.2):

- **Orquestrador Boss** — roteamento FAST/DELEGATE/MIXED, 16 subagentes declarados em `.agent.md`, pipelines de 4 passos configuráveis
- **Brain Research KB** — base de conhecimento local (SQLite + embeddings via Transformers.js/Ollama/Voyage), indexação automática de outputs relevantes, recuperação híbrida (vetor + keyword), grafos de citação, servidor MCP v2 com 4 tools (`brain_search`, `brain_store`, `brain_related`, `brain_count`)
- **Dashboard local** — servidor HTTP em `localhost` (porta dinâmica, token auth), 7 abas: Home, Models, Pipelines, Brain KB, Billing, Hooks, **Logs** (novo em v1.3.2). Ring buffer in-memory de 500 entradas + aggregação de erros de hooks via `.runtime/hook-errors.jsonl`
- **Hooks pipeline** — 6 eventos (SessionStart, PreToolUse, PostToolUse, SubagentStart/Stop, Stop, UserPromptSubmit), 16 scripts registrados. Auto-start do dashboard no SessionStart com idempotência via PID-file
- **Execução curada (Shell Workbench)** — curation-guard bloqueia/redireciona comandos curados; curation-detect detecta outputs grandes; session-whitelist popula ecosistema no boot
- **Model Router v2** — tiers billing-aware (free/cheap/standard/premium), multipliadores, `costSensitive` por agente, alertas de custo
- **Injeção de lições** — lesson-inject injeta lições do KB do pattern-analyzer via UserPromptSubmit
- **Auto-update** — plugin-updater verifica GitHub Releases a cada 24h e notifica quando há update disponível
- **Refine Mode** — sempre ativo, injeta lembrete de pesquisa a cada turno via Stop hook

## Estrutura

```
claude-code-plugins/
├── claude-code-boss/          # Plugin principal
│   ├── .claude-plugin/        # Manifesto do plugin (plugin.json)
│   ├── .mcp.json              # Definições dos servidores MCP
│   ├── agents/                # 16 subagentes (.agent.md)
│   ├── config/                # brain-config.json, model-router.json, pipelines.json, hooks-config.json
│   ├── dashboard/             # index.html — dashboard SPA (7 abas)
│   ├── docs/                  # Guias de upgrade (Ollama, Voyage, MCP Memory)
│   ├── hooks/                 # hooks.json (6 eventos, 16 scripts)
│   ├── scripts/               # 29 scripts Node.js (hooks + CLI + Brain + Dashboard)
│   ├── servers/               # boss-server + brain-server (MCP, Node.js ESM)
│   ├── skills/                # 10 skills do Claude Code
│   ├── package.json           # v1.3.2, npm test, version:sync
│   └── TASK-MAP.md            # Estado real de entrega (20 features)
└── .github/workflows/ci.yml   # CI: test + lint + grep anti-patterns + version sync
```

## Instalação

> Requer Claude Code Desktop. Consulte [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code) para detalhes sobre a plataforma.

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

MIT
