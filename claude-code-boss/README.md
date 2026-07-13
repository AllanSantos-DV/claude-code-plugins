# claude-code-boss

Plugin para Claude Code Desktop — **v2.0.0**

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
│   └── hooks.json             # 7 eventos; Stop consolidado em 1 script (stop-dispatcher.js), os demais somam ~15 scripts + 1 mcp_tool (brain_retrieve_context)
├── scripts/                   # Scripts Node.js (zero deps extras para hooks)
│   ├── dashboard.js           # Servidor HTTP local com ring buffer de logs
│   ├── brain-*.js             # Brain KB: store, index, graph, embedder, backend, CLI, consolidate (higiene)
│   ├── curation-guard.js      # PreToolUse: bloqueia/redireciona comandos curados
│   ├── stop-dispatcher.js     # Stop: roda todos os detectores in-process (1 spawn, não 11)
│   ├── doctor.js              # CLI + dashboard: diagnóstico zero-config (Node/PATH, data-dirs, daemon, hooks)
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
| SessionStart | `doctor-advisory.js` | Roda `doctor.js` com cooldown; advisory de 1 linha só se algo crítico falhar (Node/PATH, data-dir fragmentado, daemon, token) |
| SessionStart | `review-checklist-advisory.js` | Se existir `.claude/brain-review-checklist.md` (lições recorrentes de código), lembra o `/code-review` nativo de consultá-lo |
| PreToolUse (Bash) | `curation-guard.js` | Bloqueia/redireciona comandos curados |
| PostToolUse (Bash) | `curation-detect.js` | Detecta outputs grandes para curação |
| PostToolUse (Edit\|Write\|NotebookEdit) | `file-edit-detect.js` | Journala arquivos editados no turno (alimenta `verify-nudge` e `self-review`) |
| **Stop** | **`stop-dispatcher.js`** | **Entry único** — roda in-process, em ordem, todos os detectores abaixo e funde os blocks num só `{decision:'block', reason}` (1 spawn de Node, não 11+) |
| Stop (via dispatcher) | `pattern-detect.js` | Nudge advisory (throttled): capturar padrão reusável via `capture_lesson` |
| Stop (via dispatcher) | `self-review.js` | Se o turno editou arquivos, recupera lições/failures relevantes do Brain (daemon HTTP autenticado, fallback keyword) e injeta advisory — "você já errou X nisso antes" |
| Stop (via dispatcher) | `verify-nudge.js` | Se o turno editou arquivos e nenhum comando de teste/lint rodou, injeta 1 advisory (cap por sessão, sem escalonamento) |
| Stop (via dispatcher) | `refine-research.js` | Injeta lembrete de pesquisa (web → Brain → usuário) |
| Stop (via dispatcher) | `curation-stop.js` | Bloqueia stop se há comandos noisy detectados no turno (escalating, anti-loop) |
| Stop (via dispatcher) | `session-summary.js` | Cap 1/sessão: resumo positivo ("N lições capturadas") quando a sessão gerou aprendizado |
| Stop (via dispatcher) | + 7 outros | `skill-promote-trigger`, `decision-scan-response`, `decision-promote`, `research-followup-detect`, `failure-retro`, `skill-success-detect`, `retrieval-feedback`, `auto-continue-stop` — mesmo comportamento de antes, agora in-process |
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
>
> **Perfis (`hooks-config.json` → `profile`)** — um único eixo de enforcement, três modos:
> - **`standard`** (padrão) — silencioso: só a curadoria dá **1 aviso soft** e relenta;
>   os nudges de captura (`pattern-detect`, `correction-detect`, `decisionScan`), as
>   ferramentas de dev (`verifyNudge`, `selfReview`) e os blockers extras do Stop
>   (`refine-research`, `failure-retro`, `research-followup`, `auto-continue`) ficam
>   desligados. `session-summary` (1×/sessão) e o retrieval continuam.
> - **`dev`** — tudo ligado (curadoria escala até 3×), para quem estende o plugin.
> - **`free`** — passa tudo: o Stop-dispatcher faz short-circuit e **nada bloqueia**;
>   só o retrieval de contexto no prompt (read-only) segue ativo.
>
> **Troca update-safe:** o perfil é lido do config shipped **mesclado** com
> `DATA_DIR/hooks/user-config.json` (nunca versionado), então trocar não edita arquivo
> versionado e **sobrevive ao auto-update**. Use o comando **`/boss-profile <dev|standard|free>`**
> ou o seletor na aba **Hooks** do dashboard. Override individual em `hooks-config.json`
> ainda vence o preset. Vale a partir do próximo turno (sem reiniciar o Claude Code).

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

**Backend alternativo MCP Memory** (servidor externo): abra o dashboard
(`node claude-code-boss/scripts/dashboard.js`) → aba **Brain** → **Backend
Configuration**. Escolha `mcp-memory`, modo **http** (conectar a um
mcp-memory-server já rodando; deixe a URL vazia para auto-descobrir via
`~/.mcp-memory/run/daemon.json`), e use **Testar conexão**. Opcional: ligue a
**ingestão** para enviar a conversa ao servidor (curadoria server-side) — é
opt-in e desligada por padrão. O ajuste é gravado só para você em
`DATA_DIR/brain/user-config.json` (o config publicado continua `local`) e
sobrevive ao auto-update. O modo **stdio** (o plugin sobe o `.jar`, requer
Java 21+) fica disponível como opção avançada.

**Identidade do projeto (recall entre máquinas/pastas)**: o cliente escopa a
memória por um `projectId`. Por padrão ele é o **nome da pasta** (`basename` do
`cwd`) — o que muda entre máquinas/clones e pode colidir. Para fixar um id
estável e escolhido por você (resolve o caso "estou na pasta `Hpositiva` mas
quero que a sessão use o projeto `positiva`"), a precedência do cliente é:

1. variável de ambiente **`CCB_PROJECT_ID`** — força o id da sessão inteira
   (ex.: iniciar o Claude Code com `CCB_PROJECT_ID=positiva`);
2. arquivo **`.claude-boss-project`** na pasta do projeto (ou em um ancestral) —
   contém o nome escolhido (`positiva`); viaja com a pasta, **independe de git**,
   do nome da pasta e do path absoluto;
3. **`basename(cwd)`** — default legado (inalterado quando não há override).

Todos os hooks (recall no `UserPromptSubmit` e ingestão da conversa) passam a
mandar esse id ao servidor, então a busca semântica casa mesmo com a pasta tendo
outro nome. O servidor escopa/filtra por esse `projectId` (metadata/override).

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
- **Home tab**: cards de valor (tokens de output curados, lições aprendidas, %
  de retrieval citado) + card "learning loop" (capturadas vs. mescladas por
  semana) + botão de consolidação do KB (ver abaixo).

## Diagnóstico e higiene do KB

- **`node scripts/doctor.js`** — checklist zero-config: Node no PATH + versão,
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` resolvidos, **fragmentação de
  data-dir** (múltiplos `claude-code-boss*` populados sob
  `~/.claude/plugins/data/` — comum entre install via `--plugin-dir` e via
  marketplace), modelo de embedding presente, daemon HTTP + token legível, e
  quais eventos de `hooks.json` a versão instalada do Claude Code suporta.
  Mesmo diagnóstico acessível pelo dashboard (botão) e via advisory de
  SessionStart (só quando algo crítico falha, com cooldown).
- **`node scripts/brain-consolidate.js [--project <k>] [--apply]`** — funde
  lições quase-duplicadas (similaridade 0.7–0.9, mesmo tipo) num único
  sobrevivente somando `recurrence`; **dry-run por padrão**. Roda também
  semanalmente sozinho (cooldown via SessionStart) e tem botão dedicado na aba
  Home do dashboard.

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
