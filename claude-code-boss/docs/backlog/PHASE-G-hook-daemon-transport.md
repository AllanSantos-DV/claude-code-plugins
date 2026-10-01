# Fase G — Hooks via transporte de daemon (spawn efêmero → mcp_tool)

> **Status: TODOS OS 5 SPIKES (S1/S1b/S2/S3/S4) FECHADOS COM DADO REAL.**
> Rodada 1 achou dependência circular em 3 scripts (excluídos
> permanentemente) + 3 perguntas (P2/P3/P4, todas respondidas pelo dono do
> repo). Rodada 2 achou que o teste original de S1/S4 não cobria 3 casos
> reais — os 3 spikes extras (S1b + S4-ii/iii) rodaram contra uma sessão
> `claude -p` real (bloqueio de auth de sessão aninhada resolvido via
> mecanismo do Allan Launcher — ver §Resolução do bloqueio S1b/S4). Resultado:
> `pretooluse-bash-dispatcher.js` **libera** pra migração fracionada (S1b
> confirmou paridade); `stop-dispatcher.js` **mantém consolidado** — achado
> real (não suposição) de que hooks-irmãos de `Stop` não mesclam motivo, ver
> S4(iii). `graph-guard.js` livre desde a rodada 2. **Pronto para iniciar as
> tasks 2-8 (implementação real: novas tools MCP + migração de hooks).**

## Referências

- **Design:** [ADR-015-hook-daemon-transport.md](../adr/ADR-015-hook-daemon-transport.md)
- **Código base:** `hooks/hooks.json` (registro dos 14 hooks); `scripts/model-router-ensure.js`,
  `scripts/user-prompt-submit-dispatcher.js` (+ 5 sub-detectors), `scripts/session-start-dispatcher.js`
  (+ 12 sub-detectors), `scripts/pretooluse-bash-dispatcher.js`, `scripts/policy-enforce-shadow.js`,
  `scripts/graph-guard.js`, `scripts/posttoolusebash-dispatcher.js`, `scripts/file-edit-detect.js`,
  `scripts/policy-glob-inject.js`, `scripts/skill-metric.js`, `scripts/posttoolusefailure-dispatcher.js`,
  `scripts/stop-dispatcher.js`, `scripts/policy-inject.js`; `servers/brain-server/lib/http-daemon.js`
  (daemon MCP já vivo, porta 58217, `MAX_SESSIONS=50`); `servers/brain-server/lib/mcp-server.js`
  (onde novas ferramentas MCP entrariam).
- **Fatos verificados nesta sessão (medição real, `.ccb-daemon-bench/`, não
  re-provar):**
  - Latência isolada de `model-router-ensure.js`: 4285ms de mediana → 716ms
    após 3 fixes (2 spawns de PowerShell incondicionais eliminados). **Já
    corrigido, fora do escopo desta fase.**
  - Concorrência (`bench-concurrent-spawn.cjs`, N=1/5/15/30/60 via
    `Promise.all`, 2 rodadas): degradação **superlinear** — a N=60, wall-time
    é 38,9× o custo unitário isolado; p95 de UMA chamada dentro do burst chega
    a 18,5s.
  - Daemon já vivo sob a mesma carga (`bench-concurrent-warm.cjs`, `tools/list`
    sobre poucas conexões persistentes — modelo real de `mcp_tool`): wall-time
    praticamente plano até N=15 (63ms→88ms de mediana). **N=30/60 NÃO fechado**
    — a tentativa abriu 1 sessão MCP nova por chamada em vez de reusar
    conexões, bateu no `MAX_SESSIONS=50` do daemon
    (`servers/brain-server/lib/http-daemon.js:27`) e deixou o daemon de
    PRODUÇÃO em 50/50 sessões por ~30min (reaper de sessão ociosa). Incidente
    real do próprio benchmark, não do produto — mas prova que o teto de
    sessões precisa entrar na conta antes de prometer N=60 sem degradação.
  - RAM sob burst: **não medida com confiança** — tentativa via PowerShell em
    processo separado falhou (erro de sintaxe); `wmic` está descontinuado
    nesta versão do Windows; amostrar via PowerShell durante o burst
    contaminaria a própria medição. Estimativa raciocinada, não medida:
    ~2,4-4,2GB agregado a N=60 no modelo efêmero atual (60 × 40-70MB/processo).
  - 14 hooks mapeados e reclassificados após a rodada 1 do Portão de Plano
    (ver ADR-015 §Contexto/§Decisão): 5 async-elegíveis (sempre `{}`), 3
    silenciosos-exceto-alerta (`correction-detect`, `active-research-detect`,
    `policy-glob-inject` — `null`/vazio na maioria dos turnos), 3 sync-real
    de fato (`pretooluse-bash-dispatcher`, `graph-guard`, `stop-dispatcher` —
    únicos que emitem `permissionDecision`/`decision:'block'`), 3 excluídos
    PERMANENTEMENTE por dependência circular (`brain-daemon-ensure`,
    `brain-health`, `brain-status` — fazem probe fora de banda do próprio
    canal MCP/daemon, ver achado da rodada 1), 2 pendentes de classe própria
    (`policy-inject`, `model-router-ensure.js` — só `additionalContext`, não
    bloqueiam, não são "silenciosos" — ver §S4) + `brain_retrieve_context` já
    correto.
  - `mcp_tool` funciona em qualquer evento (`PreToolUse`, `PostToolUse`, `Stop`,
    `SubagentStart`, `UserPromptSubmit` incl.) exceto `SessionStart` no
    lançamento da sessão (MCP ainda não conectado) e `Setup` (nunca) — Brain
    `claude_code_mcp_tool_hook_event_support`.

## ⚠️ Decisões pendentes NO INÍCIO da fase (spikes obrigatórios antes de codar)

| # | Decisão | Como validar |
|---|---------|---------------|
| S1 | **Forma da ferramenta MCP no daemon**: uma tool genérica `run_hook({hookName, event})` fazendo dispatch interno (menos superfície nova, paridade de lógica mais fácil de garantir) OU uma tool por classe/hook (mais explícito, mais superfície) | ✅ **FECHADO.** Portou 3 hooks (1 por classe: `skill-metric` async-elegível, `correction-detect` silencioso-exceto-alerta, `graph-guard` sync-real) nas duas formas em `.ccb-hook-spike-s1/`, chamando a lógica REAL (`scripts/lib/*.js`, sem duplicar) — Form A (`run_hook` genérico com `DISPATCH` table) e Form B (3 tools explícitas). **Saída byte-idêntica nas 6 asserções de cada forma** (allow, deny com contexto, fail-open visível em falha simulada) — a escolha de forma não afeta corretude nem fail-open. **Decisão: Form B** (uma tool por hook) — consistente com a granularidade já decidida em P3 (1 entrada `hooks.json` = 1 tool no daemon, sem parâmetro `hookName` extra duplicando o que o nome da tool já expressa; e sem uma `DISPATCH` table central que cresce a cada hook migrado). |
| S1b | **(rodada 2, Achado A) Siblings `mcp_tool` no matcher `PreToolUse/Bash` preservam a regra "deny vence, `updatedInput` é descartado"?** `pretooluse-bash-dispatcher.js` consolida `curation-guard.js`+`error-guard.js` HOJE precisamente por causa de um bug de produção real e já reproduzido (upstream #75915/#15897). | ✅ **FECHADO.** Sessão `claude -p` real (bloqueio de auth resolvido, ver §Resolução abaixo) contra `.ccb-hook-siblings-test/`: as duas tools-irmãs (`test_allow_with_update` + `test_deny_no_update`, `PreToolUse/Bash`) foram chamadas na ordem registrada (confirmado em `logs/mcp-calls.log`) e o turno terminou com o Bash real BLOQUEADO, razão = a do `deny` (`"test deny"`) — sem sinal de merge/clobbering malformado. **O comportamento de hoje se preserva** com hooks-irmãos via `mcp_tool`. Libera a migração fracionada de `pretooluse-bash-dispatcher.js`. |
| S2 | ~~Teto de sessões~~ — **FECHADO.** `bench-concurrent-warm.cjs` corrigido (8 conexões persistentes reais, não 1/chamada) e re-rodado a N=1/5/15/30/60: wall-time praticamente PLANO (25ms→102ms de N=1 a N=60; mediana 8ms→63ms), **nenhuma degradação sob concorrência real**, usa só 8 das 50 sessões disponíveis — sobra folga de 6× pro cenário real do usuário. `MAX_SESSIONS=50` NÃO precisa subir pro padrão de 6-8 sessões medido. **Achado colateral**: `client.close()` do SDK NÃO chama `transport.terminateSession()` — vaza 1 slot de sessão por conexão fechada sem isso (subiu de 5→35/50 sessões antes do fix). Corrigido no script; qualquer código de produção que gerenciar conexões persistentes precisa chamar `terminateSession()` explicitamente ao encerrar. | ✅ feito — 2 rodadas confirmando estabilidade em 35 sessões (sem vazamento novo) |
| S3 | ~~Medição de RAM~~ — **FECHADO.** Técnica que funcionou: preload `NODE_OPTIONS=--require rss-self-report.cjs` injetado nos processos FILHOS do burst — cada um amostra a própria `process.memoryUsage().rss` a cada 15ms e reporta o pico no próprio `exit` via stderr. Zero processo extra de medição (a medição mora dentro do processo medido, não compete por CPU/spawn com o burst). Resultado real (não estimativa): **N=30 → 1726MB agregado (~57,5MB/processo); N=60 → 3415MB agregado (~56,9MB/processo)** — RSS por processo estável independente de N (confirma que não é vazamento por processo, é multiplicação simples N×~57MB). | ✅ feito — `rss-self-report.cjs` + `bench-burst-rss-selfreport.cjs` |
| S4 | ~~Mecanismo de fallback~~ — **RESOLVIDO no design (ver ADR-015 §Decisões do dono do repo):** fail-open VISÍVEL. Rodada 2 (Achados B/C) estendeu o teste a 3 sub-casos: (i) vazio→allow implícito; (ii) deny/block explícito realmente bloqueia; (iii) múltiplos hooks bloqueando ao mesmo tempo. | ✅ **FECHADO (3/3).** (i) `test_empty` retornou `{}` → Bash real rodou, `permission_denials:[]` — allow implícito confirmado. (ii) `test_deny_no_update` (`PreToolUse`) → `permission_denials` mostra o Bash bloqueado de fato: `mcp_tool` consegue expressar bloqueio real e o harness HONRA (não é só `additionalContext` cosmético). (iii) **achado real, não estimado**: 2 tools-irmãs de `Stop` (`test_block_reason_a`/`b`) sempre retornando `{decision:'block',reason}` — o harness NÃO mescla os motivos como `stop-dispatcher.js` faz hoje (`{decision:'block', reason: A+SEP+B}` único); em vez disso injeta **duas mensagens sintéticas separadas** na transcript (`"Stop hook feedback:\nREASON_A"`, depois `"...REASON_B"`), uma por hook, na ordem de execução, sem dedup/prioridade (confirmado em `logs/mcp-calls.log` + `logs/s4iii-stop-v2.jsonl`). Confirma o Achado C: migrar `stop-dispatcher.js` fracionado MUDARIA o comportamento observável. |

## Tarefas (ordem de execução — todos os spikes fechados, liberado pra iniciar)

1. ~~**Spikes S1-S4**~~ — **FECHADOS**, decisões e dados reais registrados na
   tabela acima. Form B (uma tool por hook) escolhida em S1; S1b e S4(i/ii/iii)
   confirmaram paridade de comportamento pra hooks-irmãos, exceto o caso
   documentado em S4(iii) (Stop-siblings não mesclam motivo).
2. **Ferramenta(s) MCP no daemon** conforme S1: implementar no `brain-server`
   (`servers/brain-server/lib/mcp-server.js` + novo módulo de dispatch),
   reusando a lógica EXISTENTE de cada script migrado (import direto do
   módulo, não reescrita) — mesmo princípio de `ADR-001`/D2 do token-guard:
   núcleo de decisão reaproveitado, só o transporte muda. Cada tool precisa
   implementar o fail-open VISÍVEL de S4: try/catch em volta da chamada real,
   e no catch devolver um `additionalContext`/reason explícito de degradação
   (nunca `{}` silencioso).
3. **Classe async-elegível** (menor risco — nunca bloqueia hoje, saída sempre
   `{}`): `skill-metric.js`, `file-edit-detect.js`,
   `posttoolusefailure-dispatcher.js`, `posttoolusebash-dispatcher.js`,
   `policy-enforce-shadow.js`. Cada um vira SUA PRÓPRIA entrada `mcp_tool` em
   `hooks.json` (decisão P3 — sem dual-registro `command`; falha de conexão
   retorna o sinal de degradação de S4, nunca trava o turno).
4. **Classe silencioso-exceto-alerta** (corrigida na rodada 1 — só 3 itens):
   `correction-detect.js`, `active-research-detect.js`, `policy-glob-inject.js`
   — cada um vira sua própria entrada `mcp_tool` (decisão P3, quebrando fora
   de `user-prompt-submit-dispatcher.js`); daemon passa a manter o estado
   relevante via loop interno já residente; hook lê via `mcp_tool`. Requer
   cuidado extra: o estado lido precisa refletir o MESMO projeto/sessão que o
   hook original calculava (não pode misturar contexto entre sessões
   concorrentes). **NÃO inclui** `brain-daemon-ensure.js`/`brain-health.js`/
   `brain-status.js` — excluídos permanentemente (ver ADR-015 §Contexto,
   achado da rodada 1: dependência circular, esses scripts existem pra
   detectar o canal MCP/daemon morto).
5. **Classe sync-real** (corrigida na rodada 1 — só 3 itens, verificado por
   grep de `permissionDecision`/`decision:'block'`): `pretooluse-bash-dispatcher.js`,
   `graph-guard.js`, `stop-dispatcher.js`. **Resolução da migração fracionada
   (rodada 2, Achados A/C, fechada com dado real de S1b/S4-iii):**
   - `graph-guard.js` — sem hooks-irmãos no matcher `Grep|Glob`, migra direto,
     sem dependência extra.
   - `pretooluse-bash-dispatcher.js` — **LIBERADO.** S1b confirmou que "deny
     vence, `updatedInput` é descartado" se preserva com `curation-guard.js`/
     `error-guard.js` como 2 entradas `mcp_tool` separadas (sem clobbering
     observado). Migra como as demais classes.
   - `stop-dispatcher.js` — **NÃO migra fracionado — decisão final, não mais
     bloqueio.** S4(iii) achou que hooks-irmãos de `Stop` NÃO mesclam motivo:
     o harness entrega N mensagens sintéticas separadas (`"Stop hook
     feedback:\n<reason>"`, uma por hook, sem prioridade/dedup), não o
     `{decision:'block', reason: A+SEP+B}` único que `mergeBlocks()` produz
     hoje. Migra como **UMA ÚNICA entrada `mcp_tool`** que por dentro roda os
     mesmos sub-detectors e devolve o `reason` já mesclado (mesma lógica de
     hoje, só o transporte muda) — exceção documentada a P3, motivada por
     evidência medida, não suposição.
   `policy-inject.js` e `model-router-ensure.js` continuam fora desta lista
   (não bloqueiam, só emitem `additionalContext`) — tratamento próprio ainda
   não desenhado, backlog separado.
6. **Testes de paridade** por hook migrado, dois casos (decisão S4): (i)
   daemon vivo → saída idêntica à `command` de hoje (byte-idêntica); (ii)
   daemon inacessível (simulado) → saída inclui o sinal de degradação de S4,
   nunca bloqueia/trava o turno.
7. **Bench de concorrência real** pós-migração: repetir
   `bench-concurrent-spawn.cjs`/`bench-concurrent-warm.cjs` (corrigidos por S2)
   a N=60 no cenário migrado, confirmando que a degradação superlinear medida
   nesta fase (achado motivador) desaparece.
8. **Docs**: `HOOKS-GUIDE.md`, `FUNCTIONAL-SPEC.md` (roadmap), `CHANGELOG.md`.

## Fora de escopo desta fase

- `SessionStart` no lançamento da sessão (`session-start-dispatcher.js`,
  metade de `model-router-ensure.js`/`policy-inject.js`) — `mcp_tool` não
  funciona nesse ponto específico (MCP ainda não conectado); continuam
  `command`. Não é regressão, é limitação real do harness.
- **`brain-daemon-ensure.js`, `brain-health.js`, `brain-status.js` — exclusão
  PERMANENTE, não só desta fase** (achado da rodada 1 do Portão de Plano):
  fazem probe fora de banda do canal MCP/daemon por desenho; migrá-los criaria
  dependência circular. Continuam `command` para sempre.
- Mudar qualquer REGRA/lógica de decisão dos hooks — só o transporte migra
  (mesmo princípio D2 do token-guard: núcleo reaproveitado).
- Subir `MAX_SESSIONS` sem medir primeiro (S2) — não assumir que 50 basta nem
  que precisa subir sem dado real.
- Prometer número de RAM sob carga antes do spike S3 achar uma técnica de
  medição que não contamine a si mesma.
- Migrar `policy-inject.js`/`model-router-ensure.js` antes de S4 decidir o
  mecanismo de fallback (P2) e a classe própria desses dois (P3 relacionado).

## Rodada 1 do Portão de Plano — achados e perguntas

Subagente fresco (contexto mínimo: só ADR-015 + este dossiê, sem histórico da
conversa), 6 eixos + matriz de confiança. **Veredito: bloqueado.** Achados 🔴
já corrigidos diretamente no ADR/dossiê acima (não exigiram decisão do dono,
só leitura de código):

- Dependência circular dos 3 scripts de daemon-liveness (excluídos
  permanentemente — ver §Contexto do ADR-015).
- `brain-health.js` era o exemplo escolhido pelo spike S1 e é o PIOR
  representante possível da classe 2 (seu propósito é validar o caminho MCP
  sem depender dele) — trocado por `correction-detect.js`.
- Contagem "3 sync-real" batia no ADR mas a lista da task 5 tinha 5 arquivos;
  `policy-inject.js`/`model-router-ensure.js` não emitem
  `permissionDecision`/`decision:'block'` em lugar nenhum do código — saíram
  da lista, ganharam classe própria pendente (S4).

**Perguntas que dependiam de decisão do dono do repo — todas RESPONDIDAS:**

- **P2 (fallback):** nem (a) fail-open silencioso nem (b) dual-registro.
  Resposta real: **fail-open VISÍVEL** — falha de transporte retorna sinal
  explícito de degradação, nunca `{}`/allow silencioso. Detalhe em ADR-015
  §Decisões do dono do repo. Task 6 redesenhada com 2 casos (daemon vivo /
  daemon inacessível com sinal visível).
- **P3 (granularidade):** dividir em entradas `mcp_tool` separadas por
  sub-detector, não manter processo consolidado. Confirmado por grep que a
  consolidação original era motivada por economia de spawn ("Consolidates 5
  per-prompt Node spawns... into ONE in-process pass" — comentário literal),
  motivação que desaparece com `mcp_tool`. Tasks 3-5 reescritas.
- **P4 (reprodutibilidade):** não versionar os benchmarks — números ficam de
  referência histórica; task 7 remede do zero sem exigir reprodução exata.

S2 e S3 não dependiam destas perguntas.

## Rodada 2 do Portão de Plano — achados (todos resolvíveis por leitura de código)

Subagente fresco e independente (não assumiu que as correções da rodada 1
estavam certas — releu o código ele mesmo). **Veredito: APROVADO pra iniciar
S1-S3**, com 3 achados que exigem ajuste de escopo antes de fechar S1/S4 (não
são pergunta ao dono — são investigações técnicas incorporadas acima):

- **Achado A** — `pretooluse-bash-dispatcher.js` tem uma regra de merge mais
  grave que a de `stop-dispatcher.js`, e a rodada 1 não a cobriu: "`deny` do
  `error-guard` vence mesmo sobre `allow+updatedInput` do `curation-guard`"
  existe por causa de um bug de produção REAL já reproduzido (cabeçalho de
  `scripts/error-guard.js:23-38`, `CHANGELOG.md:725` — upstream #75915/#15897,
  hooks-irmãos no mesmo matcher corrompendo `tool_input` um do outro). A
  correção de hoje usa "abstain via stdout vazio" (`lib/hook-io.js:136-137`),
  um mecanismo específico de hook `command` sem equivalente comprovado em
  `mcp_tool`. Virou spike **S1b**.
- **Achado B** — o teste original do S4 só cobria "vazio → allow implícito",
  nunca "deny/block explícito realmente bloqueia". Como TODA a classe
  sync-real depende de `mcp_tool` conseguir expressar bloqueio de forma que o
  harness honre (nunca testado em produção — o único `mcp_tool` existente só
  emite `additionalContext`), o S4 foi estendido com esse teste.
- **Achado C** — `stop-dispatcher.js`'s `mergeBlocks()` concatena TODOS os
  motivos de bloqueio simultâneos em ordem de prioridade; não há evidência de
  que o harness ofereça essa concatenação ordenada entre hooks `mcp_tool`
  irmãos no mesmo evento — pode ser irreproduzível, não só arriscado. S4
  estendido com um 3º teste (múltiplos Stop-siblings bloqueando junto).

`graph-guard.js` não tem essa dependência (sem hooks-irmãos no matcher
`Grep|Glob`) e pode migrar sem esperar S1b/S4(iii).

## Resolução do bloqueio S1b/S4 — auth de sessão aninhada + resultados

**Bloqueio original** (limitação de ambiente, não do desenho do teste):
infraestrutura pronta e VERIFICADA em `.ccb-hook-siblings-test/` (servidor MCP
stdio com 5 tools de teste, handshake `initialize`+`tools/list` confirmado; 4
variantes de `.claude/settings.json`), mas qualquer sessão `claude -p`
disparada de DENTRO da árvore de processos desta sessão falhava autenticação
(`403`, "Team ... not in your team memberships" do proxy litellm) — e
removendo a API key herdada pra forçar o `apiKeyHelper`, o processo travava
indefinidamente.

**Causa raiz e fix**: faltava replicar o mecanismo real de auth deste
ambiente — o "Allan Launcher" (`~/.allan-launcher/AllanCore.psm1`,
`Start-ClaudeSession` com `authKey='apikey'`) usa `claude --settings
<override>` com `{"apiKeyHelper": "", "env": {"ANTHROPIC_API_KEY":
"<chave>"}}` — o `apiKeyHelper` precisa ser **explicitamente zerado**, não só
omitido, senão ele continua competindo com a env var. Replicado nos 4 arquivos
de config em `.ccb-hook-siblings-test/.claude/configs/`; sessões aninhadas
passaram a autenticar normalmente.

**Resultados reais** (comandos rodados, não estimados):
```
cd C:\Users\asantos145\Desktop\Allan\.ccb-hook-siblings-test
cp .claude/configs/settings-s1b.json .claude/settings.json   # ou s4ii-deny / s4ii-empty / s4iii-stop
env -u ANTHROPIC_API_KEY claude --settings .claude/settings.json -p "..." --dangerously-skip-permissions --output-format json
```
- **S1b**: `logs/mcp-calls.log` confirma as 2 tools-irmãs chamadas
  (`test_allow_with_update` então `test_deny_no_update`); resultado final =
  Bash bloqueado, razão = a do `deny` (`"test deny"`). Sem clobbering.
- **S4(ii)-deny**: `permission_denials` no output do CLI mostra o Bash
  bloqueado de fato.
- **S4(ii)-empty**: `test_empty` → `{}` → Bash rodou (`permission_denials:[]`).
- **S4(iii)**: fixture original tinha bug de schema (`decision`/`reason`
  aninhados em `hookSpecificOutput`, mas `Stop` espera esses campos na RAIZ do
  JSON — confirmado contra `scripts/stop-dispatcher.js:164`); corrigido e
  re-rodado com `timeout 60` (o par sempre bloqueia, então o processo é morto
  de propósito depois do 1º ciclo pra não gerar loop custoso). `--output-format
  stream-json` capturou 2 mensagens sintéticas SEPARADAS: `"Stop hook
  feedback:\nREASON_A"` seguida de `"Stop hook feedback:\nREASON_B"` — não um
  `reason` único mesclado.

`.ccb-hook-spike-s1/` (S1): 2 formas de tool (`run_hook` genérico vs 3 tools
explícitas) portando `skill-metric`/`correction-detect`/`graph-guard` contra a
lógica real — saída byte-idêntica nas 6 asserções de cada forma; Form B
escolhida (ver tabela).

## Critérios de aceite

- [x] P2/P3/P4 respondidos pelo dono do repo (ver §Rodada 1 do Portão de Plano)
- [x] S2 fechado — sem degradação sob concorrência real (8 sessões), `MAX_SESSIONS=50` não precisa subir
- [x] S3 fechado — RAM real medida (não estimativa): N=60 → 3415MB agregado ephemeral, ~57MB/processo
- [x] S1/S1b fechados; S4 com os 3 testes (i/ii/iii) fechados — `pretooluse-bash-dispatcher.js` e `graph-guard.js` liberados pra migração fracionada; `stop-dispatcher.js` migra consolidado (achado real de S4-iii, não bloqueio)
- [ ] Suite de testes existente (`scripts/run-test-units.mjs`) verde + testes
      novos de paridade por hook migrado
- [ ] Fail-open preservado: daemon inacessível ⇒ caminho `command` local
      idêntico ao de hoje, nunca bloqueia/degrada a sessão
- [ ] Bench de concorrência (N=60) pós-migração NÃO mostra mais o padrão
      superlinear medido nesta investigação (referência: 38,9× a N=60 no
      modelo atual)
- [ ] RAM sob burst medida com técnica validada em S3 (não estimativa) e
      dentro de um teto a definir nesse spike
- [ ] `hooks/hooks.json` atualizado + docs (`HOOKS-GUIDE.md`,
      `FUNCTIONAL-SPEC.md` roadmap, `CHANGELOG.md`)
- [ ] Suite inteira verde + gate PASS + revisor adversarial PASS por fase

## Notas

- O ganho desta fase NÃO é velocidade de chamada isolada (resolvido antes,
  fora desta ADR/fase) — é blindar o sistema contra a degradação superlinear
  sob concorrência real (fan-out de sessões/subagentes) e abrir a porta pra
  desacoplar processamento pesado do turno (fire-and-forget real dentro do
  daemon). Não apresentar este trabalho como "resposta mais rápida" — é
  "comportamento estável sob carga".
- O incidente do `MAX_SESSIONS=50` durante o próprio benchmark desta
  investigação é um sinal real, não só um acidente de teste: qualquer
  migração pra `mcp_tool` precisa decidir esse teto com dado, não copiar o
  valor atual sem verificar se aguenta o padrão real de 6-8 sessões
  concorrentes do usuário.

## Processo

Revisão adversarial do plano (subagente, contexto minimo — só este dossiê +
ADR-015) em loop até aprovar → executar task a task com gate
(`scripts/run-test-units.mjs`) verde + revisor adversarial por fase → commit.
Atualizar este arquivo (decisões dos spikes S1-S3) e `docs/backlog/README.md`
no fechamento.
