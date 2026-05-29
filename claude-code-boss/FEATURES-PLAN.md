# Features Plan — Extensões do cerne (research-driven)

> **Status:** vivo, refinado por pesquisa. Cada feature passa por um **gate**:
> provar que o nativo não faz + checar mercado, ANTES de desenhar. Só sobrevive
> o que passa no gate.
> **Data:** 2026-05-29 · **Branch alvo:** `refactor/slim-down` (ou nova)

---

## Cerne (a tese que tudo precisa servir)

**Economia de contexto + memória que atravessa sessões.** Brain (lembrar,
semântico) · Curation (não desperdiçar contexto) · Learning (correções/padrões →
lições). Qualquer feature nova tem que reforçar isso e **não reimplementar o
nativo** (Agent/Workflow/Auto Memory) — o erro que originou o slim-down.

---

## Log de pesquisa (evidência — pra não refazer)

### Memória nativa do Claude Code (gate de F1)
- **Auto Memory** (v2.1.59+, **ON por padrão**): Claude grava sozinho build
  commands, insights de debug, notas de arquitetura, preferências.
  - Local: `~/.claude/projects/<project>/memory/` — `MEMORY.md` (índice) +
    arquivos de tópico `.md`. Formato **markdown**. Escopo **por-repo**, machine-local.
  - **Limitação:** só 200 linhas/25KB do `MEMORY.md` no contexto; tópicos lidos
    **on-demand por keyword**. **Sem busca semântica. Sem cross-project.**
- **CLAUDE.md / `.claude/rules/`**: instruções escritas pelo usuário.
- **Memory tool** (`/memory`): CRUD de arquivos de memória.
- **Mercado:** `claude-mem` (~46k stars) já faz "comprimir sessão → SQLite →
  recuperar no início". Niche de session-digest **ocupado**.
- Fonte: [code.claude.com/docs/memory](https://code.claude.com/docs/en/memory),
  [augmentcode claude-mem](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code).

### Tratamento nativo de output grande (gate de F3)
- Tool result > **50.000 chars** → nativo persiste em disco, mantém **preview de
  2KB** no contexto (`DEFAULT_MAX_RESULT_SIZE_CHARS`) — **todas** as tools.
- WebFetch: HTML→markdown→chunk→FTS; HTML cru nunca entra. Read trunca ~25k tokens.
- Fonte: [issue #12054](https://github.com/anthropics/claude-code/issues/12054),
  [harrisonsec pipeline](https://harrisonsec.com/blog/claude-code-context-engineering-compression-pipeline/).

---

## Teardown do claude-mem (ideia validada → o que portar)

Repo: `thedotmack/claude-mem` (~46–65k★). **Não está instalado aqui** — é
referência de mercado. Stack: SQLite + FTS5 + ChromaDB (vetor) com
**all-MiniLM-L6-v2 via ONNX** — *o mesmo embedder do nosso Brain*. Logo a
validação é do **processo**, não da tecnologia (já temos a tecnologia).

**Mecanismo (5 hooks + worker):**
- SessionStart → injeta N observações anteriores (count configurável).
- UserPromptSubmit → cria registro de sessão + indexa prompt no FTS5.
- PostToolUse (100+×/sessão) → captura trace da tool → worker comprime via
  **agent-sdk** em observações estruturadas (facts/concepts/file refs).
- Stop/Summary → resumo final (request + o que foi feito + learnings).
- SessionEnd → marca sessão completa (graceful, não DELETE; pula no `/clear`).
- Retrieval: 3 camadas progressivas (search → timeline → get_observations).

| Mecanismo claude-mem | Veredito | Razão |
|---|---|---|
| Compressão AI de traces → observação estruturada (facts/concepts/refs) | **ADAPTAR** | Nosso `brain-submit` indexa output cru >500 chars; a compressão em fatos estruturados é o pulo do gato. Mas custa LLM/worker (ver risco). |
| Resumo de sessão no Stop (request+feito+learnings) → store | **ADAPTAR via F1** | É o "session digest" validado. Mas o Auto Memory nativo já grava learnings; integrar (indexar o nativo) em vez de competir. |
| Retrieval progressivo (search→timeline→get) | **ADAPTAR** | Já temos fast/deep topK; refinar pro padrão de 3 camadas (economia de token). |
| SQLite+FTS5+vetor, MiniLM ONNX | **JÁ TEMOS** | Idêntico ao Brain. Não portar nada. |
| Web UI (:37777) | **JÁ TEMOS** | Nosso dashboard. |
| Captura de sessão completa competindo c/ nativo | **PULAR** | Auto Memory nativo já faz; integrar (F1). |
| **Decay / dedup / relevance scoring** | **NÃO TEM** → **nossa vantagem (F2)** | claude-mem não tem decay, dedup real (só na UI), nem scoring além do FTS5. Aqui a gente **supera o líder**. |

**Risco arquitetural a decidir:** claude-mem roda um **worker em background** +
chama LLM (agent-sdk) pra comprimir. Hoje o plugin não tem worker. Adotar
compressão-AI = ou um worker persistente, ou chamada LLM inline no hook
(latência/custo por turno). **Decisão de design antes de adotar a compressão.**

**Decisão (provisória, reversível) — compressão AI:** **não** adotar worker nem
compressão inline por enquanto. O Auto Memory nativo já grava learnings em
markdown de graça; o Brain só **indexa** isso (F1) + adiciona higiene (F2). Se os
learnings nativos se mostrarem rasos, ligar compressão inline (haiku no Stop) é um
add-on que não muda a arquitetura. Worker em background = descartado (infra pesada,
contra o slim-down).

**Conclusão estratégica:** o claude-mem valida que *captura no ciclo de vida +
compressão AI + retrieval semântico* é o padrão vencedor — e que **o líder não
tem higiene de memória**. Nossa diferenciação: ser a **camada semântica,
cross-project e SAUDÁVEL por cima do Auto Memory nativo** — pegar as ideias de
compressão/retrieval do claude-mem, apontá-las pra integração-com-nativo, e
adicionar a higiene (F2) que ninguém tem.

---

## Roster de features (com veredito do gate)

### F1 — Brain como camada de busca sobre a memória nativa 🟢 REFRAMED
**Decisão de posicionamento:** integrar com o nativo (não competir).

Antes era "session digest" → **morto pelo gate** (Auto Memory nativo + claude-mem
já fazem). Reframe: o Brain **indexa** `~/.claude/projects/<project>/memory/*.md`
(e `~/.claude/agent-memory/<agent>/*.md`) no vector store, oferecendo:
- **busca semântica** sobre TODOS os arquivos de tópico (nativo só carrega o head
  do MEMORY.md; tópicos são keyword on-demand);
- **busca cross-project** (nativo é por-repo).

Diferenciação clara e não-duplicada. Brain vira o "search layer" da memória nativa.

**Gate restante antes de desenhar:**
- Confirmar leitura/observação dos dirs de memória nativa (path correto por-repo,
  derivação do `<project>` a partir do git).
- Decidir gatilho de (re)indexação: hook? on-demand? watch?
- Evitar duplicar entries já no Brain (dedup vs F2).

### F2 — Lifecycle do Brain: dedup + decay + contradição 🟢 SOBREVIVE (prioridade alta)
Sem isso o KB apodrece — prova viva: **68 payloads pendentes** acumulando agora.
Se o Brain vai coexistir com o Auto Memory nativo, sua **qualidade** é o valor.

- **Achado local:** `brain-config.json` já declara `archiveAfterDays: 90`,
  `maxEntriesPerProject: 10000`, `dedupThreshold: 0.95` — mas é **config, não prova
  de implementação**.
- **Achado local:** `brain-consolidator` faz contradição só em *pesquisa
  multi-fonte*, não no KB geral.

**Gate de código — RESULTADO (2026-05-29): F2 é GREENFIELD.** As três não existem
em código:
- **Dedup:** `dedupThreshold: 0.95` só é carregado como default no
  `brain-submit.js:39` — **nunca aplicado** (sem cálculo de similaridade, sem skip).
- **Decay/eviction:** `archiveAfterDays` / `maxEntriesPerProject` **não lidos por
  nenhum script**. Config aspiracional.
- **Contradição:** só no `brain-consolidator` (pesquisa), não no KB.
- Explica o sintoma: 69 payloads acumulando sem portão de higiene → KB cresceria
  sem limite com duplicatas.

**Gate restante antes de desenhar:**
- Mercado: padrões de TTL/decay e re-ranking em vector stores (pesquisar ao
  desenhar). Implementar **fazendo valer os valores já no config**
  (`dedupThreshold 0.95`, `archiveAfterDays 90`, `maxEntries 10000`).
- Onde aplicar dedup: na submissão (`brain-submit`) ou na indexação
  (`brain-indexer`)? Decidir o ponto de enforcement.

### F3 — Curation além do Bash ❌ DROPPED
Gate matou: o nativo já offloada qualquer tool result > 50k chars pra disco. O
valor único da curation é o **script curado reutilizável** (contrato OK/FAIL),
que só faz sentido em Bash. Estender a Read/WebFetch/MCP = reimplementar o nativo.
**Não fazer.**

### F4 — Loop de eficácia das lições 🟢 SOBREVIVE (reconciliar com nativo)
Capturar lição é metade; medir se mudou comportamento e **podar lições que nunca
disparam** é a outra. Mata o vício de "acumular pra sempre".

**Gate restante:**
- Reconciliar com Auto Memory nativo: parte da captura (correções/preferências) o
  nativo já faz. Definir o que é responsabilidade do plugin vs nativo pra não
  duplicar (liga em F1 — se Brain indexa a memória nativa, a "lição" já vive lá).
- Métrica de eficácia: como detectar que uma lição preveniu um erro? (pesquisar).

---

## Não-fazer (fé no slim-down)
Roteamento de modelo · billing · pipelines declarativos · registro de swarm ·
orquestrador próprio · session-digest genérico (claude-mem/nativo já fazem) ·
curation de tools não-Bash (nativo já offloada). Tudo isso o nativo/mercado já
resolve.

---

## Ordem proposta
1. **F2 primeiro** (verificação de código: o que já existe de lifecycle). É o
   alicerce — sem KB saudável, F1 indexa lixo.
2. **F1** (integração com memória nativa) — a diferenciação que justifica o Brain.
3. **F4** por último (depende de F1 pra saber onde a lição vive).

Cada um vira sub-plano detalhado só **depois** de passar seu gate restante.
