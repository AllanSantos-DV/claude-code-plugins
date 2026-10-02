# claude-code-boss

Plugin para Claude Code Desktop — **v2.29.1**

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
│   └── hooks.json             # 8 eventos; 13 hooks `mcp_tool` (hook_*) rodam no daemon do brain-server + brain_retrieve_context; ficam como command só SessionStart (dispatcher de 12 + model-router-ensure.js) e user-prompt-submit-dispatcher (4, inclui model-router-ensure)
├── scripts/                   # Scripts Node.js (zero deps extras para hooks)
│   ├── dashboard.js           # Servidor HTTP local com ring buffer de logs
│   ├── brain-*.js             # Brain KB: store, index, graph, embedder, backend, CLI, consolidate (higiene)
│   ├── curation-guard.js      # PreToolUse: bloqueia/redireciona comandos curados
│   ├── stop-dispatcher.js     # Stop: roda todos os detectores in-process (via mcp_tool hook_stop_dispatcher, no daemon)
│   ├── doctor.js              # CLI + dashboard: diagnóstico zero-config (Node/PATH, data-dirs, daemon, hooks)
│   ├── hook-logger.js         # Utilitário: append a .runtime/hook-errors.jsonl
│   └── sync-version.js        # Propaga versão para todos os arquivos de versão
├── servers/
│   └── brain-server/          # MCP server (daemon HTTP único, porta fixa) — ver servers/brain-server/README.md
├── skills/                    # skills do Claude Code (inclui plugin-install)
├── package.json               # scripts: test, version:sync
└── TASK-MAP.md                # Histórico de entrega (parcialmente obsoleto pós slim-down)
```

## Hooks Pipeline

Todos os hooks estão declarados em `hooks/hooks.json`. Por evento, cada script
roda **num único processo Node por hook** — os detectores de cada evento são
consolidados num *dispatcher* in-process (mesmo padrão do `stop-dispatcher.js`
original): lê o payload uma vez, roda cada `run(event)` puro, funde o
resultado. `model-router-ensure.js` fica de fora do dispatcher de
`SessionStart` (spawn próprio; faz esperas reais de vários segundos na troca de
daemon). No `UserPromptSubmit` ele roda dentro do `user-prompt-submit-dispatcher`
(`run()` sem `process.exit`, com teto próprio): 1 processo por prompt, não 2.

**Desde a 2.29.1 (ADR-015)** a maioria desses hooks nem sobe processo: o
`hooks.json` declara um `mcp_tool` `hook_<nome>` do brain-server, que roda o
mesmo script in-process no daemon HTTP compartilhado (porta padrão 38217).
Medido: 8,9 ms p50 por hook (antes 122 ms com spawn) e 60 hooks concorrentes em
0,6–1,9 s (antes 7–8 s), com 234 MB no daemon em vez de ~3,9 GB somados. Uma
exceção na tool vira `systemMessage` de degradação (fail-open visível); com o
daemon fora do ar o Claude Code trata o `mcp_tool` como erro não bloqueante.
Ficam como `command` os hooks que precisam funcionar sem o daemon: `SessionStart`,
`user-prompt-submit-dispatcher` (que inclui o `model-router-ensure`). O `SubagentStart`
(`policy-inject`) também roda no daemon (`hook_policy_inject`): era 1 processo por
subagente. No daemon, `Stop` e os hooks de efeito colateral de `PostToolUse` rodam
num worker próprio (fila FIFO), fora da thread que atende os guards; os que
sempre devolvem `{}` respondem na hora e rodam em segundo plano; cada hook tem um
prazo interno de `timeout − 1 s`.

| Evento | Script | O que faz |
| --- | --- | --- |
| SessionStart | `model-router-ensure.js` | Garante o daemon do model-router na porta fixa e publica `ANTHROPIC_BASE_URL`/shim (roteamento de custo opcional) — spawn próprio, fora do dispatcher |
| **SessionStart** | **`session-start-dispatcher.js`** | **Entry único** — roda in-process os 12 detectores abaixo (`brain-daemon-ensure` + os 11 seguintes), concorrente com timeout próprio por detector (mirror dos timeouts antigos), funde os textos de advisory num só `additionalContext` |
| SessionStart (via dispatcher) | `brain-daemon-ensure.js` | Garante o daemon único e, no backend `mcp-memory` HTTP, verifica update no máximo 1x/24h; aplica/reinicia/valida versão automaticamente sem criar outro hook |
| SessionStart (via dispatcher) | `memory-rotate.js` | Rotaciona MEMORY.md quando >150 linhas (side-effect only) |
| SessionStart (via dispatcher) | `session-whitelist.js` | Detecta ecossistema do projeto, popula whitelist (side-effect only) |
| SessionStart (via dispatcher) | `brain-health.js` | Liveness probe (static + active backend.init/count): se MCP estiver caído, injeta advisory acionável; senão, silencioso |
| SessionStart (via dispatcher) | `project-snapshot.js` | Snapshot do estado do repo (branch/PRs/CI) via `git`/`gh`, cacheado 5min |
| SessionStart (via dispatcher) | `curation-session.js` | Poda one-hits antigos e injeta panorama de scripts curados; dispara higiene semanal do KB (fire-and-forget) |
| SessionStart (via dispatcher) | `doctor-advisory.js` | Roda `doctor.js` com cooldown; advisory de 1 linha só se algo crítico falhar (Node/PATH, data-dir fragmentado, daemon, token) |
| SessionStart (via dispatcher) | `review-checklist-advisory.js` | Se existir `.claude/brain-review-checklist.md` (lições recorrentes de código), lembra o `/code-review` nativo de consultá-lo |
| SessionStart (via dispatcher) | `tuning-advisory.js` | Recomendação determinística de tuning (perfil/curadoria) com cooldown de 6h |
| SessionStart (via dispatcher) | `project-identity-advisory.js` | Pasta sem project id → avisa que a memória está desligada e pede ao agente para perguntar o nome e criar `.memory/project.json` |
| SessionStart (via dispatcher) | `graph-warm.js` | mcp-memory: dispara um `ingest` incremental do Session Graph (fire-and-forget, cooldown por projeto) pra o grafo ficar pronto-e-fresco antes da 1ª busca — o servidor faz o delta (no-op ~5s se nada mudou). Silencioso, fail-open |
| SessionStart (via dispatcher) | `policy-inject.js` | Injeta as políticas standing (always) no contexto da sessão |
| SubagentStart | `policy-inject.js` | Injeta as políticas standing (always) no contexto próprio do subagente — mesma injeção do SessionStart (via `mcp_tool` `hook_policy_inject` no daemon, sem spawn por subagente) |
| PreToolUse (Bash) | `mcp_tool` → `hook_curation_guard` (`curation-guard.js`) | Bloqueia/redireciona comandos curados quando o alias é o comando inteiro (caminho absoluto do script); comando composto em que o alias é só uma parte roda com uma dica apontando o script (a saída volumosa segue cobrada no Stop); inclui o graph-guard p/ `grep -r`/`rg`/`find` amplos (mcp-memory + grafo ready → deny-once com redirect ao grafo) |
| PreToolUse (Bash) | `mcp_tool` → `hook_error_guard` (`error-guard.js`) | Nega o comando que já falhou ≥N vezes NESTA sessão, no mesmo diretório, sem nenhuma edição de arquivo desde a última falha — injeta a última saída. Repetir não desbloqueia; um sucesso ou uma edição (tentativa de correção) sim. Roda em paralelo ao `hook_curation_guard`; `deny` vence (o `pretooluse-bash-dispatcher.js` segue como entry por stdin, com a mesma regra) |
| PreToolUse (Edit) | `mcp_tool` → `hook_policy_enforce_shadow` (`policy-enforce-shadow.js`) | Shadow-mode: detecta se uma edição viola uma política de código ativa (sem bloquear ainda) |
| PreToolUse (Grep\|Glob) | `mcp_tool` → `hook_graph_guard` (`graph-guard.js`) | Busca recursiva ampla com Session Graph READY → deny-once: `graph_search`/`graph_symbols` primeiro (estrutural, ~300ms), depois re-rodar escopado; retry idêntico passa |
| **PostToolUse (Bash)** | **`mcp_tool` → `hook_posttoolusebash_dispatcher` (`posttoolusebash-dispatcher.js`)** | **Entry único** — roda `curation-detect.js` + `decision-detect.js` in-process (side-effect only, sempre `{}`) |
| PostToolUse (Bash, via dispatcher) | `curation-detect.js` | Detecta outputs grandes para curação |
| PostToolUse (Bash, via dispatcher) | `decision-detect.js` | Detecta commit/PR com cara de decisão arquitetural e stash pending para o Stop promover |
| PostToolUse (Edit\|Write\|NotebookEdit) | `mcp_tool` → `hook_file_edit_detect` (`file-edit-detect.js`) | Journala arquivos editados no turno (alimenta `verify-nudge` e `self-review`) |
| PostToolUse (Edit\|Write\|MultiEdit\|NotebookEdit) | `mcp_tool` → `hook_policy_glob_inject` (`policy-glob-inject.js`) | Injeta advisory de política glob (per-file) quando o arquivo editado casa um padrão de política ativa |
| UserPromptExpansion | `mcp_tool` → `hook_skill_metric` (`skill-metric.js`) | Métrica de uso de skill (matcher `.*`) |
| **PostToolUseFailure** | **`mcp_tool` → `hook_posttoolusefailure_dispatcher` (`posttoolusefailure-dispatcher.js`)** | **Entry único** — roda `curation-detect.js` (já filtra `tool_name==='Bash'` internamente) + `failure-detect.js` in-process |
| PostToolUseFailure (via dispatcher) | `failure-detect.js` | Journala a falha (alimenta `failure-retro`). O `error-guard` não depende mais dele: decide pelo transcript da própria sessão (`lib/session-failures.js`) |
| **Stop** | **`mcp_tool` → `hook_stop_dispatcher` (`stop-dispatcher.js`)** | **Entry único** — roda in-process no daemon, em ordem, todos os detectores abaixo e funde os blocks num só `{decision:'block', reason}` |
| Stop (via dispatcher) | `pattern-detect.js` | Nudge advisory (throttled): capturar padrão reusável via `capture_lesson` |
| Stop (via dispatcher) | `self-review.js` | Se o turno editou arquivos, recupera lições/failures relevantes do Brain (daemon HTTP autenticado, fallback keyword) e injeta advisory — "você já errou X nisso antes" |
| Stop (via dispatcher) | `verify-nudge.js` | Se o turno editou arquivos e nenhum comando de teste/lint rodou, injeta 1 advisory (cap por sessão, sem escalonamento) |
| Stop (via dispatcher) | `refine-research.js` | Injeta lembrete de pesquisa (web → Brain → usuário) |
| Stop (via dispatcher) | `project-id-stop.js` | Pasta sem project id → bloqueia 1×/turno pedindo para definir o id (memória desligada até lá); silencia os detectores que pedem captura |
| Stop (via dispatcher) | `curation-stop.js` | Bloqueia stop se há comandos noisy detectados no turno (escalating, anti-loop) |
| Stop (via dispatcher) | `session-summary.js` | Cap 1/sessão: resumo positivo ("N lições capturadas") quando a sessão gerou aprendizado |
| Stop (via dispatcher) | + 7 outros | `skill-promote-trigger`, `decision-scan-response`, `decision-promote`, `research-followup-detect`, `failure-retro`, `skill-success-detect`, `retrieval-feedback`, `auto-continue-stop` — mesmo comportamento de antes, agora in-process |
| UserPromptSubmit | `model-router-ensure.js` | Mesma garantia de daemon do model-router, agora por-turno (settings/env já publicados no SessionStart) — roda dentro do `user-prompt-submit-dispatcher` (mesmo processo) |
| **UserPromptSubmit** | **`user-prompt-submit-dispatcher.js`** | **Entry único** (command, funciona com o daemon fora do ar) — roda in-process os 3 detectores abaixo, concorrente com timeout próprio por detector, funde os textos de advisory num só `additionalContext` |
| UserPromptSubmit (via dispatcher) | `brain-daemon-ensure.js` | Mesma garantia de daemon do SessionStart — captura o daemon caído em sessões resumidas |
| UserPromptSubmit (via dispatcher) | `brain-health.js` | Mesma probe do SessionStart, com cooldown de 60s — captura MCP caído em sessões resumidas |
| UserPromptSubmit (via dispatcher) | `brain-status.js` | Advisory só quando o backend `mcp-memory` está desconectado (silencioso no backend `local`, sempre conectado por design) |
| UserPromptSubmit | `mcp_tool` → `hook_correction_detect` (`correction-detect.js`) | Detecta sinal de correção → nudge p/ `capture_lesson` (sem ler transcript) |
| UserPromptSubmit | `mcp_tool` → `hook_active_research_detect` (`active-research-detect.js`) | Detecta prompt com sinais de pesquisa externa (lib/versão/best-practice) → nudge p/ `research_query` |
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
> - **`standard`** (padrão) — silencioso, mas **aprende**: só a curadoria dá **1 aviso
>   soft** e relenta. O `correction-detect` (nudge de captura **silencioso** no
>   UserPromptSubmit, invisível ao usuário) fica **LIGADO** — o perfil quieto não mata o
>   auto-aprendizado (v2.9.0). Ficam desligados os nudges **interruptivos** e as
>   ferramentas de dev: `pattern-detect`, `decisionScan`, `verifyNudge`, `selfReview`,
>   `refine-research`, `failure-retro`, `research-followup`, `auto-continue`.
>   `session-summary` (1×/sessão) e o retrieval continuam.
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

No modo HTTP, o `SessionStart` também consulta as tools `check_update` e `update`
anunciadas pelo próprio servidor, no máximo uma vez a cada 24 horas. Quando há
release nova, a operação é chamada **uma única vez** (sem retry automático), o
Boss acompanha o restart pelo `daemon.json` e só registra sucesso quando
`/health.version` corresponde exatamente à versão esperada. SessionStarts
concorrentes são serializados por lock. Falha gera advisory, mas não bloqueia o
backend. O fluxo permanece dentro de `session-start-dispatcher.js`; nenhum hook
ou processo updater adicional é criado. No Windows, se a tool não conseguir
substituir o JAR em uso, o Boss valida o PID/comando Java, encerra o daemon,
promove o JAR já baixado e verificado e relança a versão nova; o JAR anterior é
mantido para rollback.

Por segurança, `serverUrl` remoto/de equipe **não** é atualizado automaticamente
por padrão. Esse caso exige `backend.mcpMemory.autoUpdate.allowRemote=true`; mesmo
com opt-in, o fallback Windows nunca usa o `daemon.json` local para um destino
explícito/remoto.

**Migrar o KB local que você já tem (botão "Migrar agora")**: trocar o backend
para `mcp-memory` **não leva junto** o que já estava no SQLite local — sem
migração, o acervo antigo fica órfão. No mesmo card (**Brain → Backend
Configuration**, visível só no modo `mcp-memory`) há **Migrar agora**: ele varre
todo projeto com KB local (`DATA_DIR/brain/<projeto>/brain.db`), lê cada entrada
inteira e a grava no servidor **projeto a projeto** (o daemon escopa por
`project_id` no handshake, um por conexão). A tela mostra o progresso e, no fim,
confere a contagem remota contra o que subiu.

- **Idempotente**: cada documento é gravado com `documentId` = o id local
  (`add_document` faz UPSERT), então rodar de novo **atualiza** em vez de
  duplicar. Seguro para retomar uma migração interrompida.
- **Fail-loud**: uma entrada que falha não aborta o resto, mas é coletada com a
  causa real e o resultado vira erro — nunca "sucesso" mascarando perda. Fora do
  backend `mcp-memory` a migração recusa rodar (jamais grava no store local em
  silêncio). Se a conferência final achar menos documentos no servidor do que
  subimos, isso também é reportado como erro.
- **O servidor re-embeda** cada entrada (o `add_document` manda o conteúdo, não
  os vetores), então um acervo grande leva tempo — daí o botão explícito com
  progresso, em vez de migrar sozinho ao salvar.
- **O que muda ao migrar** (trade-off honesto): a de-duplicação de lições passa a
  ser server-side (some o merge local que somava `recurrence`) e o `brain_related`
  deixa de usar o grafo de citação local, virando busca semântica. Em troca, as
  tools `graph_*` passam a funcionar (o grafo vive no servidor).
- **Limitação atual**: entradas de escopo **global** (`__user__`) ainda **não**
  migram. O servidor só aceita escrita global (escopo *home*/`skill_global`) sem
  um `project_id` ativo, e o handshake do cliente é sempre escopado num projeto
  por design (anti-contaminação). Migre-as manualmente ou aguarde o suporte.

Também dá para rodar pela linha de comando:
```bash
node claude-code-boss/scripts/brain-migrate.js
```

**Identidade do projeto (recall entre máquinas/pastas)**: o cliente escopa a
memória por um `projectId`, resolvido por uma escada **estrita** (sem fallback
para o nome da pasta):

1. variável de ambiente **`CCB_PROJECT_ID`** — força o id da sessão inteira;
2. **`.memory/project.json`** na pasta do projeto (ou em um ancestral), com
   `{"version":"1","metadata":{"defaults":{"project_id":"owner/repo"}}}` —
   viaja com a pasta, **independe de git**, do nome da pasta e do path absoluto;
3. legado `.claude-boss-project` (deprecado, ainda honrado);
4. **git remote origin** normalizado;
5. nada → **a memória fica DESLIGADA nessa pasta** (2.29.1).

**Pasta sem id = sem memória** (mesmo modelo do plugin copilot-memory). Em uma
pasta sem id (ex.: exploração fora de um repo git) o boss **não injeta recall**
(`brain_retrieve_context` volta vazio e o `self-review` do Stop não roda) e **não
salva nada** (`capture_lesson`/`brain_store`/`brain_search` com `cwd` sem id são
recusados; o `cwd` com id vence um `project` explícito). O
`SessionStart` avisa o agente, e o `Stop` (`project-id-stop`) repete o aviso a
cada turno — uma vez por turno, sem loop — até o id existir; nesse meio-tempo os
detectores de Stop que pedem captura ficam em silêncio. Para resolver, responda
ao agente o nome do projeto (ele cria o `.memory/project.json`) ou trabalhe num
repo git com remote. Para desligar os avisos: `onboarding.projectIdentity: false`
na config (a memória continua desligada sem id).

## Brain MCP: daemon único, zero processo por sessão (ADR-001)

O brain-server (`servers/brain-server/`) tem **um único modo**: um daemon HTTP de
longa duração (StreamableHTTP, *stateful*) numa **porta fixa** (`38217`),
compartilhado por toda sessão do Claude Code e qualquer outro consumidor na
máquina — **um modelo, um SQLite**. O `.mcp.json` aponta direto pra URL
(`"type":"http"`, sem `command`) — **Claude Code não spawna processo nenhum por
sessão**; cada sessão é um cliente HTTP fino do daemon único.

O daemon em si é garantido (encontrado-ou-iniciado) por um hook
`SessionStart`/`UserPromptSubmit` (`scripts/brain-daemon-ensure.js`) — efêmero
(roda, garante, sai), então não fere o próprio princípio que existe pra servir.

- **Porta é FIXA** (`38217`, não derivada por data-dir), pra bater com a `url`
  estática do `.mcp.json`. Override com `--port` ou `BRAIN_HTTP_PORT`.
- `project` é **obrigatório** por chamada (não há CWD de sessão pra inferir — o
  daemon serve todos os projetos da máquina); sem `project`, rejeita
  (`PROJECT_REQUIRED`) em vez de cair em `'default'`.

**Auto-start + auto-upgrade**: o hook de ensure sobe o daemon sozinho (detached) e, a
cada atualização do plugin, **troca um daemon obsoleto pelo novo** (lock em
`DATA_DIR` + checagem de versão via `/health`). Desligue com `BRAIN_HTTP_AUTOSTART=0`.

**Consumir de fora do Claude Code** (ex.: OpenCode): aponte pra
`http://127.0.0.1:38217/mcp` (ou a porta fixada via `BRAIN_HTTP_PORT`), passando
`project` explícito. Nenhum header de auth é exigido em `/mcp` — o `.mcp.json`
não consegue carregar um segredo gerado em runtime, então esse endpoint usa
apenas guarda de `Origin` (defesa contra DNS rebinding).

**Auth**: só `/shutdown` (ação destrutiva) exige token — token local em
`<DATA_DIR>/brain-http.token`, fixável via `BRAIN_HTTP_TOKEN`. `/mcp` usa apenas
guarda de `Origin`; `/health` permanece totalmente aberto.

> **Referência técnica completa** (tools, endpoints, supervisor, config):
> [`servers/brain-server/README.md`](servers/brain-server/README.md).

## Graph — exploração de repositório (via daemon de memória)

7 tools `graph_*` (`graph_analyze`/`graph_search`/`graph_symbols`/`graph_status`/`graph_ingest`/`graph_callers`/`graph_references`) dão **exploração rápida de um repositório** — hubs por PageRank, busca semântica com vizinhança (CALLS/CONTAINS/IMPORTS), quem chama um símbolo — para entender um repo grande sem garimpar arquivo por arquivo. São **cliente REST puro** do Session Graph Engine do daemon native-java (`POST /api/v1/graph/*`): **nenhum Java é embarcado** e, se o daemon estiver offline, as tools **falham graciosamente** (fail-open). Path-autoritativo (o daemon deriva o `project_id` do caminho e o devolve). Ficam **fora** do KB/mutex — independentes do Brain KB local. Porta de entrada: `graph_analyze`. Ref. técnica: [`servers/brain-server/README.md`](servers/brain-server/README.md).

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

## Endpoints custom — upstream e BYOK

> **💰 Cobrança**: o Model Router nasce **desativado** e ligá-lo é opt-in por conta
> e risco. Passthrough/sticky na rota Anthropic preserva a cobrança da assinatura;
> a rota BYOK e o fallback NVIDIA cobram o endpoint; uma `ANTHROPIC_API_KEY` no
> ambiente vira API pay-as-you-go. Guia completo:
> [docs/features/ROUTER-BILLING.md](docs/features/ROUTER-BILLING.md).

O proxy aceita gateways **Anthropic Messages** e **OpenAI Chat Completions**.
No dashboard você escolhe o protocolo e configura URLs completas, separadas para
modelos, geração, contagem de tokens e classificação. A mesma configuração pode
vir de variáveis de ambiente; a precedência é
`dashboard/user-config > ambiente > defaults`.

- **Anthropic**: encaminhamento nativo para a URL de geração configurada.
- **OpenAI**: a geração pode apontar para `/v1/chat/completions` ou qualquer path;
  o router traduz mensagens, ferramentas, imagens suportadas, respostas JSON e
  SSE. Campos incompatíveis falham explicitamente — nunca são omitidos em silêncio.
- **Picker `/model`**: IDs sem `claude`/`anthropic` recebem o alias
  `anthropic-ccb-alias-` apenas na listagem. O marcador é removido antes de enviar
  geração ou contagem ao endpoint; o `display_name` continua real.
- **Custom upstream** preserva a credencial do Claude Code e os
  `forwardHeaders`; **BYOK** remove essa credencial e envia somente os headers
  configurados pelo usuário.
- **Dois modos** (`/dashboard` → Model Router → BYOK):
  - **`on-limit`** (padrão) — o Claude atende normalmente e o endpoint entra
    quando a janela esgota (429), **antes** do plano B da NVIDIA. Se o endpoint
    também estiver no teto (429), a vez passa para a NVIDIA.
  - **`always`** — o endpoint atende **tudo**; não depende da assinatura Claude.
- **Fail-loud**: `401`/`404`/`5xx` e um corpo com `model is not supported` **não**
  caem em silêncio para a NVIDIA. Erro de configuração precisa aparecer, senão a
  credencial errada nunca é consertada.
- **Segurança — o ponto que mais importa**: o `authorization`/`x-api-key` que o
  Claude Code envia carrega o token da **sua assinatura**. Na rota BYOK esses
  headers são **removidos**; só vão os que você configurou. Repassá-los seria
  vazar a credencial da assinatura para um terceiro. Há um teste ponta a ponta
  que sobe um endpoint falso e falha se o token aparecer lá.
- Os headers ficam em `~/.claude/claude-code-boss/model-router/user-config.json` (permissão `0600`,
  nunca commitado) e a UI **não reexibe** os valores — mostra os nomes mascarados
  e mantém o que já está gravado quando você salva com o campo em branco.
- **Mapeamento de modelo** (opcional, só na rota BYOK): regras origem → destino
  trocam o `model` enviado ao endpoint. A ordem é: ID exato, depois o ID sem a
  data de snapshot (`-AAAAMMDD`), depois padrões com `*` (vence o que tem mais
  caracteres literais; empate, a regra que vem primeiro). Os padrões são
  testados contra o ID original, com a data: `claude-opus-*-2025*` casa
  `claude-opus-5-20250101`, e a base sem data não entra nessa etapa. Sem regra, o `model` vai como veio, e `claude-opus-5` nunca captura
  `claude-opus-5-5`. Para gateways que decidem a rota por outro campo, a
  **injeção** (desligada por padrão) grava o modelo resolvido num caminho do
  corpo ou num header via template `{model}`:

  ```json
  "byok": {
    "modelMap": {
      "claude-opus-5-5": "provedor.modelo-a",
      "claude-haiku-4-5": "provedor.modelo-b",
      "claude-sonnet-5-*": "provedor.modelo-c"
    },
    "modelInjection": { "body": { "metadata.force_model": "{model}" } }
  }
  ```

  Editável em `/dashboard` → Model Router → BYOK. Headers de credencial e de
  protocolo (`authorization`, `x-api-key`, `content-type`,
  `anthropic-version`, …), o próprio `model` e os campos de protocolo do corpo
  (`messages`, `system`, `tools`, `stream`, `max_tokens`, …) não podem ser alvo
  da injeção, e todo template precisa conter `{model}` (valor fixo é recusado).
  Nomes de header com cara de credencial (`auth`, `token`, `secret`,
  `api-key`, `cookie`, `session`, …) ou de roteamento (`Content-*`,
  `X-Original-*`, `X-Envoy-*`, `CF-*`, `*-Client-IP`, …) também são recusados
  (a lista é uma rede de segurança, não é exaustiva), e a injeção não sobrescreve um
  campo de topo que a request já traz nem cria chave que só difere de uma
  existente na caixa. **O template não é lugar
  de segredo**: aceita até 64 caracteres de texto fixo e o dashboard o exibe em
  claro. Credencial vai em *Headers*, que ficam mascarados. Uma request sem
  `model` de texto com injeção ligada falha em vez de enviar o campo vazio.
  Nomes de modelo com mais de 256 caracteres ou fora de ASCII visível nunca
  casam uma regra e seguem como vieram. O limite é de 500 regras. Se o arquivo de config tiver regra
  inválida (editado à mão), a aba mostra o erro e trava o salvar até você
  corrigir o arquivo (a mensagem mostra o caminho); o "Desligar tudo" continua funcionando.
- **Compatibilidade OpenAI Chat Completions** (opcional, só com
  `wireProtocol: "openai"` no BYOK): o padrão é o formato que um gateway
  passthrough aceita — assistant com tool calls e sem texto sai com `content: null`,
  `system` no meio do histórico fica na posição, e `tool_reference` dentro de
  `tool_result` vira texto JSON. Se o seu endpoint recusar algum desses casos,
  troque em `/dashboard` → BYOK → *Avançado: compatibilidade OpenAI Chat
  Completions* ou no arquivo:

  ```json
  "byok": {
    "openaiCompat": { "assistantEmptyContent": "empty", "systemInMessages": "reject", "toolReference": "reject" }
  }
  ```

  Valores (strings), com o padrão primeiro: `assistantEmptyContent`
  `"null"`/`"empty"`, `systemInMessages` `"keep"`/`"reject"`, `toolReference`
  `"text"`/`"reject"`. O exemplo acima troca os três.

  `"reject"` recusa a request citando a opção, sem chamar o endpoint: `400` no
  `mode: "always"`; no fallback (`on-limit`/cooldown) a resposta vira um aviso
  explicando por que a request não pôde ir ao BYOK. Valor ou chave desconhecida
  é erro de configuração, nunca default silencioso: no `always` a request falha
  com `502` citando a opção (o catálogo repassado também), e no fallback a
  resposta mostra a causa em vez de ceder à NVIDIA. O dashboard valida a opção mesmo com `wireProtocol:
  "anthropic"` (em que o router a ignora), para o erro não aparecer só ao trocar
  o protocolo.

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
