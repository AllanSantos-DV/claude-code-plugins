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
- **2.1 admission:** definir o prompt do gate (5 fatores A-MAC), o schema de
  decisão (admit/merge/skip), tamanho do lote e modelo (haiku). Onde no
  `brain-indexer` plugar.
- **2.2 decay:** fórmula/meia-vida e pesos default (começar conservador, config).
- **2.4 contradição:** método barato de detecção (heurística vs embedding vs LLM).
- **3.1:** confirmar derivação do `<project>` (git) p/ achar o dir nativo;
  gatilho de (re)indexação sem custo a cada SessionStart.
- **3b skill promotion:** schema do contador de recorrência; limiar de promoção;
  fluxo de confirmação do usuário (advisory → aprova → grava SKILL.md via
  skill-creator). Onde guardar o `recurrence`.
- **Backlog (70 pending):** o admission gate + prune lidam com o acúmulo no 1º run
  (em lotes, não 70 chamadas).

## 6. Sequência proposta
1. **2.1 admission control** (gate LLM em batch — corta lixo na fonte + processa o
   backlog de 70) + **2.3 prune/eviction** (limpa o que já está sujo).
2. **2.2 rerank com decay** (qualidade de retrieval usando colunas existentes).
3. **3.1 indexar memória nativa** (a diferenciação cross-project/semântica).
4. **3b skill promotion** (o pulo do gato — depende de recorrência acumulada limpa).
5. **2.4 contradição** + **3.2 reconciliar F4** (refinamento).

Cada etapa só abre depois de passar seu gate (§5). **Skill promotion (4) depende de
admission control (1) ter rodado tempo suficiente p/ acumular recorrência confiável.**
