# claude-code-boss: função por função

O valor do Boss cresce com o uso. Cada sessão pode deixar lições na memória, que voltam em sessões e projetos seguintes. Os comandos que enchem o contexto de saída viram scripts curados por projeto. A compactação acontece quando o cache está frio, e não no meio de um turno quente. Decisões que antes dependiam do LLM (usar o script curado, reescrever um heredoc no Windows, restaurar EOL/BOM) passam a ser regras mecânicas, por projeto. Numa máquina nova, sem sessões na memória, o único ganho inicial é a compactação no momento certo, e o gasto até pode subir (hooks e injeções entram antes de haver lição ou script que os compense). O custo em dólar por sessão não mede esse efeito: `node scripts/economy-report.js` mede custo, e hoje não separa sessões com Boss de sessões sem Boss. As medidas deste documento são contagens de eventos, descritas na seção 5.

Convenções: caminhos relativos a `claude-code-boss/`. Limiares foram lidos do código e do config shipped (`config/hooks-config.json` define `"profile":"standard"`); nenhum foi reverificado em execução. Um override do usuário em `user-config.json` pode mudar quais detectores rodam, e esse arquivo da máquina não foi lido.

## 1. Visão em tabela

| Função | Entra | Decide | LLM para mecânico | Evidência |
|---|---|---|---|---|
| correction-detect | prompt do usuário (UserPromptSubmit) | 4 regexes pt-BR/en ("não é", "na verdade", "wrong", "espera") | o gatilho é mecânico; julgar a lição e escrever continua do LLM | `nudge.emitted` (kind correction) |
| capture-dispatch | Stop, últimos 3 turnos humanos | quando oferecer captura (cadência, orçamento por modelo, máx. 8 por sessão) | quando e quantas vezes oferecer; o texto da lição segue do LLM | `capture.offered` 293 |
| capture_lesson | chamada do LLM | escopo (inferDefaultScope), dedup cosseno >= 0.9, merge | admitir ou fundir é mecânico | `lesson.captured` 886 (+966 em lote) |
| recall (retrieve-core) | prompt, cwd, sessão | piso 0.50 (local), topK 1, projeto 3 + user 2 | a busca da lição relevante deixa de ser pedida ao LLM | `retrieve.injected`: 1480 lições |
| retrieval-feedback | Stop, resposta final | citação = 2 tokens do título, ou 1 token + trecho >= 10 chars | medir uso é mecânico | `retrieve.cited` 269 (18%) |
| brain-promote | scan no projeto | `recurrence >= 3` e `confidence >= 0.8` | gerar o rascunho é mecânico; aprovar é humano | sem métrica |
| policy | ação explícita do usuário | limites de tamanho, globs, segredo | injeção declarativa, sem LLM | sem métrica |
| brain-consolidate | SessionStart, 1x por semana por projeto | funde pares do mesmo tipo com cosseno 0.7 a 0.9 | fusão mecânica | sem métrica |
| curation-detect | PostToolUse do Bash | 1500 chars ou 30 linhas; classe do comando; recorrência em 90 dias | detectar o que curar é mecânico | `curation.flagged` 3733 |
| curation-guard | PreToolUse do Bash | alias do `shells.json` casa com o comando | a decisão de usar o script passou a ser mecânica (`updatedInput`) | `curation.redirected` 218 |
| curation-stop | Stop, journal de curadoria | pede REFINE, EXTEND ou CREATE; teto de tentativas | só o pedido é mecânico; o script segue do LLM | `curation.stop.blocked` 3 |
| compaction gate | prompt humano com sessão ociosa | tokens >= 30% da janela e ocioso >= TTL do cache | decidir a hora de compactar | `compaction.run` 311 |
| shell-escape, powershell-guard, file-format-guard, graph-guard, error-guard | PreToolUse/PostToolUse | regras próprias (seção 4) | correções que antes dependiam do LLM acertar | seção 5 |

## 2. Loop de aprendizado

Fluxo: captura, recall, citação, consolidação, e (manual) skill ou policy. Cada etapa abaixo traz o que entra, o que decide, o que é mecânico e o que continua do LLM.

### 2.1 Captura

**correction-detect** (`scripts/correction-detect.js`)
- Entra: o prompt do usuário. Ignora prompt sintético e mensagem com menos de 3 caracteres.
- Decide: quatro regexes (`:15-20`). Falso positivo é aceito de propósito.
- Sai: texto de nudge pedindo `capture_lesson`. Mecânico: o gatilho. LLM: julgar se há lição generalizável e escrever título, resumo e detalhe.
- Perfil: ligado em `standard`, desligado em `free`.

**capture-dispatch** (`scripts/capture-dispatch.js`), o gatilho principal de captura no perfil standard
- Entra: o Stop, com `session_id`, `transcript_path` e id de projeto estrito. Sem id, loga e sai.
- Decide, por Stop:
  1. ingere os últimos 3 turnos humanos numa fila durável e redigida;
  2. reconcilia o ack do offer aberto;
  3. se o offer segue aberto, repete o bloqueio, até `maxBlockAttempts=5` sem ack, quando relenta;
  4. para um offer novo, usa `turn-budget.js`: no máximo 8 capturas por sessão e cooldown de 2 min; orçamento por modelo (opus 4 a 8 ciclos e 9000 chars; sonnet 4 a 6 e 8000; haiku ou desconhecido 3 a 5 e 6000); dispara com ciclos >= `maxTurns` ou chars >= `maxChars`;
  5. ciclos órfãos de sessão encerrada são adotados após 24 h.
- Sai: `{block:true}` com o trecho redigido da conversa, marcado como dado não confiável. O LLM escolhe entre `capture_lesson` e `capture_ack`.
- Mecânico: o que oferecer, quando e quantas vezes. LLM: se há lição, o texto, as tags e o tipo.
- Métricas: `capture.offered/reoffered/relented/acked/adopted`.

**Outros detectores (todos desligados em `standard`, exceto onde indicado)**
- `pattern-detect`: lembrete a cada 6 Stops (`EVERY=6`) pedindo `capture_lesson(type:"pattern")`.
- `failure-detect` registra falhas no journal (sem bloquear, sem métrica) e `failure-retro` pergunta se vale capturar quando há 2 ou mais falhas iguais (mesma chave `{tool, cmd, exit}`) ou 3 consecutivas, na janela de 10 min.
- `decision-detect` guarda decisões vistas em `git commit -m`, heredoc, `gh pr create|edit --body`; `decision-promote` (ligado em `standard`) pede `capture_lesson(type:"decision")` no Stop e expira pendings de outras sessões em 24 h. `decision-scan-response` (desligado) procura frase com verbo de escolha e conector de justificativa na resposta.

**capture_lesson** (`servers/brain-server/lib/mcp-server.js:1034-1090`; caminho remoto em `:382-409`)
- Entra: `title, summary, detail, type, tags, confidence=0.85, scope='auto', windowId`. O tipo `skill` é recusado.
- Decide:
  - escopo: `scope` explícito (`project` ou `user`) ou `inferDefaultScope(type, tags)`;
  - dedup: busca vetorial no banco do escopo de destino, mesmo tipo, cosseno >= 0.9 (`DEDUP`, `:1058`). Se achou, `merge`: `recurrence+1` e `confidence=max` (`engine/brain-store.js:886-902`). Se não, admite, com título cortado em 80 chars, resumo em 500 e até 8 tags.
- Mecânico: dedup, merge e escopo. LLM: o conteúdo.
- Métrica: `lesson.captured {type, decision:'merge'|'admit', scope, recurrence?, windowId?, source}`.
- Limite conhecido: o dedup local só olha o banco do escopo de destino. A mesma lição em dois projetos vira duas entradas, cada uma com `recurrence` 1. Isso é inferido da leitura do código, sem teste em execução.

### 2.2 Recall

**retrieve-core** (`engine/lib/retrieve-core.js`, chamado por `brain_retrieve_context`, `mcp-server.js:1131-1186`)
- Entra: UserPromptSubmit com `prompt`, `cwd` e `session_id`.
- Pré-filtros: prompt sintético (`<task-notification>`) é ignorado; cwd sem id de projeto estrito não recebe recall; menos de 3 palavras-chave (comprimento >= 4) resulta em `short`.
- Backend local (padrão shipped): `fastTopK=1`, `minScoreFast=0.50` sobre cosseno bruto. Busca em duas passadas com `topK+4=5`: `projectK=3` no banco do projeto e `userK=2` no banco `__user__` (só se o `brain.db` dele existe). Une por id, ordena por score, deduplica por título e injeta no máximo 1 entrada. Ancestrais não entram no ramo local.
- Backend `mcp-memory` (`retrieveRemote`): dois braços em paralelo (compose e braço de projeto sobre `[foco, ...ancestrais, '__user__']`), piso 0.65, query cortada em 300 chars, timeout 8000 ms, orçamento de 6000 chars, disjuntor por braço (janela 10, 5 falhas, pula 4 chamadas) e circuito global de 15 s. Não foi verificado qual backend a máquina do Allan usa.
- Escopos: o recall mistura projeto e `__user__`. É por aqui que uma lição de escopo user aparece em outro projeto.
- Mecânico: toda a busca e a injeção. Antes disso o LLM precisaria lembrar de consultar a memória.
- Persiste um `retrieval-journal` (`returnedIds`, `injectedIds`, `injectedChars`). Neste build também `injectedOrigins` e `originById` (seção 6).

### 2.3 Citação

**retrieval-feedback** (`scripts/retrieval-feedback.js`)
- Entra: o Stop, o journal de recalls da sessão e a última resposta do assistente (últimas 30 linhas do transcript, cerca de 4000 chars).
- Decide: uma entrada conta como citada (`citationMatch`, `:43-62`) se a resposta tem 2 ou mais tokens distintos do título (comprimento >= 4, até 8 tokens), ou 1 token mais uma substring contígua de 10 ou mais chars com espaço. Só pontua se houve resposta.
- Sai: silencioso, nunca bloqueia. `recordCitation(id)` faz `cited_count+1` e atualiza `last_cited_ts`. O boost de citação no rerank vem da config (`alpha 0.1`, `cap 1.5`).
- Métricas: `retrieve.injected {count, chars}`, `retrieve.empty`, `retrieve.cited {entryId}`.
- Limite: a citação é uma heurística lexical. É evidência de uso, não prova de que a lição evitou um erro.

### 2.4 Skill

**skill-promote-trigger** e **brain-promote** (`scripts/brain-promote.js`)
- Entra: Stop; o gatilho tem cooldown de 10 min e dispara `brain-promote.js scan --cwd <cwd>` em segundo plano. O `scan` roda só no projeto da sessão.
- Decide: candidatas são entradas `lesson` e `pattern` com `recurrence >= 3` e `confidence >= 0.8` (`config/brain-config.json:56-60`), ignorando slugs já tratados.
- Sai: rascunho `SKILL.md` em `<DATA_DIR>/skills-pending/<slug>/`. O rascunho não é sanitizado (usa o `detail` da lição como está). `approve <slug>` move para `~/.claude/skills/<slug>`: é decisão humana, e o SessionStart avisa que há rascunhos esperando.
- Consequência: o único caminho "projeto para usuário" que passa por limiar de recorrência gera uma skill de usuário, e exige aprovação manual. A recorrência é a de um único banco de projeto.
- `skill-success-detect` marca `skill.outcome` com heurística grosseira: sucesso 0 se houve nudge de falha depois da invocação, senão 1.

### 2.5 Policy

- `policy_activate` (`mcp-server.js:1262-1339`; store em `engine/lib/policy-store.js`): a policy nunca nasce de uma lição automaticamente, só de ação explícita do usuário.
- Regras: com `globs` o escopo é forçado a projeto; `assert` exige `globs`; limites de 10 policies sempre ativas ou 4000 chars injetados, 20 globs por policy, 50 policies glob e 10 shadow por projeto; literal com cara de segredo é recusado; texto é redigido antes de gravar.
- Injeção determinística e sem LLM: `policy-inject.js` (SessionStart, SubagentStart) injeta as "always"; `policy-glob-inject.js` (pós-edição) injeta as cujo glob casa com o arquivo editado. Policy com `scope:'user'` vale para todos os projetos, mas só se o usuário a ativar. Sem métrica.

### 2.6 Consolidação

**brain-consolidate** (`scripts/brain-consolidate.js`)
- Entra: SessionStart (`curation-session.js:95-107`), em segundo plano, no máximo 1 vez por semana por projeto.
- Decide: `planMerges` agrupa entradas do mesmo tipo com cosseno entre 0.7 e 0.9 (acima disso o dedup da captura já funde). Sobrevive a de maior recorrência, depois maior confiança, depois a mais antiga; a recorrência dos absorvidos é somada.
- Sai: o gatilho semanal usa `--apply` (a CLI é dry-run por padrão). Escopo de um único projeto. Se falhar, a semana é devolvida. Sem métrica.

### 2.7 Escopo e sanitização

**scope-sanitizer** (`engine/lib/scope-sanitizer.js`)
- Escopo padrão (`inferDefaultScope`): `decision` e `code` ficam em projeto; `reference` e `research` vão para user; qualquer tag em `USER_TAG_HINTS` (workflow, ux, tone, style, preferences, user-habits, agent-behavior, tooling-discipline, communication-style, cross-lingual, language-preference, token-efficiency) leva a user; o resto fica em projeto.
- Sanitização para user (`prepareForUserScope`): rejeita se achar segredo (`sk-`, `pa-`, `ghp_`, `gho_`, `AKIA`, `xox*`, `AIza`); troca `X:\Users\nome`, `/home/x`, `/Users/x` por `~`; e-mails por `<email>`; o id do projeto, como palavra inteira, por `<project>`.
- Chamado por `capture_lesson`, `brain_store`, pelo caminho remoto, por `scope-bulk-reclassify` e pelo dashboard.

### 2.8 Quando promove de projeto para usuário (lacuna explícita)

**Não existe promoção automática por recorrência nem por número de projetos.** O mapa de código foi feito por leitura e busca semântica, sem varredura exaustiva; não achei agregação entre projetos em lugar nenhum. O escopo `user` nasce por uma de três vias:

1. No momento da captura: `inferDefaultScope(type, tags)` por tipo ou tag (`mcp-server.js:1041`). Não há evento de promoção; só o `lesson.captured` com `scope:'user'`.
2. Reclassificação manual em lote: `scripts/scope-bulk-reclassify.js` (CLI `<project> [--type=] [--commit]`, dry-run por padrão). Para cada entrada que ainda não é user, aplica `inferDefaultScope(type, tags) === 'user'`; com `--commit`, roda `prepareForUserScope` (segredo rejeita a entrada), apaga a original, grava em `__user__` e reindexa. Recorrência e confiança são preservadas. Observação: `content.files` e as tags são copiados sem sanitizar; o sanitizer só toca título, resumo e detalhe. Sem métrica.
3. Move manual no dashboard: `PATCH /api/brain/entry/:id/scope` (`scripts/dashboard.js:916`), que também chama `prepareForUserScope`.

A recorrência (`recurrence`) é contada dentro de um único banco de projeto. Nada soma a mesma lição em N projetos. No outcome-report, 146 das capturas (17%) já nascem em escopo user, mas isso reflete tipo e tags, não evidência de reuso.

**Proposta (não implementada):** promover para `__user__` quando a mesma lição (cosseno >= 0.9) aparecer em >= 2 projetos, ou quando for citada em >= 2 sessões de >= 2 projetos, sempre passando por `prepareForUserScope`. O sinal de citação por origem viria de `retrieve.cited` com `origin` (seção 6). Antes de implementar, dois pontos a resolver: o dedup atual é por banco, então a agregação teria de ler os bancos de vários projetos; e o sanitizer precisaria cobrir `content.files` e tags.

## 3. Loop de curadoria

Objetivo: comando que despeja saída grande vira um script curado que devolve só um resumo (contrato OK/FAIL). Fluxo: detectar, pedir o script ao LLM, redirecionar mecanicamente nas próximas vezes, medir a economia.

### 3.1 curation-detect (`scripts/curation-detect.js`)
- Entra: PostToolUse e PostToolUseFailure do Bash.
- Decide:
  - Classificação (`curation-classifier.js`, função pura): limiar de saída bruta `maxOutputChars=1500` e `maxOutputLines=30` (`config/brain-config.json:70-75`). Não curado acima do limiar é `needs-curation`. Curado com sucesso acima do orçamento (padrão 3 linhas e 500 chars; se o script declara `outputLines`, esse valor, e `outputChars` padrão `outputLines*100`) é `curated-success-noisy`. Curado que falhou acima do limiar bruto é `curated-failure-noisy`.
  - Classe do comando (`engine/lib/curation-families.js`): `exploration` (grep, rg, find, ls, cat, head, tail, sed, awk, `git log/status/diff/show/blame/branch`, curl e outros), `inline` (`node -e`, `python -c`, heredoc) ou `task`. Só `task` é curável.
  - Recorrência: `oneoff.touch` conta toda ocorrência da assinatura (assinatura canônica ignora `cd`, `VAR=`, `echo`, `env`, `sudo`, `time`, flags e wrappers; `cd x && git --no-pager log -5` vira `git log`). A 1ª ocorrência ruidosa de task fica `pending`; a partir da 2ª dentro da janela de 90 dias (`seen.count >= 2`) vira pedido de curadoria.
  - Suprimido por one-hit marcado com contagem abaixo do teto 3 (assinatura de 1 token tem teto isento). Variante de script existente vira entrada `extendShell`. Descartados: comando de subagente e `CCB_RAW=1`.
  - Piped: se o agente filtra o mesmo script com o mesmo `| filtro` 2 vezes (`ASK_AT=2`), pede uma única vez para embutir o filtro no script.
- Sai: grava entradas no turn-journal (`.runtime/curation-turn-<sid>--*.json`); a resposta ao hook é sempre `{}`.
- Métricas: `curation.used`, `curation.skipped {class}`, `curation.pending {sig}`, `curation.flagged`.

### 3.2 curation-stop (`scripts/curation-stop.js`)
- Entra: o Stop, lendo o turn-journal; roda depois do `failure-retro`.
- Decide: `filterUnresolved` descarta o que já foi resolvido por `curation_mark_oneoff` ou `curation_register_shell`. Primeiro bloqueio com `attempts=1`. Num retry com `stop_hook_active`, há progresso se algo foi resolvido, se houve one-hit marcado desde o primeiro bloqueio, se o script foi editado, ou se há trabalho novo sem sobreposição. A razão escala a cada tentativa ([RETRY n/max], [FINAL]); teto `maxAttempts=3`, e 1 em `standard`.
- Sai: `{block:true}` com um bloco REFINE, EXTEND ou CREATE.
- Continua do LLM: executar `curation_register_shell` (escrever o script e escolher os aliases) ou `curation_mark_oneoff`.
- Métricas: `curation.stop.blocked`, `released`, `relented`.

### 3.3 curation-guard (`scripts/curation-guard.js`): onde a decisão foi mecanizada
- Entra: PreToolUse do Bash, com `permission_mode`.
- Decide, em cascata (`:212-366`):
  0. Reescritas no Windows via `updatedInput`: shell-escape (heredoc ou `node -e` longo vai para arquivo, `inlineMaxChars=300`) e PowerShell via Bash (escapa `$` e crase).
  1. Se o comando já invoca o script curado, deixa passar; com pipe, só registra `curation.piped`.
  2. Redirect: parte top-level da classe task cuja assinatura e flags casam com um alias é substituída pela invocação do script. Com `passthrough: true`, variantes que começam com o alias são reescritas com os argumentos; alias variante exige `acceptsArgs: true`. Não reescreve saída para arquivo ou `tee`, newline, heredoc, crase, `$()` ou subshell. Permissão `allow` em `bypassPermissions`, senão `ask`.
  3. Whitelist do `shells.json` passa.
  4. Graph-guard na superfície Bash (só com backend `mcp-memory` e grafo pronto).
  5. `denyUnknown` (padrão false).
  6. Shaper de exploração: só em `bypassPermissions` e sem Token Guard; embrulha o comando com `shape-output.js`.
  - Padrão: abstém (`{}`), nunca `allow`.
- O que era do LLM e agora é mecânico: a decisão de usar o script curado. Antes, a dica "prefira na próxima vez" era seguida em 19% das vezes e o deny-redirect em 47% (`scripts/lib/curation-redirect.js:6-9`). O redirect agora é automático e `CCB_RAW=1` na frente do comando é o escape do usuário.
- O comando vira `CCB_RAW_REPORT="<id>.jsonl" CCB_PROJECT_ROOT="<root>" <interpretador> "<script absoluto>" [args]`.
- Métricas: `curation.redirected`, `curation.uncovered`, `curation.bypass`, `curation.piped`, mais as das reescritas.

### 3.4 Economia exata: raw-report e curation-metrics
- O script curado escreve `{rawChars, rawLines}` em `.runtime/raw-report/<id>.jsonl`. O curation-detect lê e apaga o arquivo e inclui `rawChars` em `curation.used`. A economia fica exata, e não estimada. Órfãos são varridos após 24 h.
- `curation-metrics.js` (somente leitura) separa economia exata (script que reporta o bruto, e cortes do shaper) de estimada (diferença entre a linha de base da assinatura e a média do script) e lista `neverUsed`.
- `shape-output.js` corta saída de exploração em 80 linhas e 8000 chars; a completa vai para `.runtime/shaped/` (24 h, cap de 50 MB). Evento `curation.shaped`.

### 3.5 Registro, poda e escopo
- `curation_register_shell` (`scripts/lib/shell-register.js`) recusa alias genérico de 1 token, alias com valor volátil (número de 2 ou mais dígitos, hash, faixa de linhas do sed, uuid, caminho tmp) e script fora da pasta de scripts. Padrões: `outputFilter:'summary'`, `outputLines:30`, `timeoutMs:60000`.
- `curation_prune_unused` (manual, só com `apply`): candidato é um script ausente de `used`, `redirected` e `piped` numa janela de 30 dias (1 a 365), com histórico cobrindo a janela inteira; remove só o registro, com backup (5 mantidos).
- `curation-session` (SessionStart) poda one-hits frios com mais de 90 dias, compacta ruído de métricas (1 vez por dia por projeto) e injeta `[CURATION] N scripts / M one-hits`.
- Escopo: `shells.json` fica por projeto, fora do repo, em `~/.claude/claude-code-boss/curation/<owner>/<repo>/shells.json` (`scripts/curation-paths.js:11-20`); sem id de projeto usa `local/<nome>-<sha1[:10]>`. Configs versionados no repo (`.vscode/shells.json`) são lidos no lugar. **Não há promoção para nível usuário**: `listCurationHomes` só lista as pastas por projeto. O mesmo script em dois projetos é curado duas vezes.
- Continua do LLM: escrever o script e escolher os aliases.

## 4. Outras funções

- **Compaction gate** (`hooks/compaction.mjs`, `scripts/lib/compaction-core.mjs`): age só no prompt de uma pessoa com a sessão ociosa; segura o prompt, roda `/compact` e reenvia. Compacta se tokens >= 30% da janela do engine (faixa 10 a 80) e ocioso >= TTL do cache (`decideTiming`); cache quente resulta em `wait`. Cooldown de 10 min; sem leitura de tokens ou `lastAnswerAt`, não age. Corte: poda se cortar >= 85% com texto intacto; senão brief mecânico sem chamar modelo (cauda verbatim de 2000 tokens) se frio e não for `/compact` manual; senão resumo nativo. TTL de pasta cai de 1h para 5m enquanto todas as sessões da pasta passam do limiar.
- **file-format-guard** (`scripts/file-format-guard.js`): guarda EOL (CRLF/LF) e BOM do arquivo que a ferramenta Write vai sobrescrever e restaura no arquivo escrito (limite 5 MB, só texto não binário e não UTF-16). Emite `fileformat.restored`.
- **graph-guard** (`scripts/graph-guard.js`): com backend `mcp-memory` e grafo pronto, nega uma vez uma busca ampla (Grep/Glob) e aponta `graph_search` ou `graph_symbols`; o mesmo retry passa. Grafo não indexado passa com aviso. Emite `graph-guard.fired`.
- **error-guard** (`scripts/error-guard.js`): nega o comando que já falhou >= 2 vezes nesta sessão, na mesma pasta, sem edição de arquivo desde a última falha, injetando a última saída. Nunca emite `allow`, para não sobrescrever o `updatedInput` da curadoria. Emite `error-guard.denied`.
- **powershell-guard** (`scripts/powershell-guard.js`): no PowerShell 5.1 reescreve `&&` e `||` para `if ($?)`; lint e aviso para o resto. Emite `powershell.rewritten` e `powershell.warned`.
- **shell-escape** (dentro do curation-guard, etapa 0): move heredoc e `node -e` longo para arquivo; nota que `/tmp/` no Windows não é o `/tmp` do Git Bash. Emite `shell-escape.rewritten`, `denied`, `warned`.
- **doctor / custo fixo** (`scripts/doctor-first-run.js`, `lib/fixed-cost.js`): roda uma vez por build; com `fixedCost.autoFix=true` (padrão) aplica correções reversíveis numa janela de 30 dias: remove MCP sem chamadas (histórico cobrindo metade da janela, ou nunca autenticou; só escopos user e local), põe skills nunca usadas em modo só-nome, desabilita plugins com mais de 14 dias, sem uso e com custo por mensagem (nunca o próprio Boss). Registra em `~/.claude/claude-code-boss/fixed-cost-undo.json`; desfaz com `node scripts/doctor.js --undo`. Sem métrica.
- **compat-check**: confere o Boss contra o Claude Code instalado. Não li o código dele para este documento; a descrição se limita ao que consta no commit f77c54d.
- **economy-report** (`scripts/economy-report.js`): custo por sessão e comparação agrupada. Mede dólar; hoje não separa com Boss de sem Boss.
- **outcome-report** (`scripts/outcome-report.js`, `scripts/lib/outcome-metrics.js`, ainda não commitados): conta eventos dos dois loops e das decisões por regra (seção 5).

## 5. Evidência medida

Fonte: `node scripts/outcome-report.js` (`docs/research/compat-2.1.300/outcome-report.txt`). Período: eventos de 2026-06-08 a 2026-10-12, 202 projetos, 573 sessões.

| Medida | Valor |
|---|---|
| Lições capturadas | 886 (+966 de carga em massa, contadas à parte): 857 novas, 29 recorrências de lição conhecida (3%) |
| Capturas em escopo user | 146 (17%) |
| Lições recuperadas para prompts | 1480; citadas na resposta: 269 (taxa de citação 18%) |
| Origem do recall | não registrada até este build |
| Reuso | 75 lições distintas citadas; 16 em mais de uma sessão; 10 em mais de um projeto |
| Curadoria | 27 scripts curados em uso; 218 comandos tratados por script contra 3733 cuja saída bruta entrou no contexto (6% mecânico); 552 comandos ruidosos ainda sem script |
| Decisões por regra | 2513 (graph-guard 152, shell-escape.rewritten 1799, compaction.run 311, curation.redirected 218, powershell.rewritten 9, fileformat.restored 8, curation.shaped 15, error-guard.denied 1) |
| Devolvidas ao modelo | 5595 (curation.flagged 3733, capture.offered 293, nudge.emitted 1566, curation.stop.blocked 3); parcela mecânica 31% |

Por semana, parcela mecânica: 1% (semana de 28/9), 28% (5/10), 88% (12/10). A de curadoria: 1%, 69%, 80%. Semanas anteriores aparecem como n/a, não 0%, porque os eventos de regra só existem desde cerca de 3/10.

Por número de sessões do projeto (sessões iniciadas desde 2/10; taxas por sessão):

| Sessões do projeto | Sessões | Regra | Recall | Parcela mecânica | Curadoria |
|---|---|---|---|---|---|
| 1 a 3 | 188 | 2,8 | 2,09 | 48% | 24% |
| 4 a 10 | 119 | 4,47 | 1,19 | 66% | 51% |
| 11 a 30 | 74 | 12,08 | 1,96 | 66% | 28% |
| 31 ou mais | 41 | 10,24 | 2,05 | 91% | 97% |

Medidas complementares (30 dias, `compaction-report-30d.txt`, `subagent-census.txt`, `subagent-ttl-what-if.txt`):
- 47 compactações feitas pelo Boss no período, nenhuma pelo engine nativo; custo de reescrita por compactação entre US$ 0,12 e US$ 0,32 médios por modelo e janela. Em 2 das 5 sessões com mais cortes o relatório marca "compacta demais: sim"; o limiar padrão não foi alterado.
- Subagentes: 681 transcritos, 6,0% do custo; TTL de 1h para subagentes não compensa (ganho de 6,0 milhões contra custo extra de 47,2 milhões de tokens equivalentes de entrada).

Limitações, declaradas pelo próprio relatório:
- Os números são contagens de eventos registrados, não efeito causal.
- Eventos de regra só existem desde cerca de 3/10; antes disso a parcela mecânica não é calculável.
- Project-semanas com mais de 40 capturas são tratadas como carga em massa e contadas à parte.
- A curva por número de sessões é transversal e confundida: projetos com mais sessões também diferem em tamanho e tipo de trabalho. Não mostra que o projeto melhora com o uso, apenas que projetos antigos têm parcela maior.
- Não inferido: recall é oportunidade de evitar repetição; citação é evidência de que a resposta usou a lição. Nenhum dos dois prova que um erro foi evitado. Correção evitada não é medida.
- Sem medida: ganho por função de captura isolada, qualidade do texto das lições, e custo em dólar com versus sem Boss.

## 6. Dados coletados a partir deste build

Neste build (mudanças ainda não commitadas em `engine/lib/retrieve-core.js`, `scripts/retrieval-feedback.js` e `servers/brain-server/lib/mcp-server.js`), cada recall registra a origem de cada lição injetada, relativa ao projeto que pediu:
- `own`: o próprio projeto (foco); `ancestor`: a cadeia de ancestrais; `other`: outro projeto (por exemplo lição de escopo user que casou aqui); `home`: a espinha global; `unknown`: o hit não traz projeto (`injectionOrigins`, `retrieve-core.js:176`).
- `retrieve.injected` passa a levar `origins` (contagens por origem) e `retrieve.cited` leva `origin` da entrada citada (`retrieval-feedback.js`).
- Isso permite medir o efeito de lições vindas de outro projeto (quantas são injetadas, quantas são citadas) e fornece o sinal para a promoção proposta em 2.8. Os eventos já gravados não têm esse campo, então a série começa com este build.
