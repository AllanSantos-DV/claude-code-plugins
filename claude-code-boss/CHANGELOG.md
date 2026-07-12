# Changelog

## [1.24.0] - 2026-07-12

### Changed — perfis de hooks consolidados (dev · standard · free) + troca update-safe

Mesmo no perfil `standard`, o plugin fazia demais no Stop-hook — drift para quem
usa o Claude Code com o agente normal. O perfil só silenciava 5 nudges de captura,
mas ~6 detectores capazes de **bloquear** (refine-research a cada 4º Stop,
failure-retro, research-followup, auto-continue, session-summary, curation-stop)
não passavam pelo perfil e continuavam disparando. Esta release consolida os hooks
num único eixo de enforcement, com três perfis claros:

- **`dev`** — tudo ligado: constrói a KB e enforça (a curadoria escala até 3×).
  Para quem desenvolve/estende o plugin.
- **`standard`** (padrão) — silencioso: só a curadoria dá **1 aviso soft**; os
  nudges de captura E os blockers extras do Stop (refine-research, failure-retro,
  research-followup, auto-continue) ficam desligados. O `session-summary`
  (1×/sessão) e o retrieval no início do turno continuam.
- **`free`** — passa tudo: o Stop-dispatcher faz short-circuit e **nenhum detector
  bloqueia**. O retrieval de contexto no prompt (read-only, cache-safe) continua.

Detalhes:
- **Fonte única de verdade**: `lib/hooks-config.js` ganhou o preset `free`,
  estendeu `standard` e novos getters (`getRefineResearch`, `getFailureRetro`,
  `getResearchFollowup`, `getAutoContinue`). Os detectores que antes ignoravam o
  perfil agora o respeitam; os `enabled:true` fixos saíram do config shipped para
  o preset ser autoritativo.
- **Troca update-safe**: o perfil é lido de `config/hooks-config.json` (shipped)
  mesclado com `DATA_DIR/hooks/user-config.json` (nunca versionado) — mesmo padrão
  do brain e do router. Trocar de perfil não edita mais arquivo versionado, então
  o auto-update **não reverte** a escolha.
- **Como trocar**: comando **`/boss-profile <dev|standard|free>`** (script
  `scripts/profile-set.js`) ou a aba **Hooks** do dashboard, agora com o seletor
  dos 3 perfis gravando update-safe (`GET`/`PUT /api/hooks/profile`). Vale a partir
  do próximo turno — sem reiniciar o Claude Code.
- **Testes**: matriz dos 3 perfis — getters por perfil, `free` passthrough no
  dispatcher, override `DATA_DIR` vencendo o shipped, e `saveProfile`.

## [1.23.0] - 2026-07-09

### Added — integração real com o MCP Memory Server (backend por-usuário + ingestão)

O switch `local ↔ mcp-memory` existia mas era incompleto e frágil. Esta release
fecha a integração de ponta a ponta para quem roda o **mcp-memory-server** (daemon
Java nativo) e quer usá-lo como cérebro do Brain — validado ao vivo contra um
daemon real (v2.11.9): ativar → salvar conversa → recall semântico project-scoped.

- **Ativação por-usuário (não quebra terceiros)**: `backend.type`/`mcpMemory`/
  `ingestion` agora resolvem do config publicado **mesclado** com um override
  pessoal em `DATA_DIR/brain/user-config.json`. Ligar o servidor é uma escolha
  sua — o config publicado continua `local` (default seguro para quem instala o
  plugin sem o daemon), e o ajuste **sobrevive ao auto-update**. `brain-backend`
  passou a ler o merge (`lib/brain-config.load()`); o dashboard grava só o *delta*
  vs. o shipped (`lib/brain-config.deepDiff`).
- **Dashboard: conectar em vez de baixar**. O card de Backend agora lidera com
  **http (conectar a um servidor já rodando)**, com campo de URL (vazio =
  auto-descobrir via `~/.mcp-memory/run/daemon.json`), botão **Testar conexão**
  (probe `/health`), e um **link de download manual** da release — sem baixar o
  JAR automaticamente ao ativar (redundante para quem já tem o servidor). O modo
  `stdio` (o plugin sobe o JAR) fica como avançado. i18n pt/en.
- **Ingestão da conversa (opt-in)**. Novo Stop hook `conversation-ingest` que,
  **quando ligado E no backend mcp-memory**, envia cada turno (prompt + resposta)
  ao daemon como documento `conversation` para curadoria/index server-side — então
  o recall semântico do `UserPromptSubmit` passa a encontrar a conversa, não só as
  lições curadas. Três gates (backend remoto → opt-in → dedup por hash do turno),
  silencioso, fail-open, zero-token (vai direto ao daemon por HTTP, nunca pelo
  contexto do modelo). **Default desligado** (enviar o chat é escolha explícita).
- **Identidade de projeto portável (`lib/project-id.js`)**. O `projectId` que o
  cliente carimba (handshake + ingestão + recall) deixa de ser fatalmente o nome
  da pasta. Precedência: env `CCB_PROJECT_ID` → arquivo `.claude-boss-project` na
  pasta (nome escolhido, viaja com o repo, independe de git/path) → `basename(cwd)`
  (default legado inalterado). Resolve recall entre máquinas/clones e o override
  explícito "estou na pasta X mas quero o projeto Y". `resolveProject` (recall) e
  `conversation-ingest` (ingestão) usam o MESMO resolvedor, então gravação e busca
  concordam no id.

Gate: eslint + version-sync + 349 unitários + 62 hooks verdes. Smoke ao vivo
(daemon real) cobrindo ativação, `add_document`, recall project-scoped e o
override de identidade (pasta `Hpositiva` → id `positiva`).

## [1.22.6] - 2026-07-08

### Changed — economia de token: plugin voltou a ser net-positive

Diagnóstico (custo por turno vs. o que a curadoria/memória poupa) apontou que o
default estava gastando mais do que economizava. Dois ajustes, sem código de feature
novo:

- **Gate do `[BRAIN]` apertado** (`config/brain-config.json`): `minScoreFast`
  `0.20 → 0.50` (0.20 era permissivo — ~30-40% das injeções eram ruído de baixa
  relevância), `fastTopK` `2 → 1` (injeta só a melhor lição), `minScoreDeep`
  `0.08 → 0.20`. Era o maior driver de custo por turno; independe de perfil e mantém
  todas as features.
- **Perfil default `dev → standard`** (`config/hooks-config.json`): desliga os 5
  detectores de dev no Stop (`pattern-detect`, `correction-detect`, `decisionScan`,
  `verifyNudge`, `selfReview`) e faz `curation-stop` bloquear 1x sem escalar
  (`maxAttempts: 1`). Quem desenvolve/estende o plugin volta ao comportamento
  completo com `profile: "dev"` (override sempre vence o preset).

`self-review.js` passou a aceitar config via DI (`deps.cfg`) para teste isolado
race-free; testes de comportamento `dev` (curation-stop escalation, verify-nudge)
tornados profile-explícitos. README atualizado (novo default). Gate: 62 hooks + 330
unitários verdes.

## [1.22.5] - 2026-07-05

### Fixed — schema da tool `capture_lesson` não declarava os types que os próprios hooks pedem

O `inputSchema` de `capture_lesson` só listava `enum: ['lesson', 'pattern']`,
mas os Stop hooks do próprio plugin instruem o agente a chamá-la com **outros**
types: `decision-scan-response.js` pede `capture_lesson({type:'decision'})` e
`active-research-detect.js`/`research-followup-detect.js` pedem
`capture_lesson({type:'research'})`. O handler sempre aceitou qualquer string
de type — então isso era silencioso hoje — mas um host MCP que valide o schema
rejeitaria exatamente as chamadas que os próprios nudges pedem. `brain_store`
já tinha o enum completo (`note/pattern/lesson/research/code/reference/decision`);
`capture_lesson` ficou pra trás.

- `capture_lesson` agora aceita `['lesson', 'pattern', 'decision', 'research']`,
  com a descrição de cada type explicando que hooks do plugin os pedem.
  `inferDefaultScope`/`scope-sanitizer.js` já tratava `decision`→project e
  `research`→user corretamente; nenhuma mudança de runtime, só o schema
  declarado alcançou o comportamento real.
- +1 teste de regressão: varre `scripts/*.js` por todo padrão
  `capture_lesson({type:'...'})` e assere que cada type pedido está no enum
  declarado — evita o schema divergir de novo silenciosamente.
- Gate verde (330 unit/hooks).

## [1.22.4] - 2026-07-05

### Fixed — `curation-classifier.js` ignorava o `outputLines` declarado e flagava scripts curados de conteúdo em toda execução legítima

O budget de sucesso curado era hardcoded (3 linhas / 500 chars) para TODO
script curado, ignorando o `outputLines` que a entrada em `shells.json`
declara e que `curation_register_shell` aceita. Scripts que existem para
**surfar conteúdo** (ex.: `session-transcript-mine.mjs` registrado com
`outputLines: 60`, `commits-ahead.mjs --full`) eram flagados
`curated-success-noisy` em toda execução legítima — um loop de refine
invencível (observado ao vivo: 4L/563c contra o teto fixo de 3L/500c).

Correção: novo helper puro `successBudgetFor(shell)` em
`curation-classifier.js` deriva o budget da entrada casada
(`maxLines = outputLines`; `maxChars = outputChars` ou `outputLines * 100`),
e `curation-detect.js` o injeta em `classify()` via o `curatedShell` que
`matchCuratedShell` já resolvia. `classify()` continua pura (budget chega por
parâmetro); entradas sem `outputLines` mantêm o default 3L/500c. Campo
opcional `outputChars` agora aceito em `shells.json` e no
`curation_register_shell`; skill `curation-script-pattern` documenta que
`outputLines` é **enforced**, não mais só hint. +7 testes unitários
(budget por shell, derivação, regressão do default) e +1 smoke em
`test-hooks.js` (fixture de 35 linhas com `outputLines: 60` → não flagra).
Gate verde (329 unit + hooks).

## [1.22.3] - 2026-07-04

### Fixed — `research-followup-detect.js` false-nega captura quando `capture_lesson({type:'research'})` cai no escopo `__user__`

Mesma classe de falha corrigida em `curation-stop.js` na v1.19.1: uma chamada
MCP não deixa rastro no turn journal / Bash PostToolUse, então detectores Stop
precisam reconciliar contra o store real que a tool escreveu — não só contra o
que o hook já tinha em mãos.

Aqui o desvio é mais sutil: `capture_lesson({type:'research', ...})` sempre
resolve para `scope:'user'` (`inferDefaultScope` mapeia o tipo `research` →
`'user'` incondicionalmente, em `lib/scope-sanitizer.js`), então tanto a
entrada quanto sua métrica `lesson.captured` são gravadas no banco SQLite do
projeto `__user__` — um arquivo `brain.db` **fisicamente separado** do projeto
atual. `research-followup-detect.run()` só lia `store.getEventLog(...)` do
singleton já inicializado para o projeto corrente, então nunca via aquela
captura e reabria o nudge "no capture_lesson(...) followed" mesmo com uma
lição já admitida na mesma resposta.

Corrigido lendo também o `__user__` via uma conexão descartável
(`brain-store.getEventLogIsolated`, mesmo padrão de `searchIsolated`: nunca
faz `close()`/`init()` no singleton compartilhado) e mesclando os dois fluxos
de eventos antes de decidir. Reproduzido de forma hermética (nudge no projeto
atual + `lesson.captured` gravado em `__user__`) antes e depois da correção;
+2 testes de regressão em `test-units.js` (falso-negativo cross-scope
corrigido; e um guard confirmando que "nenhuma captura" ainda dispara o
nudge). Gate verde (322 unit + 61 hooks).

## [1.22.2] - 2026-07-03

### Fixed — export/import (e outros) perdiam o CORPO das lições (`store.list()` lossy)

`brain-store.listSqlite/listJson` retorna uma projeção enxuta
(id/title/type/summary/confidence/created_at/access_count) — **sem**
`content`/`tags`/`scope`/`source`/`recurrence`. Três consumidores tratavam essas
linhas como se fossem completas:

- **`dashboard.exportBrain`**: o bundle exportado não levava o corpo das lições →
  no import as entradas viravam `content:{}`. Um usuário que exportasse e
  reimportasse seu KB (migração de máquina) **destruiria o conteúdo**. Agora relê
  cada entrada via `store.getRaw` (SELECT * → `rowToEntry`) antes de anexar vetores.
- **`scope-bulk-reclassify --commit` (crítico, destrutivo)**: lia linhas lossy,
  **deletava a original** e salvava uma cópia sem corpo em `__user__` → perda
  irreversível; a inferência de scope/tags também via sempre `undefined`. Agora
  relê via `getRaw` antes de inferir e promover.
- **`brain-cli reindex`**: reconstruía o índice só de `title+summary`, descartando
  keywords do corpo + tags. Agora `getRaw` por entrada.
- **`importBrain conflict=merge`**: passa a re-indexar + registrar a entrada
  mesclada (antes deixava índice/grafo defasados).

Descoberto ao verificar o artefato durante uma consolidação real de data-dirs (o
smoke revelou `content` vazio — o padrão "teste com ctx sintético não exercita o
contrato real"). +`smoke-scope-reclassify.js` (corpo+tags sobrevivem à promoção);
`smoke-export-import.js` agora assera fidelidade de content/tags/scope no export e
no round-trip. Gate verde (319 unit/hooks).

## [1.22.1] - 2026-07-03

### Fixed — `doctor.js` nunca detectava a fragmentação REAL de data-dir

`findDataDirCandidates` procurava dirs aninhados
(`~/.claude/plugins/<marketplace>/claude-code-boss`), mas a fragmentação real
(já registrada como lição no Brain) é por **prefixo em dirs irmãos** direto sob
`~/.claude/plugins/data/` (`claude-code-boss`, `claude-code-boss-inline`,
`claude-code-boss-<marketplace>`) — o mesmo padrão que `dashboard.js` já varria
corretamente em `resolveBestDataDir`. O check `data-dir` do `doctor` nunca
disparava o warn de fragmentação em nenhum ambiente real. Encontrado escrevendo
o smoke E2E `smoke/doctor.mjs` (as funções puras já testadas com ctx sintético
não cobriam a varredura de disco). +1 teste unitário de regressão
(`findDataDirCandidates`), +1 smoke (4 cenários: env saudável, `${...}` não
resolvido, fragmentação real, evento de hook desconhecido).

### Added — smokes E2E para Fase 0 / D1 / U3 (fechamento de processo)

O plano de auto-crítica (dispatcher, self-review, doctor) previa "gate verde +
smoke local por entrega"; os 3 componentes ficaram sem smoke dedicado.
Adicionados agora: `smoke/stop-dispatcher.mjs` (spawna o hook real — prova que é
1 processo Node só, prioridade de merge de blocks, nudge incondicional do
auto-continue), `smoke/self-review.mjs` (lição semeada no KB + arquivo "editado"
→ advisory nomeando a lição via fallback keyword-only, **sem daemon rodando** —
valida a hard constraint "nunca carregar o embedder no hook"), `smoke/doctor.mjs`
(4 cenários acima).

## [1.22.0] - 2026-07-03

### Added — F3 higiene do KB (#5) + precisão do retrieval (#7) (Fase 3)

Fecha o ciclo de memória.

**#5 — Consolidação do KB (`brain-consolidate.js`)**: agrupa lições
near-duplicate (cosseno em **0.7–0.9**, mesmo tipo) usando os **vetores já
armazenados** (sem carregar o modelo), mescla cada grupo num sobrevivente
**somando recurrence** e apaga os absorvidos. Planner puro/testável
(`lib/consolidate-plan.js`, union-find + sobrevivente determinístico). **Dry-run
por padrão**; `--apply` para efetivar. Gatilho manual no dashboard (Preview/Apply)
+ **cooldown semanal** no SessionStart (fire-and-forget). O prune de one-hits já
roda no SessionStart (`curation-session.js`). Novos `brain-store.listWithVectors`
+ `setRecurrence`.

**#7 — Precisão do retrieval**: `retrieval-feedback.js` agora grava
`retrieve.injected {count}` (denominador) além de `retrieve.cited`. O card
"Retrieval precision (cited/injected)" na Home mostra a % de blocos `[BRAIN]`
efetivamente citados — insumo pra calibrar o gate de relevância **0.20**
(precisão baixa e estável = gate frouxo; alta = pode apertar). Agregação em
`lib/value-summary.js`.

- Testes: +8 unitários (planner, runner com fake store, precisão). Gate verde.

### Added — D3 checklist de review a partir de lições recorrentes (Fase 1)

Lições de **código** recorrentes viram um `.claude/brain-review-checklist.md`
curto que o `/code-review` nativo lê como contexto de projeto (1 item por lição,
com link `<!-- kb:id -->`).

- Geração **pega carona no fluxo de promoção** (`brain-promote.js scan`, já
  disparado pelo `skill-promote-trigger`): sem hook novo pra escrever. Filtra
  lições/patterns com `recurrence >= minRecurrence` **e** tags de código
  (`lib/review-checklist.js`, puro/testável); corpo determinístico (sem
  timestamp) pra não gerar reescritas ruidosas; se não há mais lições de código,
  remove o arquivo (mantém verdade).
- Advisory de 1 linha no SessionStart (`review-checklist-advisory.js`, cooldown
  6h) menciona o checklist quando ele existe, apontando o `/code-review` pra ele.
- Testes: +5 (seleção/render puros, countItems) + 2 E2E (presente/ausente).

### Added — U3 doctor: diagnóstico zero-config (Fase 2)

Novo `scripts/doctor.js` (`npm run doctor`, botão no dashboard e advisory de 1
linha no SessionStart) que reporta OK/WARN/FAIL por item, cada um com o conserto
em 1 linha:

- **Node no PATH + versão >= 22.13** (requisito do `node:sqlite`);
- **`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` resolvidos** (detecta literais `${...}`);
- **fragmentação de data-dir**: detecta múltiplos dirs populados (inline vs
  marketplace vs legacy), aponta o ativo e sugere consolidar via export/import;
- **modelo de embedding** presente no cache durável (senão, roda em modo keyword);
- **daemon HTTP**: health + token legível (lock stale → warn);
- **eventos de hook declarados vs suportados**: resolve o pendente —
  `UserPromptExpansion`/`PostToolUseFailure` são marcados como
  **runtime-dependent** (VS Code Copilot / Claude Code novo; no-op em runtimes que
  não os disparam).
- Checks são funções **puras** sobre um snapshot de contexto (testáveis);
  `gatherContext()` faz o probe real (best-effort, nunca lança).
- Advisory no SessionStart (`doctor-advisory.js`) roda só os checks críticos e
  baratos (Node + env), com cooldown de 6h, e é silencioso quando está tudo bem.
- Endpoint `/api/doctor` + botão "Run check" na Home.
- Testes: +8 unitários (cada check + runChecks/summarize). Gate verde.

## [1.21.0] - 2026-07-03

### Added — D4 card learning-loop no dashboard (Fase 1)

Novo card na Home ("Learning loop") sobre o sinal que já existe: `lesson.captured`
com `decision:'merge'` = a MESMA lição recorreu. Mostra capturadas vs. mescladas
por semana (mini-barras) + a taxa de merge com leitura interpretativa:

- **Taxa de merge caindo** → a autocrítica está mudando o comportamento (menos
  repetição de erros).
- **Subindo** → a lição não está sendo aplicada (o loop precisa de atenção).

Zero hook novo e zero métrica nova: usa `lib/value-summary.js` (learningLoop) e o
endpoint `/api/metrics/value-summary` já entregues no U2. Só agregação existente +
UI.

### Added — U2 valor visível: cards no dashboard + resumo de sessão (Fase 2)

O processo é invisível; agora o **valor** aparece. Home do dashboard ganha um
bloco "Value at a glance (last 30 days)" com 3 cards baratos, sobre dados que já
existem nas métricas:

1. **Tokens of raw output curated away** — soma de `curation.flagged.chars`
   (output bruto que estourou os limites de curadoria) ÷ 4.
2. **Lessons learned** — contagem de `lesson.captured`.
3. **Memories cited in replies** — contagem de `retrieve.cited`.

- Novo métrico `curation.flagged {chars, lines, reason}` em `curation-detect.js`
  (fire-and-forget, nunca bloqueia) — a única instrumentação nova; os demais
  cards usam métricas já existentes.
- Agregação pura e testável em `lib/value-summary.js` (também já calcula o sinal
  de learning-loop do D4). Endpoint `/api/metrics/value-summary?days=30`.
- **Resumo de sessão**: novo detector `session-summary` (14 detectores no
  dispatcher) injeta **uma** linha por sessão — "[SESSION] Captured N lesson(s)
  this session — the Brain is learning." — quando a sessão capturou ≥1 lição.
  Cap 1/sessão; janela ancorada no stamp de SessionStart (gravado por
  `curation-session.js`, sem novo spawn). Agent-facing EN; ligado nos dois perfis.
- Config `sessionSummary {enabled}`.
- Testes: +7 unitários (agregação, learning-loop, janela de sessão, resumo) e +1
  E2E. Gate verde.

### Added — D1 self-review alimentado pela memória (Fase 1)

Quando o turno editou arquivos, o Stop procura lições/failures passadas
relevantes a esses arquivos e injeta **um** aviso curto para o agente revisar o
próprio trabalho contra erros que ele já registrou:

```
[SELF-REVIEW] Files edited this turn resemble past lessons — verify before delivering:
  • "widget parser off-by-one" (recurrence 2) [lesson]
```

- **Restrição dura respeitada**: o modelo de embedding **nunca** é carregado no
  processo do hook. Retrieval em `lib/self-review-retrieve.js` com duas rotas:
  1. **Primária** — o daemon HTTP do brain-server (modelo já quente lá). Cliente
     MCP-sobre-HTTP mínimo e **autenticado por token** (`brain-http.token`),
     best-effort: porta lida do `brain-http.lock.json`, timeout curto, qualquer
     falha → `null` (cai pro fallback).
  2. **Fallback** — keyword-only via índice invertido `brain-index` +
     `brain-store.get` (sem embedder). Sempre disponível.
- Sinal de arquivos editados vem do verify-journal por-turno (D2). `self-review`
  é ordenado **antes** de `verify-nudge` no dispatcher (13 detectores agora):
  self-review só lê; verify-nudge é dono do clear de fim-de-turno.
- Gate de score + `topK` + filtro por tipo (`['lesson','failure']`). Guard
  por-sessão de "já mostrado" evita re-nagging da mesma lição em turnos seguintes.
- Injeção journaled no retrieval-journal com `tool:'Stop/self-review'` → alimenta
  a métrica de precisão do F3.
- Config `selfReview {enabled, topK:2, minScore:0.2, types}`. OFF no perfil
  `standard` (é ferramenta de dev, como os demais nudges de autocrítica).

### Fixed — verify-journal: clear de fim-de-turno agora é incondicional

`verify-nudge` retornava antes de limpar o verify-journal quando desabilitado
(perfil standard) ou em retry — mas `file-edit-detect`/`curation-detect` seguem
escrevendo, então o journal crescia sem limite. Agora o dreno acontece **sempre**
(o `self-review`, ordenado antes, já leu as edições do turno).

## [1.20.0] - 2026-07-02

### Added — U1 perfil `standard`: abre o plugin pra não-mantenedores (Fase 2)

`hooks-config.json` ganha um campo `profile` (`"dev"` | `"standard"`, padrão
`"dev"` — comportamento atual **intocado**). O perfil é um **overlay de defaults,
não uma trava**: a resolução é `deepMerge(PRESET[profile], arquivo)`, então
qualquer valor explícito no arquivo **vence** o preset (override ganha).

- Resolução centralizada em `lib/hooks-config.js` (função pura
  `resolveProfileConfig`, testável): o preset `dev` é vazio (os defaults dos
  getters já reproduzem o comportamento atual); só `standard` carrega o delta.
- Perfil `standard` (silencioso, "informa 1x, não escala"):
  `curationStop.maxAttempts=1`; `patternDetect`/`correctionDetect`/`decisionScan`
  e `verifyNudge` **OFF**. Retrieval `[BRAIN]`, brain-health, memory-rotate e
  session-whitelist seguem **ON** nos dois perfis (invisíveis, só ajudam).
- Gates de `enabled` adicionados a `pattern-detect`, `decision-scan-response` e
  `correction-detect` (curation-stop/verify-nudge já liam o getter). Novos
  getters `getProfile/getPatternDetect/getCorrectionDetect/getDecisionScan`.
- Dashboard (aba Hooks): seletor de perfil dev|standard com descrição de 1 linha;
  salvar grava o campo `profile` via o endpoint existente (validação real).
- `config/hooks-config.json`: `curationStop.maxAttempts` e `verifyNudge.enabled`
  saem do arquivo (passam a ser controlados pelo perfil); `profile: "dev"` entra.
- Testes: +11 unitários (resolução pura, override-wins, getters por perfil,
  regressão do shipped config) e +4 E2E (verify/pattern/correction OFF em
  standard; pattern dispara em dev). Gate verde.

### Added — D2 verify-nudge: "editou mas não testou" (Fase 1, self-review)

Primeiro detector de autocrítica alimentado pela atividade do turno. Se o agente
editou arquivos **e não rodou nenhum comando de teste/verificação** no turno, o
Stop injeta **um** aviso curto (advisory), pedindo pra rodar os testes antes de
entregar. É **nudge, não gate**: um contador por sessão limita o total
(`maxBlocks`, padrão 1) e não há escalonamento.

- Novo journal por-turno `lib/verify-journal.js` (race-free, prefixo próprio
  `turn-verify-<sid>--` — isolado do turn-journal de curadoria).
- Novo hook PostToolUse `Edit|Write|NotebookEdit` → `file-edit-detect.js` grava
  `{kind:'edit', path}`. A captura de assinatura de comando pega carona no hook
  Bash já existente (`curation-detect.js`) → **zero spawns novos** no caminho Bash.
- Novo detector in-process `verify-nudge` no dispatcher (12 detectores agora).
  Heurística de "rodou verificação": a sig canônica OU o id/script do shell
  curado contém um token de teste (`test`, `spec`, `vitest`, `pytest`, `gate`,
  `lint`, `tsc`, …), com `\b…\b` pra não casar `latest`/`investigate`. Extensível
  via `hooksConfig.verifyNudge.testPatterns`.
- Config nova `verifyNudge {enabled, maxBlocks, testPatterns}` (ligado no perfil
  dev, que é o padrão; U1 depois desliga no perfil standard).
- Testes: +10 unitários (regex de teste, `evaluate`, roundtrip do journal) e +4
  E2E de hook (journal de edit; nudge dispara; suprimido quando teste rodou;
  suprimido no teto do contador). Gate verde.

### Changed — Stop dispatcher: 11 spawns viram 1 passo in-process (Fase 0)

Cada `Stop` disparava 11 processos Node (um por detector) — o maior custo do hook
de Stop, e os detectores de autocrítica planejados (D1/D2) só somariam mais. Um
único `scripts/stop-dispatcher.js` agora lê o evento uma vez e roda os 11
detectores **in-process**, em sequência, medindo cada um e mesclando os bloqueios
num único `{decision:'block', reason}` (ou `{}`).

- Cada detector de Stop expõe agora um `run(event) → {block,reason} | {}` puro
  (sem ler stdin / escrever stdout) e mantém um wrapper CLI fino
  (`require.main===module` → `hook-io.runStopDetectorCli`), então rodar
  `node <script>.js` isolado e os testes de regressão seguem idênticos.
- Os 5 scripts que executavam no `require` (`pattern-detect`,
  `skill-promote-trigger`, `decision-promote`, `refine-research`,
  `curation-stop`) viraram **import-safe**.
- Ordem preservando comportamento: `decision-scan-response` grava o pending antes
  de `decision-promote` ler; `failure-retro` roda **antes** de `curation-stop`
  para ainda enxergar o turn-journal pendente e ceder a vez ("curation priority")
  antes da limpeza. Prioridade de merge: `curation-stop` > `failure-retro` > resto.
- Detectores com SQLite (`research-followup-detect`, `skill-success-detect`,
  `retrieval-feedback`) passam a compartilhar **um** handle de banco aberto em vez
  de reabrir por spawn.
- Latência: novo métrico `stop.detector {name, ms}` por detector (+ `stop.dispatch`)
  — insumo do card de latência do dashboard.
- `hooks.json` Stop agora tem **uma** entrada (`stop-dispatcher.js`, timeout 30).
- Testes: +7 unitários (merge / prioridade / invariantes de ordem) e +2 E2E de
  hook (all-quiet → `{}`; 2 bloqueios → merge em ordem de prioridade). Gate verde.

## [1.19.1] - 2026-07-02

### Fixed — curation Stop retry ignorava `curation_mark_oneoff` (deadlock de 3 retries)

Bug observado ao vivo (dogfooding): o agente respondia ao bloqueio do `curation-stop.js`
chamando `curation_mark_oneoff` — exatamente o que o reason pede — mas a detecção de
progresso do retry só enxergava entradas Bash do turn-journal e mtime de script curado.
Chamadas de tool MCP não deixam rastro Bash, então o agente ficava bloqueado pelos 3
retries refazendo trabalho já feito.

- `curation-stop.js` agora **reconcilia** `blockedEntries` com o one-hit store (por `sig`
  do journal) e com o `shells.json` (só quando a mtime é posterior ao primeiro bloqueio —
  registro mid-turn via `curation_register_shell`) antes de escalar; qualquer entrada
  resolvida libera o Stop. Novo lib puro `lib/curation-reconcile.js` (testes herméticos).
- Sinal anti-deadlock adicional: qualquer marcação one-hit com `markedAt >= firstBlockedAt`
  conta como progresso, mesmo se o sig não casar (ação de boa-fé).
- `curation_mark_oneoff` aceita novo parâmetro **`sigs`** — os `sig` do reason passados
  verbatim (match exato no store, sem derivação de alias que pode errar). O reason do
  Stop agora instrui a usá-lo. `aliases` segue funcionando.
- Estado legado de escalonamento sem `blockedEntries` preserva o comportamento antigo
  (overlap por assinatura) — sem release espúrio.
- Testes: +7 unitários (isOneHit, markedSince, mark por sigs, reconcile) e +1 E2E de hook
  (retry + one-hit marcado → release `{}` + estado de escalonamento limpo).

### Fixed — `canonicalSig` cortava em `|`/`<`/`>` dentro de aspas

Observado ao vivo: `grep -n "oneoff\|curation-stop" arquivo` gerava sig truncada
`grep "oneoff\` — perdia os operandos e colidia greps não relacionados (contagem de
recorrência fragmentada/inflada). O corte agora é **quote-aware**
(`indexOfShellMeta`): metachar entre aspas ou escapado é dado do argumento, não pipe.
Sigs históricas sem aspas (ex.: `npm test 2`) preservam a identidade; entradas
antigas com sig truncada envelhecem via prune (cutover limpo, sem migração).

### Security — auth no daemon HTTP do Brain (token + Origin guard)

Bind em `127.0.0.1` não é autorização: qualquer processo local (ou página via DNS
rebinding) podia ler/poluir o KB via `/mcp` ou derrubar o daemon via `/shutdown`.
Mesmo padrão do dashboard:

- Token gerado no primeiro boot e persistido em `<DATA_DIR>/brain-http.token`
  (sobrevive a upgrades; fixável via `BRAIN_HTTP_TOKEN`). `/mcp` e `/shutdown`
  exigem `Authorization: Bearer <token>` (ou `X-Brain-Token`), comparação
  constant-time; `/health` permanece aberto para o supervisor stale-vs-current.
- Requests com `Origin` não-localhost → 403 (guarda anti DNS-rebinding; clientes
  nativos não enviam Origin).
- `daemon-supervisor` envia o token no `POST /shutdown` (header extra inofensivo
  para daemons pré-auth durante o swap de versão).
- Novo smoke E2E `smoke/brain-http-auth.mjs` (7 asserções: health aberto, 401 sem
  token, 403 Origin estrangeira, handshake com token, shutdown gated).

## [1.19.0] - 2026-07-02

### Added

- Sticky Tier Router (opt-in, cache-safe): picks the model tier once per session (turn 0) via a content-hash session key and holds it constant, so Anthropic's per-model prompt cache is preserved instead of being broken every turn.
- Limit Fallback decoupled into its own opt-in `fallback-only` passthrough mode: forwards requests unchanged (cache-safe) and only diverts on HTTP 429 (Claude usage-window exhausted) to NVIDIA NIM when a key is set, else prompts `/dashboard`. Works even with per-turn routing disabled.
- Dashboard: live router mode indicator (off / sticky-tier / fallback-only / per-turn) with a color dot and a "reload pending" hint, surfaced from the server `/health` and state file.
- Dashboard: full visual reskin using Anthropic's official brand (Poppins/Lora typography, brand palette) with light and dark themes.

### Changed

- Per-turn cost-routing (`enabled`) is now DEPRECATED (kept functional): routing to a different model per request breaks the per-model prompt cache (documented anti-pattern). Prefer the Sticky router. Router remains OFF by default.

## [1.18.0] - 2026-07-02

### Added — tool `curation_register_shell` (criar script curado sem Write/Edit manual)

O Stop hook `curation-stop.js` pede pra criar um script curado + registrar em
`shells.json` quando um comando bruto gera output volumoso. Até aqui isso só dava pra
fazer via `Write`/`Edit` do próprio Claude Code — e o classificador do Auto Mode trata
essa escrita como "persistent configuration fora do escopo da tarefa", bloqueando
repetidamente mesmo com autorização do usuário em chat.

- **Nova tool MCP `curation_register_shell`**: recebe `{ id, scriptPath, content,
  aliases, label?, icon?, outputFilter?, outputLines?, timeoutMs?, cwd? }`, escreve o
  arquivo do script e adiciona/atualiza a entrada em `shells.json` num único passo,
  server-side — sem passar pelas ferramentas de edição de arquivo que o classificador
  intercepta. Chamar de novo com o mesmo `id` **atualiza** em vez de duplicar.
- **Novo módulo `scripts/lib/shell-register.js`**: reaproveita `isGenericAlias`
  (mesma validação "alias too broad" de `curation_mark_oneoff`) e resolve a raiz do
  projeto **limitada ao repositório git** de `cwd` — proteção contra o
  `findProjectRoot` (que sobe diretórios procurando qualquer `shells.json`) vazar
  para fora do projeto atual e escrever num `shells.json` de outro lugar (ex.: home
  do usuário). Também valida que `scriptPath` não escapa do diretório de scripts
  esperado (guarda contra path traversal).
- **`curation-stop.js`** e a skill `curation-script-pattern` atualizados para citar a
  nova tool como caminho preferido de CREATE, mantendo Write/Edit manual como
  fallback.
- **+8 testes unitários** para `shell-register` (criação, update idempotente,
  validações, guarda de path traversal, formatação do JSON).

## [1.17.0] - 2026-07-02

### Changed — roteador de modelo agora é OPT-IN (desligado por padrão)

Rotear cada request para um modelo diferente **quebra o prompt cache da Anthropic** e
**aumenta o custo**. O cache é **por modelo**: a cada troca (haiku/sonnet/opus) o prefixo
inteiro (system + tools + histórico) vira **cache-miss** no modelo novo e é cobrado como
**input cheio (1,0×)** + **cache-write (1,25× em 5 min / 2× em 1 h)**, no lugar do
**cache-read (0,1×)**. Em ferramentas como o Claude Code — que mantêm um prefixo enorme
quente entre turnos — isso faz "o cache todo virar pago". A Anthropic ainda oferece
controle **first-party** de custo/qualidade pelo parâmetro `effort` **no mesmo modelo**
(sem quebrar cache), tornando o roteador externo redundante e caro como default.

- **`config/router-config.json`**: `enabled` **`true` → `false`** (+ `_comment_enabled`
  documentando o custo/cache e como ativar).
- **`scripts/model-router-ensure.js`**: `readConfig()` passa a fazer **merge
  `shipped ⊕ DATA_DIR/model-router/user-config.json`** (novo `mergeRouterConfig`, espelha
  o `mergeUserConfig` do server — `nim`/`routing` raso, escalares sobrescrevem). É o que
  torna o **opt-in durável**: ligar em `/dashboard → Router` grava `{enabled:true}` no
  user-config e **sobrevive a updates**. `main()` agora é guardado por
  `require.main === module`; o módulo exporta `mergeRouterConfig`/`readConfig` p/ testes.
- **Dashboard**: o toggle `#router-enable` já existia e continua sendo o caminho de
  opt-in — nenhuma mudança de UI necessária.
- **Nota**: com o roteador off, o **plano B de limite (429 → NVIDIA/aviso)** também fica
  inativo até ligar — é o mesmo proxy.
- **+6 testes** herméticos (`mergeRouterConfig` + lock `enabled === false` no shipped).

## [1.16.0] - 2026-07-01

### Added — dashboard: status do roteador ao vivo + auto-update do plugin

O plugin é instalado por um **marketplace local** (git-subdir), então o `/plugin` do
Claude Code **não puxa atualização** sozinho — só o aviso de 24h. Esta versão fecha
esse buraco pelo próprio dashboard e torna a atividade do roteador **visível**.

- **Luz de status ao vivo** na aba do Roteador: um ponto ao lado de **Status** fica
  **verde pulsante** quando o proxy está no ar e **cinza** quando parado (reusa
  `.router-dot`), complementando o texto `running · porta · PID` que já existia.
- **Card "Plugin & atualização"**: mostra a **versão instalada** (+ sha curto e versão
  do Node), a **última release no GitHub**, botão **Verificar atualizações** e, quando
  há versão nova, **Atualizar agora** — com dica de rodar `/reload-plugins` depois.
- **Novo módulo `scripts/lib/plugin-updater.js`** (self-update): consulta
  `releases/latest`, baixa o ZIP do asset (seguindo redirects de CDN), valida o
  `package.json` extraído, copia para o cache `~/.claude/plugins/cache/.../<sha>/`,
  roda `npm install --omit=dev` e reaponta o `installed_plugins.json` (com backup).
  Mata `brain-server` **stale** de caches antigos — **nunca** o próprio PID que
  responde ao POST. Faz deref de tag anotada para o SHA real (fallback `rel-X-Y-Z`).
- **Rotas no dashboard**: `GET /api/plugin/version`, `GET /api/plugin/update-check`
  (cache 6h em memória, API anônima do GitHub — sem misturar credencial) e
  `POST /api/plugin/update`.
- **Aviso `[model-router] ATIVO` 1x por sessão** (antes repetia todo turno): reduz o
  ruído de contexto que consumia tokens à toa.
- **+6 testes herméticos** (`parseVersion`/`compareSemver`/`pickAsset`/
  `computeUpdateState`), validados contra a release real do GitHub.

## [1.15.0] - 2026-07-01

### Added — opt-out de auto-injeção de LIÇÕES do Brain

- **Nova config `kb.retrieval.contextExcludeTypes`** (default `[]`): lista de tipos
  (`lesson`/`pattern`/`reference`/`memory`) que **não** entram no bloco `[BRAIN]`
  auto-injetado no `UserPromptSubmit`. Não afeta o **retrieval** nem a **captura** —
  só o que é efetivamente injetado no prompt. Default `[]` = injeta todos
  (comportamento atual), **retrocompatível**.
- **Getter `getContextExcludeTypes()`** (normaliza para trim/lowercase; não-array →
  `[]`) e função pura **`filterInjectableEntries(entries)`** (exportada e testável)
  em `scripts/lib/retrieve-core.js`.
- **User-override durável em `DATA_DIR/brain/user-config.json`**: deep-merge sobre o
  config shipado (mesmo padrão do model-router), então a preferência **sobrevive ao
  auto-update** do plugin e liga o filtro só para o usuário, sem tocar no repo.
- **+6 testes herméticos**: `getContextExcludeTypes` (default/normalização/não-array),
  deep-merge do override preservando os demais campos do shipado, e
  `filterInjectableEntries` (exclui `lesson`, mantém `reference`/`pattern`,
  case-insensitive, vazio → `[]`).

### Changed

- O Brain **deixa de auto-injetar LIÇÕES** (`type=lesson`) no prompt quando
  `contextExcludeTypes` inclui `"lesson"`, **eliminando a dupla-injeção**: o
  skill-kit semântico (bge-m3) passa a ser a **fonte única** de lições no prompt.
  `retrieve()` e `formatContext()` permanecem **intactos** e o journal segue medindo
  o retrieval **real** — só a **injeção** passa pelo filtro. Captura
  (`capture_lesson`), skill-promotion, `brain_search` sob demanda e a injeção de
  `reference`/`pattern`/`memory` seguem **inalterados**.

## [1.14.0] - 2026-06-30

### Added — router: catálogo DINÂMICO de modelos por assinatura

O roteador deixa de ficar **travado em modelos hardcoded** (`sonnet-4-6`/`opus-4-8`/
`haiku-4-5`) e passa a descobrir os modelos da **sua própria assinatura** em runtime,
para acompanhar lançamentos (ex.: Sonnet 5, mais barato) sem editar config nem
esperar release.

- **Novo módulo `servers/model-router/catalog.js`**: consulta `GET /v1/models` da
  Anthropic usando a **credencial que o Claude Code já manda** (logo o resultado já
  vem escopado pelo seu plano Pro/Max/API). Por família (haiku/sonnet/opus) elege o
  modelo **mais novo** (`created_at`) e lê os níveis de `effort` **reais** de
  `capabilities.effort` — fim do mapa estático de effort que defasava a cada modelo
  novo.
- **`resolveModel` e `reconcileEffort` cientes do catálogo**: quando o catálogo está
  aquecido, o tier resolve para o modelo dinâmico e o effort é reconciliado pela
  capacidade real do destino; sem catálogo, comportamento **idêntico** ao mapa
  estático.
- **À prova de hot path**: o refresh é assíncrono (fire-and-forget) e a leitura é
  síncrona com **fallback total** ao estático. Se `/v1/models` estiver offline ou o
  token não tiver escopo de listagem (401/403), nada quebra — segue no mapa shipado.
  Cache com TTL (1h), backoff de erro (5min) e guarda anti-rajada.
- **Config `routing.catalog`** (`enabled` default ON, `ttlMs`, `errorBackoffMs`) e
  endpoint **`GET /catalog`** no proxy para observabilidade (snapshot + idade).
- **+11 testes herméticos** (servidor `/v1/models` fake): eleição do mais novo,
  extração de effort, paginação por cursor, fallback em 403, e integração
  `resolveModel`/`reconcileEffort` ligado/desligado.

### Fixed — Desktop: roteamento restaurado via shim do claude.exe

O Claude **Desktop 2.1.197** passou a **forçar** `ANTHROPIC_BASE_URL=
https://api.anthropic.com` no processo do claude-code (entrypoint `claude-desktop`),
fazendo o claude-code **ignorar** o bloco `env` do `settings.json` — então o
roteamento (proxy local) deixou de valer na GUI. Causa provada em laboratório e no
próprio código do app (host de produção hardcoded). Não é algo que o plugin ou a
assinatura controlem.

- **Shim isolado do binário** (`servers/model-router/wrapper.cs` +
  `scripts/model-router-shim.js`): o plugin renomeia `claude.exe`→`claude-real.exe` e
  instala um wrapper minúsculo como `claude.exe`. Quando o Desktop spawna o
  claude-code, o wrapper troca a URL pelo **proxy local** e chama o binário real,
  herdando stdio (stream-json passa transparente). A GUI não muda.
- **Cirúrgico e reversível**: afeta **somente** o `claude.exe` do Claude Code — zero
  variável global, zero PATH, zero hosts, zero CA (o oposto de mexer no ambiente do
  sistema, que vazaria para outros apps). Instalação **atômica com rollback** e
  **fail-open**: se o roteador estiver fora do ar, o wrapper deixa o Claude ir
  **direto** — nunca derruba o app. O Job Object usa
  `KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`: fechar o app encerra o claude-code (sem
  órfãos), **mas** os netos **detached** — em especial o proxy `model-router`, que
  precisa persistir entre reaberturas — **escapam do job e sobrevivem**. Sem o
  `SILENT_BREAKAWAY_OK`, o roteador morreria junto ao fechar o Desktop e a reabertura
  seguinte ficaria sem rota na 1ª mensagem (validado ao vivo).
- **Auto-mantido**: o hook `ensure` (SessionStart) instala/reaplica o shim na versão
  ativa do claude-code e, após updates do app, reinstala na nova versão. Publica a URL
  viva em `~/.claude/model-router-url.txt` (lida pelo wrapper). O `env` do
  `settings.json` continua mantido para o modo **CLI** (que o respeita). `.verified`
  não é tocado (o Windows não revalida o hash em runtime).
- **+18 testes herméticos** (dirs fake, nunca tocam no binário real): comparação de
  versão, detecção de estado (instalado/reaplicar/órfão), instalação idempotente,
  rollback, remoção e seleção da versão mais nova; compilação via csc validada no
  Windows.

## [1.13.0] - 2026-06-30

### Added — learning: telemetria de eficácia do loop (nudge → captura)

O loop de aprendizado curado agora é **medido**: dá pra ver quantos "empurrões"
(nudges) dos detectores realmente viram lição salva, em vez de confiar no escuro.

- **Evento canônico `nudge.emitted{kind}`**: todo detector que sugere capturar uma
  lição passa a emitir um evento padronizado. `correction-detect` e `pattern-detect`
  (que antes não emitiam nada) agora emitem; `decision-promote`, `failure-retro`,
  `active-research-detect` e `research-followup-detect` tiveram seus eventos
  renomeados para o formato único `nudge.emitted` com o `kind` da origem.
- **Taxa de conversão por tipo** (`scripts/lib/capture-rate.js` →
  `aggregateCaptureRate`): cruza `nudge.emitted{kind}` com `lesson.captured{type}`
  para calcular a taxa nudge→captura por tipo, mais um bucket `spontaneous` (lições
  salvas sem nudge prévio). A correlação é **por projeto** (o `lesson.captured` vem
  com `session_id` nulo), agregando todos os projetos com métricas.
- **Dashboard**: endpoint `/api/metrics/capture-rate` (via `getCaptureRate`, que
  reusa `listMetricsProjects`/`aggregateAcrossProjects`) e um card **"Loop efficacy"**
  mostrando a eficácia do loop por tipo.
- Mantém-se retrocompatível e sem efeito no caminho quente — é instrumentação de
  leitura sobre o ledger de métricas que já existia.

## [1.12.0] - 2026-06-30

### Added — brain: backend remoto via Native Java (MCP StreamableHTTP)

O cérebro (Brain KB) do Boss agora pode usar um **servidor de memória externo**
(o daemon "Native Java" / `mcp-memory-server`) como backend, em vez do SQLite local
— sem perder a retrocompatibilidade (o **default continua local**).

- **Transport HTTP no MCP client** (`scripts/mcp-client.js`): além do `stdio` (jar
  via spawn), o cliente fala **MCP StreamableHTTP** (`POST /mcp`, respostas JSON
  puras). Faz discovery do daemon por `~/.mcp-memory/run/daemon.json` (override
  `runDir`), sonda `/health`, faz `initialize` carimbando o `projectId` (escopo da
  sessão inteira), captura o header `Mcp-Session-Id` e o repassa em toda request,
  manda `notifications/initialized` (204) e `DELETE /mcp` no close. Protocolo
  `2025-06-18`. Não envia header `Origin` (evita 403 fora de loopback).
- **Dispatcher reescrito pro contrato real do daemon** (`scripts/brain-backend.js`):
  os wrappers MCP foram corrigidos contra o servidor v2.10.1 — `add_document`
  manda `{content, metadata}` e lê o id do texto `Document added with ID: <uuid>`;
  `search_memory` usa `topK` e parseia o **objeto** `{results:[…]}` (antes esperava
  um array → vinha sempre vazio); `get/delete/list_document(s)` usam `documentId`;
  `get_related_documents` (inexistente no daemon) é **emulado** via `search_memory`
  do texto do doc. `peekMode()` lê o modo sem conectar.
- **Caminho quente roteável**: leitura (`scripts/lib/retrieve-core.js` →
  `retrieveRemote`) e escrita/busca do brain-server (`servers/brain-server/lib/mcp-server.js`
  → `handleRemoteKbTool`, `REMOTE_KB_TOOLS`) passam pelo dispatcher quando o backend
  está em modo `mcp-memory` — então a injeção de contexto e o `brain_store` realmente
  usam o servidor externo, não só CLI/dashboard.
- **Config** (`config/brain-config.json`): `backend.mcpMemory` ganhou
  `transport`/`serverUrl`/`runDir`/`projectId` (defaults `stdio`/vazios; `backend.type`
  segue `local`). **Config-tester** (`scripts/config-testers/mcp-memory.js`) valida o
  modo `http` sondando o `/health` do daemon e reportando a versão.
- **Limitação v1 (honesta)**: o scope `user` (lições cross-project) não é modelado
  remotamente — em modo remoto tudo fica sob o `projectId`; `scope` vira só metadata.
- Testes herméticos novos (daemon `/mcp` fake): transport HTTP (sessão+projectId),
  mapeadores do dispatcher e config-tester remoto. Gate **161/0**.

### Fixed — teste flaky de isolamento (`brain-health [UserPromptSubmit/defects→advisory]`)

Usava um data-dir **fixo** (`/tmp/ccb-bh-broken`), então o stamp de throttle
(`.brain-health-last`, cooldown 60s) vazava entre execuções do gate e estrangulava o
advisory no 2º run rápido → falso negativo. Agora usa um `mkdtemp` fresco como os
demais brain-health tests.

## [1.11.0] - 2026-06-30

### Added — model-router: roteamento de modelo por peso do prompt (proxy local)

Um proxy HTTP local (`servers/model-router/`) que fica **entre o Claude Code e a
API da Anthropic**: classifica o "peso" de cada prompt com um embedder MiniLM local
e reescreve o campo `model` para rotear **haiku / sonnet / opus** dentro da própria
assinatura do usuário — o objetivo é **esticar a janela de acesso**, gastando opus só
quando o trabalho realmente pede.

- **Engine** (`servers/model-router/index.js`): bind em **porta fixa** (13456),
  classificação local por âncoras de cosseno e estado/log em `DATA_DIR/model-router/`.
  Porta já ocupada por um router nosso saudável → **reuso** (sai limpo, sem incrementar),
  mantendo a URL estável.
- **Contagem de tokens isenta** (`/v1/messages/count_tokens`): essas chamadas são
  **gratuitas** na Anthropic e independem do modelo (tokenizer compartilhado) — o proxy
  as **repassa verbatim**, preservando o path original, **sem** classificar, trocar de
  modelo ou acionar o plano B. Antes o forward reescrevia **qualquer** path para
  `/v1/messages` (hardcoded), convertendo a contagem **grátis** em **geração paga** e
  saturando o rate limit no boot (rajada de 429 → planos-B inúteis). O forward agora
  **preserva o path/query original** em todas as requisições.
- **Isolamento via `settings.json` env** (PROVADO em Claude Desktop v42.4.0): a redireção é
  **escopada ao Claude Code** gravando `ANTHROPIC_BASE_URL=http://127.0.0.1:13456` no bloco
  `env` do `~/.claude/settings.json`. O cowork do Desktop **respeita** esse env e o aplica
  **só aos processos do Claude Code** → zero efeito em outros apps (ex.: GitHub Copilot/hermes).
  **Nunca** definimos variáveis no nível User/sistema (vazariam e corromperiam outros apps) nem
  dependemos de wrapper do `claude.exe` (incompatível com a instalação MSIX/Store, read-only).
  O wrapper C# e o patcher via `NODE_OPTIONS` de versões anteriores foram **aposentados**.
- **Ativação por hook** (`scripts/model-router-ensure.js`): SessionStart + UserPromptSubmit
  sobem o servidor na porta fixa e gravam `env.ANTHROPIC_BASE_URL` **só quando o roteador está
  vivo**, removendo-o no instante em que não está (porta morta = "Solicitação falhou") —
  idempotente, escrita atômica, e com **self-heal** de qualquer resíduo global de versões antigas.
- **Dashboard + ativação guiada**: nova aba **Router** (toggle, chave NVIDIA mascarada,
  aceite de termos, status e banner de restart), rotas `/api/router/{config,status,apply}`,
  o slash command **`/dashboard`** e um aviso de primeira execução. A chave da NVIDIA
  vive **somente** em `DATA_DIR/model-router/user-config.json` (nunca versionada); a API
  devolve apenas `hasNvidiaKey` + os últimos 4 dígitos.
- **Plano B no limite excedido**: quando a janela do Claude esgota (HTTP 429), o proxy
  **não propaga o erro** — com chave NVIDIA, roteia para a NVIDIA NIM (OpenAI-compat),
  traduzindo Anthropic↔OpenAI em streaming e não-streaming, **sempre com um aviso de
  que a resposta veio da NVIDIA, não do Claude**; sem chave, devolve uma mensagem no
  formato Anthropic orientando rodar `/dashboard`. Configurável em `config.fallback`.
- **Classificador opus-averse** (`config.classifier`): calibrado com tráfego real, evita
  mandar prompt trivial pra opus (que era eleito quando nada casava). Piso de confiança
  global, barra mais alta para opus (score absoluto + margem) e rebaixamento para o
  melhor tier não-opus; tudo ajustável sem código.
- **Circuit breaker no limite excedido** (`config.fallback.cooldown`): evita a rajada de
  429 sem prender o usuário no plano B quando o Claude volta. **Reset determinístico,
  multi-fonte** (na ordem): headers do 429 (`retry-after` → `anthropic-ratelimit-unified-reset`
  → buckets) **e** — caso típico da **assinatura** (Claude Pro/Max) — o **reset embutido no
  CORPO da resposta**: o evento `rate_limit_event` (`rate_limit_info.status:"rejected"` +
  `resetsAt` em epoch) ou o marcador `Claude AI usage limit reached|<unix>[|tipo]`. O proxy
  agora faz um **"tee" leve do stream 200** (repassa verbatim ao cliente **e** escaneia esse
  sinal), porque a assinatura sinaliza a janela esgotada **dentro de um 200**, não só via 429.
  Achando o reset (header **ou** corpo), espera **exatamente** até lá (`source:'body'`/`'header'`).
  Só quando **nada** legível existe é que o 429 vira **esporádico** (janela deslizante): um 429
  isolado cai no plano B só naquela request e a **próxima já testa o Claude**; após `tripAfter`
  429s **seguidos** arma um cooldown **curto** (`noHeaderMs`, padrão 15s) e re-sonda —
  **qualquer resposta do Claude zera o contador** e retoma na hora. Todo 429 registra **captura
  diagnóstica** (todos os headers `anthropic-ratelimit-*` + preview do corpo) p/ travar a forma
  real no próximo limite. Estado persistido em `DATA_DIR/model-router/cooldown.json` (sobrevive a
  restart). Mensagens de plano B com dica **honesta**: "Claude volta ~HH:MM" quando há reset real
  (header/corpo); senão "reavaliando o Claude em ~Ns". Ajustável (`enabled`, `noHeaderMs`,
  `tripAfter`, `minMs`, `maxMs`).
- **Teto de modelo** (`config.routing.ceiling`, padrão ligado): o modelo escolhido no
  dropdown do Claude Code vira um **teto**, não uma sugestão. O classificador pode
  **rebaixar** livremente p/ economizar (ex.: opus→haiku num rename trivial), mas **nunca
  escala acima** do que o usuário pediu — se o prompt pareceria opus mas o usuário escolheu
  sonnet, mantém **exatamente** o modelo do usuário. Modelo desconhecido no dropdown → sem
  teto (segurança). Desligável com `routing.ceiling:false` (volta ao roteamento livre).
- **Telemetria de economia** (endpoint `/metrics`, aba **Router** do dashboard): contadores
  de requisições roteadas, classificadas, rebaixadas, bloqueadas pelo teto, servidas pelo
  Claude vs. plano B, cooldowns e tokens; e uma **economia estimada** por pesos de custo
  (proxy dos preços públicos: opus ~15× haiku, em `config.routing.costWeights`) — `baseline`
  = sempre o modelo do dropdown, `actual` = só o que o Claude de fato serviu (plano B conta
  custo-Claude zero). Persistida em `DATA_DIR/model-router/metrics.json` (sobrevive a restart),
  com `POST /metrics/reset` p/ zerar. Os pesos afetam **só o relatório**, nunca o roteamento.

### Fixed — model-router: 429 de concorrência não trava mais o plano B com o Claude vivo

- **Falso-positivo do cooldown de palpite** (`config.fallback.cooldown.probeSuppressMs`,
  padrão 30s): o Claude Code dispara **várias requisições em paralelo** por turno e a
  Anthropic devolve **429 de concorrência** (corpo `rate_limit_error` genérico, **sem**
  reset em header/corpo) p/ algumas enquanto **serve 200** p/ outras. O heurístico
  headerless contava esses 429 como "janela esgotada" e, após `tripAfter`, armava um
  cooldown que mandava **tudo** pro plano B por ~15s — e re-armava a cada turno, deixando
  o usuário **preso no plano B mesmo com o Claude disponível**. Agora há dois guardas: (1)
  um 429 **sem reset legível** é **ignorado** (não conta, não arma) se o Claude respondeu
  **200 nos últimos `probeSuppressMs`** — é concorrência, não janela; (2) um **200 limpo**
  **derruba na hora** um cooldown de **palpite** já armado por uma rajada concorrente. Os
  cooldowns **autoritativos** (reset real via header/corpo) seguem armando **imediatamente**
  e **não** são afetados — só a heurística de último recurso deixou de dar falso-positivo.
- **Parâmetro `effort` reconciliado por modelo ao rebaixar** (corrige `400 ... does
  not support the effort parameter` e o erro de valor inválido entre modelos): o
  `effort` (Anthropic) vive em **`body.output_config.effort`** e tem **escala própria
  por modelo** — pela doc oficial, **Opus 4.8/4.7** têm `xhigh`; **Sonnet 4.6/Opus 4.6**
  têm `max` mas **não** `xhigh`; **Haiku 4.5 não suporta `effort`**. Quando o usuário
  escolhe Opus 4.x com nível de _effort_ e o router **rebaixa** o modelo (teto/economia),
  não dá p/ "passar reto" (Sonnet rejeita `xhigh`) nem "stripar cego" (jogaria fora um
  `effort` válido no Sonnet). Agora `reconcileEffort` resolve contra o **modelo de
  destino**: **mantém** se o destino aceita o valor, **clampa** p/ o maior suportado
  (ex.: Opus `xhigh` → Sonnet `high`) quando suporta `effort` mas não aquele valor, e
  **remove** só quando o destino não tem `effort` (Haiku). Modelo **mantido** pelo teto
  preserva o `effort` intacto. A matriz é **configurável** (`routing.effort.{order,support}`,
  match por prefixo cobre sufixo de data) e a decisão é logada (`Roteado.effort`). O plano
  B já era imune (monta o próprio body OpenAI).
- **Isolamento total no Claude Code (sem vazamento global)**: o mecanismo antigo definia
  `NODE_OPTIONS` e `ANTHROPIC_BASE_URL` no **escopo User do Windows** — variáveis
  **machine-wide** que **vazavam para outros apps** (ex.: GitHub Copilot/hermes) e corrompiam
  o launch deles (`NODE_OPTIONS` com aspas quebrava `--settings`; `ANTHROPIC_BASE_URL` apontando
  p/ porta morta gerava "Solicitação falhou"). Agora o roteamento é **exclusivo do Claude Code**:
  o `ensure.js` publica a URL do proxy em `~/.claude/model-router-url.txt` e o **wrapper do
  `claude.exe`** injeta `ANTHROPIC_BASE_URL` **apenas no próprio processo** (lendo esse arquivo).
  O hook **nunca** define env global e ainda faz **self-heal**, removendo qualquer
  `NODE_OPTIONS`/`ANTHROPIC_BASE_URL` global residual e o patcher órfão de versões antigas;
  quando o router para ou é desabilitado, o arquivo de URL é **apagado** (o wrapper nunca injeta
  porta morta — auto-cura). O mecanismo `patcher.js`/`NODE_OPTIONS` foi **aposentado**
  (sem nenhum `require` vivo; substituído pelo wrapper). O **quoting de argumentos** do
  wrapper foi corrigido para o algoritmo canônico `CommandLineToArgvW`, preservando o JSON
  de `--settings` (antes uma flag com espaços/aspas era remontada errada).

## [1.10.0] — 2026-06-15

### Added — curation "one-hit" marking with a recurrence ceiling

The curation Stop hook re-fired on **one-hit** commands (single-use, e.g. a one-off
`git log`): detection was output-VOLUME only, with no notion of recurrence, and the
only sanctioned "skip" — a text-only "it's one-shot, moving on" reply — was treated
as no-progress and escalated. So a genuinely single-use command got blocked up to
`maxAttempts` times, every time it appeared.

Now the agent can **mark a command one-hit** so the Stop hook stops asking to curate
it — but it can't become a cheap bypass:

- **Added** the `curation_mark_oneoff` MCP tool — the agent passes the command's
  `aliases` (the SAME forms it would register when curating, so marking costs the
  same work as doing it right). A 1-token alias (e.g. `git`) is rejected — it would
  silence unrelated subcommands.
- **Added** `scripts/lib/command-signature.js` — a canonical signature that
  normalizes `cd …`, env assignments, wrappers (`bash -c`, `pwsh -File`, …), pipes
  and flags, so the same command isn't fragmented by cwd or masked by variation
  (`cd /p && git --no-pager log -5` → `git log`).
- **Added** `scripts/lib/oneoff-store.js` — a per-project store (in the data dir,
  not the versioned `shells.json`) counting every matching invocation in a sliding
  window. Past the configurable ceiling the marking is **refused** — a recurring
  command must be curated; one-hit can't silence it forever. Overlapping markings
  merge (no count fragmentation); cold entries are pruned.
- **Changed** `curation-detect.js` — counts recurrence and **suppresses** valid
  one-hit markings at the source (they never reach the Stop list).
- **Changed** `curation-stop.js` — the block reason is now **oriented**: each
  command shows its signature and `count/ceiling`, plus the two ways out (curate or
  `curation_mark_oneoff`), so the agent decides on data, not a guess.
- **Added** `curation-session.js` (SessionStart) — prunes cold entries and injects a
  short curation panorama (how many curated scripts + one-hits the project tracks).
- **Config** `curation.oneHitMaxRecurrence` (default 3) + `curation.oneHitWindowDays`
  (default 90) in `brain-config.json`.

### Changed — unified quality gate (`npm run gate`)

Local and CI now run the **same** gate (`npm run gate`): ESLint over `scripts/` AND
`servers/`, version-sync, and the test suite. The catch-masking checks moved from
GNU-only CI greps to an AST ESLint rule (`no-silent-return-catch`) — cross-platform
and finally covering the brain-server. The CI workflow just calls the gate, so "lint
passed locally but a separate CI grep failed" can't happen again.

### Fixed

- Return-only `catch { return … }` blocks in the brain-server daemon + `searchIsolated`
  now log/acknowledge the error before returning (CI gate).
- Plugin README: the hooks table referenced the deleted `brain-retrieve-prompt.js`;
  it now points to the `mcp_tool` → `brain_retrieve_context` warm retrieval. Added a
  dedicated `servers/brain-server/README.md` (transports, daemon, config).

## [1.9.0] — 2026-06-14

### Added — brain-server can run as a long-lived HTTP service (additive, opt-in)

The brain-server (MCP) was stdio-only: every host connection spawned its own
process + ~118MB model, all competing for the same SQLite, and external consumers
(e.g. OpenCode) had to point at the rotating-SHA plugin cache (unstable; the brain
vanished when the SHA was cleaned). It can now ALSO run as a single long-lived HTTP
daemon (StreamableHTTP, **stateful**) shared by N workspaces/clients — one model,
one SQLite.

**stdio stays the default and behaves exactly as before** — no reinstall and no
`.mcp.json` change for Claude Code users.

- **Added** `servers/brain-server/lib/mcp-server.js` — `createBrainServer()`, the
  transport-agnostic MCP assembly (tools + handlers) reused by both transports. An
  async mutex serializes the KB tools so concurrent HTTP sessions can't corrupt the
  process-singleton DB. Tool logic is a faithful move from `index.js` (no stdio
  behavior change).
- **Added** `servers/brain-server/lib/http-daemon.js` — `--http` daemon: stateful
  StreamableHTTP (a per-session `createBrainServer` keyed by `mcp-session-id`),
  `/health`, `/mcp`, port-as-singleton-lock, idle-session reaper, graceful
  `/shutdown` (forces keep-alive connections closed).
- **Added** `servers/brain-server/lib/daemon-supervisor.js` + `daemon-common.js` —
  the stdio launcher best-effort auto-starts the daemon (detached, survives the
  host) and, on a plugin update, **version-swaps a stale daemon for the new one**
  (lock in `DATA_DIR` + `/health` `pluginRoot` check). Disable with
  `BRAIN_HTTP_AUTOSTART=0`.
- **Changed** `servers/brain-server/index.js` — now a thin transport selector:
  stdio by default (`StdioServerTransport`); `--http [--port N | env
  BRAIN_HTTP_PORT]` runs the daemon. Project scoping: **stdio infers from CWD
  (unchanged); HTTP requires an explicit `project`** and rejects otherwise (never
  falls back to `'default'`).

**Migration — point an external consumer (e.g. OpenCode) at the daemon:** set
`BRAIN_HTTP_PORT` to a known value, then configure the consumer with a remote MCP
endpoint `http://127.0.0.1:<port>/mcp` (and always pass an explicit `project` per
call). Claude Code keeps using stdio via the unchanged `.mcp.json`. The two modes
share the same SQLite/KB.

### Added — warm adaptive retrieval auto-injected on every prompt

The Brain now feeds relevant lessons into context automatically. A new
`brain_retrieve_context` tool — called by a `mcp_tool` `UserPromptSubmit` hook —
embeds the prompt in the warm server (~26 ms), vector-searches behind an adaptive
relevance gate, federates `project` + `__user__` scopes, dedups by title, and
injects a short `[BRAIN]` block. No per-tool-call cold retrieval.

- **Added** `scripts/lib/retrieve-core.js` + the `brain_retrieve_context` brain-server
  tool (embed → two-pass scope search → relevance gate → title-dedup →
  `hookSpecificOutput.additionalContext` envelope, the only form a UserPromptSubmit
  `mcp_tool` hook injects).
- **Changed** `hooks/hooks.json` — `UserPromptSubmit` calls the `mcp_tool` hook
  against `plugin:claude-code-boss:brain-server` (warm embedder) instead of a cold
  per-call script. The relevance gate was calibrated (`0.45 → 0.20`, measured against
  the embedder's real score distribution) and retrieval now federates the global
  `__user__` scope (parity with `brain_search`, via an isolated read connection so
  the warm server's singleton isn't churned).

### Fixed — KB entries vectorized by title+summary, not the (diluting) detail

Including the long, dense `detail` in the embed text diluted the vector below the
retrieval gate (measured cos **0.51** for `title+summary` vs **0.13** for
`title+summary+detail` on the same entry/query) — so even an exact-title match
wasn't retrieved.

- **Added** `scripts/lib/embed-text.js` (`buildEmbedText`) as the single canonical
  embed-text builder, used by `capture_lesson`, `brain_store`, `brain-index-native`,
  and `brain-reembed`. `detail` is still stored and shown on retrieval; it just no
  longer steers the vector. Existing entries migrate by re-running `brain-reembed`.

## [1.8.3] — 2026-06-13

### Fixed — hooks now use exec form so plugin paths survive Windows shells

Every handler in `hooks/hooks.json` was in **shell form**
(`"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/x.js\""`). On Windows, Claude
Code runs shell-form hook commands through **Git Bash** (or PowerShell when Git
Bash is absent), which tokenizes the string and can mangle `${CLAUDE_PLUGIN_ROOT}`
or a path containing spaces. Per the Claude Code hooks reference, the fix is
**exec form**: set `args`, and `command` is spawned directly with no shell, so each
path is passed verbatim on every platform.

- **Changed** `hooks/hooks.json` — all 27 handlers converted to exec form
  (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/x.js"]`). No shell
  tokenization on any platform; `node` is a real binary that resolves on PATH
  everywhere.
- **Changed** `scripts/config-testers/hooks.js` — the validator now extracts the
  script path from `args` (exec form) as well as the `command` string (shell form),
  so the on-disk/syntax checks still cover every hook.
- **Changed** `scripts/dashboard.js` — the Hooks tab parses both forms (shared
  `hookScriptPath` / `hookDisplayCmd` helpers); previously exec-form hooks showed
  as inactive with no script name.
- **Added** exec-form coverage to `scripts/test-units.js`.

### Added — brain-health surfaces the JSON-fallback (degraded SQLite) state

When neither `node:sqlite` (Node < 22.13) nor `better-sqlite3` is available, the
Brain silently falls back to a JSON store (no metrics, dashboard count = 0). The
SessionStart probe now reports this via `getSqliteBackend() === 'none'` with the
running Node version and the upgrade path. (A *missing* Node can't be detected by
a Node hook — if `node` is off PATH the hook never spawns; see
anthropics/claude-code#66183, #35175 — that case is covered in docs.)

- **Changed** `scripts/brain-health.js` — adds a degraded-SQLite advisory
  (SessionStart only, ahead of the embedder/pending-drafts notices).

### Docs — Node on the system PATH is the #1 prerequisite

- **Changed** root `README.md`, `claude-code-boss/README.md`, and the
  `plugin-install` skill — lead with **Node ≥ 22.13 on the system `PATH`** and the
  real cause of "it only works on your machine": Claude Code spawns plugin hooks
  and MCP servers with bare `node` from the **system PATH**, not the Node bundled
  in Claude Desktop (anthropics/claude-code#66183, #35175). No system Node → hooks
  no-op and the Brain MCP is DOWN (`spawn node ENOENT`). Added troubleshooting rows
  and corrected the hooks summary (7 events, 24 scripts).

## [1.8.2] — 2026-06-13

### Fixed — brain-index crashed on keywords colliding with `Object.prototype`

`brain-index.js` stored its inverted index in plain objects and tested presence
with `if (!_index.keywords[kw])`. For a keyword equal to an `Object.prototype`
member (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) this returned
the inherited method, skipped the array initialization, and threw
`x.includes is not a function` — silently breaking the keyword index for any entry
whose text contained such a technical term (and thus dropping it from keyword
search).

- **Changed** `scripts/brain-index.js` — the `keywords` / `tags` / `projects` /
  `types` maps are now prototype-less (`Object.create(null)`), both on creation
  and when loading an existing `index.json`, so no keyword can collide with a
  built-in member.

## [1.8.1] — 2026-06-13

### Fixed — Brain MCP was DOWN on fresh install (brain-server deps not installed)

The brain-server is a separate package (`servers/brain-server/`, ESM) whose only
dependency is `@modelcontextprotocol/sdk`. The postinstall installed the plugin
root but never the brain-server, so on any fresh install (marketplace or the
install-local cache) `node_modules` was missing there and the MCP server
(`brain_search` / `brain_store` / `capture_lesson`) failed to start. The
`.mcp.json` `NODE_PATH` points at the root `node_modules`, which does not contain
the SDK either.

- **Changed** `scripts/plugin-setup.js` — postinstall now installs the brain-server
  deps (`npm install` in `servers/brain-server/`) when missing; loud but non-fatal
  on failure. `brain-health` already surfaces the defect, so a miss is visible.

## [1.8.0] — 2026-06-13

### Changed — embedding model is now part of setup (not silently optional)

The embedder powers semantic search **and** the pattern→skill learning loop
(dedup→recurrence needs vectors). It was treated as silently optional: the model
downloaded lazily on first use, into a cache inside `node_modules` (wiped on
reinstall), with no setup step and no health visibility — so the learning loop
could die invisibly. Now it is a verified, durable part of setup.

- **Added** `scripts/brain-warm.js` + `npm run setup:brain` — downloads and
  verifies the model (test embed → checks dimensions). Idempotent; one-time
  migration copies an existing model out of the legacy `node_modules` cache
  instead of re-downloading.
- **Changed** `scripts/plugin-setup.js` (postinstall) — now warms the embedding
  model after deps. Internet is assumed (the plugin was just fetched online).
  Skipped in CI and via `CLAUDE_SKIP_EMBED_WARM=1`; non-fatal but LOUD on failure
  (the model also fetches lazily on first use).
- **Changed** `scripts/brain-embedder.js` — model cache moved to a durable,
  user-level path (`<CLAUDE_PLUGIN_DATA>/models/`) via `transformers env.cacheDir`,
  so it survives `node_modules` deletion/reinstall.
- **Changed** `scripts/brain-health.js` — SessionStart now surfaces a soft advisory
  when the model is not downloaded (cheap filesystem check, no model load),
  instead of skipping the embedder entirely.
- **Docs** — README + `plugin-install` skill reframe the embedder as REQUIRED for
  full value (no longer "optional/degrades"), with the durable cache and
  `npm run setup:brain` documented.
- **Investigated** transformers→`sharp`: confirmed `sharp` is a hard, eagerly-imported
  native dependency of `@xenova/transformers` in **all** versions (v2/v3/v4) — a
  version bump cannot remove it. It ships prebuilts for mainstream platforms (no
  compiler on a normal `npm install`). `brain-warm` now hints at `npm rebuild sharp`
  on a sharp failure, and the `plugin-install` skill documents the `ollama`/`voyage`
  escape hatch for platforms without a prebuilt.

### Changed — SQLite backend is now Node's built-in `node:sqlite` (zero native deps)

Makes the plugin install and run on any machine with a modern Node — no C/C++
build toolchain, no `node-gyp`, no native compilation. Previously the Brain KB
required the native `better-sqlite3` addon, which failed to compile on fresh
machines (no Build Tools) and on newer Node without a prebuilt binary, silently
degrading the KB.

- **Added** `scripts/lib/sqlite-compat.js` — backend-agnostic loader. Prefers the
  built-in `node:sqlite` (Node >= 22.13), falls back to a compiled `better-sqlite3`
  only if already present, then to the JSON store. Bridges the API deltas
  (`readonly` → `readOnly`, no `.pragma()` → routed to `exec`, BLOB → `Uint8Array`)
  and suppresses the benign `node:sqlite` ExperimentalWarning. Never throws.
- **Changed** `package.json` — removed the required native `better-sqlite3`
  dependency and the unused native `sharp` optional dependency; added
  `engines.node >= 22.13.0`. The plugin now declares **no native dependency**.
- **Changed** `scripts/brain-store.js`, `brain-reembed.js`, `dashboard.js`,
  `test-hooks.js` — load SQLite through the adapter. `brain-reembed.js` previously
  hard-required `better-sqlite3` with no fallback; it now works on `node:sqlite`.
- **Fixed** `brain-store.js` `blobToVector` — honors `byteOffset` so Float32
  vectors round-trip correctly from a `Uint8Array` (node:sqlite) as well as a
  `Buffer` (better-sqlite3).
- **Fixed** `brain-store.js` `save()` — now returns the entry id. A latent bug
  returned `undefined`, breaking `brain-backend.saveLocal` (`get(undefined)` under
  the stricter `node:sqlite` binding) whenever the embedder was ready.
- **Changed** `scripts/plugin-setup.js` — reinstalls only when `node_modules` is
  missing (no longer hinges on the optional `sharp` probe); warns on Node < 22.13.
- **Changed** CI — test matrix bumped from Node 20 to Node 22 + 24 (Node 20 lacks
  `node:sqlite`).

### Added — `plugin-install` skill

Clear, machine-agnostic install + troubleshooting workflow: missing `node_modules`,
`gyp ERR` / Build Tools errors (no longer needed), old Node → JSON fallback, and
install verification via `getSqliteBackend()`.

## [1.6.0] — 2026-05-31

### Changed — brain-indexer trigger refactored to in-loop Stop pattern

Replaces the UserPromptSubmit advisory (which the LLM routinely ignored, letting
the pending backlog grow to 389+ payloads) with a blocking Stop hook that emits
`decision:"block" + reason` directly to the main agent. Same pattern as
`pattern-detect.js` and `curation-stop.js`: the main agent has live turn context
and a Task tool, so it can launch `brain-indexer` immediately.

- **Added** `scripts/brain-stop.js` — Stop hook with per-session state file
  (`.runtime/brain-stop-<sid>.json`) tracking `{attempts, lastPendingCount,
  firstBlockedAt}`. Progress detection: if pending dropped vs last block, the
  agent processed payloads — clear state and release. Escalating reason across
  attempts (informative → `[RETRY N/M]` forceful → `[FINAL RETRY]` literal Task
  call). Safety cap via `brainStop.maxAttempts` (default 3) prevents UX
  lock-up.
- **Updated** `agents/brain-indexer.agent.md` — `maxTurns 10 → 20` and
  two-phase workflow (Phase 1 admission triage up to 100 files using Step 0;
  Phase 2 indexes cap 30 admitted files through Steps 1-5).
- **Updated** `scripts/brain-retrieve-prompt.js` — advisory line silenced when
  `pending >= brainStop.threshold` (the Stop hook owns the trigger from there).
- **Config** `config/hooks-config.json` — added
  `brainStop: { enabled: true, threshold: 10, maxAttempts: 3 }`.

### Changed — brain-submit admission gates tightened

Cuts payload volume by rejecting trivial captures before they reach the queue.

- **Added** `TRIVIAL_COMMAND_PREFIXES` blacklist in `scripts/brain-submit.js`
  (git status/log/diff/show/branch/remote, ls/dir/pwd/cd/echo/whoami/date/
  hostname/cat/type/head/tail/less/more/which/where/env/printenv) — rejected
  before any other gate.
- **Wired** `minBashLines: 3` gate (was unused in config).
- **Config** `config/brain-config.json` — `minOutputChars 500 → 1500`.

### Added — dashboard surface for brain-stop

- **`dashboard/index.html`** — replaced the dead "Auto-Trigger de Agentes"
  card with a live "Brain Indexer Auto-Trigger" card bound to
  `brainStop.enabled` and `brainStop.threshold` (render + save handlers).

### Fixed — LLM-facing strings translated to English

Hook `reason` / `additionalContext` fields and skill/agent prose are injected
verbatim into the model's context. Mixed-language injection wastes tokens and
weakens instruction following. Audit pass translated remaining PT-BR strings
to terse English; human-facing docs (README, CHANGELOG, plan files) stay in
PT-BR.

- `scripts/brain-stop.js` — reasons in English, no cost noise.
- `scripts/curation-stop.js` — reason in English.
- `scripts/curation-guard.js` — three block/warn reasons translated; the
  build-tool warning also fixed semantically (it claimed "the system will
  auto-create a curated script", which never happens — now correctly states
  the Stop hook will block and require the agent to create one before ending
  the turn).
- `scripts/brain-retrieve-prompt.js` — "Conhecimento relevante encontrado"
  → "Relevant knowledge found".

### Tests

- `scripts/test-hooks.js` — 37/37 passing. New coverage: 8 brain-stop cases
  (no-pending, below-threshold, first-block, retry-no-progress-escalate,
  retry-progress-detected, max-attempts-relent, disabled) and 4 brain-submit
  trivial/significant/min-lines cases.

## [1.5.0] — 2026-05-31

### Changed — curation loop refactored to in-loop Stop pattern (BREAKING)

Replaces the curation-improver subagent + UserPromptSubmit backlog injection
with an in-loop Stop hook that emits `decision:"block" + reason` directly to
the main agent. Same pattern as `pattern-detect.js` (commit `bff3e40`,
`refactor(brain): in-loop lesson capture`). The main agent has live turn
context — a fresh subagent did not — so it creates better curation scripts.

- **Removed** `agents/curation-improver.agent.md` — subagent eliminated.
- **Removed** `scripts/curation-backlog.js` + its UserPromptSubmit hook entry —
  backlog mechanism no longer needed (no subagent to wake up).
- **Added** `scripts/curation-stop.js` — Stop hook reads per-turn state and
  emits a block+reason instructing the main agent to read the new skill and
  author a `.mjs` curator. Anti-loop via `stop_hook_active` guard.
- **Added** `skills/curation-script-pattern/SKILL.md` — migrated from the
  deleted agent's instructions. Loaded on-demand when the Stop hook references
  it by path; documents the `.mjs` template, OK/FAIL contract, `shells.json`
  schema, and `outputFilter` cheatsheet.
- **Rewrote** `scripts/curation-detect.js` — instead of writing per-event
  payload files to `data/detect-curation/`, appends entries to a single
  per-turn state file at `data/.runtime/curation-turn-<sessionId>.json`.
  Entries dedup'd by `command+reason`, capped at 50/turn.
- **Config** `config/hooks-config.json` — added `curationStop.enabled: true`.

### Migration

The directory `data/detect-curation/` (runtime, outside the repo) is no
longer written or read. Existing payload files there can be deleted; they
were only consumed by the now-removed subagent + backlog hook.

## [1.4.0] — 2026-05-31

### Fixed — hooks correctness pass + MCP brain_store orphan bug

- **`curation-guard.js`** — hook output format was wrong: returned top-level
  `permissionDecision: "allowed"|"denied"` (silently ignored by Claude Code).
  Now returns the correct `hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "allow"|"deny", permissionDecisionReason }` per the official
  hooks reference. Auto-approve of whitelisted commands and deny of blacklisted
  ones likely never worked before. Also removed `pwsh`/`powershell`/`bash` from
  `BUILD_TOOLS` (those are shells, not build tools — were triggering false-positive
  warnings).
- **`brain-retrieve.js`** — `STOP_WORDS` was declared after its first use (TDZ).
- **`refine-research.js`** — rewritten with `EVERY=4` throttle via state file
  (matches `pattern-detect`'s pattern); removed dead ref to deleted `octopus.agent.md`;
  `stop_hook_active` anti-loop guard preserved.
- **`hook-logger.js`** — log rotation switched to probabilistic trim (~1%) instead
  of read+rewrite on every append (was O(n) per log line).
- **`hooks/hooks.json`** — explicit per-hook `timeout` (5–10s) replacing implicit
  defaults; better failure semantics.
- **`servers/brain-server/index.js` `brain_store` handler** — wrong call signatures:
  `kbIndex.index(id, keywords)` and `kbGraph.registerNode(id, type)` were silent
  no-ops (canonical signature is `(entry)`). Entries saved via MCP `brain_store`
  were **orphans** — not in the keyword index, not in the citation graph. Now
  builds embedding upfront and calls `save(entry, vector)` + `index(entry)` +
  `registerNode(entry)` in one pass. `capture_lesson` already used the correct
  signatures.
- **`README.md` (root)** — MCP tool count corrected from 5 to 7 (was omitting
  `research_query` and `research_status`).

### Tests

- `scripts/test-hooks.js` — 26/26 green, covers all hook events including
  `curation-guard` whitelist/blacklist/denyUnknown matrix and `refine-research`
  throttling.

### Added — Brain hygiene + in-loop learning (the differentiator)

- **Admission control (A-MAC)** in `brain-indexer` — admit/merge/skip gate; merge
  bumps a new `recurrence` column (migrated in place). Stops duplicate accumulation.
- **Rerank with decay** in `brain-store.search` — combined score (relevance +
  recency + frequency + confidence), Generative Agents pattern. Configurable via
  `kb.rerank`. Zero schema change.
- **Prune/eviction** (`brain-store.prune`) — graceful archive (not delete) to
  `entries_archive`; stale + over-capacity, utility = AMV-L/Priority Decay.
- **Native memory indexing** (`brain-index-native.js`) — indexes Claude's native
  Auto Memory (`~/.claude/projects/<cwd>/memory/*.md`) into the Brain for semantic
  + cross-project search the native layer lacks.
- **Skill promotion** (`brain-promote.js`) — recurring lessons → global skills
  (Voyager skill-induction); curated: scan→draft(staging)→approve. Never auto-spam.
- **`capture_lesson` MCP tool** — in-loop curated lesson capture with inline
  admission control. Replaces post-hoc transcript-parsing analyzers.

### Removed — token-villain cleanup

- **`pattern-analyzer` + `correction-analyzer` subagents** — re-read raw transcripts
  on a premium model (~50k/run, 96% noise). Replaced by in-loop `capture_lesson`
  (~200 tokens). `correction-detect`/`pattern-detect` are now lean advisory nudges
  (no transcript reading, no payloads). `brain-indexer` pinned to `haiku`.
- **`pattern-detection` skill** + its `hooks-config.json` keys (`patternDetect`,
  `correctionDetect`) — obsolete after the in-loop redesign.

### Changed — slim-down refactor (Brain + Curation focus)

O plugin foi reduzido ao que o Claude Code nativo **não** entrega. A camada de
orquestração (que reimplementava em prompt o Agent/Workflow nativo) foi removida;
ficaram **Brain KB** (busca semântica), **Curation** (anti context-bloat) e a
camada de **aprendizado** (captura advisory de padrões/correções).

- **Removidos (camada A — orquestração):** agente `octopus` (a main session volta
  ao loop nativo), `pipeline-executor`, os 7 agentes-clone (researcher, implementor,
  validator, reviewer, planner, debugger, documenter), `model-router` + `cost-tracker`
  + `ack-tracker` + `discipline-guard`, `boss-server` (MCP), configs
  `model-router.json` / `pipelines.json`, e skills `octopus-coordination`,
  `multidev-orchestration`, `pipeline-delegation`, `billing-awareness`,
  `code-review-standards`.
- **`settings.json`:** removido `"agent": "octopus"` — sem orquestrador próprio.
- **Camada B (aprendizado) — mantida e corrigida:** hooks agora são **advisory**
  (sem "MANDATORY/you MUST") com **backpressure** (cooldown + cap de contagem).
  `lesson-inject` foi fundido em `brain-retrieve-prompt` (injeção de lessons +
  advisory de pendências).
- **Dashboard:** enxugado para 4 abas (Home, Brain KB, Hooks, Logs); não auto-inicia
  mais no SessionStart (lançar sob demanda).
- **hooks.json:** de 6 eventos/15 scripts para 5 eventos/~9 scripts.

### Removed

- **`plugin-updater.js`** and **`plugin-version.json`** — custom plugin update mechanism removed.
  The root cause was a fixed `"version"` string in `plugin.json` that prevented the Claude Code
  native resolver from detecting new commits. Removing that field (D1) makes the official
  `/plugin update` command work correctly — no custom updater needed.

- **`install-local.js`** — replaced by `dev-claude.ps1` / `dev-claude.sh` wrappers that use
  the official `claude --plugin-dir <path>` flag for local development.

### Migration notes for existing installs

If you had a previous version of this plugin installed, you may have orphaned files in
`~/.claude/plugins/data/claude-code-boss/`. These are safe to delete manually:

```
~/.claude/plugins/data/claude-code-boss/updater.lock
~/.claude/plugins/data/claude-code-boss/plugin-update-check.json
~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```

To clean all at once (PowerShell):
```pwsh
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\updater.lock" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\plugin-update-check.json" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\.payload-cleaned" -ErrorAction SilentlyContinue
```

Bash/zsh:
```bash
rm -f ~/.claude/plugins/data/claude-code-boss/updater.lock \
      ~/.claude/plugins/data/claude-code-boss/plugin-update-check.json \
      ~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```
