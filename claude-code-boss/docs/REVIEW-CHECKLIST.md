# Review Checklist — Plugin vs Claude Code Nativo

> **Data**: 2026-05-22
> **Objetivo**: Comparar cada feature do plugin com o que Claude Code já oferece nativamente. Decidir se cada script/agente/skill realmente adiciona valor ou se está reinventando funcionalidade nativa.
> **Legenda**: 🔴 Nativo cobre / 🟡 Nativo cobre parcialmente / 🟢 Plugin adiciona valor real

---

## Resumo

| Status | Contagem | Decisão |
|--------|----------|---------|
| 🔴 Nativo cobre | 2 | Pode remover — Claude Code já faz |
| 🟡 Nativo cobre parcialmente | 9 | Manter, mas simplificar — plugin complementa |
| 🟢 Plugin adiciona valor real | 9 | Manter — gap real que nativo não cobre |

> Algumas features aparecem em mais de uma categoria porque têm sub-componentes com maturidade diferente.

---

## 1. Pattern Detection

**Plugin**: `scripts/pattern-detect.js` (Stop hook a cada 4 turns) + `agents/pattern-analyzer.agent.md` (subagente analisa transcript em 2 eixos) + `skills/pattern-detection/SKILL.md`
**Status**: 🟢 Plugin adiciona valor real

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Detecção de padrões em transcripts | **Não faz**. Issue #17161 fechada como "not planned". | Stop hook a cada 4 respostas + subagente com taxonomia de 7 categorias |
| Análise de anti-patterns | **Não faz**. | Dois eixos: workflow shells + agent anti-patterns |
| Aprendizado com histórico | Apenas auto-memory (captura correções diretas como "use pnpm"). | Análise estruturada com categorias (hallucination, scope creep, loop, etc.) |

**Veredito**: ✅ Gap real. Claude Code não tem nada equivalente.

---

## 2. Correction Detection

**Plugin**: `scripts/correction-detect.js` (UserPromptSubmit a cada 2 turns) + `agents/correction-analyzer.agent.md` (subagente haiku)
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Capturar correções do usuário | Auto-memory captura correções como "use pnpm, not npm" automaticamente. Aprende comportamento. | Hook detecta sinais de frustração/correção, subagente analisa e salva como lesson estruturada. |
| Detecção proativa | **Não faz**. Auto-memory é reativo (você corrige, ele aprende). | UserPromptSubmit hook examina cada interação em busca de padrões de correção. |
| Extração em lessons | Auto-memory salva em MEMORY.md (index) + topic files (detalhes). Carregado por relevância (Sonnet). | Salva em agent-memory do correction-analyzer com formato próprio de lesson. |

**Análise**: O auto-memory nativo já captura correções que o usuário dá. A diferença é que nosso correction-detect é proativo (examina todas as interações) vs reativo (só quando usuário corrige explicitamente). O valor real é pequeno — o nativo já cobre 80% do caso de uso.

**Veredito**: 🟡 Gap pequeno. O auto-memory nativo já aprende com correções. O valor adicional do hook proativo é marginal. Pode simplificar ou remover.

---

## 3. Shell Curation

**Plugin**: `scripts/curation-guard.js` (PreToolUse Bash — BLOCK + redirect), `scripts/curation-detect.js` (PostToolUse Bash — detecta output grande), `scripts/session-whitelist.js` (SessionStart — popula whitelist), `agents/curation-improver.agent.md` (cria .mjs scripts), `skills/shell-execution/SKILL.md`
**Status**: 🟢 Plugin adiciona valor real (partes) / 🔴 Nativo cobre (partes)

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Bloquear comandos perigosos | **Sim**. Permission system: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`. Sandbox com restrições de FS/rede. AST parsing avalia comandos antes de executar. Comandos read-only (`ls`, `cat`, `grep`) são auto-allowed. | curation-guard.js bloqueia comandos raw quando existe script .mjs curado. |
| Whitelist de comandos | **Sim**. Read-only commands list é nativa e extensível. | session-whitelist.js popula `.vscode/shells.json` com comandos do ecossistema do projeto. |
| Análise de output grande | **Não faz**. Bash tool trunca em 30K chars, mas não analisa ou age sobre output grande. | curation-detect.js detecta output >5K chars ou 80 linhas, aciona curation-improver. |
| Geração de scripts curados (.mjs) | **Não faz**. Não tem conceito de "curated script" com contrato OK/FAIL. | curation-improver.agent.md cria scripts .mjs a partir de output analysis. |
| Learning loop | **Não faz**. Não aprende com comandos que você executa. | Ciclo completo: guard → detect → improver → .mjs → shells.json. |

**Análise**: A parte de **bloqueio** (curation-guard.js) é parcialmente redundante — Claude Code já tem permission system + sandbox + AST parsing que é mais sofisticado. A parte de **learning loop + geração de scripts .mjs** é única — Claude Code não faz nada disso.

**Veredito**: 🟢 Learning loop + .mjs generation é gap real. 🔴 A parte de blocking é parcialmente redundante com o permission system nativo.

---

## 4. Refine Mode

**Plugin**: `scripts/refine-research.js` (Stop hook — sempre injeta lembrete) + `agents/refine-researcher.agent.md`
**Status**: 🟢 Plugin adiciona valor real

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Pesquisar respostas para dúvidas | **Não faz automaticamente**. Claude espera você fazer perguntas. O `/research` command existe mas é manual. | Stop hook SEMPRE injeta "research answers to your questions" + subagente pesquisa automaticamente. |
| Always-on research | **Não tem**. | Conceito de "Refine Mode — Always On". Após qualquer resposta com `## Questions`, o subagente pesquisa sem você pedir. |

**Veredito**: ✅ Gap real. Nativo não tem always-on autonomous research.

---

## 5. Model Router + Billing

**Plugin**: `config/model-router.json`, `scripts/model-router.js` (SessionStart), `scripts/cost-tracker.js` (SubagentStop), `skills/billing-awareness/SKILL.md`
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Selecionar modelo por sessão | **Sim**. `/model` picker, `--model` flag, `ANTHROPIC_MODEL` env var, `settings.json:model`. | model-router.js reescreve `.agent.md` files no SessionStart com base em config. |
| Modelo por subagente | **Sim**. Frontmatter `model:` field em `.agent.md` (sonnet/opus/haiku/inherit/full ID). | Usa `model: inherit` em todos agentes e router decide qual modelo injectar. |
| Roteamento automático por task | **Não**. Issue #39282 — feature request aberta, não implementada. | Router aplica tiers por agente (costSensitive + minTier), mas a decisão real é do Claude (octopus escolhe o caminho). |
| Custo por agente | **Não**. `/cost` mostra total da sessão, não por agente. | cost-tracker.js registra cada invocação de subagente com modelo + multiplier. |
| Alertas de orçamento | **Não**. | cost-tracker alerta quando costSensitive agent usa modelo caro ou total > threshold. |

**Análise**: O roteamento em si (escolher qual modelo) o Claude Code já faz nativamente via `model:` field no frontmatter. O que plugin adiciona: (1) reescrita automática via SessionStart, (2) tracking de custo por agente, (3) alertas de orçamento. A reescrita via SessionStart resolve um problema real (não precisa editar 17 arquivos .agent.md manualmente), mas poderia ser substituído por templates.

**Veredito**: 🟡 Gap parcial. O `model:` field nativo já cobre o roteamento. O valor real do plugin está no cost tracking + budget alerts.

---

## 6. Lesson Injection

**Plugin**: `scripts/lesson-inject.js` (UserPromptSubmit — lê agent-memory, keyword-match, injeta lessons relevantes)
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Carregar lessons aprendidas | Auto-memory carrega MEMORY.md + topic files por relevância (Sonnet sideQuery, top 5). | Lê agent-memory do pattern-analyzer, faz keyword match com mensagem do usuário, injeta via hookSpecificOutput. |
| Detectar lessons relevantes | **Sim**. Sonnet rankeia até 200 arquivos por filename + frontmatter + mtime, retorna top 5 por turno. | Keyword match simples contra topic files. |
| Formato das lessons | MEMORY.md (index lines ~150 chars) + topic files (Markdown). | Topic files em agent-memory/pattern-analyzer/ (mesmo formato). |

**Análise**: O auto-memory nativo já carrega lessons relevantes automaticamente usando Sonnet para rankear. O lesson-inject.js faz keyword match que é **menos sofisticado** que o sideQuery() nativo com Sonnet. A diferença é que o plugin injeta via hookSpecificOutput (mais visível) vs auto-memory (carregado silenciosamente).

**Veredito**: 🔴 Potencialmente redundante. O auto-memory nativo já carrega lessons mais inteligentemente (Sonnet relevance vs keyword match). Único valor é a injeção visível via hookSpecificOutput.

---

## 7. Brain KB (Knowledge Base)

**Plugin**: 7 scripts (store, embedder, index, graph, submit, retrieve, retrieve-prompt) + 3 agentes (indexer, retriever, consolidator) + 1 skill
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Busca em código | **Sim**. Glob (pattern), Grep (regex/content), Read (file content), LSP (symbols). Live search, não RAG. | N/A — não buscamos código, buscamos conhecimento. |
| Busca semântica em conhecimento | **Não faz**. Claude Code não mantém índice vetorial. Design intencional (artigo: live search > vector RAG para código). | Embeddings via Transformers.js/Ollama/Voyage + SQLite + cosine similarity. |
| Memória persistente | **Sim**. Auto-memory: `~/.claude/projects/<slug>/memory/` com MEMORY.md + topic files. | SQLite database por projeto com schema próprio (entries, embeddings, keywords, graph_edges). |
| Citação e relações | **Não faz**. Auto-memory não tem grafo de citações. | Citation graph com 7 edge types (references, contradicts, supersedes, implements, etc.). |
| Indexação automática | Apenas auto-memory (captura durante conversa). | brain-submit.js (PostToolUse Bash) + brain-indexer subagente processam payloads. |
| Retrieval em tempo real | Auto-memory carrega topic files por relevância a cada turno. | brain-retrieve.js (PreToolUse) + brain-retrieve-prompt.js (UserPromptSubmit) buscam KB. |

**Análise**: Claude Code deliberadamente não faz RAG — o design é baseado em live search (Glob, Grep, Read, LSP). O rationale é que código requer matching exato, não semântico. Para **conhecimento geral** (docs, patterns, lessons, decisões arquiteturais), um KB separado pode fazer sentido, mas o auto-memory nativo já cobre esse caso — ele persiste e recupera conhecimento entre sessões.

**Veredito**: 🟡 Gap real existe (citation graph, embeddings), mas o auto-memory nativo já cobre 60% do caso de uso (memória persistente + retrieval por relevância). O valor real está no citation graph + buscas semânticas que o nativo não faz.

---

## 8. Pipeline Delegation

**Plugin**: `config/pipelines.json`, `agents/pipeline-executor.agent.md`, `skills/pipeline-delegation/SKILL.md`
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Delegar para subagentes | **Sim**. Agent tool (ex-Task) — spawn subagente com contexto, ferramentas, modelo. Suporta paralelo com `run_in_background`. | pipeline-executor spawna subagentes sequencialmente via Task tool, lendo passos de config JSON. |
| Pipeline declarativo | **Não**. Não tem formato de pipeline. O octopus manualmente decide o que fazer. | pipelines.json define steps + cascade tiers. Octopus lê o config e spawna executor. |
| Validação em cascata | **Não**. Não tem conceito de validation gates. | Cascade steps com progressive tiers (syntax → logic → security), param no primeiro failure. |
| Reuso de pipelines | **Não**. | pipelines.json permite adicionar novos pipelines sem editar agent.md. |

**Análise**: O Agent tool nativo já permite encadear subagentes. O pipeline-executor apenas automatiza o que o octopus faria manualmente (spawnar subagentes em sequência). O valor real está no formato declarativo + cascade validation, que são conceitos que o nativo não tem.

**Veredito**: 🟢 Pipeline declarativo + cascade validation são gaps reais. Mas a execução em si (spawnar subagentes) o nativo já faz. O plugin adiciona uma camada de orquestração acima.

---

## 9. Dashboard / Config UI

**Plugin**: `scripts/dashboard.js` (HTTP server, 15 endpoints) + `dashboard/index.html` (SPA 6 tabs)
**Status**: 🔴 Nativo cobre

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Ver config | **Sim**. `/config` (ou `/settings`) — tabbed panel interativo com busca. | Dashboard Home tab + Models/Pipelines tabs. |
| Ver/editar modelo | **Sim**. `/model` — picker interativo com effort level. | Models tab com selects e save button. |
| Ver hooks | **Sim**. `/hooks` — read-only browser grouped by event com drill-down. | Hooks tab com toggle on/off. |
| Ver memória | **Sim**. `/memory` — browse/edit CLAUDE.md, rules, auto-memory. Toggle on/off. | Não tem. |
| Gerenciar permissões | **Sim**. `/permissions` — UI para ver/gerenciar regras. | Não tem. |
| Ver skills | **Sim**. `/skills` — lista, sort por token count, toggle visibility. | Não tem. |
| Ver custo | **Sim**. `/cost` — tokens por sessão. `/usage` — plan limits. | Billing tab com logs e filtro. |
| Ver status | **Sim**. `/status` — active settings sources e origins. | Home tab com stats grid. |
| Desktop app | **Sim**. IDE com drag-and-drop panes (chat, diff, preview, terminal, file, plan, tasks). | Não tem. |

**Análise**: Claude Code tem 8+ comandos nativos que cobrem **todas** as funcionalidades do dashboard, com UIs interativas no terminal. O dashboard do plugin adiciona apenas:
- Visualização web (vs terminal)
- Brain KB search (que o nativo não tem)
- Pipeline viewer (que o nativo não tem)
- Toggle hooks on/off (o nativo é read-only)

**Veredito**: 🔴 Maioria do dashboard reinventa `/config`, `/model`, `/hooks`, `/cost`. As únicas abas com valor real são Brain KB e Pipelines. Considere manter apenas essas como mini-features e usar os comandos nativos para o resto.

---

## 10. MEMORY.md Auto-Rotation

**Plugin**: `scripts/memory-rotate.js` (SessionStart — rotaciona MEMORY.md quando >150 linhas)
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Limite de MEMORY.md | **Sim**. Hard cap de 200 linhas E 25KB. Conteúdo além é truncado com warning. | Rotation preventiva: quando >150 linhas, arquiva em `archive/` e preserva últimas 20. |
| Consolidação automática | **Sim**. `autoDream` — após 24h + 5 sessões, consolida/deduplica/prune memórias. | Não faz consolidação — só rotate. |
| Gerenciamento de tópicos | **Sim**. MEMORY.md é índice com pointers de ~150 chars para topic files. Topic files carregados on demand. | Não gerencia topic files — só o MEMORY.md. |

**Análise**: O auto-dream nativo já faz consolidação automática. O limite de 200 linhas é nativo. O que o plugin adiciona é um corte preventivo (150 linhas) + archive. O auto-dream é mais sofisticado (sumariza, deduplica, prune). O rotate simples pode até atrapalhar o auto-dream ao arquivar conteúdo que ele consolidaria.

**Veredito**: 🟡 Gap marginal. O auto-dream nativo já gerencia o ciclo de vida da memória. O rotate preventivo pode ser útil como safety net, mas o nativo já tem `autoDream` que é mais inteligente.

---

## 11. Pluggable Memory Backend (MCP)

**Plugin**: `scripts/brain-backend.js`, `scripts/mcp-client.js`
**Status**: 🟢 Plugin adiciona valor real

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Backend de memória configurável | **Não**. Memory system é fixo (arquivos Markdown em `~/.claude/projects/<slug>/memory/`). | brain-backend.js abstrai: local (SQLite) ou mcp-memory (Java MCP server). Troca por 1 linha de config. |
| Conectar a MCP Memory Server | MCP é suportado como protocolo, mas não tem memory server integrado. | mcp-client.js gerencia conexão stdio, auto-download JAR, handshake MCP. |

**Veredito**: ✅ Gap real. Nativo não tem backend configurável. Único no ecossistema.

---

## 12. Plugin Auto-Update

**Plugin**: `scripts/plugin-version.json`, `scripts/plugin-updater.js` (SessionStart)
**Status**: 🟢 Plugin adiciona valor real

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Auto-update de plugins | Documentação menciona `/plugin update`, **não implementado** (CLI reference não lista). | SessionStart hook checa GitHub releases, compara semver, notifica se newer disponível. |

**Veredito**: ✅ Gap real. `/plugin update` é documentado mas não implementado.

---

## 13. Discipline Guard

**Plugin**: `scripts/discipline-guard.js` (PreToolUse Write|Edit)
**Status**: 🔴 Nativo cobre

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Proteger arquivos de modificação | **Sim**. Permission system: `acceptEdits` (auto-approve edits), `plan` (approve all), `dontAsk`. `.claude/settings.json:permissions`. | discipline-guard.js intercepta Write/Edit e aplica regras comportamentais. |
| Guardrails comportamentais | **Parcial**. Permission system + sandbox + AST parsing. Não tem "não modificar X sem perguntar" explícito, mas o sistema de permissões cobre. | Regras como "não modificar sem autorização explícita". |

**Análise**: Claude Code já pede confirmação para operações destrutivas (a menos que `dontAsk` ou `acceptEdits` esteja ativo). O discipline-guard adiciona regras comportamentais, mas o permission system nativo já cobre o caso de uso principal.

**Veredito**: 🔴 Redundante com o permission system nativo. O `dontAsk` desativaria o guard também.

---

## 14. Ack Tracker

**Plugin**: `scripts/ack-tracker.js` (SubagentStart/Stop + Stop report)
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Rastrear subagentes ativos | **Parcial**. `/agents` mostra sessões ativas. Mas não expõe via hooks de forma estruturada. | SubagentStart/Stop hooks registram início/fim. Stop hook reporta. |
| Contar subagentes simultâneos | **Não expõe**. Interno do Claude Code sabe, mas não dá para hooks acessarem. | ack-tracker mantém contador próprio via JSON em disco. |

**Análise**: O `/agents` comando nativo mostra subagentes ativos. O ack-tracker é usado internamente pelo cost-tracker para saber quantos subagentes estão rodando. O valor é como infraestrutura interna.

**Veredito**: 🟡 Útil como infraestrutura interna para o cost-tracker. Sozinho, o `/agents` nativo já cobre.

---

## 15. Billing / Cost Tracker (per-agent)

**Plugin**: `scripts/cost-tracker.js` (SubagentStop — log + alertas)
**Status**: 🟡 Nativo cobre parcialmente

| Aspecto | Claude Code nativo | Plugin |
|---------|-------------------|--------|
| Custo por sessão | **Sim**. `/cost` — tokens + estimated dollar cost para API users. | cost-tracker.log persistente cross-session. |
| Custo por agente | **Não**. `/cost` mostra total da sessão, sem granularidade por subagente. | Registra cada invocação: agente, modelo, multiplier. |
| Alertas de budget | **Não**. | Alerta quando costSensitive agent usa modelo caro. |
| Dados históricos | `/usage` mostra plan limits e rate limits. JSONL logs existem mas subcontam output tokens (~2x). | cost-tracker.log persistente, lido pelo dashboard. |

**Análise**: O `/cost` nativo dá o custo da sessão atual. O plugin adiciona granularidade por agente e persistência histórica. Valor real existe, mas é nicho.

**Veredito**: 🟢 Gap real na granularidade por agente + persistência cross-session. 🟡 `/cost` nativo já cobre 70% (sessão atual).

---

## Mapa de Decisão Final

```
Feature                        Nativo?        Decisão
──────────────────────────────────────────────────────────
1. Pattern Detection           🔴 Não faz     🟢 MANTER (gap real)
2. Correction Detection        🟡 Auto-memory 🟡 SIMPLIFICAR (nativo já cobre 80%)
3. Shell Blocking              🔴 Permission  🔴 REMOVER (nativo cobre)
3b. Shell Learning Loop        🔴 Não faz     🟢 MANTER (gap real)
4. Refine Mode                 🔴 Não faz     🟢 MANTER (gap real)
5. Model Router                🟡 model: field🟡 SIMPLIFICAR (nativo já roteia)
5b. Cost Tracking              🟡 /cost       🟢 MANTER (gap em per-agent)
6. Lesson Injection            🟡 Auto-memory 🔴 REMOVER (nativo carrega melhor)
7. Brain KB (citation graph)   🟡 Auto-memory 🟢 MANTER (gap em grafos + embed)
8. Pipeline (declarative)      🔴 Não faz     🟢 MANTER (gap real)
8b. Pipeline (execução)        🟡 Agent tool  🟡 OK como wrapper
9. Dashboard                   🔴 /config etc 🔴 REMOVER (usar comandos nativos)
10. MEMORY Rotation            🟡 autoDream   🟡 SIMPLIFICAR (nativo já consolida)
11. Pluggable Backend          🔴 Não faz     🟢 MANTER (gap real)
12. Auto-Update                🔴 Não faz     🟢 MANTER (gap real)
13. Discipline Guard           🔴 Permission  🔴 REMOVER (nativo cobre)
14. Ack Tracker                🟡 /agents     🟡 MANTER como infra interna
15. Billing (per-agent)        🟡 /cost       🟢 MANTER (gap em granularidade)
```

## Recomendações

### Remover (🔴 nativo cobre totalmente)
1. **`scripts/dashboard.js` + `dashboard/index.html`** — Claude Code tem `/config`, `/model`, `/hooks`, `/cost`, `/memory`, `/skills`, `/permissions`. Use nativos.
2. **`scripts/discipline-guard.js`** — Permission system nativo com sandbox + AST parsing cobre.
3. **`scripts/lesson-inject.js`** — Auto-memory com sideQuery() Sonnet é mais inteligente que keyword match.
4. **`scripts/curation-guard.js`** (parte de blocking) — Permission system + sandbox nativo cobre. Manter só a parte de redirect para .mjs curado.

### Simplificar (🟡 nativo cobre parcialmente)
5. **`scripts/correction-detect.js` + `agents/correction-analyzer.agent.md`** — Auto-memory já captura correções. Reduzir frequência ou remover.
6. **`scripts/model-router.js`** — Reescrever .agent.md no SessionStart é útil, mas a decisão de modelo é nativa. Simplificar para só o cost tracking.
7. **`scripts/memory-rotate.js`** — autoDream nativo já consolida. Rotation preventivo é safety net marginal. Simplificar ou confiar no nativo.

### Manter (🟢 gap real)
8. Pattern Detection (todo o sistema)
9. Shell Learning Loop (curation-detect + improver + .mjs generation)
10. Refine Mode (refine-research.js + refine-researcher)
11. Brain KB citation graph (manter, mas consciente que nativo tem auto-memory)
12. Pipeline declarativo + cascade (pipelines.json + executor)
13. Pluggable Memory Backend (brain-backend.js + mcp-client.js)
14. Auto-Update (plugin-updater.js)
15. Cost Tracking per-agent (cost-tracker.js)
16. Ack Tracker (infra interna para cost-tracker)
