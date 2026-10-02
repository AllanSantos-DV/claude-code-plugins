# Backlog

Pontos de melhoria identificados fora do escopo do trabalho corrente (ver política de sessão: "ponto óbvio de melhoria encontrado FORA do escopo atual não é implementado na hora").

## Fase G — hardening do daemon de hooks (rumo à 3.0.0)

Revisão de 2026-10-02 sobre a Fase G (ADR-015) não lançada. Branch de trabalho:
`feat/hook-daemon-transport`. Cada item = um commit mínimo com teste; só vira
`[x]` depois da validação que prova a correção. Legenda: `[ ]` pendente, `[~]` em
andamento, `[x]` resolvido. Medição de referência (servidor de thread única
imitando o daemon, transcript real de 90 MB): 6 `Stop` simultâneos → 60
`PreToolUse` esperam **3,1 s** (p50 = p95) e o RSS vai a **1,16 GB**.

### Performance / robustez do daemon

- [x] **G1 — `Stop` lê o transcript inteiro, síncrono, até 3×, na thread do daemon.**
  **RESOLVIDO em 2026-10-02**: novo `scripts/lib/transcript-tail.js` —
  `readTailLines` (lê do fim para trás, para ao juntar as N linhas, teto 4 MiB)
  em `readLastAssistantText`/`readLastUserText`; `readTailText` (assíncrono, só a
  janela final `SAFE_MAX_CHARS*4+4`) no `conversation-ingest`. Medido no
  transcript real de 90 MB: 179 ms → 1,6 ms / 0,9 ms, mesmas 30 linhas. 4 testes
  novos (paridade com leitura inteira, leitura limitada ao final via espião de
  `fs.readSync`, teto de bytes, `clampRaw` idêntico num arquivo de 31 MB).
  `retrieval-feedback.js:70-73` (`readLastAssistantText`, também usado por
  `decision-scan-response.js:74`), `retrieval-feedback.js:140-143`
  (`readLastUserText`) e `conversation-ingest.js:109` (lê tudo e só depois
  `clampRaw`). ~200 ms por leitura de 90 MB; no daemon isso trava os hooks de
  TODAS as sessões. Fix: leitura do final do arquivo com teto de bytes (já existe
  `_readTail` em `capture-dispatch.js:86`) e `conversation-ingest` lendo só
  `SAFE_MAX_CHARS` do fim.
- [x] **G2 — SQLite síncrono dos hooks na thread principal do daemon.**
  **RESOLVIDO em 2026-10-02**: fila pesada num worker dedicado
  (`servers/brain-server/lib/hook-worker.js` + `hook-worker-client.js`, 1 por
  daemon, FIFO serial — preserva "PostToolUse grava antes do Stop ler"; recriado
  se morrer). `lane: 'heavy'` em `hook-tools.js`: `hook_stop_dispatcher`,
  `hook_posttoolusebash_dispatcher`, `hook_posttoolusefailure_dispatcher`,
  `hook_file_edit_detect`, `hook_skill_metric`, `hook_policy_enforce_shadow`.
  Guards de `PreToolUse`, `graph-guard` e detectores de prompt seguem na thread
  principal (só gravam métrica no SQLite próprio, transação curta). `/health`
  expõe `hookWorker`. Bench (6 sessões × 5 PostToolUse Bash + 3 edits + Stop,
  transcript real de 44 MB): inline o guard respondeu **1 vez** em 1,5 s; com o
  worker **157–166 vezes**, p50 4,4 ms / p95 6,4–7,5 ms. Testes: composição da
  fila, roteamento (pesado → worker, rápido nunca), falha do worker → mensagem
  visível sem bloquear, paridade byte a byte via worker REAL, recriação após crash. As tools
  do KB passam pelo pool de workers (ADR-014), os hooks não: `metrics.fire` →
  `metrics-store.js`, `brain-store.js` em `retrieval-feedback`, `session-summary`,
  `skill-success-detect`, `research-followup-detect`, `self-review`. Com
  `busy_timeout = 5000` (`brain-store.js:194`, `metrics-store.js:121`) um worker
  gravando para o daemon inteiro por até 5 s. Fix: separar fila rápida (guards de
  `PreToolUse`, `graph-guard`) da fila pesada (`Stop`, `PostToolUse`, SQLite) fora
  da thread principal.
- [x] **G3 — `self-review` vaza 1 sessão MCP por `Stop` com edição.**
  **RESOLVIDO em 2026-10-02**: `retrieveViaDaemon` encerra a sessão com `DELETE
  /mcp` no `finally` (sucesso, erro e timeout). Prova contra o daemon REAL
  (`startHttpDaemon`, data-dir temporário): código antigo deixa 5 sessões abertas
  após 5 chamadas, o novo deixa 0. Testes: `DELETE` com o session id no caminho
  feliz e no de erro (daemon falso) + teste com o daemon real (`sessions.size === 0`).
  `lib/self-review-retrieve.js:143` faz `initialize` no próprio daemon e nunca
  encerra (sem `DELETE`/`terminateSession`); o slot só volta no reaper de 30 min
  (`http-daemon.js:24`). Com 6–8 sessões os 50 slots (`MAX_SESSIONS`) esgotam e
  sessão nova do Claude Code recebe 429 → sem hooks e sem tools do Brain. Fix:
  dentro do daemon chamar a busca in-process; fora dele, encerrar a sessão.
- [x] **G4 — classe "async-elegível" não é fire-and-forget.** `hook-tools.js:84-88`
  faz `await m.run(ev)` antes de responder, contra a ADR-015 §Decisão 1. Fix:
  responder `{}` na hora e enfileirar o trabalho.
  **RESOLVIDO em 2026-10-02**: `async: true` nos 5 hooks que sempre devolvem `{}`
  (`skill_metric`, `file_edit_detect`, `posttoolusebash_dispatcher`,
  `posttoolusefailure_dispatcher`, `policy_enforce_shadow`) → `hookWorker.enqueue`
  e ack `{}` imediato. Continuam na MESMA fila FIFO do worker (o efeito colateral
  cai antes do próximo `Stop`). Fila de segundo plano com teto de 1000 (descarta o
  mais antigo, com log). Fail-open continua VISÍVEL (P2): falha em segundo plano é
  anexada como `systemMessage` no próximo `Stop` daquela sessão, uma vez. Bench
  (60 `PostToolUse` Bash simultâneos): p95 ~580 ms → ~2 ms. Testes: conjunto async
  ⊂ fila pesada, ack sem esperar o worker, ordem FIFO com worker real, falha
  reportada no próximo `Stop` só da sessão certa e só uma vez.
- [x] **G5 — sem prazo, cancelamento nem limite de concorrência por hook.** Hook
  que estoura o `timeout` do `hooks.json` continua rodando no daemon; `Stop`s se
  acumulam sem teto. (Substitui o item de timeout em "Arquitetura".) Fix: prazo
  interno abaixo do timeout declarado; `Stop` serializado por sessão com coalescência.
  **RESOLVIDO em 2026-10-02**: prazo por tool = `timeout` do próprio `hooks.json`
  − 1 s (fonte única, `deadlinesFromHooksJson`). Fila rápida: `withDeadline` —
  passado o prazo responde a mensagem de fail-open visível (nunca decide nada).
  Fila pesada: `hookWorker.run(…, {timeoutMs})` + prazo absoluto no job; o worker
  PULA o job que ainda estava na fila quando o prazo passou (`/health` →
  `hookWorker.expired`), em vez de rodar trabalho que ninguém lê. A "coalescência"
  sai disso: um `Stop` velho abandonado expira e não roda. Fila de segundo plano já
  tem teto (G4). Limite conhecido: código síncrono não é abortável — um hook que
  passa do prazo termina em segundo plano. Testes: prazos derivados do
  `hooks.json`, hook inline travado responde no prazo, `Stop` preso atrás da fila
  responde no prazo e depois é pulado (worker real).
- [x] **G6 — `SubagentStart` ainda sobe 1 `node` por subagente** (`policy-inject.js`,
  `hooks/hooks.json:21-31`) — exatamente o cenário de fan-out. `mcp_tool` funciona
  nesse evento. Fix: migrar para `mcp_tool`.
  **RESOLVIDO em 2026-10-02**: `hook_policy_inject` (fila rápida; ecoa
  `hook_event_name` como o CLI) e `SubagentStart` no `hooks.json` como `mcp_tool`.
  Bench (60 `SubagentStart` simultâneos): spawn ~3,9–4,0 s com 60 processos
  `node` → daemon ~0,26 s, 0 processos. Testes: paridade sem política e com
  política ATIVA (byte a byte com o CLI, eco `SubagentStart`, silêncio após
  desativar); `policy-inject` na lista de scripts que não podem mais ser
  spawnados. Achado e corrigido na hora: `config-testers: hooks validates this
  repo hooks.json` tinha piso fixo `>= 5` hooks `command` — virou a contagem exata
  lida do `hooks.json`. Docs: README, HOOKS-GUIDE (filas, fire-and-forget, prazo,
  leitura do final do transcript — cobre G1–G5), FUNCTIONAL-SPEC.
  **Pendente de validação no Claude Code real** (instalação isolada, antes do
  pacote): confirmar que o `mcp_tool` no `SubagentStart` injeta no contexto do
  subagente — o dossiê afirma suporte ao evento, este teste roda fora do harness.
- [x] **G7 — `UserPromptSubmit` sobe 2 `node` por prompt** (`model-router-ensure` +
  `user-prompt-submit-dispatcher`, `hooks/hooks.json:240-254`) e roda também em
  cada `<task-notification>` de agente em background. Fix: um só spawn, saída
  rápida antes de carregar módulos pesados, throttle por sessão para as checagens
  de saúde, e pular prompts sintéticos.
  **RESOLVIDO em 2026-10-02 (o que a medição justificou)**: medido em ambiente
  isolado, o script quase não pesa — o piso do processo `node` nesta máquina é
  ~50–90 ms / ~63 MB (antivírus avalia cada processo). Por isso "saída rápida" e
  "pular sintético" dentro do script quase não economizam; o que economiza é
  eliminar spawn. Feito: `model-router-ensure.main()` virou `run(evento)` sem
  `process.exit` (o CLI segue igual para o `SessionStart`) e entrou como 1º
  detector do `user-prompt-submit-dispatcher` (teto 25 s, concorrente com os
  outros); o dispatcher sai sozinho após esvaziar o stdout (o router deixa handles
  abertos). Por prompt: 2 processos (~72 + 68 MB) → 1 (~75 MB), latência igual
  (~110 ms). Testes: lista do dispatcher, `run()` não chama `process.exit`,
  `UserPromptSubmit` com 1 só `command`, CLI do dispatcher termina sozinho.
  O ruído dos detectores em `<task-notification>` segue no **U6**.
- [x] **G8 — não há como subir um daemon isolado para bench/teste.**
  **RESOLVIDO em 2026-10-02 (sem código novo no plugin)**: `startHttpDaemon` direto,
  com `CLAUDE_PLUGIN_DATA`/`HOME`/`USERPROFILE` temporários e `port: 0`, sobe um
  daemon isolado sem ponteiro global nem consolidação. Usado pelo teste do G3 e
  pelo bench local `.claude/scripts/bench-hook-daemon-launcher.mjs`.
  `servers/brain-server/index.js` publica o ponteiro global de data-dir
  (`publishAndFollow`) e consolida pastas vizinhas no boot. Fix: modo
  `--isolated` (data-dir e porta próprios, sem ponteiro global, sem consolidação).
  Nota (G3, 2026-10-02): chamar `startHttpDaemon` direto (sem o `index.js`) com
  `CLAUDE_PLUGIN_DATA`/`HOME`/`USERPROFILE` num diretório temporário e `port: 0`
  já sobe um daemon isolado — o teste de G3 usa isso. Pode bastar para o bench.
- [~] **G9 — bench de aceite realista** (depende de G8): 6–8 sessões MCP, transcripts
  grandes reais, `Stop` concorrente com `PreToolUse` e indexação rodando. Critério:
  p95 de `PreToolUse` < 100 ms durante `Stop`s e RSS do daemon estável.
  **Bench feito (2026-10-02)** — `.claude/scripts/bench-hook-daemon.mjs` (local):
  daemon isolado em processo filho, 8 sessões MCP reais por HTTP, por rodada os 2
  guards irmãos de `PreToolUse`, `PostToolUse` Bash, edição, `Stop` a cada 4 com o
  transcript real de 90 MB; depois rajada de 60 `PreToolUse` + 8 `Stop` juntos.
  Base da Fase G (`72de19b`) → HEAD:

  | | base | HEAD |
  |---|---|---|
  | PreToolUse em regime p50/p95/máx | 53 / 971 / 2181 ms | **5 / 32 / 47 ms** |
  | PostToolUse p50/p95 | 53 / 90 ms | **2 / 17 ms** |
  | Stop p50/p95 | 503 / 2529 ms | 574 / 2147 ms |
  | rajada 60 PreToolUse p50/p95 | 912 / 1160 ms | **131 / 222 ms** |
  | RSS pico do daemon | 388 MB | 566 MB |

  **Achados no bench e corrigidos na hora** (caminho quente do daemon):
  (a) `data-dir.writeActivePointer` reescrevia o ponteiro global (tmp+rename) em
  TODA chamada de `dataDir()` com env — agora não escreve se já aponta para a
  pasta; `publishAndFollow` com caminho rápido; `readActivePointer` com cache por
  ino/mtime/tamanho: `dataDir()` 0,8 → 0,07 ms. (b) Reset+releitura da config a
  cada chamada → `sourceStamp()` (stat) em `hooks-config`/`brain-config`, reset só
  quando muda. (c) `runWithHookEnv` copiava o `process.env` inteiro por chamada →
  visão read-through (Proxy). (d) `curation-paths.findProjectRoot` fazia até 170
  `existsSync` por chamada → memo de 30 s por cwd. (e) **Bug**: o `_cfgCache` do
  `curation-paths` nunca era invalidado no daemon (config de curadoria editada só
  valia após reiniciar o daemon) — agora segue o carimbo do `hooks-config`; teste
  falha sem a correção e passa com ela. Custo por chamada: `error_guard` 3,9 →
  0,8 ms, `correction_detect` 2,3 → 0,5 ms.
  **Ainda abertos**: rajada de 60 com p95 222 ms (> 100 ms) → **G11**; RSS → **G10**.
- [x] **G10 — primeira passada do `capture-queue.ingest` lê o transcript inteiro.**
  **RESOLVIDO em 2026-10-02 (decisão do dono: "ler o inteiro está errado; últimos
  X turnos, configurável, padrão 3, via tool reutilizável, só user + assistant,
  thinking opcional")**: novo `lib/transcript-turns.js` (`readLastTurns`, lê do fim
  para trás até juntar N turnos humanos, teto 16 MiB; limpeza mecânica do
  `transcript-block`: sem tool call/output, subagente, hook feedback, resumo de
  compactação; thinking só com `includeThinking`). `capture-queue.ingest` usa ele
  a cada `Stop` (cursor de bytes removido); dedup por hash + `promptId` (turno que
  cresceu é atualizado na fila, não duplicado). Config `kb.capture.turns: 3` e
  `kb.capture.includeThinking: false` (CONFIGURATION.md). 1 `Stop` no transcript
  de 90 MB: pico do daemon 340 → 254 MB. Bench 8 sessões: RSS 566 → 440 MB, Stop
  p95 2147 → 495 ms, rajada p95 222 → 103 ms. Testes: janela/limpeza/thinking,
  leitura limitada ao final (espião de bytes), fila com 3 de 40 turnos,
  idempotência, turno crescido sem duplicata. Os 5 cenários de teste do
  `capture-dispatch` que gravavam o transcript inteiro e esperavam 1 `Stop` lendo
  tudo agora semeiam turno a turno (como uma sessão real: 1 `Stop` por turno).
  `scripts/lib/capture-queue.js:95-130`: com cursor 0 (1º `Stop` da sessão, ou
  rebase após compactação) faz `_readBuf(from=0, boundary)` do arquivo todo, extrai
  TODOS os ciclos e grava todos na fila e no arquivo de estado. Medido: 1 `Stop`
  com transcript de 90 MB leva o daemon de 207 → 340 MB; 8 sessões → pico 566 MB.
  Decisão do dono necessária: limitar a 1ª passada a uma janela final (últimos
  N MB / K ciclos) muda a semântica (ciclos antigos da sessão não seriam
  oferecidos). Fix proposto: janela final + leitura em blocos.
- [x] **O11 — `lib/error-store.js` virou só escrita** depois do U2/U10: o
  `error-guard` lê o transcript; `failure-detect` (record) e `error-resolve`
  (resolve, detector do `posttoolusebash-dispatcher`) seguem gravando um store que
  ninguém lê. Remover gravação + módulo + fixtures num commit de limpeza.
  **RESOLVIDO em 2026-10-02**: removidos `lib/error-store.js`, `error-resolve.js`,
  o `recordErrorGuard` do `failure-detect`, o detector do dispatcher e o
  `errorGuard.windowDays` (90 dias) da config. Testes: 11 do store saíram; o do
  `failure-detect` passou a verificar o journal de falhas (o efeito que ficou);
  fixtures do `error-guard` só com transcript. Docs: README, CONFIGURATION.
- [ ] **O12 — 39 pastas `_boss-backup-*` (2,4 GB) acumuladas em
  `~/.claude/plugins/data/`** (vistas em 2026-10-02, de 2026-07-18 a 2026-08-01).
  Parecem backups da consolidação de data-dirs sem poda. Verificar quem cria
  (`consolidate-datadirs`?), limitar retenção (ex.: últimos N / X dias) e oferecer
  limpeza no doctor/dashboard.
- [x] **Proteção de sessão isolada (achado ao preparar a validação, 2026-10-02)**:
  numa config isolada o `model-router-ensure` ainda mexeria em estado da máquina
  (porta fixa do router, limpeza de env de usuário via PowerShell, shim do
  `claude.exe`). `CCB_ISOLATED=1` faz ele não gerenciar o router (commit
  e4954b2). Teste: nenhum processo é disparado com a variável ligada.
- [x] **U12 — `graph-guard` trata `grep -rn padrão arq1 arq2 …` com arquivos
  explícitos como "busca recursiva ampla"** e nega (deny-once). Visto em
  2026-10-02. `lib/graph-guard-core.js` `matchBroadBashSearch`: só deveria valer
  quando o alvo é a raiz/diretório, não uma lista de arquivos.
  **RESOLVIDO em 2026-10-02**: a causa real era o corte no 1º `|` sem respeitar
  aspas — o `\|` do padrão (`"a\|b"`) cortava o comando ali e os arquivos-alvo
  sumiam. Agora `_firstPipelineWords` corta só no `|` fora de aspas e separa
  palavras respeitando aspas. Replay no histórico: "busca ampla" 49 → 17
  comandos; todos os que mudaram eram `grep -r` com escopo explícito e padrão com
  alternativas. Testes: alternativa citada + arquivos = escopado; padrão com
  espaço e `|` = 1 palavra; `.` continua amplo.
- [x] **O10 — `scripts/lib/session-marker.js` ficou sem uso** depois do G10 (o
  `capture-queue` era o único consumidor do cursor). Só os próprios testes o usam.
  Remover módulo + testes num commit de limpeza.
  **RESOLVIDO em 2026-10-02**: módulo removido; 5 testes dele saíram; as 18
  chamadas de higiene de fixture nos testes do `capture-dispatch` saíram (o
  teardown agora é `capture-queue.reset`, o estado que importa). Suíte 1291/0.
- [ ] **G11 — rajada de 60 `PreToolUse` simultâneos ainda com p95 ~220 ms.**
  (Após o G10: p95 103 ms, praticamente na meta de 100 ms.) Fica aberto só para
  confirmar no bench do ambiente real (máquina mais fraca); nada a otimizar antes
  dessa medição.
  120 chamadas MCP (2 guards irmãos × 60) serializadas na thread principal: o que
  sobra é ~1,6 ms de CPU do `curation_guard` + o overhead por requisição do SDK
  MCP/HTTP. Próximos passos: perfilar o `curation_guard` (shells.json / assinatura)
  e medir o custo fixo do SDK por chamada.

### Validação no Claude Code REAL — sessão isolada (2026-10-02)

Harness local `.claude/scripts/isolated-smoke.mjs` (plugin via `--plugin-dir` a
partir de `git archive HEAD`, `CLAUDE_CONFIG_DIR`/`HOME` temporários, daemon na
porta 38219, `CCB_ISOLATED=1`, probe que grava o input bruto dos hooks). O daemon
real (2.29.0, porta 38217) seguiu intacto. Resultados (Claude Code 2.1.283):
- [x] Hooks `mcp_tool` rodam no daemon isolado (journal do `posttoolusebash` em
  segundo plano e `capture-queue` do `Stop` gravados no data-dir isolado).
- [x] **G6**: `hook_policy_inject` no `SubagentStart` injeta a política no
  contexto do subagente (o subagente citou "veio pelo hook SubagentStart").
- [x] **U5**: `agent_id`/`agent_type` no input de hook de subagente e os
  placeholders funcionam em `mcp_tool` (corrigido, commit 1c5cbe7).
- [x] **U2/U10 (P8)**: 3ª execução idêntica sem edição foi bloqueada com a
  mensagem nova (`permission_denials` no resultado do CLI).
- [x] 4 sessões reais simultâneas: todas concluíram; hook worker sem expirados
  nem re-enfileirados.
- [ ] **O14 — 1ª sessão com o daemon parado: o MCP falha ao conectar
  (ECONNREFUSED) no início** e os hooks `mcp_tool` só passam a funcionar depois
  que o `brain-daemon-ensure` (UserPromptSubmit) sobe o daemon — os do 1º
  prompt podem ser perdidos (vistos: os efeitos da sessão apareceram, a janela
  inicial não foi medida). Medir na instalação real (1ª sessão após boot) e
  avaliar subir o daemon já no `SessionStart` ou no logon (como o token-guard).
- [ ] **O13 — RSS do daemon com backend local: ~533 MB parado** em sessão real
  (bench sem embedder: ~440 MB). Medir a divisão (embedder na thread principal,
  N slots do pool do KB, hook worker) antes de otimizar.
- [ ] **G12 — inferência do embedder na thread principal do daemon** a cada
  prompt (`brain_retrieve_context`, backend local): trava os guards durante a
  inferência. Medir o tempo por prompt; se relevante, mover para worker.

### UX / ruído visto usando a ferramenta (sessão de 2026-10-02)

- [x] **U1 — `curation-guard` redireciona comando composto para script que não o
  cobre** — **RESOLVIDO em 2026-10-02 pelo resultado medido** (replay de 9.459
  chamadas reais): dos 727 comandos que casam com um alias, 401 eram compostos e
  só 51 desses tiveram saída volumosa. Nova regra: o alias sendo o comando inteiro
  (`command-signature.workSegments` = 1 segmento de trabalho, descontando
  `cd`/`echo`/atribuição/heredoc de escrita) → nega como antes; composto → permite
  + `additionalContext` com o script curado; a saída volumosa segue cobrada pela
  curadoria do `Stop`. Negações no histórico: 727 → 326 (−55%). Caminho do
  script agora ABSOLUTO (com `/`) na negação e na dica. Testes: composto → allow +
  dica com caminho absoluto, `cd x && alias | tail` segue negando, `workSegments`. (`git log …; git diff --shortstat; git show --stat` → `git-log-branch.mjs`,
  sem data nem diffstat) e sugere caminho relativo (`.vscode/scripts/…`) que
  quebra fora da raiz do repo. **Decisão do dono (2026-10-02)**: entender melhor o
  comportamento — pesquisar, medir, testar cenários — e escolher pelo resultado dos
  testes (nada de mudar no escuro). Contexto da análise: hoje QUALQUER segmento que
  bate com um alias nega o comando composto inteiro (`shells-config.js:149-160`).
  Proposta: negar só quando o alias é o comando todo (ou o único segmento
  significativo); em composto, permitir + `additionalContext` apontando o script
  curado do segmento — a curadoria do `Stop` continua pegando saída volumosa. E
  sugerir o caminho ABSOLUTO do script. Nesta sessão foram 8+ chamadas negadas
  por isso, incluindo `git diff > arquivo` e `for … git -C …` de inspeção.
- [x] **U2 — `error-guard` bloqueia por falhas registradas em OUTRO cwd** (falhou em
  `claude-code-boss/`, bloqueou na raiz onde funcionaria): a chave ignora o cwd.
  **Análise (2026-10-02) — decisão do dono, junto com o U10**: ignorar cwd/flags é
  DESENHO declarado (`lib/error-store.js:15-16`: "identity is the exact
  canonicalSig … so cwd/flags/wrappers don't fragment the count"). O defeito real é
  um IMPASSE: 2 falhas em 90 dias (`DEFAULT_WINDOW_DAYS`/`DEFAULT_THRESHOLD`)
  bloqueiam o comando, e só um SUCESSO do mesmo comando limpa (`error-resolve`) —
  que nunca acontece, porque ele está bloqueado. A única saída é uma variação do
  comando (caminho absoluto, outro argumento). Proposta: negar UMA vez por
  (sessão, sig) injetando a causa — o retry idêntico na mesma sessão passa (padrão
  que o `graph-guard` já usa) — e/ou considerar o cwd quando o comando tem caminho
  relativo. Mantém o objetivo (o agente vê a causa antes de repetir) sem travar.
  **Decisão do dono (2026-10-02)**: NÃO liberar por retentativa — o modelo aprende
  a burlar e nunca corrige a causa; e janela de 90 dias está errada. Mesmo método
  do U1: pesquisar, medir, testar cenários e escolher pelo resultado.
  **RESOLVIDO em 2026-10-02 (U2 + U10) pelo resultado medido**: replay de 9.459
  chamadas Bash reais (66 sessões, `.claude/scripts/replay-guards.mjs`, local) contra
  8 políticas. Escolhida a **P8 — sessão + diretório efetivo + só uma edição real
  desbloqueia**: bloqueios falsos (o comando teria funcionado) 34 → 4, loops cegos
  deixados passar 17 → 14 (melhor que o atual). Retentativa NÃO desbloqueia (um
  retry negado não conta); só sucesso ou Edit/Write. Políticas descartadas pelos
  números: P4 "libera se rodar outro comando" (é o burlar), janela de 4 h, só
  cwd. Implementação: `lib/session-failures.js` lê o transcript da própria sessão,
  incremental (só os bytes novos; a frio até 8 MB: 26 ms 1×/sessão, depois
  0,04 ms/consulta); chave `canonicalSig + diretório efetivo` (`cd X &&` ou cwd;
  `/c/x` = `C:\x`); comandos de subagente e negações de hook não contam. Mensagem
  não sugere mais "rode uma variação". **Achado e corrigido na hora**: com o G4 o
  registro da falha (`posttoolusefailure`, fila de segundo plano) podia cair DEPOIS
  do próximo `PreToolUse` — corrida que some ao ler o transcript (verificado nesta
  sessão: o tool_result anterior já está no transcript quando a próxima chamada
  começa). Testes: 2 falhas bloqueiam/1 não, edição libera e retry negado não,
  escopo sessão/diretório/subagente, incremental + reescrita, mensagem sem "variação".
- [~] **U3 — script curado proíbe pipe e trunca a saída ("--full to see")**,
  forçando nova execução. E a detecção de pipe olha o comando INTEIRO, não o
  segmento: `… test-hooks.mjs && node release-audit.mjs check | tail -2` foi
  bloqueado como "script curado com pipe" — o pipe era do `release-audit`.
  **Parte do bug RESOLVIDA em 2026-10-02**: `pipesCuratedScript` só nega quando o
  pipe está no MESMO segmento, à direita da chamada do script curado. Teste em
  `test-hooks.js` (falha no código antigo, passa no novo). **Aberto (decisão de
  desenho)**: a política "script curado nunca com pipe" + saída truncada continua
  — o atrito de rodar de novo com `--full` é do contrato da curadoria.
- [x] **U11 — comentário do `matchCuratedShell` (`shells-config.js:126-136`) é
  falso.** **RESOLVIDO em 2026-10-02**: `_tokenize` agora respeita aspas como um
  shell (string entre aspas = 1 token; `\` literal p/ caminho Windows; `\"`
  escapa); string após `-c`/`-Command`/`/c` é tokenizada por dentro (shell-in-
  shell). Replay nas 9.558 chamadas reais: a decisão "invoca o script curado"
  mudou em 3, todas falsos positivos eliminados (nome do script dentro de padrão
  `grep`, expressão `sed`, `node -e`); a regressão vista na 1ª versão
  (`pwsh -Command "& ./…ps1"`) foi pega pelo replay e corrigida. Testes: dentro de
  string não conta, caminho citado conta, caminho Windows sem aspas conta,
  `-Command`/`bash -c` contam. Diz que `echo "running .vscode/scripts/vitest.ps1"` NÃO casa, mas o
  `_tokenize` tira as aspas de cada token e o path casa. Na prática um nome de
  script curado dentro de uma string (`node -e "…test-units.mjs…"`) conta como
  "invocando o script". Fix: tokenizar respeitando aspas (como
  `command-signature.indexOfShellMeta`) e corrigir o comentário.
- [x] **U4 — RESOLVIDO em 2026-10-02 (decisão do dono: mudar na major)**:
  assinatura de composto = assinatura de cada segmento de trabalho, em ordem,
  sem repetição, unidas por ` && ` (1 segmento de trabalho continua igual).
  Achado e corrigido na hora: `{ …; } > f` expôs o fechamento `} > f` como
  "comando" — `GROUP_CLOSE` agora aceita o fechamento com redirecionamento.
  Replay: assinaturas que cobriam comandos de trabalho diferentes 425 (2.285
  comandos) → 27 (248, só repetição colapsada); 4.041 assinaturas de compostos
  mudam (major: marcações/curadoria antigas de compostos são pedidas de novo
  uma vez — CHANGELOG). 9 testes que fixavam "o 1º segmento" atualizados para a
  nova identidade, mantendo o que cada um protege (sem fusão, sem vazamento).
- [ ] ~~U4 — assinatura de uso único genérica demais~~ (`ls lib` de um comando
  `ls lib && wc … && grep …`): marcar como one-off silencia qualquer `ls lib`.
  **Medido em 2026-10-02 — decisão do dono**: a assinatura de composto é o 1º
  segmento de trabalho POR DESENHO declarado (teste "the sig is the FIRST
  invocation (by design)"). No histórico, 425 assinaturas cobrem 2+ comandos de
  trabalho diferentes (2.285 de 9.625 comandos, ~24%): `git status` cobre 50
  variantes (`git status && git diff`, `… && ls .vscode/scripts`). Efeito além do
  one-off: recorrência e saída volumosa são atribuídas ao 1º segmento (a saída
  de um `git diff` vira "git status precisa de script curado"). Proposta: a sig
  de composto = sigs de todos os segmentos de trabalho. Mexe na identidade usada
  por curadoria/one-off/aliases (marcações gravadas deixam de casar e são podadas
  pelo `oneoff-store.load`) — por isso não foi feito sem decisão.
- [x] **U13 — número de descritor fica na assinatura** — **RESOLVIDO em
  2026-10-02 (decisão do dono: mudar na major)**: o número COLADO ao
  redirecionamento sai da assinatura (`git status 2>&1` = `git status`;
  `sleep 2 > f` mantém o `2`). Testes de identidade atualizados (antes fixavam
  `npm test 2`). Entradas gravadas com o sufixo antigo deixam de casar — o
  usuário é cobrado uma vez (registrar no CHANGELOG da major). Texto original: (`git status 2>&1` →
  `git status 2`, diferente de `git status`). Medido em 2026-10-02: corrigir muda
  2.919 de 9.625 assinaturas (~30%) e quebra 2 testes que fixam a identidade das
  sigs gravadas — mesma natureza do U4 (migração de dados gravados). Testado e
  REVERTIDO; aguarda a mesma decisão do U4. Fix pronto: no `canonicalSig`, ao
  cortar no redirecionamento, remover o número COLADO (`2>`), nunca um argumento
  seguido de espaço (`sleep 2 > f`).
- [x] **U5 — RESOLVIDO em 2026-10-02 com teste no Claude Code REAL (sessão
  isolada)**: o input do `PreToolUse`/`PostToolUse` de uma chamada de subagente
  traz `agent_id` e `agent_type` (da sessão principal, não); e os placeholders
  `${agent_id}`/`${agent_type}` FUNCIONAM no `input` de `mcp_tool` (probe: subagente
  → `ad838ed94863c25b6`, principal → vazio). `hooks.json` passa `agent_id`/`agent_type`
  aos dispatchers de `PostToolUse`/`PostToolUseFailure`; o `curation-detect` não
  põe comando de subagente no journal do turno (o `Stop` do pai não cobra) — a
  recorrência segue contando. Teste unitário: principal entra no journal,
  subagente não; `hooks.json` passa o campo; `rebuildEvent` descarta vazio.
- [ ] ~~U5 — comandos de subagente entram na curadoria do `Stop` do pai~~ (o `find`
  em `token-guard` foi do subagente e bloqueou o turno principal).
  **Pesquisado em 2026-10-02**: a doc oficial do Claude Code não diz se o input de
  `PreToolUse`/`PostToolUse` de uma chamada de subagente traz `agent_id`, nem
  documenta placeholder `${agent_id}` para `mcp_tool` (consulta via agente de
  docs, sem fonte conclusiva). Depende de teste no Claude Code REAL: logar o input
  do hook quando um subagente roda Bash — entra no smoke de validação.
- [x] **U6 — hooks de `UserPromptSubmit` disparam sobre `<task-notification>`**:
  "the user may be correcting you" e sugestão `research_query({query:"<task-notification>"})`.
  **RESOLVIDO em 2026-10-02**: `lib/prompt-kind.js` (`isSyntheticPrompt`: prompt que
  começa com `<task-notification>`, formato confirmado no transcript desta sessão).
  `correction-detect`, `active-research-detect` e `brain_retrieve_context` não
  rodam sobre ele (o recall injetava lições sem relação sobre o relatório do
  agente — parte do U7). Testes: helper, os 2 detectores calados na notificação e
  ativos no mesmo texto digitado pelo usuário, `retrieve()` nunca chamado na
  notificação e chamado num prompt real.
- [ ] **U7 — recall injeta lição de outro projeto/irrelevante** ("Memory convergence…
  hermes… develop 92 commits" numa sessão do claude-code).
  **Investigado em 2026-10-02**: parte do ruído vinha de recall sobre
  `<task-notification>` (resolvido no U6). A lição "hermes" NÃO aparece no
  `brain_search` do projeto (`scope: both`) — logo não vem do KB do projeto: veio
  do caminho do `brain_retrieve_context`, que em `mcp-memory` chama o
  `compose_recall` do servidor externo (blocos de escopo global/ancestral). A
  causa está no lado do servidor (`native-java`), fora deste plugin. Próximo
  passo: capturar o trace do `compose_recall` (bloco/escopo/score da entrada) no
  teste em ambiente real e abrir o achado no projeto do servidor.
- [x] **U8 — `[BRAIN·SKILLS] 1 available capability pointer(s): - (unnamed)`** em
  todo turno: ponteiro sem nome renderizado.
  **RESOLVIDO em 2026-10-02**: `brain-backend.splitComposeBlocks` deriva o nome da
  1ª linha da descrição/texto e DESCARTA o ponteiro sem nada que o nomeie (o
  `deriveTitle` nunca devolve vazio — cai em `'memory'` —, por isso o teste do
  texto vem antes). Teste: vazio descartado, nome derivado da descrição, nenhum
  bloco `[BRAIN·SKILLS]` quando só havia ponteiros vazios.
- [x] **U9 — `active-research-detect` com falso positivo `libMention`** —
  **RESOLVIDO em 2026-10-02 pelo resultado medido** (1.365 prompts humanos reais):
  disparava em 75, sendo 66 só por menção de lib e 9 por lib + versão — na amostra,
  praticamente tudo ruído ("verifica o docker", "faz o fetch", `\claude` de um
  caminho `…\claude-code`, `v1` em nome de arquivo). Agora: lib 1.0 → 0,5 e
  versão 0,5 → 0,4 (contexto, não pedido — só disparam com "melhor forma"/
  integração), nome de lib dentro de caminho/identificador não conta, e novo sinal
  forte `researchAsk` (1.0: "pesquisa/pesquise/research/procure na internet/
  estado da arte", fora de caminho), config `activeResearch.triggers.researchAsk`.
  Replay: 75 → 50 disparos, a maioria pedidos reais de pesquisa. Testes: casos
  reais que não disparam mais, pedido explícito e "melhor forma" + lib disparam,
  lib/research dentro de caminho não contam. (Texto original:) em
  "Teste rápido do MCP smart-tool".
- [x] **U10 — `curation-guard` e `error-guard` se travam em runner de teste.** (RESOLVIDO com o U2 em 2026-10-02.)
  Parte RESOLVIDA em 2026-10-02 pelo O4 (`node - <<EOF`/`cat <<EOF` não colapsam
  mais para a sig do programa puro). O impasse "bloqueado até passar, mas não pode
  rodar" fica com a decisão do **U2**.
  `error-guard` bloqueia `node .vscode/scripts/test-units.mjs` por falhas antigas
  (registro "1137 passed / 1 failed", de outra época) — e a chave ignora os
  argumentos (`--all` também é bloqueado); o `curation-guard` bloqueia o runner
  cru e manda de volta para o wrapper. Só saiu pelo caminho absoluto. Pior: a
  chave chega a colapsar para o programa sozinho — `node` (qualquer `node - <<EOF`)
  ficou bloqueado por uma falha antiga de outro script stdin. Runner de
  teste é exatamente o comando que se repete depois de corrigir: não deveria
  ser bloqueado por falha anterior, ou a chave deveria considerar mudança de código.

### Outros achados da revisão

- [x] **O1 — `retrieval-feedback.js:186` escopa por nome de pasta**
  (`path.basename(ev.cwd)`), contra o contrato de project id da 2.29.1.
  **RESOLVIDO em 2026-10-02**: era bug real — `store.init({project: basename})` +
  `recordCitation(id)` fazia `UPDATE` num shard sem a entrada (0 linhas, silencioso):
  citações de lições reais nunca contavam (só se o nome da pasta fosse o id).
  Agora a citação vai para o escopo de onde a entrada foi RECUPERADA (`project` do
  journal, gravado por `brain_retrieve_context`), com fallback
  `tryResolveProjectId(cwd)`; sem escopo (pasta sem id) não registra. Métricas
  seguem por `basename`, como todos os outros writers de métrica (store local,
  consistente entre escrita e leitura). Teste falha no código antigo, passa no novo.
- [x] **O9 — `lib/metrics.js:14-18` cai em `process.cwd()` sem `ctx.cwd`.** No
  daemon é o cwd do próprio daemon (1ª sessão), não o da sessão. Todos os chamadores
  atuais passam `ev.cwd` e o `hooks.json` sempre envia `cwd`, então não foi visto
  acontecer; fallback correto no daemon seria `hookEnv().CLAUDE_PROJECT_DIR`.
  **RESOLVIDO em 2026-10-02**: fallback `ctx.cwd` → `hookEnv().CLAUDE_PROJECT_DIR` →
  `process.cwd()`. Teste: dentro de `runWithHookEnv` usa a raiz da sessão que chamou.
- [x] **O2 — `_readBuf` duplicado** em `capture-dispatch.js:56` e
  `lib/capture-queue.js:71`.
  **RESOLVIDO em 2026-10-02**: uma cópia só, `readRange` em `lib/transcript-tail.js`;
  os dois módulos importam (`readRange: _readBuf`). Teste do range (intervalo,
  além do EOF, arquivo ausente, intervalo vazio) + suíte inteira verde.
- [x] **O3 — ADR-015 com cabeçalho "Proposto"** apesar de implementada; e a branch
  `dev` tinha outro "ADR-015" (router upstream override) — numeração colidindo.
  **RESOLVIDO em 2026-10-02**: cabeçalho "Implementado (não lançado)" + nota do
  hardening (classe 4 resolvida por G6/G7, filas G2/G4/G5). A colisão só existe no
  patch resgatado da `dev` (`docs/plans/salvage/dev-commits/0002-…ADR-015.patch`) —
  se for reaproveitado (O4), renumerar como ADR-016.
- [x] **O4 — trabalho não commitado resgatado das worktrees removidas** (patches em
  `docs/plans/salvage/`, local): `loving-morse` (fix de assinatura de curadoria
  com testes), `dazzling-jang` (`command-signature`/`oneoff-store`), `dev`
  (2 commits de router + `scripts/detectors/` não versionado). Avaliar e
  reaproveitar ou descartar.
  **AVALIADO em 2026-10-02**: `loving-morse` **aplicado** (limpo sobre o HEAD,
  +14 testes, suíte 1294/0): heredoc deixa de colapsar a assinatura para o
  programa puro (`node - <<EOF` → `node heredoc-<digest>`; `cat > f <<EOF` é
  setup), `>&2`/`&>` não viram segmento, sig de 1 token de programa é marcável
  como one-off, batch de `curation_mark_oneoff` não funde sigs sem relação — é a
  raiz do bloqueio de `node`/`cat` do **U10** (o `error-store` usa `canonicalSig`).
  `dazzling-jang`: versão anterior/paralela da mesma correção (`stripHeredocBodies`,
  `markExact`/`markGroup`), superada pela `loving-morse` — descartada. `dev`:
  "cache-aware sticky" e "upstream override + custom headers" já estão na `main`
  em forma mais evoluída (modo `sticky-tier`; gateway `upstream` com
  `forwardHeaders`/`endpoints`/`wireProtocol`) — descartada. MAS o não commitado
  da `dev` traz uma FEATURE inacabada que não está na `main`:
  `scripts/detectors/execution-guard-detect.js` (detector de `Stop`: o assistente
  anuncia que vai editar — "vou corrigir", "I'll apply the fix" — e encerra o turno
  sem chamar Edit/Write) + `getExecutionGuard` no `hooks-config` + ligação no
  `stop-dispatcher` (`dev-uncommitted.patch` + `dev-untracked-detectors.tar`). Não
  aplicado (feature nova, fora do escopo de correção) → item **F1** abaixo.
  `openhands`: vitrine da v2.23.0, obsoleta — descartada.
- [ ] **F1 — (feature, resgatada da `dev`) `execution-guard-detect`.**
  **Decisão do dono (2026-10-02)**: ENTRA na nova major, mas precisa ser melhor
  desenhada antes (ainda está crua) — não analisar agora. Quando for: redesenhar,
  reaplicar sobre o HEAD (o `stop-dispatcher` mudou), testes, fila pesada do daemon.
  Os patches seguem em `docs/plans/salvage/` (local) caso precise consultar.
- [x] **O5 — preflight do `.vscode/scripts/test-units.mjs` não detecta devDependency
  ausente.** **RESOLVIDO em 2026-10-02** (ferramenta local, `.vscode/` não é
  versionado): o preflight resolve cada `devDependency` do `package.json` e falha
  com "devDependencies ausentes: eslint (rode: npm install)" antes de rodar.
  Verificado numa árvore temporária sem o eslint. Sem `eslint` instalado, os 6 testes `require-windows-hide` falham como
  falha de teste (`Cannot find module 'eslint'`), não como ambiente incompleto.
  Visto em 2026-10-02; resolvido localmente com `npm install`. Fix: o preflight
  checar `require.resolve` das devDependencies que a suíte usa.
- [x] **O6 — slot do pool de workers do KB nunca é recriado.**
  **RESOLVIDO em 2026-10-02**: worker morto falha as chamadas em voo e é recriado
  na próxima chamada do slot (o worker novo começa sem estado de `init` — toda
  sequência do chamador já começa com `init({project})`). Teste: `poolSize 1`,
  salva, mata o worker, a próxima sequência funciona e lê o dado salvo. O teste
  existente de `pluginRoot` inválido segue verde (o worker recriado também falha
  ao carregar → rejeita, nunca trava).
  `servers/brain-server/lib/kb-worker-client.js:105-130`: depois de `error`/`exit`,
  `dead` fica setado e toda chamada para aquele slot (projetos com o mesmo hash)
  falha até reiniciar o daemon. Fix: recriar o slot na próxima chamada, como o
  hook worker do G2 faz.
- [x] **O7 — `kb-worker.js:14-17` afirma "uma mensagem por vez", mas o handler é**
  **VERIFICADO em 2026-10-02 — sem bug, comentário corrigido**: as chamadas se
  intercalam nos `await`, mas toda sequência que troca o projeto singleton do
  worker roda sob o `kbLock` do slot (`dispatchKbTool`, inclusive o caminho remoto
  e o `recordLessonMetric`); o único chamador fora do lock (`policy_shadow_report`)
  usa `getEvaluationCountsIsolated` (conexão própria, read-only, 1 chamada
  síncrona). Comentário do `kb-worker.js` reescrito com essa regra e o aviso para
  novos chamadores. (Texto original do achado abaixo.)
- [ ] ~~O7 — `kb-worker.js:14-17` afirma "uma mensagem por vez", mas o handler é~~
  `async`** (`parentPort.on('message', async …)`): chamadas assíncronas se
  intercalam nos `await`. Verificar se algum método do store depende dessa
  serialização; se sim, fila explícita (como `hook-worker.js`); se não, corrigir
  o comentário.
- [x] **O8 — mensagem para um hook worker morrendo se perde até o timeout.** Entre a
  morte do worker e o evento `exit`, um `run()` posta para o worker morto e só
  falha no `callTimeoutMs` (60 s). Coberto na prática pelo prazo do G5.
  **RESOLVIDO em 2026-10-02 — e era pior do que o registrado**: além do `run()`
  (que o `exit` já rejeita, e o prazo do G5 limita), um crash perdia em SILÊNCIO
  todos os jobs de segundo plano ainda na fila do worker morto (até 1000: gravações
  de journal/métrica). Agora o worker confirma cada job de segundo plano (`bgDone`)
  e o cliente reenfileira os não confirmados no worker novo — pelo menos uma vez,
  com no máximo 1 nova tentativa por job (um job que derruba o worker sempre não
  vira loop de crash). `/health` → `hookWorker.background`/`requeued`. Teste: 40
  jobs ocupando + 5 edições na fila, mata o worker, as 5 edições aparecem no
  journal depois do dreno.

## Testes

- `scripts/test-units.js`, teste `plano B: stream com várias linhas SSE somando mais de 32 MiB termina completo (o teto é por linha)` (~9361): flake intermitente sob carga (anotado em 2026-09-30, durante a Fase G da 2.29.1, que não toca o model-router): falhou com `nvidia: conteúdo perdido (867 chars)` em 1 de 3 rodadas completas da suíte, e outra rodada teve 2 falhas da família `plano B`; a terceira passou limpa. Mesma família de timing do item de FIN/reset abaixo. Investigar se o stream de >40 MiB é cortado por prazo do teste ou do router quando a máquina está carregada.
- `scripts/test-units.js`, teste `plano B: corpo de RECUSA cortado (FIN, reset) ou parado no meio…` (~8898): flake intermitente, 1 falha em cerca de 17 execuções completas da suíte (anotado em 2026-09-25 pelo tester da r28 do gate da 2.29.1, numa rodada lenta de 111,9 s contra ~86 s). Isolado, inclusive sob 32 processos ocupando a CPU, passa. Hipótese não confirmada: a janela `ms >= 4500 && ms <= 7500` (~8930) é apertada sob carga; a mensagem não foi capturada porque o wrapper `.vscode/scripts/test-units.mjs` (no ramo de falha, ~74) só repassa as linhas `✗`; o runner cru (`scripts/test-units.js`, ~18975) imprime na linha seguinte a primeira linha do erro, que traz os ms medidos se a falha for a da janela (~8930). Próximo passo: capturar essa mensagem (rodando o runner cru ou fazendo o wrapper repassar a linha) e medir do lado do servidor falso ou alargar o limite superior.
- `.vscode/scripts/i18n-audit.mjs` falha em `dashboard/index.html` já no HEAD `44a9ff6` (anotado em 2026-09-25, durante o `byok.openaiCompat` da 2.29.1, que não criou nenhuma das chaves abaixo): 6 chaves usadas no HTML sem tradução em EN nem PT (`brain.migrateTitle`, `brain.migrateHint`, `brain.migrateBtn`, `brain.editorTitle`, `brain.reembedHint`, `router.oneMillionWarn`) e 62 chaves órfãs por idioma (várias são usadas por `t()` em JS, o que o audit talvez não enxergue — confirmar antes de apagar). Corrigir as traduções ausentes e separar órfã real de falso positivo do audit.
- `scripts/test-units.js` (`runTest`, ~58-70) e o wrapper `.vscode/scripts/test-units.mjs` (`execSync`, ~53) não têm timeout: um teste que nunca resolve pendura a suíte inteira sem dizer qual é (o tester da r30 do gate da 2.29.1 viu isso com um mutante, 2026-09-25). Dar um prazo por teste no `runTest` que falha com o nome do teste, e um teto no `execSync` do wrapper.
- `scripts/test-units.js` (`FASE-E e2e: POST /v1/messages/count_tokens responde…`, ~7027): o processo filho do router não fixa o upstream e abre conexões reais com `api.anthropic.com:443` mandando `x-api-key: test-not-real` (~7076, ~7086): o count_tokens, o `GET /v1/models` do aquecimento do catálogo (o passthrough chama `maybeWarmCatalog` antes) e os dois `POST /v1/messages` (~7083-7093). Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pelo tester da r32 do gate da 2.29.1, que rodou a suíte com uma trava de rede. Correção: passar `ROUTER_UPSTREAM_HOST/PORT/PROTOCOL` apontando para um servidor falso em 127.0.0.1, como o teste ~7399 já faz.
- A suíte (`node .vscode/scripts/test-units.mjs`) baixa o modelo do embedder de `huggingface.co` quando ele não está em cache (visto pelo tester da r32 do gate da 2.29.1, 2026-09-25, com a trava de rede). Teste unitário que depende de rede externa falha offline e varia com o cache. Localizar o teste que carrega o embedder e decidir entre modelo fixo local, skip explícito sem cache, ou mock.
- `scripts/test-units.js`: o caso (b) do teste `BYOK on-limit: openaiCompat inválido só é lido quando o destino é o BYOK…` (~10112) e o teste `BYOK cooldown: geração e count_tokens desviados aplicam mapeamento e injeção…` (~10494) dependem do `UPSTREAM_FALLBACK` real do router; se um mutante (ou um bug) mandar a request ao fallback, o teste tenta sair para a rede em vez de falhar localmente (tester da r32 do gate da 2.29.1, mutante X13, 2026-09-25). Opcional: apontar o fallback para um servidor falso nesses testes.
- ~~Cobertura end-to-end de `isCustomEndpoint` → timeout real em `model-router/index.js`~~ — **RESOLVIDO em 2026-09-12**: `router.requestUpstream`/`UPSTREAM_TIMEOUT_MS`/`BYOK_UPSTREAM_TIMEOUT_MS` exportados e cobertos em `scripts/test-units.js` (3 testes, monkey-patch em `https.request` provando o `teto` passado a `req.setTimeout` sem esperar um timeout real).
- ~~`byok.resolveUpstream` com `config.byok.enabled` E `config.upstream.enabled` simultaneamente `true` — nunca testado, antigo ou novo.~~ — **RESOLVIDO em 2026-09-17**: decisão do Allan foi manter o comportamento como está (BYOK sempre vence), só formalizar. Adicionado comentário explícito em `byok.js`'s `resolveUpstream` (logo antes do `parseBaseUrl(b.baseUrl)` do ramo BYOK) documentando que, quando ambos estão `enabled:true`, o objeto `anthropic` montado a partir de `upstream` é integralmente descartado — não é bug, é precedência intencional — e alertando sobre a mistura parcial que ocorre no ramo `misconfigured` (`Object.assign({}, anthropic, {...})` preserva host/headers do upstream junto com o erro do BYOK). Teste dedicado adicionado em `scripts/test-units.js` (`byok.resolveUpstream: BYOK e upstream ligados juntos → BYOK vence (upstream é totalmente descartado, não mesclado)`), construindo um `config` com `upstream.baseUrl` e `byok.baseUrl` distintos e provando que o `host` resolvido é o do BYOK, nunca o do upstream. Suite completa: 1012 passed / 0 failed.
- ~~`dashboard.js`'s `getRouterConfig`/`byokSafe` (rota `GET /api/router/config`) — RESOLVIDO PARCIALMENTE em 2026-09-16 pra feature `fixedTimeoutMs`/`rotatingTimeoutMs`/`logLatency`~~ — **RESOLVIDO por completo em 2026-09-18**: fechado o gap dos campos mais antigos (`classifyRemote`, `byok.enabled`, `byok.mode`, `fixedEndpoint`) e do `enabled` top-level, que continuavam sem cobertura nesse mesmo handler. Teste novo em `scripts/test-units.js` (`dashboard.getRouterConfig: byok.classifyRemote/byok.enabled/byok.mode/byok.fixedEndpoint e enabled top-level refletem o override`) reusando o mesmo padrão (`res` fake + `JSON.parse`). Detalhe de investigação: o baseline "sem override" do `enabled` top-level depende do `config/router-config.json` REAL do repo (não é isolado por `CLAUDE_PLUGIN_DATA` como o resto do handler) — por isso o teste não fixa esse baseline, só prova a transição bidirecional forçada pelo override (`true`→`false`), robusta a qualquer valor atual do shipped config. Os campos `byok.*` (sem shipped config equivalente) têm baseline seguro e são testados também no estado inicial. Suite completa: 1020 passed / 0 failed.
- ~~`router.parseTimeoutEnv` — os testes cobrem só a metade do fallback numérico do contrato, nunca que `logger.warn(...)` é de fato chamado no caso de env inválida.~~ — **RESOLVIDO em 2026-09-18** junto com o item de `withLatencyLog` abaixo (mesma causa raiz): `index.js` agora exporta o objeto `logger` (mesma referência usada internamente por todas as chamadas de `logger.warn/info/error/debug` no arquivo) em `module.exports`. Dois testes novos em `scripts/test-units.js` (`router.parseTimeoutEnv: env inválida chama logger.warn...` / `...env ausente NÃO chama logger.warn...`) monkey-patcham `router.logger.warn` temporariamente (restaurado em `finally`) e provam tanto a chamada (env inválida) quanto o silêncio (env ausente, comportamento normal). Revisão independente (agente `reviewer`, 2026-09-18, background) confirmou: mesma referência de objeto (não cópia), export só acontece no branch `else` de `require.main === module` (nunca exposto quando roda como servidor real), nomes de campo do assert batem exatamente com o que a chamada real emite, sem vazamento de estado entre testes. **Zero achados — gate fechado.** Suite completa: 1024 passed / 0 failed.
- ~~`router.withLatencyLog` — mesma limitação do item acima, só que para `logger.info('Upstream TTFB', ...)`.~~ — **RESOLVIDO em 2026-09-18**, junto com o item acima (mesmo `logger` exportado, mesma rodada de revisão, mesmo veredito zero achados). Dois testes novos (`router.withLatencyLog: logLatency:true chama logger.info...` / `...sem logLatency NÃO chama logger.info...`) provam a chamada real (`{host, ms, status}`, com `ms` sendo `number`) e o passthrough puro (sem log) quando `logLatency` é falsy.
- ~~`dashboard/index.html`'s campo de timeout do BYOK: entrada NÃO-vazia porém inválida (ex.: negativo que escapa da validação nativa `type="number"`, ou notação como `1e10`) é ignorada em silêncio, sem feedback ao usuário.~~ — **RESOLVIDO em 2026-09-17**: `applyRouter()`'s blocos de `fixedTimeoutMs`/`rotatingTimeoutMs` agora espelham exatamente o padrão já usado pro parsing de headers — se `!Number.isFinite(v) || v < 0`, aborta o save (`return`) e mostra `router.byokTimeoutInvalid` (chave i18n nova, EN+PT-BR) em vez de simplesmente pular a atribuição do campo. Teste de padrão-de-fonte dedicado adicionado em `scripts/test-units.js` (já que `index.html` não tem harness jsdom — cobertura client-side nesta base é sempre via regex sobre o texto fonte). Suite completa: 1012 passed / 0 failed.
- ~~`mcp-health probeHealth` — falha pré-existente e não-relacionada em `node .vscode/scripts/test-units.mjs`~~ — **RESOLVIDO em 2026-09-18, mas não como esperado**: investigação (grep exaustivo em todo o repo, incluindo `test-hooks.js`, excluindo `.token-guard/results/*.txt` históricos) não encontrou esse teste em lugar NENHUM do código-fonte atual — e `mcp-health.js` nunca é sequer `require()`'d em `test-units.js`. Histórico via `git log` confirma só 1 commit tocou `mcp-health.js` (o commit original que introduziu o arquivo), descartando "foi corrigido depois". Conclusão: o teste que falhava foi perdido (provavelmente durante algum refactor de `test-units.js` que não tocou `mcp-health.js` diretamente) sem deixar rastro em commit — não é que o bug sumiu, é que a cobertura sumiu, silenciosamente, há suíte inteira rodando 0 failed. `probeHealth` (usado tanto por `dashboard.js`'s `GET /api/brain/health` quanto por `brain-status.js`) ficou sem NENHUM teste até agora. Fechado de vez: teste novo em `scripts/test-units.js` (`mcp-health.probeHealth: backend mcp-memory conectado via daemon real (fake) e desconectado quando porta fechada`) com servidor HTTP real (não mock) respondendo `/health` com `{ok:true}`, lendo `daemon.json` de um `runDir` temporário (exercitando o caminho de resolução real, não só `serverUrl` direto), provando `connected:true` com a porta aberta e `connected:false` depois de fechar o servidor (porta TCP fechada de verdade, sem nada escutando). Suite completa: 1020 passed / 0 failed.
- ~~`kb-worker-client.js`'s `worker.unref()` (linha 54) é uma armadilha de testabilidade: um `await` isolado sobre uma chamada RPC, sem nenhum outro handle referenciado ativo no event loop, deixa o processo Node terminar (exit code 0, sem erro, sem assertion rodada) ANTES da resposta do worker chegar.~~ — **RESOLVIDO em 2026-09-18, com fix comportamental real (não só documentação, como a entrada original sugeria como suficiente)**: `kb-worker-client.js` agora alterna `ref()`/`unref()` no handle do worker conforme há ou não chamadas em voo. `call()` chama `worker.ref()` no momento em que registra a entrada em `pending` (antes de `postMessage`); `settle(id, fn)` — o único ponto que remove uma entrada de `pending`, usado tanto pelo handler `'message'` quanto pelo timeout — chama `worker.unref()` sempre que, depois de remover a entrada, `pending.size === 0`; o handler `'error'` (que limpa toda a fila de uma vez via `pending.clear()`, sem passar por `settle()`) também chama `worker.unref()` explicitamente; e o handler `'exit'` ganhou a mesma chamada, por simetria com `'error'` (empiricamente inofensiva — o handle já está morto quando `'exit'` dispara — mas remove a ambiguidade de leitura). Resultado: o processo só fica vivo durante o round-trip de uma chamada em voo, nunca em repouso — o comportamento em produção (`http-daemon.js`, que sempre tem outro handle ref'd via `httpServer`) não muda. Teste de regressão dedicado adicionado em `scripts/test-units.js` (`kb-worker-client: a bare await with ZERO keepalive of its own does not exit the process early`): um processo filho REAL (`execFileSync`), sem nenhum `setInterval`/keepalive próprio, faz `init`+`save`+`get` via `createKbWorkerClient` e prova que a entrada é recuperável — provando o fix diretamente, não só por leitura de código. **Duas rodadas de revisão independente** (agente `reviewer`, background): a primeira aprovou o fix de `ref()`/`unref()` em si, mas sugeriu (achado cosmético) adicionar `worker.unref()` também no handler `'exit'` para simetria com `'error'` — aplicado imediatamente (regra de gate: qualquer achado, mesmo cosmético, exige nova rodada antes de fechar); a segunda rodada, escopada só nessa linha adicionada, confirmou que o diff é exatamente essa uma linha + comentário, verificou que `worker.unref()` dentro de `'exit'` é seguro por construção (`ref()`/`unref()` só alternam uma flag interna, sem exceção mesmo após o handle já ter sido destruído), rodou a suíte completa e retornou **APPROVE — zero achados**. (A mesma rodada reportou de passagem uma falha em `mcp-health probeHealth` na sua própria execução; reproduzida aqui com uma suíte limpa rodada logo em seguida — `1025 passed / 0 failed`, duas vezes seguidas — não reproduz, e o teste em questão não tem nenhuma relação de código com `kb-worker-client.js`/`worker_threads`; tratado como flakiness de timing de porta isolada, fora do escopo deste item, sem ação adicional.) **Gate fechado.** Suite completa: 1025 passed / 0 failed.
- ~~`kb-worker-client.js`'s `call()` (linhas 56-63) não tem timeout por chamada.~~ — **RESOLVIDO em 2026-09-17**: `createKbWorkerClient({ pluginRoot, callTimeoutMs = 30000 })` agora aceita um `callTimeoutMs` e todo `call()` arma um `setTimeout` (`.unref()`'d) que rejeita com `` `kb-worker call timed out after ${callTimeoutMs}ms (${mod}.${method})` `` se nenhuma resposta chegar — nomeando o `mod.method` ofensivo pra debug. Um `settle(id, fn)` helper compartilhado entre os três caminhos de término (`message`/`error`/`exit`) limpa o timer e evita double-settle/vazamento. Dois testes novos em `scripts/test-units.js`: um prova que uma chamada sem resposta correspondente rejeita rápido e nomeada (`callTimeoutMs:1` contra o worker_thread real); outro prova que uma resposta tardia chegando depois do timeout já disparado é um no-op silencioso (não ressuscita nem faz double-settle). Suite completa: 1012 passed / 0 failed.

## Project id (residuais do patch "pasta sem id = memória off", 2.29.1, 2026-09-25)

Achados da rodada reviewer/tester que ficaram fora do patch:

- Resolução git síncrona duplicada: o daemon (`resolveDispatchProjects` e o handler de `brain_retrieve_context`) e o Stop (`stop-dispatcher.dispatch` e `project-id-stop.run`) chamam `tryResolveProjectId`/`resolveProjectChain` mais de uma vez para o mesmo `cwd` na mesma chamada, e cada uma pode rodar `git remote`. Resolver uma vez e repassar, ou cachear por `cwd` dentro da chamada.
- Id `host/owner/repo` vindo do git remote (ex.: `github.com/owner/repo`) vira uma KB local aninhada em `brain/github.com/owner/repo`, que o dashboard e o `brain-migrate` não listam (eles varrem só um nível). Listar recursivamente ou achatar o id no nome do diretório.
- `resolveProject` (chamadas sem `cwd`) ainda usa o `CCB_PROJECT_ID` do env do daemon HTTP, que é o env da sessão que subiu o daemon, não o da sessão que chama. Pré-existente; em HTTP essa chamada deveria recusar ou usar só o `project` explícito.
- O inverso: um `CCB_PROJECT_ID` definido só na sessão chamadora não chega à resolução por `cwd` no daemon HTTP (o `cwdResolveEnv` só repassa o `sessionRoot`). A sessão com id por env fica com memória off se a pasta não tiver `.memory/project.json` nem git remote. Repassar o id da sessão no payload (como o `sessionRoot`) se isso for um caso real.
- No modo HTTP, um agente num subdiretório de um projeto sem git, chamando sem `sessionRoot`, é recusado: sem o teto `CLAUDE_PROJECT_DIR`, o `findProjectRoot` (`scripts/lib/project-id.js` ~198) só olha o próprio `cwd` e o toplevel git, e não sobe até o `.memory/project.json` da raiz. Fazer os clientes mandarem sempre o `sessionRoot`, ou subir até achar um marker quando não há teto.
- Quem fixou `backend.mcpMemory.projectId` na config passa a ver o aviso de "sem project id" nas pastas sem id, porque essa config deixou de valer como id da pasta. Decidir se o aviso deve citar essa config (ela não liga mais a memória) ou se ela deve voltar a contar como degrau da escada.

## Config/Hooks

- Curadoria (Stop hook): o comando de subagente `cd …/model-router && cat protocols/anthropic.js protocols/index.js; grep -n "wireProtocol…" upstream-profile.js` foi reportado com a sig de OUTRO comando (`sed 1452,1620p ".../r9-v228.diff"`), que já é alias do `read-slice` — contagem 6/3 acumulada numa sig errada força curadoria sem saída. Investigar a derivação da sig em comandos compostos/`cd &&` (achado 2026-09-24). Recorrência em 2026-09-24: `git diff HEAD … CHANGELOG.md` veio com a sig `ssh mac-ts "echo '--- listening ports` (50/3), `wc -l byok-model.js …` com a sig `sed 1452,1620p …r9-v228.diff` e `cat -n byok-model.js` com `grep "function mergeRouterSection" upstream-profile.js`. Como essas sigs erradas já passaram do teto, `curation_mark_oneoff` as recusa e o Stop hook bloqueia sem saída válida. Nova recorrência em 2026-09-25: `cd …; git diff servers/model-router/protocols/openai-chat.js | head -150; sed -n 150,215p …` veio de novo com a sig `ssh mac-ts "echo '--- listening ports` (50/3); `curation_mark_oneoff` recusou. Mais uma em 2026-09-25 (sessão retomada): `git diff --quiet refs/ccb-snap/r21 -- claude-code-boss && echo …; test -f …byok-model.js` e o `git diff refs/ccb-snap/r20 refs/ccb-snap/r21 --stat …` do tester r21, ambos com a mesma sig `ssh mac-ts …` (50/3); e o `s=$(git stash create) && git update-ref refs/ccb-snap/r22 …` com a sig `git show HEAD:claude-code-boss/servers/model-router/index.js` (6/3). Na r23, três `git diff` r22↔r23 do orquestrador caíram de novo na sig `ssh mac-ts …`. Na r24, um composto do tester (`mkdir -p $S && ls …; ls .vscode/scripts/test-units.mjs; head -40 .vscode/scripts/test-units.mjs`) foi atribuído ao script curado `test-units.mjs` e gerou um pedido de REFINE "curated-success-noisy" sem o script ter rodado. Na r26 repetiu com uma leitura pura (`sed -n '1,60p' .vscode/scripts/test-units.mjs`). Na r27 o Stop hook gerou a sig de 1 token `/tmp/r27rev` (composto `W=$(cygpath -w /tmp/r27rev …); node -e …`) e o `curation_mark_oneoff` recusou essa mesma sig como "too broad": o hook pede uma sig que o próprio tool não aceita. Na r28 o mesmo aconteceu com a sig `ls` já no teto (17/3, vinda de comandos compostos de subagentes como `cd …; ls -a; du -sh …`): o hook exige curar, o `curation_mark_oneoff` recusa, e um script curado para `ls` não faz sentido. Na r29 apareceram mais dois casos: a sig `"$TEMP")/r29rev"` (8/3) é um pedaço da atribuição `D="$(cygpath -u "$TEMP")/r29rev"` e junta comandos diferentes (recusada por ter 1 token); e `node iso.js` (4/3) é o harness de mutantes que cada tester recria em `$TEMP` a cada rodada — o tool recusa marcar e exige curar um arquivo temporário. O REFINE do `.vscode/scripts/test-units.mjs` voltou a vir de uma leitura pura (`read-slice.mjs .vscode/scripts/test-units.mjs 1 80`). Na r33, um `sleep 240; grep -v … full-mut.txt | cut …` de subagente veio com a sig `sed '621,625p' servers/model-router/index.js` (3/3, no teto, recusada), e três `git diff refs/ccb-snap/r32 refs/ccb-snap/r33` com a sig `ssh mac-ts …` de novo. Em 2026-09-25 (spike S0, `launcher-genai`), um `cat > s0-inject.js <<'EOF' … EOF` que cria um arquivo com heredoc virou a sig de 1 token `cat` (15/3): o hook exige curar e o `curation_mark_oneoff` recusa por ser "too broad", o mesmo impasse da r27/r28. No mesmo dia, na sessão do patch "pasta sem id = memória off", a sig `cat` chegou a 20/3 (heredocs `cat > …` e leituras `cat arquivo | …`). Continua sem saída; as outras 37 sigs da rodada foram marcadas one-hit normalmente. Na rodada seguinte da mesma sessão, o `curation_mark_oneoff` recebeu a sig `git diff docs/BACKLOG.md` (1/3) e a recusou respondendo com a sig `ssh mac-ts …` (50/3). Como ela veio num lote, o lote inteiro de 20 foi recusado; marcadas uma a uma, as outras 19 passaram. O problema está no próprio tool, que mapeia a sig recebida para outra, não só no Stop hook.

- `.vscode/scripts/git-diff-files.mjs` (script curado): argumento que não casa com nenhum arquivo, ou opção desconhecida, vira pathspec e o script responde `OK: no diff` — falso negativo mudo. Ex.: `git-diff-files.mjs refs/ccb-snap/r21 refs/ccb-snap/r22 --stat` disse "no diff" com 4 arquivos diferentes entre os snapshots (achado em 2026-09-25). Recusar opção desconhecida e caminho que não existe nem no disco nem no git, com `FAIL`.

- ~~`claude-code-boss/hooks/hooks.json`'s bloco Stop hook referencia um caminho absoluto específico da máquina do Allan~~ — **RESOLVIDO em 2026-09-16**, diagnóstico corrigido em relação à entrada original: `execution-guard-stop.js` não existe em lugar nenhum dentro do plugin (`claude-code-boss/scripts/`), só em `C:\Users\allan\Desktop\Projetos\claude-code\.claude\scripts\` — a pasta `.claude` pessoal de Allan, um nível ACIMA do repo do plugin. Ou seja, trocar pelo placeholder `${CLAUDE_PLUGIN_ROOT}` (como a entrada original sugeria) teria só trocado um caminho quebrado por outro (`MODULE_NOT_FOUND` pra todo usuário, já que o arquivo não é distribuído com o plugin). Correção real: a entrada de hook inteira foi removida do `Stop` array em `hooks/hooks.json` — era um script de debug pessoal vazado pro arquivo versionado, não uma dependência do plugin.

## Docs

- `docs/CONFIGURATION.md`: a tabela do router não tem linhas para `byok.modelMap` nem `byok.modelInjection` (só o README e o CHANGELOG da 2.29.1 descrevem). Achado em 2026-09-25 durante o `byok.openaiCompat`, que ganhou a sua linha; acrescentar as duas com tipo, default (`[]`/`null`) e o resumo das regras de validação.

- ~~`claude-code-boss/CHANGELOG.md`'s entrada `[2.25.0]` não menciona a mudança de timeout BYOK/`fixedEndpoint`~~ — **RESOLVIDO em 2026-09-16**: entrada "Added — BYOK: timeout por tipo de endpoint, sem limite opcional, e log de latência" adicionada ao `[2.25.0]`, cobrindo `fixedEndpoint`, `fixedTimeoutMs`/`rotatingTimeoutMs` (incluindo a semântica de `0` = sem limite) e `logLatency`, junto dos 4 env vars novos.

## Arquitetura

- Fase G (2.29.1, anotado em 2026-09-30) — `.mcp.json` tem a porta do brain-server fixa na URL (`http://127.0.0.1:38217/mcp`): quem define `BRAIN_HTTP_PORT` precisa editar o `.mcp.json` à mão, e a edição some a cada atualização do plugin. Sincronizar a URL com a porta efetiva exige mudança de arquitetura (o Claude Code lê o `.mcp.json` estático).
- Fase G (2.29.1, anotado em 2026-09-30) — timeout de `mcp_tool` sem abort no daemon: movido para **G5** acima.
- Fase G (2.29.1, anotado em 2026-09-30) — as 12 tools `hook_*` aparecem na lista de tools do modelo (descrição marca como internas). Avaliar esconder do `tools/list` sem quebrar a chamada via `mcp_tool`.
- Fase G (2.29.1, anotado em 2026-09-30) — o `user-prompt-submit-dispatcher` ainda sobe 1 processo Node por prompt para `brain-daemon-ensure`/`brain-health`/`brain-status` (excluídos por dependência circular com o daemon), e `policy-inject`/`model-router-ensure` seguem como `command`. Desenhar o tratamento próprio deles.
- ~~`servers/model-router/protocols/openai-chat.js`: um turno assistant só com blocos `thinking` (sem texto nem `tool_use`) vira `{"role":"assistant","content":null}` sem `tool_calls`, fora da spec do Chat Completions.~~ — **RESOLVIDO em 2026-09-25, na própria 2.29.1** (o reviewer r19 apontou que estava dentro do botão da feature `assistantEmptyContent`): sem `tool_calls` o turno sai sempre com `content: ""`; `null` só com `tool_calls` e a opção no padrão. Teste `openai-chat: assistant sem texto e sem tool_use (só thinking ou vazio) sai com content "" em qualquer opção`.
- `servers/model-router/index.js` (`handleLimitExceeded`, ~1833) + `byok.js` (`resolveUpstream`, ~152): no fallback `on-limit`/cooldown, BYOK ligado com Base URL (ou, sem ela, o primeiro endpoint) ausente ou inválida vira `misconfigured` e o plano B segue para a NVIDIA só com `logger.error` — o usuário não vê a causa. Já um perfil de protocolo inválido (`openaiCompat`, `wireProtocol`, URL de operação) responde com a causa (2.29.1). Pré-existente; anotado em 2026-09-25 pelo tester r19. Decidir se o `misconfigured` também responde com a causa em vez de ceder à NVIDIA. Caso vizinho (tester r21): sem Base URL, `endpoints.generate: '   '` (só espaços) com `endpoints.models` válido vira `misconfigured` em `resolveUpstream`, que não apara a string, enquanto `resolveOperationProfile` apara e trataria `generate` como ausente — as duas funções discordam sobre o mesmo valor. Variantes (reviewer e tester r22): Base URL `'   '` com `endpoints.generate` válido vai para a NVIDIA (`resolveUpstream` não apara), enquanto o perfil usaria o `generate`; e `endpoints.generate` que não é texto (`123`, `true`, `{}`) é descartado sem aviso por `resolveOperationProfile` (`upstream-profile.js:151`) — com Base URL válida o router deriva o endpoint e chama o BYOK em silêncio, sem Base URL vira `misconfigured`. Fail-loud pediria `{ok:false}` para `endpoints[op]` presente que não é texto.
- `servers/model-router/index.js` (rota `local:catalog`, ~3262): quando o perfil `models` é inválido (qualquer causa, inclusive `byok.openaiCompat` inválido), `GET /v1/models` encurtado para o catálogo local responde `200 {"data": []}` e a rota não loga nada (o aviso só aparece se outra request passar por `maybeWarmCatalog`) — lista vazia silenciosa. Pré-existente para qualquer erro de perfil; anotado em 2026-09-25 na revisão r19. Decidir se responde `502` com a causa, como o passthrough.
- `servers/model-router/index.js` (`byokFallback` → `reportFailure`, ~1765): no fallback `on-limit`/cooldown, as falhas de transporte do BYOK ("resposta passou do teto", "conexão caiu no meio da resposta", "está inacessível") saem sem o hint de quando o Claude volta; só as recusas locais e as do endpoint (`byok.userAdvice(..., hint)`) trazem. Pré-existente; anotado em 2026-09-25 pela revisão r20. Decidir se essas mensagens também anexam o hint.
- ~~`servers/model-router/index.js` (rotas `passthrough`, ~3285-3310): `/v1/models` e `/v1/messages/count_tokens` são declaradas com `auth: 'signature'` (~189-190), mas o ramo `passthrough` retorna antes da checagem de assinatura (~3328-3334).~~ — **RESOLVIDO em 2026-09-25, na 2.29.1**: a checagem de auth foi movida para o início do despacho declarativo; teste `router: rotas passthrough com auth signature … → 401, BYOK não é chamado`. Registro original: Request sem `x-api-key` nem `authorization` é aceita, e sob BYOK o router anexa a credencial configurada do usuário. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pela revisão r30 do gate da 2.29.1. Possível problema de segurança: mover a checagem de assinatura para antes do passthrough. Na correção, o teste `BYOK openaiCompat inválido no catálogo local…` precisa mandar o header de assinatura no `GET /v1/models`.
- `servers/model-router/index.js` (cooldown com custom upstream): a geração só aplica o cooldown quando o upstream é a Anthropic real (`isRealAnthropic`, ~2944-2948), mas count_tokens, catálogo e classify remoto usam `cooldownActive` sem essa checagem (~2858, ~3147, ~468/~585). Com o custom upstream ligado e um cooldown ainda ativo (ex.: restaurado de `cooldown.json`, `loadCooldown` ~2021), a geração vai ao gateway e as rotas laterais vão ao BYOK. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pelo tester r31 do gate da 2.29.1. Decidir se `cooldownActive` também exige a Anthropic real como upstream.
- `servers/model-router/byok.js` (`resolveUpstream`, ~120-131): com `upstream.enabled: true` e uma URL operacional inválida (Base URL ou, sem ela, o primeiro endpoint), `parseBaseUrl` devolve `null` e o bloco é pulado sem log: a request segue para a Anthropic real, com o usuário achando que está no custom upstream. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pela revisão r32 do gate da 2.29.1. Fail-loud pediria erro visível (`misconfigured` com a causa) em vez de cair na Anthropic em silêncio.

- ~~`CCB_PROJECT_ID` (env, documentado como o jeito de "fixar" o projeto quando lições somem ao trocar de pasta/máquina — `CONFIGURATION.md`/`TROUBLESHOOTING.md`) seria silenciosamente ignorado por `brain_retrieve_context`.~~ — **RESOLVIDO em 2026-09-21 (achado da auditoria original era FALSO-POSITIVO — não havia bug no código atual)**: a entrada original (2026-09-20, auditoria Fase 0 do ADR-014) alegava que `resolveProjectChain`'s `tryResolveProjectId({cwd})` "nunca olha `CCB_PROJECT_ID`". Investigação (2026-09-21) releu `scripts/lib/project-id.js`'s `_resolveWithStrength({cwd, env=process.env, ...})` (linhas 260-285): o "Rung 1 — env override (explicit, wins over everything)" checa `CCB_PROJECT_ID` incondicionalmente ANTES de qualquer inspeção de `cwd` (`const forced = sanitize(env && env.CCB_PROJECT_ID); if (forced) return {id: forced, strength:'env'};`). Verificado empiricamente com dois scripts `node -e`: um passando `env` explícito, outro reproduzindo a assinatura EXATA usada em produção por `resolveProjectChain({cwd, sessionRoot})` (sem `env` explícito, dependendo do default `process.env`) — ambos confirmam que `focusId` (usado como `focusId || project` no handler de `brain_retrieve_context`, `mcp-server.js:917-923`) honra corretamente o override. `git log --oneline -- scripts/lib/project-id.js` mostra que essa lógica já existia antes da data da auditoria original — a auditoria leu o código errado, não um comportamento que foi corrigido depois. **O gap real, genuíno, era só de cobertura de teste**: nenhum dos 3 testes existentes com `CCB_PROJECT_ID` (`scripts/test-units.js`) cobria especificamente `resolveProjectChain`'s `focusId` (cobriam só `resolveProjectId`/`projectIdStrength`/`pia.needsNudge`). Fechado com um teste de regressão novo (`project-id resolveProjectChain: env CCB_PROJECT_ID wins as focusId over the cwd's own git-remote/marker identity, not just resolveProjectId`), usando um `cwd` isolado com git-remote fake próprio (`fakeGitWithRemote`) pra provar que o override vence mesmo quando o cwd teria uma identidade PRÓPRIA e diferente — trava o comportamento correto atual, não corrige nada. Nota: `chain` (a spine de ancestrais pra recall) continua incluindo o git-remote real do `cwd` mesmo com o override — isso é intencional (ancestor-spine é sobre a árvore de diretórios real, não sobre a identidade ativa forçada) e não contradiz a garantia testada, que é só sobre `focusId`. Suite completa: 1033 passed / 0 failed.

- ~~`brain-config.js`'s `save()` sem proteção contra "lost update" entre saves concorrentes~~ — **RESOLVIDO em 2026-09-17** via CAS/versionamento otimista. Uma entrada anterior deste item afirmava que só existia um call-site (`mcp-wizard.js`'s `start()`) e que ele já era seguro; isso estava **errado** — revisão adversarial encontrou um segundo call-site independente, `dashboard.js`'s `saveBrainConfig` (rota `PUT /api/brain/backend-config`), que duplicava a mesma lógica de `deepDiff(shipped, parsed)` contra o MESMO arquivo (`globalDir()/user-config.json`) sem passar por `save()`. Uma primeira tentativa de correção (merge do override atual antes de diffar) foi **revertida** por estar quebrada: `config` é sempre um snapshot COMPLETO do caller (nunca um delta), então o merge não conseguia distinguir "mudança intencional" de "visão stale" e acabava reproduzindo o mesmo bug relocado (provado por teste + reprodução isolada). **Correção real**: um inteiro `_v` é gravado junto do diff dentro do PRÓPRIO `user-config.json` (`_onDiskVersion`, `load()`/`loadWithVersion()` em `brain-config.js`) — `loadWithVersion()` retorna `{config, version}` atomicamente (Node é single-thread, cache-populate e version-capture no mesmo bloco síncrono); `save(config, {expectedVersion})` só aceita a escrita se o `_v` em disco ainda for esse mesmo baseline, senão lança `err.code='BRAIN_CONFIG_CONFLICT'` (fail-loud, nunca sobrescreve às cegas) — `expectedVersion` é opcional, então callers antigos (helpers de teste que escrevem o override direto via `fs`) continuam com o comportamento last-write-wins sem precisar mudar. `_v` é estritamente um campo de wire/persistência: `load()` o extrai e remove antes do merge (nunca vaza pros getters), e o wire protocol HTTP usa `_version` como campo irmão (GET inclui, PUT exige e `dashboard.js` faz `delete parsed._version` antes de validar/persistir). Os dois call-sites de produção foram migrados: `mcp-wizard.js`'s `start()` (via `loadBrainConfigWithVersion()` + `saveBrainConfig(cfg, {expectedVersion})`, propagando o conflito pro catch existente) e `dashboard.js`'s `getBrainConfig`/`saveBrainConfig` (retornam HTTP 409 no conflito). Corrigido de brinde um bug fail-loud pré-existente e não relacionado descoberto ao implementar isso: `dashboard/index.html`'s `saveBrainBackendConfig()` nunca checava `result.error` — qualquer erro do servidor (validação OU o novo 409 de CAS) era tratado como sucesso silencioso ("Salvo!"); agora checa `result.error` explicitamente e adota `result.version` como novo baseline pro próximo save da mesma página. 5 testes novos em `scripts/test-units.js` (seção "item 5: brain-config CAS"), incluindo a reprodução direta do lost-update original (caller A carrega em v0, caller B salva primeiro bumpando pra v1, A tenta salvar com seu baseline v0 stale e é rejeitado — mudança de B verificada intacta em disco). Suite completa: 1017 passed / 0 failed.

- ~~Um único `kb-worker` (worker_thread) serve TODOS os projetos do daemon — throughput serial entre projetos, não só dentro de um projeto.~~ — **RESOLVIDO em 2026-09-21 (ADR-014, implementação completa)**: item original (2026-09-17, fix do bug de `/health` travando) marcava isso como YAGNI sem pesquisa. Investigação completa (agente `researcher`, fontes: docs oficiais Node, docs oficiais `better-sqlite3` — que **recomenda oficialmente** pool de N workers via `os.availableParallelism()` para exatamente este caso — issue público `openclaw/openclaw#138474`) reverteu a decisão. **ADR-014** (`docs/adr/ADR-014-kb-worker-pool.md`) e o **Plano de implementação** (`docs/plans/PLAN-kb-worker-pool.md`) passaram por gate de 5 rodadas de revisão adversarial+testabilidade independentes, fechando com **ZERO achados**. Implementado: pool de N `worker_threads` (mesmo `kb-worker.js`, sem alteração de conteúdo) com roteamento sticky por projeto (`workerIndex = hash(canonicalProject) % N`, função `canonicalProject`/`workerIndexFor` em `kb-worker-client.js`) e lock por worker (não mais global), cobrindo os 4 módulos singleton (`brain-store.js`/`brain-index.js`/`brain-graph.js`/`metrics-store.js`). Fases 0-3 (auditoria, roteamento, lock, testes) concluídas com suíte automatizada; **Fase 4 (smoke manual)** validada com evidência real: dois projetos concorrentes caem em workers diferentes (`workerIndex A=0 B=1`), suas janelas `[startedAt,finishedAt]` genuinamente se sobrepõem (não só "ambos rápidos"), e `/health` responde em `max=5ms` sob carga concorrente (< 200ms). Ressalvas registradas no próprio Plan: a validação exigiu forçar o backend `local` in-process (monkeypatch de `backend.peekMode()`, nunca persistido em disco) porque a config de produção real desta máquina usa `backend.type: 'mcp-memory'` (remoto) — o pool não é exercitado pelas sessões do dia a dia aqui; e a amostragem de latência do `/health` no smoke ficou fina (`samples=2`) por limitação do harness (cliente+servidor no mesmo processo Node). Commit feito em 2026-09-21 (`52a8d30`).
- ~~`withLock` (`mcp-server.js:390-396`) serializa KB_TOOLS só DENTRO de uma sessão HTTP, não ENTRE sessões~~ — **RESOLVIDO em 2026-09-17**: achado de forma independente tanto por um agente `reviewer` quanto pelo agente `tester` (revisão de testabilidade do patch de `kb-worker`), CRÍTICO — verificado por leitura direta do código (não só relatado pelos agentes): `_chain` era uma variável de closure dentro de `createBrainServer()`, e `http-daemon.js` chama `createBrainServer(...)` UMA VEZ POR SESSÃO NOVA, então cada sessão MCP tinha seu próprio mutex, todas compartilhando o MESMO singleton de módulo `_db`/`_project`/`_index`/`_graph` (`brain-store.js`/`brain-index.js`/`brain-graph.js`) que `getKB(project)` troca a cada chamada — Sessão A rodando `getKB('projA')`→`store.search(...)` podia ser intercalada pela Sessão B trocando `_project`/`_db` pro projeto B no meio, lendo/escrevendo no banco ERRADO. Pré-existente ao patch de `kb-worker` (mesmo singleton, mesmo mutex por-sessão já era assim antes), mas o patch alargou MUITO a janela: antes cada chamada SQLite era síncrona e monopolizava a thread principal (bloqueio "acidentalmente" serializava tudo); depois do worker, cada `await store.X()` é um round-trip de mensagem real que cede o event loop pela duração inteira da chamada. **Correção**: nova factory exportada `createKbLock()` em `mcp-server.js`, instanciada UMA VEZ por processo daemon em `http-daemon.js` (ao lado do `kbWorker`, já único-por-processo) e passada como `kbLock` pra TODO `createBrainServer({..., kbLock})` — todas as sessões agora compartilham o mesmo mutex (`mode:'stdio'`, que nunca tem sessões concorrentes no mesmo processo, continua caindo no fallback `kbLock || createKbLock()`, seguro). **Provado empiricamente** (não só por leitura de código): 2 testes novos em `scripts/test-units.js` (seção "kbLock cross-session serialization") — um positivo (duas instâncias reais de `createBrainServer({mode:'http', kbLock:sharedLock})` disparando `brain_count` concorrente pra dois projetos diferentes NUNCA intercalam) e um controle negativo (as MESMAS duas instâncias SEM `kbLock` compartilhado intercalam de fato — prova que o teste tem poder de detecção real, não é um falso-negativo estrutural). Suite completa: 1007 passed / 0 failed após o fix. Corrigido também de brinde o handler `policy_shadow_report` (`mcp-server.js`), que fazia `require('metrics-store.js')` síncrono direto no main thread (mesma classe do bug original de `/health` travando) — agora roteia por `kbWorker.metricsClient` como os demais call-sites, com teste dedicado provando o roteamento. **Rodada de revisão fresca subsequente (obrigatória pela regra de gate — correção não fecha sem revisão independente com zero achados) encontrou um TERCEIRO call-site da MESMA classe de bug**: `brain_retrieve_context` — o `KB_TOOLS` de maior frequência, dispara em TODO `UserPromptSubmit` — chamava `retrieve-core.js`'s `retrieve()`, que fazia `require('../brain-store.js')` direto no topo do arquivo e rodava `store.init()`/`searchTwoPass()` (SQLite síncrono via better-sqlite3) na main thread do daemon, ignorando o `kbWorker` por completo. Corrigido: `retrieve()` ganhou um 3º parâmetro `deps` (mesmo padrão já usado por `retrieveRemote`), com `deps.store` sobrepondo o require direto; o call-site em `mcp-server.js` (`case 'brain_retrieve_context'`) agora passa `kbWorker ? { store: kbWorker.storeClient } : {}`, espelhando o padrão de `getKB`/`recordLessonMetric`/`policy_shadow_report`. Teste dedicado adicionado (`brain_retrieve_context: routes retrieve-core's local search through kbWorker.storeClient when kbWorker is present`) que substitui `retrieve-core.js`'s `retrieve` exportado por um espião (mesmo módulo via cache do `require`, mesmo caminho absoluto que o handler usa) e prova que `deps.store === kbWorker.storeClient` chega até ele. Suite completa após este segundo fix: 1008 passed / 0 failed. **A rodada de revisão fresca subsequente DE FATO rodou** (via agente `reviewer` independente, background) — confirmou o fix do `withLock`/`kbLock` e do `brain_retrieve_context` corretos, mas achou um **QUARTO call-site da MESMA classe de bug, ainda não coberto**: `getKB()` (`mcp-server.js`) gateava `store` por `kbWorker` mas fazia `require(...brain-index.js)`/`require(...brain-graph.js)` incondicional — `index.init()`/`graph.init()` (chamados em TODA invocação de `getKB()`, ou seja em `brain_search`, `brain_store`, `capture_lesson`, `brain_related` e até `brain_count`) rodavam `fs.readFileSync`/`writeFileAtomic` síncronos na main thread do daemon, reproduzindo o bug original pra dois módulos que usam `fs` em vez de SQLite. (Nota: a mensagem do commit anterior alegava uma segunda rodada limpa já concluída — isso era falso; o texto acima, mantido sem edição até esta revisão, estava certo.) **Corrigido em 2026-09-18**: `servers/brain-server/lib/kb-worker.js` ganhou `index`/`graph` no mapa `modules` (mesmo worker_thread do `store`/`metrics`); `servers/brain-server/lib/kb-worker-client.js` ganhou `INDEX_METHODS`/`GRAPH_METHODS` (extraídos dos `module.exports` reais de `brain-index.js`/`brain-graph.js`) e `indexClient`/`graphClient` no retorno de `createKbWorkerClient()`; `getKB()` agora gateia `index`/`graph` exatamente como já gateava `store`: `kbWorker ? kbWorker.indexClient : require(...)`. Zero mudança nos call-sites (`kbIndex.*`/`kbGraph.*` em `mcp-server.js`) — já eram `await`-based, mesmo padrão que permitiu migrar `store` sem tocar call-sites. Testes novos: o teste de sincronia de arrays (`STORE_METHODS/METRICS_METHODS stay in sync...`) foi estendido pra `INDEX_METHODS`/`GRAPH_METHODS` contra os exports reais dos dois módulos; teste de roteamento dedicado (`capture_lesson: getKB() routes index/graph through kbWorker.indexClient/graphClient...`) prova via `kbWorker` fake que `capture_lesson` (que usa `store`+`index`+`graph` na mesma chamada) realmente atravessa os clients do worker e não cai no require direto. Suite completa após este terceiro fix: 1018 passed / 0 failed. **Rodada de revisão independente fresca sobre este terceiro fix RODOU (agente `reviewer`, background, 2026-09-18) e retornou APPROVE com ZERO achados**: leu por completo o estado atual (não o relato) de `kb-worker.js`, `kb-worker-client.js`, `getKB()`+todos os call-sites `kbIndex.`/`kbGraph.` em `mcp-server.js`, `brain-index.js`/`brain-graph.js` inteiros (conferiu `INDEX_METHODS`/`GRAPH_METHODS` manualmente linha a linha contra os `module.exports` reais, não só confiou no teste automatizado), `retrieve-core.js`, `http-daemon.js`; grepou o repo inteiro por outros `require` diretos de `brain-index.js`/`brain-graph.js` fora do daemon compartilhado (achou vários em `dashboard.js`/`brain-cli.js`/scripts standalone/hooks — todos em processos separados, fora do escopo do bug ADR-001, confirmado que nenhum roda dentro do processo do daemon); traçou manualmente o teste de roteamento novo pra confirmar que ele de fato falharia sem o fix (não é vacuous); confirmou que `save()` é privado em ambos os módulos e só é chamado internamente por métodos já cobertos pela lista `INDEX_METHODS`/`GRAPH_METHODS`; confirmou que nenhum call-site faz `instanceof`/comparação de referência que quebraria com o proxy do worker; confirmou o fallback simétrico em modo `stdio`; e confirmou que o `kbLock` único-por-processo ainda cobre corretamente os 3 `await`s sequenciais de `getKB()` (`store.init`/`index.init`/`graph.init`, agora 3 round-trips de mensagem separados) contra intercalação entre sessões. **Gate fechado — item RESOLVIDO por completo, sem pendência.**
- ~~`dashboard.js`'s `normalizeTimeoutMs` duplica a mesma lógica de validação de `byok.js`'s `normalizeTimeoutOverride`~~ — **RESOLVIDO em 2026-09-18**: extraída pra `scripts/lib/normalize-timeout.js` (função única `normalizeTimeoutMs`). A premissa original ("dashboard.js não importa `servers/model-router/*`") apontava pra direção errada de dependência — `servers/model-router/index.js` já importa de `scripts/lib/*` (`router-mode.js`, `router-config-path.js`, `router-fingerprint.js`), então o util compartilhado foi colocado em `scripts/lib/` (onde já mora o resto do código reusável) e ambos os lados passaram a importar de lá: `byok.js` agora tem `normalizeTimeoutOverride` como alias do import (mantém o nome exportado — usado por `scripts/test-units.js` — sem quebrar call-sites existentes), e `dashboard.js` removeu sua cópia local e importa direto. Suite completa: 1017 passed / 0 failed.

- `scripts/dashboard.js` (declaração de `resolveRouterFlags`) — `}function resolveRouterFlags() {` colado na chave de fechamento da função anterior (pré-existente no HEAD `44a9ff6`; achado em 2026-09-23 durante o mapeamento de modelo do BYOK). Só formatação: quebrar a linha.
- `.vscode/scripts/diff-router-copies.mjs` (local, fora do git) — `resolveCachePath` devolve o PRIMEIRO diretório de `plugins/cache/.../claude-code-boss/` que tiver `servers/model-router/index.js`, não o SHA ativo em `installed_plugins.json`. Com várias cópias em cache, compara contra uma versão velha. Corrigir lendo `installPath` de `~/.claude/plugins/installed_plugins.json` (achado em 2026-09-23).
- `scripts/dashboard.js` (POST `/api/router/config`, normalização do `byok` em `writeRouterOverride`, ~1527-1616) — um `byok` parcial sem `enabled` (ex.: `{byok:{mode:'always'}}`) desliga o BYOK, e com isso o padrão KEEP preserva sem aviso uma `modelMap`/`modelInjection` inválida já gravada. O teste em `test-units.js` (~13304) não confere `enabled`. Achado em 2026-09-24 no gate r6 do `byok.modelMap` (2.29.1).
- `servers/model-router/index.js` (plano B BYOK, `reportFailure`/`settleRefusal`, ~1750-1795) — o log e a mensagem usam `upstreamTarget.host` em vez de `operationTarget.host`; com `endpoints.generate` num host diferente da `baseUrl`, o texto `Revise a Base URL` cita o host errado. Achado em 2026-09-24 no gate r6 do `byok.modelMap` (2.29.1).
- `servers/model-router/index.js` (handler de `/v1/messages`, ~linha 3344) — o `req.on('end', async …)` não tem try/catch nem há `process.on('unhandledRejection')` no router: qualquer exceção inesperada no fluxo encerra o processo em vez de virar um 500 para aquela request. O caso concreto (corpo JSON não-objeto: `null`, `"texto"`, `1`, `[]`) foi corrigido no hotfix 2.29.1; falta a rede de segurança geral (achado r8, 2026-09-24).
- `servers/model-router/index.js` (`anthropicToOpenAI`, tradutor do plano B NVIDIA, ~linha 1075-1094) — usa `b.text || ''` e converte tipos em silêncio: número vira string (`0` vira vazio), objeto vira `"[object Object]"` e `null` vira vazio, enquanto o adaptador OpenAI (`protocols/openai-chat.js`) já recusa com 400 desde o 2.29.1. Alinhar o tradutor NVIDIA ao mesmo contrato (achado r12, 2026-09-24).
- `servers/model-router/index.js` (`nvidiaFallback`, `byokFallback`) — quando o cliente desconecta no meio do plano B, a request ao upstream (NVIDIA ou BYOK) não é abortada: o endpoint continua gerando e gastando cota (o tester viu 30 de 30 frames enviados depois de o cliente sair). Abortar o request upstream no `'close'` da resposta ao cliente (achado r13, 2026-09-24).
- `servers/model-router/index.js` (`handleLimitExceeded`) — com `res` já destruído (o cliente saiu enquanto o router lia o corpo do 429), o plano B ainda é acionado e faz uma chamada inútil à NVIDIA/BYOK. Checar `res.destroyed` no guard do topo (achado r13, 2026-09-24).
- `servers/model-router/index.js` (caminho principal: leitura do corpo do 429/trigger, ~2997-3014, e ramo `>=400` de `proxyOpenAIResponse`, ~1518-1534) — corpo de erro que para de chegar sem a conexão fechar pendura o cliente: não há teto de inatividade nem prazo total, como o `armRefusalIdle` já dá às recusas do plano B no 2.29.1. Reusar o mesmo helper (achado r15, 2026-09-24).
- `servers/model-router/index.js` (resposta 200 não-stream do plano B: `jsonNvidiaToAnthropic` ~1187 e o ramo não-stream de `proxyOpenAIResponse` ~1609-1645) — corpo que para de chegar sem a conexão fechar pendura o cliente (o `setTimeout(0)` depois dos headers tira o timeout do corpo). Precisa de teto de inatividade e prazo total como o da recusa (achado r15, 2026-09-24).
- `servers/model-router/index.js` (fim de stream SSE OpenAI/NVIDIA, `sseTailFrame`) — limite conhecido: um corpo delimitado pelo fechamento da conexão (sem `content-length`/chunked) que é cortado exatamente entre duas linhas completas parece um fim limpo. Só dá para detectar exigindo `[DONE]` ou `finish_reason`, o que quebraria upstreams compatíveis que não mandam nenhum dos dois. Avaliar exigir um dos dois quando o upstream já mandou antes na mesma sessão (achado r15, 2026-09-24).

## Brain / Retrieval

Achados do spike S0 (2026-09-25, sessão no `launcher-genai`, medição do que o `brain_retrieve_context` injeta de fato):

- ~~`servers/brain-server/lib/mcp-server.js` (`case 'brain_retrieve_context'`)~~ — **SUPERADO no 2.29.1**: numa pasta sem id o recall agora é desligado de propósito (vazio explícito, antes de qualquer busca); numa pasta com id o braço de projeto roda sempre e o smoke pelo `createBrainServer` no repo do boss devolve o hit do projeto em ~1 s. O stderr mudo do `catch` fail-open continua valendo como item à parte. Texto original: o hook devolveu vazio em 31 de 31 prompts reais (3 sessões) e em duas chamadas diretas pela tool; não existe nenhum `retrieval-turn-*` em `brain-data/.runtime/`, então o servidor nunca teve `entries` não-vazio. O mesmo `retrieve-core.retrieve` + `filterInjectableEntries` + `formatContext`, rodado num processo Node avulso com o mesmo `project`/`chain`, devolve 1 fato + 1 capability em 7 de 10 prompts. Causa não isolada. O `catch` fail-open (~951) só escreve no stderr do daemon, que não fica em lugar nenhum: o erro some. Tornar visível (motivo no recall-health ou no journal) antes de depurar.
- ~~`scripts/lib/project-id.js` (`resolveProjectChain`)~~ — **RESOLVIDO no 2.29.1** pela opção "avisar que o projeto não tem id": pasta sem id = memória desligada, com aviso no SessionStart e no Stop (`project-id-stop`). Texto original: num diretório sem git nem marcador (`launcher-genai`), devolve `chain: []` e `focusId: null`. O recall sai sem escopo de projeto: os 7 fatos acima vieram todos de outros projetos e nenhum servia ao prompt. Com `brain_search` escopado em `launcher-genai`, as entradas certas aparecem (score 0,79). Usar o `project` resolvido pelo cwd como foco quando não houver `focusId`, ou avisar que o projeto não tem id.
- ~~`scripts/lib/retrieve-core.js` (`retrieveRemote` → `compose_recall`)~~ — **RESOLVIDO no cliente no 2.29.1**: query truncada em 800 chars (`maxQueryChars`); prompt de 4,7k chars caiu de 11–14 s para 1,6–2,4 s. A causa do lado do servidor segue nos itens do native-java abaixo. Texto original: 3 de 10 prompts, os mais longos, estouraram os 8000 ms; os demais levaram 0,4 a 7,6 s, dentro do caminho síncrono do UserPromptSubmit. O `recall-health.json` mostra 70% degradado nas últimas 50 chamadas (221 timeouts, 55 remote-error, 25 ancestor-timeout no acumulado). Truncar o prompt antes do compose ou medir onde o memory-server gasta o tempo.
- `user-prompt-submit-dispatcher.js` (BRAIN-STATUS) — injeta "mcp-memory backend unreachable" (`http://127.0.0.1:64817`) enquanto a porta está escutando e `brain_search`/`brain_count` respondem pela MCP. O aviso está errado ou mede outra coisa; conferir qual probe ele usa.
- `servers/brain-server/lib/mcp-server.js` (`catch` fail-open do `brain_retrieve_context`) — o erro só vai para o stderr do daemon, que não fica em lugar nenhum. Registrar o motivo no recall-health ou no journal.

Achados da correção de recall do 2.29.1 (medições no memory-server native-java 2.44.3, 2026-09-25) — lado do servidor, repo do native-java:

- `compose_recall` roda os blocos tipados em sequência (procedural[home], skill, knowledge[active]…) e refaz embed + FTS por bloco: o custo soma por bloco. Embedar a query uma vez e rodar os blocos em paralelo.
- O custo de FTS cresce com o tamanho da query (4,7k chars → 14 s no compose, 800 → 1,1 s). O cliente trunca em 800, mas o servidor devia limitar sozinho.
- Filtro de escopo aplicado depois do top-K (post-filter): com muitos docs de outros escopos, o bloco volta vazio mesmo tendo docs do projeto. Filtrar antes do ranking.
- Os blocos tipados nunca devolvem os docs que o boss grava (lessons/patterns/decisions): só o `search_memory` com `metadata.project_id` os traz. Avaliar um bloco "project docs" no compose e aposentar o braço paralelo do cliente.
- O spine home (procedural[home]) injeta procedurais graduados pelo Dreaming que são lixo (textos genéricos de sessão), com score 0,47–0,52 em prompts sem relação e 0,60–0,70 nos relevantes. Limpar o critério de graduação do Dreaming; do lado do cliente, avaliar um piso de score para o spine home (hoje sem piso — `fastTopK=1` limita o estrago a 1 fato).

Lacunas conhecidas do gate de project id (2.29.1):

- `servers/brain-server/lib/mcp-server.js` (`resolveKbProject`) — sem `cwd`, um `project` explícito continua aceito sem verificação (o daemon HTTP não sabe a pasta do chamador). Ideia: amarrar a sessão MCP ao `cwd` no handshake e recusar `project` que não bata.
- `servers/brain-server/lib/mcp-server.js` (`handleRemoteKbTool`) — no backend `mcp-memory`, `scope: user` não é roteado para `__user__` (grava sob o projeto do handshake) e o `brain_search` ignora `scope`. O caminho local já faz isso. Rotear via `metadata.project_id` no `saveMcp` e `projectIds` no `search`, depois de confirmar que o servidor aceita `__user__` declarado pelo chamador.
- `servers/brain-server/lib/mcp-server.js` (`resolveProject`) — no modo HTTP, um `project` explícito no formato `owner/repo` (o formato que a escada estrita produz) é zerado pelo `sanitizeProjectId` (barra recusada) e a chamada falha com `PROJECT_REQUIRED`. Visto ao vivo em 2026-09-25 com `capture_lesson project:"AllanSantos-DV/claude-code-plugins"`. Com `cwd` (2.29.1) funciona; validar `project` explícito com `assertSafeProjectId` em vez do sanitizador legado.
- `scripts/project-id-stop.js` — pastas de exploração recebem o aviso a cada turno sem opção de "não é um projeto, pare de pedir" além do opt-out global. Avaliar um opt-out por pasta.

## UX

- ~~`dashboard/index.html`'s `testMcpMemory()` esconde `mcp-wizard-btn` em todo `r.ok === true`, inclusive nos casos `will-download`/`will-auto-download`~~ — **RESOLVIDO em 2026-09-20**: `testMcpMemory()` agora verifica `details.action` e só esconde o botão quando NÃO é `will-download`/`will-auto-download` (nesses dois casos o botão permanece visível como único controle de ação). `renderWizard` anti-XSS `escapeHtml` já coberto nesta release.

## CI/Infra

- ~~`actions/setup-node@v4` sendo forçado a rodar em Node 24 mesmo mirando Node 20~~ — **RESOLVIDO em 2026-09-20**: `actions/setup-node@v4` → `@v6` em `ci.yml`, `release-audit.yml`, `release-guard.yml`, `pages-guard.yml` (runtime Node 24 nativo, elimina warning `forced to run on Node.js 24` em toda run).

## Curation / command-signature

- [x] **RESOLVIDOS em 2026-10-02 (os 2 itens abaixo)**: `command-signature` trata `(`/`{` iniciais e `)`/`}` finais sem par como estrutura, e `VAR=$(cmd …)` assina pelo `cmd` interno (`$((` segue sendo atribuição aritmética; `VAR=$(cat <<EOF` é setup). Casos: `(cd /p && git diff)` → `git diff`, `(cd /p && npm test)` → `npm test`, `(\ncd x\nnpm test\n)` → `npm test`, `{\n git log\n} > f` → `git log`, `X=$(git diff HEAD)` → `git diff HEAD`, `OUT=$(python3 - <<EOF …)` → `python3 heredoc-<digest>` (era vazio). Replay no histórico: 150 de 9.627 assinaturas mudaram, todas para melhor (ex.: `stash create)` → `git stash create`, `root 2` → `npm root 2`).
- **Subshell/grupo `(...)`/`{...}` funde comandos não relacionados** (achado pré-existente, revisão round 2 do fix de misattribution, 2026-09-24): `(cd /p && git diff)` e `(cd /p && npm test)` assinam ambos `(cd /p` (NAV_SEGMENT não casa por causa do `(`); `(\ncd x\nnpm test\n)` e `{\n git log\n} > f` assinam `(`/`{` — 1 token não-programa: MCP recusa, não é ceiling-exempt, não é curável. Fix provável: `stripPrefixes` remover `(`/`{` iniciais (e `GROUP_CLOSE` já pula o fechamento). `scripts/lib/command-signature.js`.
- **`ENV_ASSIGN` (`\S*`) come `$(` de command substitution** (pré-existente): `OUT=$(python3 - <<EOF ...)` → sig `''` (sinalizado sem sig, nada limpa); `X=$(git diff HEAD)` → `diff HEAD)` (perde o programa). Fix provável: tratar `VAR=$(cmd ...)` assinando pelo `cmd` interno.
- **Programa chamado por caminho (`./gradlew`) não é ceiling-exempt** (pré-existente): `PROGRAM_NAME` exige nome sem `/`; `./gradlew | tail` → sig 1-token recusada pelo MCP. Ainda curável registrando o script. Avaliar aceitar `./x`/`bin/x` em `isCeilingExempt` (`scripts/lib/oneoff-store.js`).
