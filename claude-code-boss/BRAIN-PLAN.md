# Brain Plan — O trunfo: criar, otimizar e linkar com a infra enxuta

> **Status:** vivo, research-driven. Gates antes de codar.
> **Data:** 2026-05-29 · **Branch:** `refactor/slim-down`
> **Tese:** o Brain é nosso diferencial — busca semântica + cross-project + memória
> **saudável** por cima do Auto Memory nativo. O líder de mercado (claude-mem,
> 46k★) **não tem higiene de memória**; é aí que ganhamos.

---

## 0. Achado-chave (grounding de código)

O schema do Brain **já foi desenhado pra higiene** — só falta a lógica:

`entries`: `id, type, project, session_id, title, summary, content, source, tags,`
`confidence, access_count, last_accessed, created_at` + tabelas `embeddings`,
`keywords`, `graph_edges`.

Os sinais de scoring que o mercado usa (relevância + tempo + frequência) **já estão
nas colunas** (`confidence`, `last_accessed`, `access_count`, `created_at`). O que
falta:
- `save()` faz `INSERT OR REPLACE` por **id** → sem dedup por **similaridade**.
- `searchSqlite()` rankeia **só por cosine** → ignora confidence/recência/acesso.
- Nada aplica `maxEntriesPerProject` (10000) nem `archiveAfterDays` (90).
- `graph_edges` existe mas não há aresta de **contradição** em uso.

**Conclusão:** F2 = implementar a lógica que o schema já antecipa. Baixo risco
estrutural, alto valor.

---

## 1. Padrões de mercado (gate — fonte)

- **Dedup/merge** de memórias sobrepostas é essencial — sem isso a mesma entidade
  aparece em dezenas de representações e polui o retrieval.
- **Importance weighting + decay**: memórias de baixa confiança/uso decaem; score
  por relevância **e uso**.
- **Reranking** iterativo/misto rende os melhores resultados.
- **Consolidação tipo-humana**: probabilidade de recall = f(relevância, tempo
  decorrido, frequência de recall), com decay dinâmico.
- **Deleção robusta** pra evitar erros auto-reforçados.
- Equilíbrio custo×acurácia: memórias demais confundem, de menos perdem contexto.
- **A-MAC (Adaptive Memory Admission Control):** valor de memória = utilidade
  futura + confiança factual + novidade semântica + recência + tipo de conteúdo;
  **pré-filtro por regra (barato) + UMA chamada LLM** de utilidade. NÃO 5-9
  chamadas/item (caro). Evita "garbage nodes" e episódico contaminando semântico.
- **Skill Induction / Skill Library (Voyager, Agent Skill Induction, Agent Workflow
  Memory):** comportamento/lição recorrente vira **skill reutilizável** — mas só
  após **self-verification** validar. Compositional, interpretável, evita
  esquecimento catastrófico.
- Fontes: [atlan](https://atlan.com/know/agentic-ai-memory-vs-vector-database/),
  [sparkco](https://sparkco.ai/blog/mastering-memory-consistency-in-ai-agents-2025-insights),
  [arxiv 2512.12818](https://arxiv.org/pdf/2512.12818),
  [A-MAC arxiv 2603.04549](https://arxiv.org/pdf/2603.04549),
  [Voyager arxiv 2305.16291](https://arxiv.org/abs/2305.16291).

---

## 2. Design da otimização (F2 — hygiene) 🟢 prioridade

Cada item mapeado ao ponto de enforcement no código atual.

### 2.1 Admission Control — gate de qualidade LLM na ingestão (A-MAC)
Decisão (do usuário, justificada): **não** fazer dedup cego por regex/cosine. Um
**gate LLM em batch** analisa os patterns/corrections pendentes ANTES de consumi-los,
porque lixo na memória contamina TODA a pipeline downstream. O custo vale.

Fluxo (no **`brain-indexer`** — agente que JÁ existe; enriquecer, não criar novo):
1. **Pré-filtro por regra (barato):** descarta ruído transacional (muito curto,
   sem sinal). Sem LLM.
2. **Busca semântica:** pra cada payload, `search` por near-dups no KB existente.
3. **UMA chamada LLM em batch** (haiku) julga o lote, por payload decidindo:
   `admit` (novo e válido) · `merge` (dup → funde no existente, bump
   `access_count`/`confidence`) · `skip` (lixo/redundante). Pontua novidade +
   confiança factual (A-MAC: 5 fatores).
4. Só os `admit`/`merge` viram entries. **Nunca lixo reusável downstream.**

- **Custo controlado:** 1 LLM/lote (não por item), modelo barato, pré-filtro por
  regra antes. Respeita o slim-down (sem worker; roda no indexer já existente).
- **Backlog (70 pending):** o 1º run processa em lotes com esse gate.

### 2.2 Reranking com decay (no search)
- Trocar score puro-cosine por **score combinado**:
  `final = w_rel·cosine + w_rec·recency(last_accessed|created_at) + w_freq·norm(access_count) + w_conf·confidence`
- `recency` = decay exponencial sobre tempo decorrido (parâmetro de meia-vida).
- **Ponto:** `searchSqlite()` / `searchJson()` scoring loop.
- Pesos configuráveis em `brain-config.json` (estender `kb.retrieval`).

### 2.3 Eviction / archive (manutenção)
- Fazer valer `maxEntriesPerProject` (evict pior-score/stale) e `archiveAfterDays`
  (mover antigas+baixo-acesso pra `archive/`, não DELETE — "graceful" como claude-mem).
- **Ponto:** passo de manutenção (hook SessionStart leve, ou script `brain-prune`).
- Deleção robusta: nunca evictar alta-confiança/alto-acesso recente.

### 2.4 Contradição (graph)
- Ao indexar, detectar conflito com entry existente (mesma entidade, claim oposto)
  → criar aresta `contradicts` em `graph_edges`; surface no retrieval.
- **Ponto:** `brain-indexer` + `brain-graph`. (Reusar lógica do `brain-consolidator`.)
- Gate: como detectar contradição barato (sem LLM por item)? Pesquisar ao desenhar.

---

## 3. Linkar com a infra enxuta (F1 — integração nativa) 🟢

O "linkar com a nova infra" = conectar o Brain ao que sobrou do plugin:

### 3.1 Indexar a memória nativa
- Ler `~/.claude/projects/<project>/memory/*.md` (Auto Memory nativo) e
  `~/.claude/agent-memory/<agent>/*.md` → indexar no Brain como entries
  (`type: 'native-memory'`), com embedding.
- Ganho: **busca semântica + cross-project** sobre notas que o nativo só expõe
  per-repo via keyword on-demand. Diferenciação pura.
- **Ponto:** novo `brain-index-native.js` (gatilho: SessionStart ou on-demand).
- Dedup (2.1) evita reindexar o que não mudou (hash/mtime do arquivo).

### 3.2 Fechar o loop com os hooks que ficaram
- `brain-submit` (PostToolUse) → aplica dedup (2.1) antes de enfileirar.
- `brain-retrieve-prompt` (UserPromptSubmit) → usa rerank (2.2); lessons já vêm
  daqui (fusão feita no slim-down).
- `pattern-detect`/`correction-detect` → lições viram entries do Brain (decisão do
  REFACTOR-PLAN §4), recuperadas por 2.2. Reconcilia F4.

---

## 3b. Skill Promotion — o pulo do gato (lição recorrente → skill global) ⭐

O ápice do pilar de learning, e **diferenciação pura**: nem o Auto Memory nativo
nem o claude-mem promovem aprendizado a skill. Paradigma validado: **Skill
Induction / Skill Library (Voyager)** — comportamento recorrente vira skill
reutilizável, **após validação**.

**Pipeline completa (conecta tudo):**
`capture (pattern/correction)` → `admission gate LLM (§2.1)` → `KB limpo` →
`recorrência detectada` → `promoção a SKILL.md global`.

**Mecanismo:**
1. **Sinal de recorrência:** cada `merge` no admission control (§2.1) incrementa um
   contador de reforço na entry (reusa `access_count` + um `recurrence`). Lição que
   reaparece sobe o contador.
2. **Candidatura:** recorrência ≥ limiar **E** alta confiança/generalizável (julgado
   pelo gate LLM) → vira **candidata a skill**.
3. **Validação (princípio Voyager — self-verification):** LLM confirma que a lição é
   generalizável e acionável (não um fato pontual). Reusar a skill `skill-creator`
   (existe no ambiente) pra gerar um `SKILL.md` bem-formado.
4. **Promoção com confirmação:** gravar `skills/<nome>/SKILL.md` (user-scope/global)
   — **com confirmação do usuário** via advisory (skill é contexto sempre-carregado;
   skill ruim polui TODA sessão = lixo amplificado). Nunca auto-spam.

**Reconcilia F4 (eficácia das lições):** promoção a skill é o sinal máximo de
eficácia; lição que nunca recorre **decai** (§2.3) e é podada. O loop se fecha:
lição boa sobe a skill, lição morta some.

**Guardrail anti-erro:** promoção é **curada, não automática**. Recorrência +
validação LLM + confirmação do usuário. Skill gerada entra como proposta, não direto.

---

## 4. Não-fazer (e a distinção do custo LLM aceito)
**Proibido:** worker em background · compressão-AI por sessão competindo c/ o nativo
· reimplementar captura de sessão · storage novo · promoção automática de skill
(sem confirmação) · LLM por-item (custo explosivo).

**Custo LLM ACEITO (justificado):** o **gate de admission control (§2.1)** e a
**validação de promoção (§3b)** — ambos **em batch, modelo barato, com pré-filtro
por regra antes**. A diferença do proibido: aqui o custo é na **ingestão/promoção**
(bounded, raro), não por turno/retrieval; e roda no `brain-indexer` já existente,
sem worker. Justificativa: lixo em memória contamina toda a pipeline downstream.

---

## 5. Gates restantes antes de codar

### 5.0 Gate do passo 1 (admission control) — ABERTO 2026-05-29
**Achado-chave (interno):** o `brain-indexer` **já é um agente LLM** que analisa
cada payload — o custo do gate **já é pago**; admission control = fortalecer o que
ele já faz (+ passo de busca semântica + decisão explícita), não custo novo.

| Item | Fonte | Resolução |
|---|---|---|
| Prompt (5 fatores) | externo (A-MAC) | utilidade/confiança/novidade/recência/tipo |
| Schema decisão | ext+int | `admit/merge/skip` (indexer já tem regra soft cosine>0.95) |
| Onde plugar | interno | pré-filtro regra em `brain-submit.js`; decisão LLM no agente `brain-indexer` |
| Modelo | decisão | haiku (indexer é `effort: low`) |
| **Merge + recorrência** | ✅ externo | A-MAC/decay tratam "frequência de uso" e "re-observação" como sinais **distintos** → **adicionar coluna `recurrence`** (separada de `access_count`). Merge incrementa-a. |
| **Batch dos 70** | ⚙️ ops | parâmetro de engenharia (sem resposta de pesquisa): **lotes de ~20/run**, ajustável; limitado pelo contexto/maxTurns do indexer |

**Validação do gate:** 5/6 itens respondidos por pesquisa (externa/interna); 1
(batch) é parâmetro operacional ajustável. **Sem pendência de design não-validada.**

### 5.0b Gate do passo 2 (rerank com decay) — ABERTO 2026-05-29
**Referência canônica:** Generative Agents (Stanford) — score = soma ponderada de
recency + importance + relevance, min-max normalizados.

| Item | Fonte | Resolução |
|---|---|---|
| Fórmula decay | ✅ externo | exponencial, fator **0.995/unidade de tempo** (hora no paper) |
| Pesos default | ✅ externo | **iguais** (α=β=γ=1 no paper), min-max norm, config-tunável |
| Importance signal | ✅ ext+int | mapeia pro `confidence` (0-1) que o indexer já grava |
| Onde plugar | ✅ interno | scoring loop de `searchSqlite`/`searchJson` — **`confidence`, `created_at`, `access_count` já vêm no SELECT**; trocar `score=cosine` por soma ponderada |
| Config surface | ✅ interno | novo bloco `kb.rerank` no `brain-config` (`kb.retrieval` já existe) |

`final = w_rel·cosine + w_rec·decay(last_accessed|created_at) + w_freq·norm(access_count) + w_conf·confidence`

**Validação:** 5/5 respondidos por pesquisa. **Zero mudança de schema** (sinais já
no SELECT). Único ajuste: unidade de tempo do decay (hora vs dia p/ contexto de
código) — grounded no 0.995/h, config-tunável. Sem pendência não-validada.

> Nota: min-max norm de recency/frequency é sobre o conjunto recuperado — viável,
> pois `searchSqlite` carrega as rows do projeto antes de pontuar.

### 5.0c Gate do passo 2.3 (prune/eviction) — ABERTO 2026-05-29
**Descoberta:** prune **cai de graça do passo 2.** A literatura (AMV-L, Priority
Decay) usa um **utility score contínuo** p/ evict — que é **exatamente o score do
rerank (§2.2)**. Não há fórmula nova.

| Item | Fonte | Resolução |
|---|---|---|
| Política | ✅ externo | **Priority/Score Decay** (melhor p/ memória heterogênea); reusa score do rerank como utility |
| Archive vs delete | ✅ externo | **archive (graceful)**, não delete — preserva sinal (Reflection-Summary) |
| Quando evictar | ✅ ext+config | `count > maxEntriesPerProject` (10000) → evict menor-score; `age > archiveAfterDays` (90) **E** baixo-acesso → archive |
| Onde plugar | ✅ interno | `brain-store` tem `list`+`delete`; add archive; rodar no fim do run do `brain-indexer` (bounded) |

**Validação:** 4/4 por pesquisa. **Reusa o score do §2.2** (zero fórmula nova).
Fonte: [agent memory eviction policies](https://medium.com/@bhagyarana80/agent-memory-eviction-8-policies-that-stop-stale-tool-decisions-fa84ec80d144),
[fazm memory triage](https://fazm.ai/blog/ai-agent-memory-triage-retention-decay).

### 5.0d Gate do passo 2.4 (contradição) — ABERTO 2026-05-29
**Descoberta:** contradição **cai de graça do passo 1.** Padrão de mercado:
*recuperar vizinhos semânticos (vetor) → LLM julga só esses* (não all-pairs). O
admission control (§2.1) **já** faz busca semântica + julga via LLM — basta o mesmo
julgamento emitir `contradicts`.

| Item | Fonte | Resolução |
|---|---|---|
| Método barato | ✅ externo | recuperar similares → LLM julga só candidatos (não par-a-par); evita custo |
| Onde plugar | ✅ interno | piggyback no admission LLM (§2.1); `graph_edges` + `brain-graph.addEdge` já existem; indexer já instruído (linha 181) |

**Validação:** 2/2 por pesquisa. **Reusa o LLM do §2.1** (zero passo novo/caro).
Fonte: [RAG contradictions](https://medium.com/@wb82/taming-the-information-jungle-how-rag-systems-handle-contradictions-25227c943980),
[SparseCL](https://arxiv.org/html/2406.10746v1).

### 5.0e Gate do passo 3.1 (indexar memória nativa) — ABERTO 2026-05-29
| Item | Fonte | Resolução |
|---|---|---|
| Derivação do dir | ✅ interno | **path da cwd sanitizado** (confirmado: `C--Users-allan-Desktop-Projetos-claude-code` = `C:\...\claude-code`), não git. Computável. |
| Estrutura do arquivo | ✅ interno | markdown com `## seções` (confirmado em `agents.md`) → chunk por header → entry `type: native-memory` |
| Re-index sem custo | ⚙️ ops | check de `mtime`/hash por arquivo; reindexa só o que mudou |
| Onde plugar | ✅ interno | novo `brain-index-native.js`; gatilho on-demand ou SessionStart leve |

**Validação:** 3/4 por pesquisa interna; 1 (gatilho/cadência) é ops param.

### 5.0f Gate do passo 3b (skill promotion) — ABERTO 2026-05-29
| Item | Fonte | Resolução |
|---|---|---|
| Formato SKILL.md | ✅ interno | frontmatter `--- description ---` + body md (confirmado); gerar via skill `skill-creator` do ambiente |
| Mecânica | ✅ externo | Voyager: promove após **self-verification**; recorrência ≥ limiar + LLM valida generalizável |
| Recorrência | ✅ (5.0) | coluna `recurrence` (decidida no gate 5.0); `merge` incrementa |
| Confirmação | ✅ interno | advisory (padrão já existe) → usuário aprova → grava `skills/<n>/SKILL.md` |
| Limiar de promoção | ⚙️ ops | `recurrence ≥ 3-5`, tunável |

**Validação:** 4/5 por pesquisa; 1 (limiar) é ops param. Guardrail: nunca auto-spam.

### 5.1 Parâmetros operacionais (ajustáveis, não bloqueiam)
Batch do indexer (~20) · unidade de tempo do decay (h/dia) · cadência de reindex
nativo · limiar de recorrência (3-5). Todos config-tunáveis, começam conservadores.

## 6. Sequência proposta (todos os gates ABERTOS e validados)

Descoberta da pesquisa: **2.3 e 2.4 não são passos separados — caem de graça** dos
passos 1 e 2 (reusam o LLM do admission e o score do rerank). Isso enxuga o plano.

1. **Passo 1 — Admission control** (gate LLM batch no `brain-indexer`: pré-filtro +
   busca semântica + `admit/merge/skip`) **+ contradição (2.4)** no mesmo julgamento
   **+ coluna `recurrence`**. Corta lixo na fonte + processa backlog (lotes ~20).
2. **Passo 2 — Rerank com decay** (score combinado no `searchSqlite`/`searchJson`)
   **+ prune/eviction (2.3)** reusando esse score como utility. Zero schema.
3. **Passo 3 — Indexar memória nativa** (`brain-index-native.js`) — a diferenciação.
4. **Passo 4 — Skill promotion** (recorrência ≥ limiar → validação LLM → confirmação
   → `SKILL.md`). O pulo do gato. Depende de recorrência limpa acumulada (passo 1).
5. **Passo 5 — Reconciliar F4** (lições do pattern/correction ↔ Brain ↔ skills).

**Status do plano: COMPLETO.** Todos os gates abertos e validados contra pesquisa
externa+interna. Sem ponto de design não-respondido — só parâmetros operacionais
ajustáveis (§5.1). Pronto p/ implementar quando o usuário decidir "sair de fato".
