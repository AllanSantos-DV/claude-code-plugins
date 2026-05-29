# Refactor Plan — Slim Down ao núcleo: Brain + Curation + Aprendizado

> **Status:** ✅ EXECUTADO e verificado em 2026-05-29 (branch `refactor/slim-down`).
> **Verificação:** `npm test` 26/26 · eslint 0 erros · smoke 5/5 · dashboard boot +
> `/api/status` OK. **Pendente:** commit (aguardando OK), reinstalar plugin a partir
> da branch p/ valer em runtime, `ROADMAP.md`/`TASK-MAP.md` (obsoletos — ver §7).
> **Data:** 2026-05-29
> **Princípio:** parar de reimplementar em *prompt* o que o Claude Code já entrega
> nativamente (Agent tool, Workflow tool, subagents com `model:`, session
> management). Manter o que o nativo **não** tem: **Brain KB** (busca semântica),
> **Curation** (anti context-bloat) e a **camada de aprendizado** (captura
> automática de padrões/correções → conhecimento consultável → escalonamento que
> me torna menos redundante e mais assertivo).

---

## 0. As duas camadas (a distinção que guia tudo)

| Camada | O que é | Veredito |
|---|---|---|
| **A — Engine de orquestração** | octopus routing, pipeline-executor, model-router, boss-server, agentes-clone | ❌ REMOVER — reimplementa Agent/Workflow nativos |
| **B — Aprendizado + escalonamento** | pattern-detect, correction-detect, refine-research, lesson-inject + Brain | ✅ MANTER (corrigir execução) — o nativo NÃO faz isto |

**Por que a camada B não é redundante:** o agent-memory nativo é *manual* e
*não-semântico*. A camada B faz três coisas que o nativo não cobre:

1. **Captura automática** de correções/padrões do transcript.
2. **Recuperação semântica** via Brain (busca vetorial).
3. **Escalonamento no Stop hook:** web (volátil) → local/Brain (estável) →
   usuário (última camada). É isto que me obriga a me auto-resolver antes de
   perguntar.

A execução atual, porém, está patológica (hooks coercitivos "MANDATORY ACTION",
backlog sem limite: 63 payloads Brain / 11 curation). Logo: **manter o conceito,
corrigir a execução.**

---

## 1. Decisões fechadas (resolvidas por pesquisa local + design)

| Decisão | Resolução | Evidência |
|---|---|---|
| Lessons: onde moram? | **Brain KB** (entries semânticas, fonte única) | elimina overlap com agent-memory nativo |
| Hooks da camada B | **Advisory + backpressure** | trocar "MANDATORY/you MUST" por informativo; limitar/lote nos payloads |
| Dashboard auto-start | **Remover do SessionStart** (on-demand) | sobe HTTP server detached toda sessão = desperdício p/ UI de config |
| Skill code-review-standards | **Remover** | órfã: referenciada só pelo `octopus.agent.md` (que sai) |
| Dados do Brain KB | **Preservar (não-decisão)** | só 22 entries/132K reais; dados em `CLAUDE_PLUGIN_DATA`, refat não toca |
| `lesson-inject` | **Fundir em `brain-retrieve-prompt`** | se lessons são entries do Brain, a recuperação é a mesma via Brain |
| Gatilhos da camada B sem o octopus | **No próprio hook (advisory)** — opção A | padrão de mercado: `additionalContext` é a superfície nativa; desacopla de qualquer agente, não sequestra a main session |

---

## 1b. Pendências conhecidas (resolver na execução)

| # | Pendência | Sev. | Resolução |
|---|---|---|---|
| 1 | **Auto-trigger sem dono:** instruções "spawn pattern/correction/brain/curation" vivem só no `octopus.agent.md` (que sai) | 🔴 alta | **RESOLVIDA:** mover instrução completa (nome do agente + path + "se relevante") para o `additionalContext` advisory de cada hook. Loop nativo lê e decide. |
| 2 | `sync-version.js` (KEEP) referencia `boss-server` (REMOVE) | ✅ resolvida | **Falso alarme:** o match é só um comentário (linhas 17-18) que diz que boss-server NÃO é sincronizado. Array funcional `FILES` (linha 108) não toca boss-server. Ação: ajustar a linha de comentário (opcional). Sem acoplamento. |
| 3 | `docs/` não classificado | 🟡 baixa | remover `REVIEW-CHECKLIST.md` (sai com code-review-standards); manter guias `UPGRADE-*` e `BRAIN-RESEARCH-PLAN.md` (Brain) |
| 4 | **Lessons:** onde vivem hoje? | 🟠 média | **RESOLVIDA:** vivem no agent-memory NATIVO dos subagentes (`~/.claude/agent-memory/pattern-analyzer/` e `correction-analyzer/`), não num store proprietário. Analyzers seguem gravando lá (idiomático); novo passo indexa no Brain via `brain-store` p/ busca semântica. Substitui o match-por-keyword do `lesson-inject` por retrieval semântico. |
| 5 | **`lesson-inject` faz 2 coisas:** injeta lessons E gera os contadores "N pending" varrendo `detect*/` | 🟠 média | fusão NÃO é limpa: (a) retrieval de lessons → Brain/`brain-retrieve-prompt`; (b) contagem advisory → migrar p/ dentro de cada hook detector (casa com #1). Não perder o aviso de pendências. |
| 6 | `output-styles/` vazio? | ✅ resolvida | **Confirmado vazio** (Glob: zero arquivos). Ação: remover o diretório. Sem risco. |
| 7 | Backlog atual (63 Brain / 11 curation / 4 corrections) | ✅ resolvida | Não é plan-breaker: detectores da camada B (ficam) consomem `detect*/`; `brain-indexer` (fica) consome `brain-pending/`. Ação: flush único dos backlogs no 1º run pós-refat. |

**Smoke tests:** ✅ verificado — `smoke/` não referencia nenhum componente removido.

> **Regra deste plano:** nenhuma linha fica como "trivial em aberto". Toda pendência é
> RESOLVIDA (com evidência) ou vira tarefa de execução com ação concreta + rede de
> segurança (`npm test` + smoke + restart na §6).

---

## 2. Inventário detalhado

### 2.1 Agentes (`agents/`) — 17 → 8

**MANTER (8):**

- Brain: `brain-consolidator`, `brain-indexer`, `brain-retriever`, `brain-source-researcher`
- Curation: `curation-improver`
- Aprendizado: `pattern-analyzer`, `correction-analyzer`, `refine-researcher`

**REMOVER (9 — camada A):**

- `octopus` → ⚠️ default da main session; remover devolve o loop nativo (objetivo).
- `pipeline-executor`
- `researcher / implementor / validator / reviewer / planner / debugger / documenter`

### 2.2 Scripts (`scripts/`) — 33 → ~29

**MANTER — Brain (11):** `brain-backend`, `brain-cli`, `brain-embedder`,
`brain-graph`, `brain-index`, `brain-retrieve`, `brain-retrieve-prompt`,
`brain-store`, `brain-submit`, `brain-test.mjs`, `mcp-client`

**MANTER — Curation (6):** `curation-detect`, `curation-guard`,
`curation-classifier`, `curation-backlog` (→ advisory+backpressure),
`session-whitelist`, `shells-config`

**MANTER (corrigir) — Aprendizado (3):** `pattern-detect`, `correction-detect`,
`refine-research` — todos passam a **advisory + backpressure**; lessons gravam no
**Brain** via `brain-store`.

**MANTER — Utilidade (5):** `memory-rotate`, `hook-logger`, `plugin-setup`,
`install-local`, `sync-version`

**MANTER — Dashboard (2, enxugar):** `dashboard`, `dashboard-start`

**ATUALIZAR:** `test-hooks` (remover casos dos scripts deletados)

**FUNDIR:** `lesson-inject` → lógica migra para `brain-retrieve-prompt` (lessons
viram entries do Brain, recuperadas no mesmo caminho).

**REMOVER (4 — camada A):**

- `model-router` (+ `config/model-router.json`)
- `cost-tracker`
- `ack-tracker`
- `discipline-guard` (atrelado ao octopus)

### 2.3 Servers (`servers/`)

- ✅ MANTER `brain-server`
- ❌ REMOVER `boss-server` (MultiDevRegistry; + entrada em `.mcp.json`)

### 2.4 Config (`config/`)

- ✅ MANTER `brain-config.json`
- ✂️ ENXUGAR `hooks-config.json` (tirar chaves de hooks removidos)
- ❌ REMOVER `model-router.json`, `pipelines.json`

### 2.5 Skills (`skills/`) — 11 → 6

**MANTER (6):** `brain-knowledge`, `brain-research`, `shell-execution`,
`native-session-management`, `config-dashboard` (atualizar), `pattern-detection`

**REMOVER (5 — camada A):** `octopus-coordination`, `multidev-orchestration`,
`pipeline-delegation`, `billing-awareness`, `code-review-standards`

---

## 3. hooks.json — reescrita

| Evento | Antes | Depois |
|---|---|---|
| SessionStart | memory-rotate, session-whitelist, **model-router**, **dashboard-start** | memory-rotate, session-whitelist |
| PreToolUse `Write\|Edit` | brain-retrieve, **discipline-guard** | brain-retrieve |
| PreToolUse `Bash` | brain-retrieve, curation-guard | *(inalterado)* |
| PostToolUse `Bash` | curation-detect, brain-submit | *(inalterado)* |
| PostToolUseFailure `Bash` | curation-detect | *(inalterado)* |
| **SubagentStart** | ack-tracker start | ❌ evento removido |
| **SubagentStop** | ack-tracker stop, cost-tracker | ❌ evento removido |
| Stop | ack-tracker report, pattern-detect, refine-research | pattern-detect, refine-research *(advisory)* |
| UserPromptSubmit | correction-detect, brain-retrieve-prompt, **lesson-inject**, curation-backlog | correction-detect, brain-retrieve-prompt, curation-backlog *(advisory)* |

Resultado: de 6 eventos / 15 scripts → 5 eventos / ~9 scripts. Camada A some;
camada B fica mas para de coagir.

---

## 4. Fixes da camada B (item novo — corrigir execução)

1. **Tom advisory:** remover "MANDATORY ACTION / you MUST spawn" dos
   `additionalContext`. Trocar por informativo ("N padrões pendentes — rode X se
   relevante"). O agente decide; o hook informa.
2. **Backpressure:** limitar payloads pendentes (ex.: descartar/agrupar acima de
   N; processar em lote). Acabar com acúmulo tipo 63 payloads.
3. **Lessons → Brain:** `pattern-analyzer`/`correction-analyzer` gravam lessons
   como entries do Brain (via `brain-store`), recuperadas por
   `brain-retrieve-prompt`. Fonte única; fim do lesson store paralelo.
4. **Escalonamento explícito:** `refine-research` (Stop) documenta a cascata
   web → Brain/local → usuário-por-último como contrato.

---

## 4b. Resultados da varredura de acoplamento (validação linha-a-linha)

Grafo de `require`/import + refs MCP + configs, lido no código (não por nome):

| Fronteira | Veredito |
|---|---|
| Brain cluster | ✅ auto-contido (Brain + `mcp-client`) |
| Curation cluster | ✅ auto-contido (`shells-config`, `curation-classifier`, `hook-logger`) |
| `brain-server` | ✅ requer só `brain-store/index/graph/embedder` |
| `boss-server` | ✅ sem consumidores externos — remoção limpa |
| Agentes que ficam | ✅ nenhum referencia agente removido |
| `test-hooks.js` | ⚠️ referencia scripts removidos → UPDATE |
| **`dashboard.js` + `index.html`** | 🔴 único acoplamento real — cirurgia coordenada (abaixo) |

### Dashboard — edição cirúrgica (NÃO é "remover aba")

`dashboard.js` mistura rotas KEEP (Brain/curation/hooks/logs) e REMOVE
(models/pipelines/billing) no mesmo arquivo; o **Home tab consome campos
removidos** (`index.html` 517-520) → cortar só o backend quebra o Home.

**`dashboard.js` remover:** `validateModels` (85-103), `validatePipelines`
(105-124), `getModels`/`saveModels` (243-258), `getPipelines`/`savePipelines`
(262-277), `getBillingLogs` (438-455); rotas `/api/models`, `/api/pipelines`,
`/api/billing/logs` (653-656, 666).
**`dashboard.js` editar `getStatus` (162-239):** remover leituras
`model-router.json` (163), `pipelines.json` (164), `cost-tracker.log` (204-217)
e chaves `models/pipelines/billing` da resposta (230-237). Manter brain/hooks.
**`index.html` remover:** nav (86,88), seções `tab-pipelines` (122-128),
`tab-billing` (291-299); state keys (485); router (493); `loadModels`/
`loadPipelines`/`loadBilling` + saves (538-616, 836-845).
**`index.html` editar `loadHome` (517-520):** remover stat-cards Pipelines e Total Cost.

> **Nota:** `getCurationBuiltin` (dashboard.js:490) duplica à mão os sets de
> `curation-guard.js`. Ambos ficam; acoplamento que pode divergir, não bloqueia.

**Conclusão da varredura:** fronteiras limpas em tudo, exceto o dashboard, agora
mapeado com precisão de linha. Nenhuma surpresa de `require` cruzado fora disso.

---

## 5. Outros arquivos

- `.mcp.json` → remover bloco `boss-server`.
- `.claude-plugin/plugin.json` → atualizar `description` (tirar "Party/Discovery/
  swarm"); foco Brain + Curation + Aprendizado.
- `dashboard/index.html` → remover abas órfãs (Models, Pipelines, Billing).
  Sobram: Home, Brain KB, Hooks, Logs.
- `README.md`, `ROADMAP.md`, `CHANGELOG.md` → atualizar.
- `package.json` → deps de runtime permanecem (Brain).

---

## 6. Ordem de execução (segura → arriscada)

Tudo em branch `refactor/slim-down`.

1. **Declarativo:** deletar agentes-clone, skills da camada A, `model-router.json`,
   `pipelines.json`. (não quebra runtime)
2. **Reescrever `hooks.json`** (§3).
3. **Aplicar fixes da camada B** (§4): advisory + backpressure + lessons→Brain +
   fundir `lesson-inject` em `brain-retrieve-prompt`.
4. **Deletar scripts da camada A** (model-router, cost-tracker, ack-tracker,
   discipline-guard) + atualizar `test-hooks.js`.
5. **Remover `boss-server`** + entrada `.mcp.json`.
6. **Enxugar dashboard** + `hooks-config.json`; tirar dashboard-start do SessionStart.
7. **Atualizar** plugin.json / README / ROADMAP / CHANGELOG.
8. **Verificar:** `npm test` + smoke + reiniciar Claude Code e confirmar Brain
   (retrieve/submit/lessons), curation guard e o escalonamento da camada B.
