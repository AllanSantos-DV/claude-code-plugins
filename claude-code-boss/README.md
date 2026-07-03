# claude-code-boss

Plugin para Claude Code Desktop — **v1.20.0**

Brain KB (busca semântica), execução curada (anti context-bloat) e aprendizado leve para Claude Code. A orquestração fica a cargo das ferramentas nativas (Agent/Workflow) — o plugin foca no que o nativo não tem.

---

## Pré-requisitos

- [Claude Code Desktop](https://claude.ai/download)
- **Node.js 22.13+ no `PATH` do sistema** — requisito #1. O Claude Code dispara os
  hooks e o servidor MCP com `node` puro resolvido pelo **PATH do sistema**, **não**
  pelo Node embutido no Desktop ([claude-code#66183](https://github.com/anthropics/claude-code/issues/66183),
  [#35175](https://github.com/anthropics/claude-code/issues/35175)). Sem Node no
  PATH: os hooks viram no-op silencioso e o Brain MCP fica **DOWN** (`spawn node
  ENOENT`). No Windows, instale o MSI oficial e **feche o Claude Code por completo
  (tray + Gerenciador de Tarefas) e reabra** para herdar o PATH. Usa o `node:sqlite`
  nativo; em Node mais antigo o Brain cai no fallback JSON — **sem compilação nativa
  em nenhum caso**. Troubleshooting completo: skill `plugin-install`.
- (Opcional) Java 21+ para backend MCP Memory
- (Opcional) Ollama para embeddings locais via GPU

## Instalação

```bash
cd claude-code-boss
npm install
```

O `npm install` (postinstall) **baixa o modelo de embedding** (~100-200 MB, uma vez) para um cache durável em `<CLAUDE_PLUGIN_DATA>/models/` (default `~/.claude/plugins/data/claude-code-boss/models/`) — habilita o search semântico **e** o loop de aprendizado (pattern→skill). Internet é assumida (você já baixou o plugin online). Pular (CI/automação): `CLAUDE_SKIP_EMBED_WARM=1`. (Re)baixar depois: `npm run setup:brain`.

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
├── .mcp.json                  # Servidor MCP: brain-server
├── config/
│   ├── brain-config.json      # Provider de embedding, backend (local|mcp-memory), thresholds
│   └── hooks-config.json      # Configuração dos hooks (memoryRotate, curationGuard, etc.)
├── dashboard/
│   └── index.html             # SPA — 4 abas: Home / Brain KB / Hooks / Logs
├── hooks/
│   └── hooks.json             # 7 eventos, 24 scripts (command "node") + 1 mcp_tool (brain_retrieve_context)
├── scripts/                   # Scripts Node.js (zero deps extras para hooks)
│   ├── dashboard.js           # Servidor HTTP local com ring buffer de logs
│   ├── brain-*.js             # Brain KB: store, index, graph, embedder, backend, CLI
│   ├── curation-guard.js      # PreToolUse: bloqueia/redireciona comandos curados
│   ├── hook-logger.js         # Utilitário: append a .runtime/hook-errors.jsonl
│   └── sync-version.js        # Propaga versão para todos os arquivos de versão
├── servers/
│   └── brain-server/          # MCP server (stdio + HTTP daemon) — ver servers/brain-server/README.md
├── skills/                    # skills do Claude Code (inclui plugin-install)
├── package.json               # scripts: test, version:sync
└── TASK-MAP.md                # Histórico de entrega (parcialmente obsoleto pós slim-down)
```

## Hooks Pipeline

Todos os hooks estão declarados em `hooks/hooks.json`. Eventos e scripts ativos:

| Evento | Script | O que faz |
| --- | --- | --- |
| SessionStart | `memory-rotate.js` | Rotaciona MEMORY.md quando >150 linhas |
| SessionStart | `session-whitelist.js` | Detecta ecossistema do projeto, popula whitelist |
| SessionStart | `brain-health.js` | Liveness probe (static + active backend.init/count): se MCP estiver caído, injeta advisory acionável; senão, silencioso |
| PreToolUse (Bash) | `curation-guard.js` | Bloqueia/redireciona comandos curados |
| PostToolUse (Bash) | `curation-detect.js` | Detecta outputs grandes para curação |
| Stop | `pattern-detect.js` | Nudge advisory (throttled): capturar padrão reusável via `capture_lesson` |
| Stop | `refine-research.js` | Injeta lembrete de pesquisa (web → Brain → usuário) |
| Stop | `curation-stop.js` | Bloqueia stop se há comandos noisy detectados no turno (escalating, anti-loop) |
| UserPromptSubmit | `brain-health.js` | Mesma probe do SessionStart, com cooldown de 60s — captura MCP caído em sessões resumidas |
| UserPromptSubmit | `correction-detect.js` | Detecta sinal de correção → nudge p/ `capture_lesson` (sem ler transcript) |
| UserPromptSubmit | `mcp_tool` → `brain_retrieve_context` | Retrieval QUENTE por-turno: embeda o prompt no brain-server (warm ~12–26ms), gate 0.20, federa `__user__`, injeta bloco `[BRAIN]` (substitui o antigo `brain-retrieve-prompt.js`) |

> **Captura de lição in-loop:** quando o usuário corrige, o agente (no loop, com
> contexto completo) chama a tool MCP **`capture_lesson`** com a lição curada — que
> roda admission control inline (dedup/merge → `recurrence`). **Sem reler transcript,
> sem subagente caro.** Os hooks só dão o nudge.
>
> **Tom advisory:** os hooks informam, não coagem. Sem orquestrador próprio:
> a delegação usa as ferramentas nativas (Agent/Workflow).

## Brain KB

Base de conhecimento local com 3 layers:

1. **Storage** (`brain-store.js`) — SQLite via `node:sqlite` (built-in do Node 22.13+, **zero deps nativas**) com fallback automático para `better-sqlite3` (se instalado) e, por fim, JSON. Busca vetorial (cosine similarity JS, suficiente para <10K entradas), FTS keyword search
2. **Index** (`brain-index.js`) — Índice invertido de palavras-chave com TF scoring
3. **Graph** (`brain-graph.js`) — Grafo de citação com 6 tipos de aresta

**Providers de embedding** (configurável em `config/brain-config.json`):

| Provider | Config | Requisito | Custo |
| --- | --- | --- | --- |
| `transformers` (padrão) | `embedder.provider: "transformers"` | Zero build; baixa o modelo (~100-200 MB) no install | Zero |
| `ollama` | `embedder.provider: "ollama"` | Ollama rodando localmente | Zero |
| `voyage` | `embedder.provider: "voyage"` | Chave API Voyage AI | ~$0.10/1M tokens |

**Modelo padrão**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, 50 idiomas) — recupera lessons EN a partir de prompts em qualquer idioma suportado. Baixado automaticamente no `npm install` para um cache durável (`<CLAUDE_PLUGIN_DATA>/models/`, sobrevive a reinstalls); refaça/verifique com `npm run setup:brain`.

**Breaking change — cutover de modelo**: ao trocar o `embedder.model`, vetores antigos ficam incompatíveis. Rode uma vez:
```bash
node claude-code-boss/scripts/brain-reembed.js
```
O script wipa a tabela `embeddings` de todo project DB e re-embeda usando o modelo atual. Sem fallback, sem `previousModel`, sem dual-read — plugin é single-tenant.

**Backend alternativo MCP Memory** (Java 21+): veja `docs/UPGRADE-MCP-MEMORY.md`.

## Brain MCP: stdio (padrão) + HTTP (opt-in)

O brain-server (`servers/brain-server/`) atende em **dois transportes**, com a mesma
lógica e o mesmo SQLite/KB:

- **stdio (padrão, inalterado)** — cada host (Claude Code, via `.mcp.json`) spawna
  seu próprio processo. Comportamento idêntico ao histórico; o `project` é inferido
  do CWD. **Nada muda para quem já usa** — sem reinstalar, sem mexer no `.mcp.json`.
- **HTTP (opt-in, aditivo)** — um **daemon único de longa duração** (StreamableHTTP,
  *stateful*) que N workspaces/clientes compartilham (**um modelo, um SQLite**), em
  vez de N processos stdio. Sobe com:
  ```bash
  node servers/brain-server/index.js --http [--port <N>] --plugin-data <DATA_DIR>
  ```
  A porta é determinística por data-dir (ou fixe com `BRAIN_HTTP_PORT`). Em HTTP o
  `project` é **obrigatório** por chamada (não há CWD para inferir — sem `project`,
  rejeita em vez de cair em `'default'`).

**Auto-start + auto-upgrade**: o launcher stdio sobe o daemon sozinho (detached) e, a
cada atualização do plugin, **troca um daemon obsoleto pelo novo** (lock em
`DATA_DIR` + checagem de versão via `/health`). Desligue com `BRAIN_HTTP_AUTOSTART=0`.

**Migrar um consumidor externo (ex.: OpenCode)** do cache de SHA rotativo para uma
URL estável: fixe `BRAIN_HTTP_PORT` e aponte para um MCP remoto
`http://127.0.0.1:<port>/mcp` (passando `project` explícito **e** o header
`Authorization: Bearer <token>` — token em `<DATA_DIR>/brain-http.token`, fixável
via `BRAIN_HTTP_TOKEN`). O Claude Code segue em stdio pelo `.mcp.json` inalterado.

**Auth do daemon HTTP (v1.19.1+)**: `/mcp` e `/shutdown` exigem o token (mesmo
padrão do dashboard: token local + guarda de `Origin` contra DNS rebinding);
`/health` permanece aberto para o supervisor de versão.

> **Referência técnica completa** (tools, endpoints, supervisor, config):
> [`servers/brain-server/README.md`](servers/brain-server/README.md).

## Dashboard

Iniciado **sob demanda** (não mais no SessionStart). Configura o **plugin**
(brain-config, hooks). Lance com `node scripts/dashboard.js` (ou via skill
`config-dashboard`).

- **Abas**: Home, Brain KB, Hooks, Logs
- **Porta**: dinâmica (0 → auto-assign, sempre `127.0.0.1`); fixe com `DASHBOARD_PORT`
- **Auth**: token aleatório gerado no boot (salvo em `.runtime/dashboard.json`)
- **Logs tab**: ring buffer de 500 entradas + `hook-errors.jsonl` agregado. Auto-refresh a cada 2s, Copy JSON, Clear

## Versionamento

Fonte canônica: `package.json` → propagada via `sync-version.js` para:
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
npm test           # testes de hooks
npm run version:sync  # Re-sincroniza versão sem bump
```

## Desenvolvimento local

Para testar mudanças não-commitadas localmente antes de publicar:

```bash
node claude-code-boss/scripts/install-local.js
```

Isso copia o estado atual do diretório para o cache do Claude Code Desktop (usando o SHA do commit atual como nome do diretório). Reinicie o Desktop para carregar.

Depois de commitar e fazer push, o marketplace atualiza automaticamente via `/plugin update claude-code-boss` no Claude Code.

## Licença

[MIT](../LICENSE) — licença cobre todo o monorepo, incluindo este plugin e seus sub-pacotes.
