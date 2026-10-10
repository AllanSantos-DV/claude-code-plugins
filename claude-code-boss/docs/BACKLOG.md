# Backlog

Pontos de melhoria identificados fora do escopo do trabalho corrente (ver política de sessão: "ponto óbvio de melhoria encontrado FORA do escopo atual não é implementado na hora").

## Auditoria adversarial pré-release 3.2.0 (2026-10-09) — 7 achados, todos corrigidos na hora

- [x] **[alto] Migração que falhava uma vez nunca mais terminava** (`curation-paths.js` `_migrate`): a 1ª falha deixava a pasta da curadoria sem `shells.json` (só o aviso) e o rename da pasta temporária por cima dela falhava sempre; `curation_register_shell` recusava tudo. Agora uma pasta existente sem `shells.json` recebe os arquivos no lugar. Teste "falha → corrige → migra" + mutação.
- [x] **[médio] `.vscode` versionado de um branch vazava para todos os branches/clones**: a migração fundia a config rastreada pelo git na pasta compartilhada (em `bypassPermissions`, alias de PR rodando sem pergunta em outro branch). Agora config rastreada NÃO é movida nem fundida: é lida no lugar, por branch, como antes (`getRepoShellsFiles` + `shells-config`); só a pessoal (não rastreada) migra. Isso também substitui a correção anterior do "re-migrado em todo processo". Teste + mutação.
- [x] **[médio] Falha do `git ls-files` apagava arquivos rastreados**: o erro virava "nada rastreado". Agora: sem repositório → nada rastreado; dentro de repositório, qualquer erro do git aborta a migração (fail closed, arquivo antigo continua em uso); chamadas em lotes de 50; diretório/arquivo symlink não é seguido. Teste + mutação.
- [x] **[médio] SessionStart sobrescrevia o `shells.json` antigo no modo de fallback** (`session-whitelist.js`): só escreve dentro da pasta da curadoria e nunca sobrescreve arquivo que não leu. 2 testes + mutação.
- [x] **[médio] Cópia do banco de métricas antigo com corrida/inconsistência** (`metrics-project.js`): agora `VACUUM INTO` (snapshot consistente com WAL, mesmo com o banco aberto) + criação exclusiva do destino. Teste com linha no WAL e banco aberto + mutação.
- [x] **[médio] Modelo de passthrough da skill quebrava argumentos no Windows** (`shell: true` → cmd.exe relê os args): modelo Node agora `shell: false`; shim `.cmd` (npm/npx/mvn) → modelo Bash com `"$@"`. Doc.
- [x] **[baixo] Lançamento oculto falhava em silêncio sem VBScript** (`mcp-launcher.js`): `kickLauncherVerified` confere a saída do wscript; se falhar, registra e cai para o lançamento comum (o servidor sobe). Teste + mutação.

- [x] **Achado no CI de Linux (3.2.0) — a migração zerava a idade dos scripts (achado e corrigido na hora)**: `copyFileSync` não preserva o mtime no Linux/macOS (no Windows preserva); o prune de nunca-usados lê essa idade, então todo script movido parecia novo por 30 dias. Agora a cópia reaplica atime/mtime. Teste (pega no Linux).
- [x] **Achado no CI de Linux (3.2.0) — testes de hooks dependiam do checkout real (achado e corrigido na hora)**: a fixture usa `cwd: "C:\\fixture"`, relativo no Linux; resolvia contra a pasta atual (o repo). Com os hooks rodando numa área isolada, a área ganhou marcador de projeto e o `seedRecurrence` resolve contra ela. A trava de sandbox passou a ser checada antes de qualquer chamada ao git. Validado num contêiner Linux (node:24) com o gate completo: só sobram as 7 falhas de ambiente que a v3.1.1 tem no mesmo contêiner (e que passam no CI real).

## Ferramental de release

- [x] **"O agente `vitrine` não abre" — NÃO é deste repo (verificado na release 3.2.0)**: o subagente `vitrine` que o Claude Code oferecia é o do *copilot-marketplace* (carregado da pasta de agentes do Copilot do usuário, com `tools: [read, search, edit, …]` de Copilot) e foi recusado com zero ferramentas. O `.github/agents/vitrine.agent.md` daqui já declara Read/Edit/Write/Bash e não é registrado como subagente (fica em `.github/agents/`): a prática é rodar um agente geral que segue o arquivo — foi o que se fez.

## Janela piscando (relatado pelo Allan em 2026-10-09) — corrigido

- [x] **Janela do terminal piscando a cada início de sessão (achado e corrigido na hora)**: o `SessionStart`
  (`brain-daemon-ensure.js`) rodava o inicializador do mcp-memory SEMPRE, mesmo com o daemon vivo (`spawned:false`),
  e headless `claude -p` de outras ferramentas (sdk-cli, pastas smart-tool/claude-code) disparavam um a cada ~30 s.
  O `kickLauncher` usava `spawn('cmd.exe', {detached:true, windowsHide:true})`: no Windows `detached` cria o
  processo sem console (DETACHED_PROCESS), o `windowsHide` é ignorado e o PowerShell do `.cmd` ganha console
  visível. Medido com EnumWindows (`smoke/launcher-flash.cjs`): `CASCADIA_HOSTING_WINDOW_CLASS 'powershell …'` com
  detached, nenhuma sem — mas sem detached o inicializador morre junto com o hook (provado). Correção:
  `SessionStart` só chama o inicializador quando o `/health` falha (o `_ensureDaemon` do mcp-client); o kick vai
  por `wscript //B scripts/lib/run-hidden.vbs <launcher>` (GUI, sem console; `Run(…, 0, False)`) — janela: nenhuma;
  sobrevive ao pai: sim. Smoke real: daemon vivo → `alive`, 0 processos, 0 janelas; daemon morto → `kicked`,
  0 janelas, daemon de volta (pid novo). Testes + 2 mutações pegas.

## Análise 2026-10-09 (pedido do Allan) — decidido por ele no mesmo dia: fazer

- [x] **Achado na validação real da A2 — config legado RASTREADO pelo git era re-migrado em todo processo novo (achado e corrigido na hora)**: visto no smart-tool (shells.json rastreado): cada hook num processo novo mesclava de novo, gravava um backup novo e sobrescrevia o aviso. Agora a pasta da curadoria guarda a impressão (sha1) do que já foi mesclado (`migrated.json`); só um arquivo alterado (mudança de colega) é mesclado de novo. Teste + mutação.

- [x] **INCIDENTE no desenvolvimento da A2 — a suíte de testes moveu e PERDEU a curadoria real do repo claude-code (achado e corrigido na hora)**: os testes trocam o HOME por uma pasta temporária e alguns hooks rodavam sem `cwd` → `process.cwd()` = o repo; a migração nova moveu `.vscode/shells.json` + 46 scripts para o HOME temporário, e um teste posterior apaga `~/.claude/claude-code-boss` desse HOME. Também um teste unitário subiu de uma pasta temporária até `C:\Users\allan` (a trava do HOME olha o HOME trocado) e moveu o `~/.vscode/shells.json` real (este tinha backup e foi restaurado). Correção: `CCB_TEST_SANDBOX=1` nas duas suítes — a migração recusa qualquer projeto fora do diretório temporário (teste + mutação, que ao ser aplicada moveu de novo o arquivo do HOME: prova de que a trava é o que protege) — e os hooks dos testes rodam com `cwd` numa área isolada. Prova: o `.vscode` restaurado sai idêntico (md5 dos 53 arquivos) das duas suítes. Recuperação: o `.vscode` do claude-code foi reconstruído das transcrições (54 `curation_register_shell`, 12 Write, 56 Edit reaplicados em ordem) + histórico local do VS Code + uma leitura completa do `shells.json` de 17/09 → 48 entradas, 47 com script (scripts editados fora dessas ferramentas podem estar numa versão anterior; `git-ignored-why.mjs` ficou na versão de junho — uma edição de julho não pôde ser reaplicada).

- [x] **Achado na A1 — o redirecionamento perdia o prefixo `VAR=valor` (achado e corrigido na hora)**: `NODE_ENV=test npm test` virava o script sem o NODE_ENV; e a variante `FOO=1 git stash list` mandava ao script `stash list` (o split cru contava o FOO=1). Agora `envPrefixOf` re-prefixa e `argsAfter` tira os argumentos depois do prefixo. Teste + 2 mutações.
- [x] **Achado na A2 — o SessionStart criava um `shells.json` em toda pasta aberta (achado e corrigido na hora)**: `session-whitelist` escrevia em qualquer projeto com `.vscode/` — origem dos 31 repos com `.vscode/shells.json`. Agora só escreve para projeto que já tem curadoria. Teste + mutação.
- [x] **Achado na A2 — entrada para `.vscode/scripts/x` sem o arquivo no disco ficava com o caminho do repo (achado e corrigido na hora)**: visto no test-hooks; o mapeamento agora usa o prefixo da pasta de curadoria, exista o arquivo ou não. Teste + mutação.
- [x] **Achado na A3 — o updater do painel apagava a pasta de cache existente (achado e corrigido na hora)**: `plugin-updater.js` fazia `rmSync(destDir)` ao reinstalar o mesmo SHA — a pasta de onde o daemon pode estar rodando (o mesmo que derrubou o daemon em 2026-10-05 no install-local). Agora vai para uma pasta nova (`freshCacheDir`). Teste + mutação.

- [x] **A1 — redirecionamento de comando já curado: RESOLVIDO com passthrough** (não vetor). Pesquisa: o rtk (rtk-ai/rtk, mesmo problema via hook do Claude Code) só reescreve para um repasse transparente do mesmo binário com os mesmos argumentos. Implementado: script com `passthrough: true` recebe toda variante que começa com um alias, argumentos e flags inclusos (`curation-redirect.js` `passthroughMatch`/`argsAfter`); opt-in por script (um wrapper dry-run não pode repassar `--ci`). Replay 7 projetos/14,6 mil comandos: 173 → até 256 redirecionamentos. 4 testes + mutações pegas. Análise original: Replay em 7 projetos (14.145 chamadas Bash, 13.422 partes de tarefa): 171 redirecionáveis por assinatura exata; 897 "quase" (mesma família de 2 tokens). Embeddings (`paraphrase-multilingual-MiniLM-L12-v2`, o embedder do plugin) nos 238 quase-acertos únicos: só 23 com cosseno ≥ 0,80, e 152 com margem < 0,05 entre o 1º e o 2º script. Rotulados à mão, os 23: 2 corretos, 5 precisariam passar argumento, 1 ambíguo, 15 errados, 3 deles operações de escrita (`git add`/`git commit -F` → script de leitura). Proposta alternativa no relatório: aliases parametrizados + `acceptsArgs`, com o EXTEND da F3.0-2.
- [x] **A2 — curadoria fora do `.vscode` — RESOLVIDO**: `~/.claude/claude-code-boss/curation/<owner>/<repo>/` (id estrito; `local/<nome>-<hash>` sem id), migração automática com backup, rastreados pelo git ficam e são avisados, falha mantém o arquivo antigo em uso, `CCB_PROJECT_ROOT` no redirecionamento, aviso único no SessionStart; whitelist só para projeto com curadoria. 3 testes de migração + testes atualizados; 10/10 mutações pegas. (decisão do Allan: pasta local do usuário por id do projeto; a copilot-delegate não é critério). Análise original: viável com ressalvas. Todo acesso passa por `curation-paths.js`, mas `path.join(projectRoot, cfg)` não aceita pasta fora do repo; `invocationFor` recusa script fora da raiz; 19 de 141 scripts se localizam por `__dirname/../..`; a extensão `copilot-delegate` lê `.vscode/shells.json` FIXO (sem configuração). Decisão do dono: mover (pasta de dados do plugin por project id) × manter e só auto-excluir via `.git/info/exclude`.
- [x] **A3 — versão do plugin = SHA do commit — RESOLVIDO** (commit 7bf7c5c: `version` no plugin.json + guarda `unreleased` + updater; 5 testes, 5/5 mutações). `plugin.json` sem `version` desde `6cd3336c` (2026-05-25) → o Claude Code usa o SHA (12 chars) como versão: 60 pushes no `main` entre 2026-07-29 e 2026-10-09, 31 sem tag, todos entregues como "versão nova" (inclusive só página/rf-reviewer). Proposta: `version` no `plugin.json` sincronizado pelo `sync-version.js` + guarda de CI "mudou código do plugin no main ⇒ versão subiu" + `install-local` com sufixo `-dev.<sha>`. O `rf-reviewer` já fixa a versão.
- [x] **Achado (A1) — alias com argumento volátil nunca casa de novo — RESOLVIDO**: `curation_register_shell` recusa alias com valor de uso único (número/id, hash, faixa do sed, UUID, caminho temporário — `volatileLiteral`) e aponta o prefixo estável + `passthrough: true`. Teste + mutação. Análise original:: `curation_register_shell` aceita aliases com literal de uma instância (native-java `pr-inspect`: `gh pr view 38 --repo … --json …`), e quase todos os 715 quase-acertos do native-java são isso (`gh pr checks <n>`, `gh pr view <n>`). Proposta: recusar/normalizar número/hash/caminho temporário no alias, ou guardar o padrão com placeholder.
- [x] **Achado (A2) — chave de métricas por `basename` — RESOLVIDO**: `metrics-project.metricsKeyFor` = id estrito como um segmento legível (`owner__repo`), pasta sem id cai no nome; o banco antigo pelo nome é COPIADO na 1ª vez (outro repo homônimo pode ainda lê-lo). Gravador (`metrics.js`) e leitores (value-digest, session-summary, research-followup, tuning-advisory, skill-success, prune) usam a mesma função. Achado junto e corrigido: `lesson.captured` era gravado sob o id cru (`owner/repo`, pasta aninhada) e o resumo de sessão lia pelo nome da pasta — nunca contava as lições do projeto; agora `metricsKeyForId`. 2 testes + 3 mutações. Análise original:: `metrics._resolveProject` usa `path.basename(cwd)`; dois repositórios com o mesmo nome de pasta dividem o mesmo `metrics.db`. Relevante se a curadoria for para o banco por projeto: a chave teria de ser o project id estrito.

## Fase C — redesenho da curadoria (branch `feat/curation-redesign`, aprovado em 2026-10-02)

Diagnóstico (replay `.claude/scripts/replay-curation-reuse.mjs`, 3.990 chamadas Bash reais do projeto): 670 invocações de script curado; 191 comandos crus que casavam com alias DEPOIS de o script existir; dicas do guard seguidas 19% (77/401), negações com redirecionamento 47% (72/153), negações por pipe 76%; 18 de 41 scripts nunca usados; aliases superajustados (comando literal de um dia) ou em linguagem natural; a única métrica (`curation.flagged`) mede saída crua que ENTROU no contexto e o dashboard a exibe como "tokens economizados" (invertida). Cada fase: commit próprio, teste, replay antes/depois e stress no Claude Code real.

- [x] **C0 — `updatedInput` pelo `mcp_tool`**: provar no Claude Code real se um PreToolUse `mcp_tool` pode reescrever o comando (allow + updatedInput). Se não puder, o curation-guard volta a ser hook `command` (decisão do usuário).
  **PROVADO em 2026-10-02 (Claude Code 2.1.283, sandbox)**: `allow` + `updatedInput` pelo `mcp_tool` reescreve o comando (`echo marcador-original` → saiu `marcador-REESCRITO`) — o curation-guard fica no daemon. `defer` + `updatedInput` NÃO serve: em `-p` vira tool adiada (`hook_deferred_tool`) e a sessão para sem rodar nem reescrever. Docs: https://code.claude.com/docs/en/hooks (acesso 2026-10-02) — `allow` contorna as permissões; `ask` mostra a modificação ao usuário. Regra adotada: `permission_mode` bypassPermissions → `allow`; demais modos → `ask` (nunca contornar a postura do usuário). As sessões reais do usuário são `bypassPermissions`. O modelo estranhou a saída reescrita → o redirecionamento precisa de aviso explícito (`additionalContext`).
- [x] **C1 — casar por assinatura** (feito: `lib/curation-families.js` + `planRedirect` casam assinatura canônica + flags por parte do comando — ver C2/C3): cada script guarda as assinaturas canônicas da família que o originou; o guard casa a assinatura de cada segmento (aliases seguem por compatibilidade).
- [x] **C2 — redirecionamento automático**: comando inteiro que casa por assinatura é reescrito para o script (updatedInput); composto → nega com a substituição exata (fim da dica que ninguém segue).
  **FEITO em 2026-10-02** (`lib/curation-redirect.js`, commit 6c34fdd): parte de TAREFA com assinatura+flags iguais a um alias é reescrita para o script (também dentro de composto, mantendo `cd` etc.); bypassPermissions → allow, outros modos → ask; aviso explícito com `CCB_RAW=1` como saída crua. Não reescreve: variantes (métrica `curation.uncovered`), saída para arquivo/`tee`, heredoc/multilinha, exploração. Dica "Prefer it next time" e deny-redirect removidos. **Provado no Claude Code real** (sandbox): `npm run hello 2>&1 | tail -5` → script curado (`CURATED-OK`, nenhuma das 300 linhas cruas), `${permission_mode}` resolvido no mcp_tool, aviso entendido pelo modelo, `CCB_RAW=1` devolveu a saída crua.
- [x] **C3 — só curar o que se repete**: o Stop cobra curadoria a partir da 2ª ocorrência da família; a 1ª fica pendente.
  **FEITO em 2026-10-02** (com o classificador da C1, `lib/curation-families.js`): três classes — exploração (git log/status/diff/show…, grep, sed, cat, ls, find, curl…; decisão do usuário: Token Guard quando instalado, senão moldador do boss — detecção pelos hooks PostToolUse em settings.json), inline (`node -e`, `python -c`, heredoc) e tarefa. Só tarefa é cobrada, e só a partir da 2ª ocorrência (métricas `curation.skipped`/`curation.pending`). Replay das 1.316 cobranças REAIS do Stop no projeto: 932 exploração + 60 inline + 279 1ª ocorrência = **1.271 evitadas (96,6%)**; restam 45 (tarefas recorrentes). Testes: unit do classificador e da detecção do Token Guard; hooks com exploração/inline/1ª ocorrência sem journal.
- [x] **C-achado — a curadoria adotava a HOME como raiz do projeto (achado e corrigido na hora)**: visto no stress real da C2b — uma pasta sem `shells.json` próprio nem marcador subia até `C:\Users\allan`, que tem um `~/.vscode/shells.json` perdido, e herdava a config/scripts de curadoria da home (e o `~/.claude/settings.json` passava por "settings do projeto"). `curation-paths._walkProjectRoot` agora para antes da home (mesma regra do project-id). Teste com home falsa; mutação: sem a correção a raiz virava a home. O `~/.vscode/shells.json` solto (só uma whitelist, `shells: []`) e a pasta vazia `~/.vscode/scripts` foram apagados em 2026-10-02 a pedido do usuário; o `boss-install-local.sh` local passou a ter o repo principal como padrão (o worktree antigo não existia mais).
- [x] **C2b — moldador de exploração sem Token Guard (feito, commit db88361)**: **provado no Claude Code real** — `cat` de 500 linhas chegou ao modelo como 80 linhas / 2.150 de 13.892 caracteres (−85%), com o arquivo completo indicado; o modelo leu só as linhas 450–452 dele.
- [x] **C4 — métricas reais** (feito: C4a/C4b/C4c abaixo; o "raw-after-curated" ficou coberto por `curation.uncovered` (variante sem script) + `curation.bypass` (CCB_RAW=1)): `curation.used` (execuções por script, tamanho da saída), `curation.redirected`, `curation.raw-after-curated`, economia estimada; métricas dos demais mecanismos não padrão (guards: dica/negação/redirecionamento; daemon: latência/expirados por hook).
  - [x] **C4a/C4b — eventos + endpoint (feito)**: `curation.used` (script, chars, sucesso), `sig` em `curation.flagged`/`curation.redirected`, `curation.pipe-denied`, `error-guard.denied`; `lib/curation-metrics.js` (`summarizeCuration`, puro) e `GET /api/metrics/curation?days&project&root`. Economia **exata** (moldador) separada da **estimada** (redirect: média bruta da assinatura − média da saída curada, só quando existe linha de base — sem linha de base conta em `withoutBaseline`, nada inventado); saída bruta que entrou no contexto aparece como **custo** (a visão antiga somava isso como "economia" — invertido); scripts nunca usados via `root`. Teste unitário + smoke HTTP isolado (HOME/CLAUDE_PLUGIN_DATA temporários, eventos reais via `metrics.record`): 200 com 7.500 estimados + 4.200 exatos, `neverUsed:[lint]`; `root` inválido → 400.
  - [x] **C4c — latência por hook no `/health` do daemon (feito)**: acumulador por processo em `lib/hook-tools.js` (o daemon cria um `hookTools` por sessão MCP), `calls/ok/degraded/expired/queued` + p50/p95/max das últimas 200 chamadas; módulo que não carrega aparece como `{unavailable}` e não impede o boot (5 testes do supervisor pegaram a 1ª versão, que derrubava o boot com pluginRoot falso — corrigido antes do commit). **Provado no Claude Code real** (sandbox): `curation_guard` 40 ms, `error_guard` 28 ms, prompt hooks 18 ms, `posttoolusebash` em fila, `stop` 412 ms.
  - [x] **C-achado — `isolated-smoke setup` reaproveitava o daemon do sandbox anterior (achado e corrigido na hora, ferramenta local)**: mesma versão + raiz antiga ainda no disco → o supervisor compartilha (regra G13) e o run testava o código velho (o `/health` vinha sem `hookLatency`). O `setup` agora para um daemon de `%TEMP%\ccb-iso-*` na porta do sandbox e recusa (FAIL) se a porta for de outro processo.
- [x] **C5 — painel "Curation & guards" no dashboard (feito)**: card de valor "Tokens saved by curation (exact + est.)" no lugar do invertido "Tokens of raw output curated away" (que somava `curation.flagged` — saída bruta que ENTROU no contexto); `value-summary.contextSaved` removido (único consumidor era esse card). Painel: economia exata (moldador) / estimada (redirect, com/sem linha de base) / custo (saída bruta) / redirects allow·ask; tabela por script (redirects, execuções, saída média em tokens, sucesso, variantes descobertas); não curados (exploração/inline/1ª ocorrência), bypass, guards; scripts nunca usados (campo "project folder", salvo no navegador) como candidatos a poda; latência por hook do daemon (p50/p95/max/expirados/degradados/fila) — daemon fora → mensagem visível. Validado: Edge headless sobre dashboard isolado (HOME/CLAUDE_PLUGIN_DATA temporários, eventos reais) com a latência vinda do daemon real do sandbox — números conferidos à mão (moldador 11.742 chars ≈ 2,9k tokens; redirects 32.100 ≈ 8k); porta morta → "brain daemon not reachable on port 1"; i18n-audit PASS (268/268).
- [x] **C6 — pipe sobre script curado: de negação para permitir + medir (achado pelo replay de ganho real; corrigido na hora)**: replay `replay-curation-gain.mjs` (usa o `planRedirect`/`planShaping`/`shape` reais sobre 4.170 chamadas Bash reais do projeto) contou **243 negações** do guard antigo: com a política nova 142 passariam, 2 seriam redirecionadas, e **99 continuariam negadas** pela regra "script curado com pipe" — a maior fricção restante (batida 2× nesta mesma sessão). Seguir essa negação = rodar de novo SEM o filtro → MAIS saída no contexto + uma volta perdida. Agora: permitido, sem texto (custa tokens), e medido como `curation.piped` por script (coluna "Piped" no painel = sinal de que a saída do script não serve → ajustar o script). Testes: hook (allow sem texto) + unitário (dispara só no pipe real; não no pipe de outro segmento nem na leitura do arquivo); mutação (negação de volta) → o unitário falha.
- [x] **C-achado — o detector cobrava curadoria de comando já moldado pelo boss (achado no stress real e corrigido na hora)**: no stress da C6 (Claude Code real, sandbox), o PostToolUse recebe o comando REESCRITO pelo moldador (`set -o pipefail; { cat big.txt; } 2>&1 | node …shape-output.js …`); o `set` virava TASK, a 2ª ocorrência pediu script, e o agente marcou `set pipefail && cat big.txt` como one-off (assinatura falsa também no oneoff store). `curation-redirect.unwrapShaped` (casa exatamente o formato do `planShaping`) e o detector julga o comando original. Testes: ida e volta `unwrapShaped(planShaping(x)) === x` + hook (moldado, recorrente e ruidoso → sem journal); mutação (sem o desembrulho) → o hook falha.
- [x] **C-achado — quatro testes de hook semeavam recorrência num caminho errado (achado e corrigido na hora)**: o literal JS era `'C:\fixture'`, em que `\f` é form feed — o caminho semeado não era o da fixture (`C:\fixture` com barra real); passavam porque a chave de projeto de dois caminhos inexistentes coincide. Corrigido para o literal com barra escapada (`'C:\\fixture'`), como nos testes C3.
- [x] **C — stress real da Fase C (sandbox, Claude Code real, HEAD 62acdd0+)**: `npm test` → redirecionado ao script (1 linha, 40 chars, contra 401 linhas cruas); `node tests.mjs | tail -1` → permitido (C6); `cat big.txt` (600 linhas) → moldado para 81 linhas / 4.237 chars; `npm test -- --reporter=dot .` → variante não coberta, rodou crua (404 linhas, 23,5k chars — medida como `uncovered`, política escolhida); `npm run lint` → redirecionado.
- [x] **C — ganho real medido (replay `replay-curation-gain.mjs` sobre 4.170 chamadas Bash reais do projeto + painel sobre os eventos do stress real)**: (1) **negações do guard antigo: 243 → 0** — 142 passam (variantes não são mais negadas), 2 viram redirect transparente, 99 eram "pipe em script curado" (C6, agora permitido e medido): cada uma era uma volta perdida; (2) **cobranças do Stop: 1.316 → 45** (C3, replay anterior: −96,6%); (3) **moldador** (só sem Token Guard): 25 de 497 comandos de exploração elegíveis cortados, ~30,5k tokens (2,9% de toda a saída Bash do histórico) — no stress real, `cat` de 600 linhas 59,8k → 7,8k chars; (4) **redirect por economia de saída: não mensurável neste histórico** — onde o redirect pegaria, o agente já limitava a saída sozinho (`| tail`, `> log; grep`) ou o guard antigo negava; o ganho do redirect aqui é a volta poupada, não caracteres. O painel mostra isso sem inventar (`withoutBaseline`). Leitura: o valor da Fase C está em tirar fricção (negações/cobranças) e limitar exploração sem Token Guard; scripts curados são muito usados diretamente (614 invocações).
- [x] **C-achado — métricas de uma sessão espalhadas em duas chaves de projeto (achado na validação real e corrigido na hora)**: após o `install-local` (907e0b1), o `curation.piped` de `cd .. && node …/test-hooks.mjs | tail -1` foi gravado sob `claude-code-boss` e o `curation.used` do mesmo comando sob `claude-code`: `metrics._resolveProject` preferia o `cwd` do evento (diretório atual do shell, que deriva com `cd`) à raiz da sessão. Agora: `ctx.project` → `CLAUDE_PROJECT_DIR` da chamada → `ctx.cwd` → `process.cwd()`. Teste O9 estendido (raiz vence cwd derivado; sem raiz → cwd como antes); mutação (ordem antiga) → O9 falha. Painel sem filtro já somava tudo; com filtro de projeto mostrava parte.
- [x] **C-achado — hooks servidos pelo daemon nunca receberam a raiz da sessão (achado na validação real e corrigido na hora)**: seguindo o achado anterior (métricas em duas chaves), uma sonda numa sessão real mostrou `project_dir: ""` em TODOS os hooks `mcp_tool`. Causa (binário 2.1.283, schema do hook): "String values support ${path} interpolation from the hook input JSON" — `${CLAUDE_PROJECT_DIR}` é variável de ambiente, não campo do input, e vira "". Efeito: no daemon, `CLAUDE_PROJECT_DIR` vazio → consumidores caíam no `cwd` (que deriva com `cd`) ou no `process.cwd()` do daemon (pasta da 1ª sessão). Correção: o SessionStart (hook `command`, onde a variável é real) grava `session_id → raiz` em `<dataDir>/.runtime/session-roots/` (`lib/session-root.js`, poda > 7 dias) e o `runHookInline` resolve pelo `session_id` quando `project_dir` vem vazio. Testes: ida e volta + poda; integração (`project_dir ""` → raiz gravada, vence o cwd derivado; `project_dir` real ainda vence; sessão desconhecida → sem raiz); mutação (sem o fallback) → falha. **Provado no Claude Code real** (sandbox, sonda): `project_dir ""` → `resolved` = raiz do projeto em todos os 6 hooks. Sessões abertas antes desta build seguem sem raiz até reiniciar (sem SessionStart novo).
- [x] **C-achado — saída de comando composto debitada do orçamento de um script curado (achado no Stop real e corrigido na hora)**: o Stop desta sessão pediu para "refinar" `.vscode/scripts/test-hooks.mjs` por 42 linhas que vinham de `test-units.mjs; test-hooks.mjs; eslint … | tail; release-audit …` — a saída de todas as partes. Agora um composto que contém um script curado registra a execução (`curation.used` com `compound: true`), mas não entra no orçamento do script nem na média de saída dele (o painel mostra "—" quando só há execuções compostas). Execução solo ruidosa continua pedindo refinamento. Testes: hook (composto → sem journal; solo → journal) + unitário (composto conta execução, fica fora da média); mutação → o hook falha. Os demais 44 itens daquele Stop eram exploração/inline gravados pelo daemon antigo antes da instalação (a C3 já não os cobra) — marcados one-off.
- [x] **C-achado — alias cru de um script curado era tratado como execução do script (achado no Stop real e corrigido na hora)**: o Stop pediu para "refinar" `.vscode/scripts/git-log-branch.mjs` por 102 linhas de um `git log --reverse … | cut` CRU — `git log` é alias desse script, exploração nunca é reescrita, e o detector julgava "curado" por casar o alias. Agora "curado" = o caminho do script é um token do comando (o script rodou); alias cru cai nas regras de classe/recorrência (exploração → não curada). Teste de hook + mutação (julgar por alias) → falha.
- [x] **C-achado — teste do graph-guard só passava por causa do `~/.vscode/shells.json` solto da máquina (achado ao apagá-lo; corrigido na hora)**: `graph-guard [Bash scoped grep -r subdir via curation-guard → allow]` usa um cwd em `%TEMP%` sem marcador; o runner troca a HOME por uma temporária, então a parada "antes da HOME" não atua na HOME real, a busca da raiz chegava a `C:\Users\allan`, o arquivo solto a tornava raiz e o Token Guard de `~/.claude/settings.json` era lido como "do projeto" — sem moldador, `allow`. Apagado o arquivo, o moldador entrou (`ask`, sem `permission_mode`). O teste agora é hermético: `permission_mode: bypassPermissions` e afirma só o que é dele (graph-guard não nega grep com escopo).
- [x] **Auditoria pré-release 3.0.0 (camada adversarial, `release-auditor`) — todos os achados reproduzidos e corrigidos na hora**:
  - **Moldador, exit 141:** `set -o pipefail` + pipe do próprio agente (`seq … | head -1` → 0 puro, 141 embrulhado) = falha falsa que alimentava o error-guard. Comando com pipe próprio nunca é embrulhado. Teste: recusa + exit real preservado (`cat` ok → 0, `cat nope` → 1).
  - **Moldador, sintaxe:** `ls -la #x` e `cat foo\` eram embrulhados → erro de shell. Recusados (`#` fora de aspas no início de palavra, `\` final). Teste com `#`/`|` entre aspas ainda embrulhados.
  - **Moldador, buffer até EOF:** `tail -f`/`less`/`watch` embrulhados; tudo em memória; morte por timeout perdia tudo. Follow/interativos recusados; `shape-output.js` em **streaming** (cabeça sai na hora, resto direto para o arquivo, teto 50 MB). Teste: cabeça visível ANTES do EOF + arquivo com a saída completa.
  - **Lane pesada travável:** job que nunca termina prendia o worker FIFO de todas as sessões. Reciclagem após 3 prazos seguidos sem nenhuma mensagem do worker (`stats().recycled`). Testes com worker real que pendura (recicla 1×, próximo hook roda no worker novo) e com prazos intercalados de progresso (não recicla).
  - **Postura de permissão (achado "low" que era sério):** `curation-guard`/`graph-guard`/dispatcher/`hook-tools` respondiam `allow` para TODO comando — `allow` de PreToolUse pula as permissões; fora de bypass tudo era aprovado sem prompt (desde a 1.x). Agora "nada a fazer" = `{}`; whitelist só isenta de `denyUnknown`; moldador só em `bypassPermissions` (em `ask` todo `cat`/`grep` passaria a pedir aprovação). 23 testes de hook reescritos para afirmar abstenção (`abstained(r)`) + teste do modo default.
  - **`invocationFor`:** caminho de script com `"`/`$`/crase ou fora da raiz do projeto → sem reescrita. Teste.
  - **SECURITY.md:** brain daemon descrito com porta efêmera + token; corrigido (38217 fixa, `/mcp` só origin guard) e documentado o risco aceito (squatter de outro usuário do SO).
  - **CHANGELOG:** "12 hooks" → 13 (os 12 da Fase G + `hook_policy_inject` do G6).
  - Mutação de cada correção (pipe, reciclagem, streaming, aspas no caminho, abstenção) → o teste correspondente falha.
  - **Provado no Claude Code real** (sandbox, HEAD 4dc36b4, saída do `hook_curation_guard` lida no transcript): `npm test` → `allow` + reescrita para o script; `cat big.txt` → `allow` + moldador (81 linhas); `cat big.txt | head -3` → `{}` (não embrulhado, 3 linhas, sem exit 141); `ls #listing` → `{}` (rodou normal); `echo plain` → `{}` (abstenção — nada de `allow` cego).
  - **Provado também em modo de permissão PADRÃO** (sandbox, HEAD ca7b297, `claude -p --permission-mode default`): `node noisy.js` → guard `{}` → o Claude Code pediu aprovação ("This command requires approval" — antes o `allow` cego o rodaria direto); `npm test` → guard `ask` + reescrita para `tests.mjs` (o pedido mostra a troca); `cat big.txt` → guard `{}` → liberado pelo próprio Claude Code como leitura, saída inteira (600 linhas), sem moldador (fora de bypass ele não age). A ferramenta local `isolated-smoke run … --mode <modo>` roda sem `--dangerously-skip-permissions`.
- [x] **Morte intermitente da suíte unitária — RESOLVIDA (causa achada)**: repro direcionado do teste G3 (daemon real → 3 consultas com timeout → `d.shutdown()`) em processo isolado: 1 em 10 morreu com **`0xC0000409`** (STATUS_STACK_BUFFER_OVERRUN, fast-fail nativo; o "exit 127" do Git Bash era esse código truncado) DENTRO do shutdown — o `terminate()` do embed worker no meio do init nativo do onnxruntime. Também afetava o daemon real (restart/troca de versão com o embedder carregando). Correção: `embed-worker-client.shutdown()` libera os chamadores na hora mas espera a operação em curso terminar (teto 30 s) antes do `terminate`. Teste com worker real lento (shutdown espera, op conclui, chamador liberado) e com worker que nunca responde (teto); mutação → falha. Repro após a correção: 40/40 limpos (dois lotes de 20, mesmo cenário).
- [x] **F3.0-1 — `/dashboard` sem LLM (pedido de clientes; feito)**: hook `UserPromptExpansion` (`dashboard-command.js`, command, matcher `dashboard`) + atalho no `user-prompt-submit-dispatcher` → `ensureDashboard()` (sonda HTTP real da porta publicada, sem processo duplicado) → abre o navegador → bloqueia com a URL. **Provado no Claude Code real** (sandbox, HEAD cc626e2): `/dashboard` e `/claude-code-boss:dashboard` → `turns=0`, `cost=$0`, 2,0 s (subindo) e 0,8 s (reaproveitando); com abertura de navegador → "(aberto no navegador)". Achados no caminho, corrigidos na hora: (a) o nome curto `/dashboard` a CLI não resolve como comando em `-p` (`unknown_command_fallback`) — o texto ia ao modelo (5 turnos) e a expansão nunca disparava → atendido também no UserPromptSubmit; (b) o starter passava `DASHBOARD_NO_OPEN='0'`, lido como "não abrir" — o navegador nunca abria; (c) o texto de reserva mandava ler `dashboard.json` num caminho que não vale em todo ambiente → usa o `{ok,url}` do starter; (d) a 1ª versão do teste real do starter podia deixar um dashboard órfão numa regressão de "sobe dois" → o `finally` mata também o PID do discovery da pasta temporária. Testes: unitários (decisão, matcher do hooks.json, prompt digitado, starter real sobe 1× e reaproveita) + hook (dispatcher com `/dashboard` → block + URL); mutações (não bloquear; ignorar o vivo; sem o atalho no dispatcher) → falham. Harness: `MSYS_NO_PATHCONV=1` obrigatório ao passar `/comando` pelo Git Bash (vira `C:/Program Files/Git/comando`).
- [x] **F3.0-2 — variante recorrente vira alias (EXTEND; feito)**: `curation-detect` usa o `planRedirect` para reconhecer, numa cobrança de tarefa recorrente e ruidosa, uma variante não coberta de um script existente → entrada `extendShell` (id, script, aliases atuais); `curation-stop` ganha a seção EXTEND (aceitar a variante + `curation_register_shell` com o mesmo id e aliases atuais + variante). **Provado no Claude Code real** (sandbox): sessão 1 — variante rodou 2× crua (404 linhas), Stop pediu EXTEND, o modelo estendeu `tests.mjs` (repassa args) e registrou `["npm test","npm test -- --reporter=dot"]`; sessão 2 — a variante foi redirecionada (1 linha). Achados no caminho, corrigidos na hora: (a) **cache do `shells.json` congelado no daemon** (chave só por raiz; regressão da Fase G — script/alias registrado no meio da sessão não redirecionava até reiniciar o daemon) → carimbo path+mtime+size; `invocationFor` aceita o campo legado `command`; (b) **`CCB_RAW=1` cobrado como falta de curadoria** e contado para o teto do one-off (o modelo ficou num beco: cobrança + one-off recusado) → execução crua pula journal e recorrência (o verify-journal ainda a vê); (c) **variante crua caía em REFINE** (`curatedScript` preenchido por casar alias) → só quando o script rodou. Testes: unitários (EXTEND ponta a ponta no processo; cache segue o arquivo; execução crua não conta) + mutações de cada um → falham; suítes 1351/0 e 135/0.
- [x] **F3.0-3 — filtro repetido vira ajuste do script (feito)**: `curation-guard.pipeFilterOf` extrai o filtro aplicado ao script (estágios depois do `|` no segmento que o roda, espaços normalizados); `lib/piped-store.js` conta por projeto/script/filtro (janela `oneHitWindowDays`) e devolve `ask` **uma única vez** por chave; `curation-detect` (só quando o script rodou e não é composto, nem subagente) gera REFINE "filtered Nx with `| filtro` — bake this filter into the script… asked once". **Provado no Claude Code real** (sandbox, script `report.mjs` de 20 linhas): sessão 1 — pedido, o modelo reduziu o sucesso a 1 linha (contrato OK/FAIL); sessão 2 — mesmo filtro 2×, nenhuma cobrança. Achado no caminho, corrigido na hora: a 1ª versão **zerava a contagem quando o script mudava** e voltava a pedir duas execuções depois — ruído puro (o filtro já não cortava nada e embuti-lo esconderia falhas; o PostToolUse só vê a saída depois do pipe, então "o filtro ainda corta?" não é mensurável) → pedir no máximo uma vez. Testes: unitário ponta a ponta (pede 1×; nunca de novo para o par, mesmo após mudar o script; outro filtro conta à parte; sem pipe não pede) + mutações (não marcar "pedido"; nunca pedir) → falham.
- [x] **F3.0-4 — poda de scripts nunca usados (feito)**: `metrics-store.getCurationUsageIsolated` (exato, sem teto de linhas: evento de curadoria mais antigo + ids que rodaram via used/redirected/piped; listado no `kb-worker-client`), `lib/shells-prune.js` (`pruneCandidates`/`pruneShells`), dashboard (`prune` no `GET /api/metrics/curation` com `root`; `POST /api/curation/prune`; botão com confirmação no painel) e tool MCP `curation_prune_unused` (lista por padrão; `apply` + ids). Salvaguardas: sem candidatos se o histórico não cobre a janela (métricas de uso só existem desde a 3.0 — risco de apagar tudo numa instalação recém-atualizada), nunca script mais novo que a janela, recusa de ids não candidatos, backup + JSON indentado, arquivo do script preservado. **Provado no Claude Code real** (sandbox com fixture de histórico de 40 dias): a tool listou só `report` (60d, nunca rodou), a poda removeu o registro, `tests` (usado) ficou, backup gravado, arquivo mantido; restaurado pelo backup; dashboard: GET listou o candidato, POST `tests` → 400 recusado, POST `report` → removido; painel renderizado (Edge headless) com "1 never ran in 30 days … Prune 1". Testes: unitários (histórico curto/ausente → nada; regras de idade/uso/arquivo ausente; aplicação com recusa, backup e formatação; consulta real ao store + tool MCP) + mutações das 3 salvaguardas → falham.
- [x] **Achado — o script da página do dashboard não compilava desde a C6 (achado na validação visual da poda; corrigido na hora)**: o `title` da coluna "Piped" tinha apóstrofos (`script's`, `doesn't`) dentro de uma string JS entre aspas simples → erro de sintaxe que parava o script inteiro da página → **nenhum painel carregava** (inclusive na instalação local 3.0.0). Os testes não pegavam (o i18n-audit só lê chaves). Corrigido (`&#39;`) + teste que compila todo `<script>` embutido do `index.html` (mutação reintroduzindo o apóstrofo → falha). Também: o link direto do painel é `?root=` (o hash seleciona a aba; `#root=` deixava a Home sem inicializar).
- [x] **F3.0-5 — resumo de valor no SessionStart (feito)**: `scripts/value-digest.js` (detector do `session-start-dispatcher`, timeout 5 s): projeto = basename da raiz da sessão; eventos `curation.*` dos últimos 7 dias do store de métricas do projeto → `summarizeCuration` → uma linha `[BOSS] Curadoria nos últimos 7 dias: … Maior gargalo: …`; gargalo por regras fixas (variantes recorrentes de um script ≥2, custo cru > economia com ≥2 comandos, script com <80% de sucesso em ≥3 execuções); 1×/24 h por projeto (carimbo no data dir); silencioso sem atividade, sem gastar o carimbo. **Provado no Claude Code real** (sandbox): após uma sessão com `npm test` redirecionado e `cat` moldado, a sessão seguinte recebeu a linha (~6.5k tokens economizados, 1 redirect, 1 execução); a terceira, no mesmo dia, não. Testes: unitários (formato e escolhas do gargalo; métricas reais → 1×/dia, dia seguinte de novo, projeto ocioso silencioso sem carimbo) + mutações (sem cooldown; carimbar sem atividade) → falham; teste do `DETECTORS` atualizado (13).
- [x] **F3.0-6 — alerta de hook lento (feito)**: `lib/hook-latency-alert.js` (`slowHooks` puro: expirado>0, ou p95 ≥ 50% do prazo do hooks.json com ≥10 chamadas medidas; fila/assíncronos fora; `alertOnce` 1×/hook/6 h por PID do daemon) + `brain-health` (SessionStart e UserPromptSubmit com throttle de 60 s) consultando o `/health` do daemon (`BRAIN_HTTP_PORT`, 700 ms) **só se o `pluginRoot` dele for o desta instalação** — semântica certa (daemon de outra instalação não é nosso) e hermeticidade dos testes (a suíte, com raiz no repo, nunca lê o daemon real). **Provado no Claude Code real** (sandbox; só a cópia do sandbox ganhou um atraso de 7,6 s no `curation-guard` para `SLOWME`): `/health` com `expired:1`, p95 7034 ms; a sessão seguinte abriu com o `[BRAIN-HEALTH] Hook(s) do daemon sem folga: curation_guard p95 7034ms (prazo 7000ms), 1 prazo(s) estourado(s)…`; a seguinte, não. Ajuste editorial visto no resultado: "Em 1+ chamadas" → "Medido em N chamada(s)". Testes: unitários (regras do slowHooks; alertOnce por PID/janela; integração com `/health` falso — outra instalação ignorada, esta alertada) + mutações (sem checagem de instalação; sem janela; sem limiar) → falham.
- [x] **Auditoria 2 (6 funcionalidades novas, código após c240d4a) — todos os achados verificados corrigidos na hora**:
  - **high — poda listava scripts em uso numa instalação vinda da 2.x**: o início do histórico era o `curation.*` mais antigo, e `curation.flagged` existe desde a 2.x → a trava de janela passava no dia do update (projeto real: 23 de 42 scripts listados como "nunca rodaram"). Agora só eventos da era de uso (used/redirected/piped/uncovered/skipped/pending/bypass/shaped). No mesmo projeto real (leitura): 0 candidatos, "insufficient history".
  - **medium — EXTEND resetava o script**: `curation_register_shell` reconstruía a entrada (orçamento/timeout/label/ícone voltavam ao padrão; `content` obrigatório até para só acrescentar alias) → upsert que preserva campos omitidos, `content` opcional num id existente (arquivo intocado, mas precisa existir), id novo ainda exige `content`; mensagem EXTEND e schema da tool atualizados.
  - **medium — `curation_prune_unused` sem `cwd` usava o `process.cwd()` do daemon** (pasta da 1ª sessão) → `cwd` obrigatório (validação + `required` no schema).
  - **low — subagente gastava o pedido único do piped→refine** → só um pedido entregável (`deliverable: !agent_id`) consome a vez.
  - **low — `/outro-plugin:dashboard` era sequestrado pelo atalho digitado** → só `/dashboard` e `/claude-code-boss:dashboard`.
  - **low — backups da poda ao lado do `shells.json`, sem limpeza** → diretório de dados do plugin, 5 mais recentes por projeto.
  - **plausível corrigido — o alerta de hook lento escondia os outros avisos do BRAIN-HEALTH** → somado, não substituto.
  - Testes: um por achado + mutações de cada correção (6/6 pegas). **Provado no Claude Code real** (sandbox HEAD 9846098): (a) `curation.flagged` de 40 dias + uso de hoje → tool lista 0 candidatos com o motivo; (b) EXTEND seguido pelo modelo manteve `label`/`outputLines:7`/`timeoutMs:99000`/`outputFilter` e somou o alias; (c) a sessão abriu com o alerta de hook sem folga **e** o aviso de rascunho pendente juntos.
- [x] **Plausível (auditoria 2) — chave de métricas × raiz da poda em projeto aninhado**: a poda lê `basename(raiz do shells.json)`; as métricas gravam em `basename(CLAUDE_PROJECT_DIR)`. Com `shells.json` numa subpasta da raiz da sessão, a poda leria um banco sem os eventos de uso → "histórico insuficiente" (falha segura: nada é podado, só deixa de sugerir). Não reproduzido. Proposta: resolver o projeto das métricas pela mesma regra do `_resolveProject` (raiz da sessão) e passar à poda.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): a tool passa à poda a chave de métricas da RAIZ DA SESSÃO (raiz da sessão MCP; stdio: `CLAUDE_PROJECT_DIR`) quando o `shells.json` está dentro dela; fora dela, `basename(raiz)` como antes. `pruneCandidates`/`pruneShells` aceitam `project`. Teste com `shells.json` em subpasta (lê o histórico da sessão) + raiz fora da sessão; 2 mutações pegas (código antigo; sem a guarda "fora da sessão").
- [x] **Achado (backlog zero, 2026-10-03) — o painel do dashboard tinha a mesma chave errada da poda**: `getCurationSummary`/`postCurationPrune` (`scripts/dashboard.js`) chamavam `pruneCandidates`/`pruneShells` sem `project` → `basename(pasta digitada)`; com `shells.json` numa subpasta do projeto da sessão, o painel lia um banco vazio ("histórico insuficiente"). Visto ao conferir os chamadores da correção anterior. **Corrigido na hora**: `metricsProjectFor(root, projetosComMétricas)` — a pasta mais próxima, subindo até o topo do repo (`.git`), cujo nome tem banco de métricas; nunca acima do repo. Teste + mutação (sem o limite do repo) pega.
- [x] **Achado (backlog zero, 2026-10-03) — `POST /api/plugin/update` sem trava** (`scripts/dashboard.js` `postPluginUpdate`): duplo clique ou duas abas rodavam dois `performUpdate` ao mesmo tempo — download/extração/`npm install` no mesmo destino e o `installed_plugins.json` reapontado em paralelo. Visto ao conferir o que o smoke antigo R3 cobria. **Corrigido na hora**: um update por vez (2º pedido → 409 "update already in progress"), liberado no `finally`. Teste com `performUpdate` controlável + mutação pega.
- [x] **Achado (backlog zero, 2026-10-03) — smokes locais (gitignored) desatualizados**: ao rodar todos para validar o token do `/mcp`, falhavam IGUAL no `develop` (pré-existente): fixtures sem project id (o gate estrito bloqueava todo Stop), contratos antigos (guard dava `allow` → hoje se abstém; C3: 1ª saída ruidosa de tarefa fica pendente; doctor: evento desconhecido é aviso), porta antiga (58217), arquivos removidos (`config/model-router.json`, `scripts/plugin-version.json`, CLI `scripts/plugin-updater.js`), endpoints removidos (`/api/models`, `/api/pipelines`), regex mais larga que a regra real, e dois smokes (`dashboard-logs`, `r7`) subiam o dashboard com HOME/dados REAIS. **Corrigido na hora**: `stop-dispatcher`, `curation-loop`, `self-review`, `doctor`, `brain-http-auth`, `audit-r7-schema`, `dashboard-logs`, `claude-code-dev-install-flow` atualizados (HOME/dados isolados onde sobem o dashboard); aposentados para `docs/plans/salvage/` os que testavam o que não existe mais ou é coberto com mais precisão (stdio boot/degraded-boot, r3 updater, r5b → regra ESLint `local/no-silent-return-catch`, version-sync → `sync-version --check` no gate, test-daemon-supervisor, dashboard-autostart). Resultado: 12/12 smokes verdes.
- [x] **Plausível (auditoria 2) — duas subidas simultâneas do dashboard**: duas sessões chamando `/dashboard` no mesmo instante sobem dois processos (porta 0); o último a gravar `dashboard.json` vence e o outro espera 8 s e responde "não respondeu", deixando um órfão. Janela pequena; padrão anterior à 3.0. Proposta: lock de arquivo (`O_EXCL`) no `ensureDashboard` durante a subida.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): `ensureDashboard` pega a trava `.runtime/dashboard.starting` (`O_EXCL`) antes de subir; quem perde espera o servidor do outro e responde `already-running` (ou diz que a outra subida não respondeu, sem criar um segundo); trava de dono morto ou mais velha que a tentativa é retomada; liberada no `finally`. Teste com o dashboard REAL: 2 chamadas simultâneas → 1 servidor, mesmo pid; trava viva sem servidor → espera e avisa; trava de dono morto → retomada; trava liberada. 3 mutações pegas (sem trava, sem retomada, sem liberar).
- [x] **Achado (2026-10-04) — `/dashboard` reaproveitava um painel de OUTRA instalação** (`scripts/dashboard-start.js` `liveDashboard`): a checagem era só "pid vivo + porta responde"; depois de uma atualização do plugin, o painel subido pela versão anterior continuava servindo o código antigo a todas as sessões (mesma classe da lição do Brain sobre daemon velho em cache endereçado por conteúdo). Visto ao responder se o dashboard é único por máquina — e importa nesta versão, que troca o visual. **Corrigido na hora**: o `dashboard.json` registra o `pluginRoot`; o `/dashboard` só reaproveita o painel da instalação atual — outro (ou um antigo, sem o campo) é encerrado e um novo sobe. Teste com o dashboard real (painel de "outra instalação" substituído, o atual reaproveitado) + mutação pega.
- [x] **Padrão (auditoria 2) — `curation_mark_oneoff` também cai no `process.cwd()` do daemon sem `cwd`**: menos grave (marca uso único no projeto errado, reversível), mas mesma classe da tool de poda. Proposta: exigir `cwd` ou resolver pelas `sessionRoots` como `resolveKbProject`.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): a varredura da classe achou mais 4 tools com o mesmo fallback, corrigidas junto (*achadas e corrigidas na hora*): `curation_register_shell` (gravava script/shells.json no projeto da 1ª sessão — o pior), graph tools sem `root` (analisavam a pasta errada), `policy_shadow_report` (chave de métricas errada) e `policy_adjudication_prepare` (varria o workspace errado); e o `oneoff.resolveProjectKey` trocava um `cwd` inexistente pelo `process.cwd()`. Helper único `callerCwd` no `mcp-server.js`: `cwd` passado → ele; stdio → `process.cwd()` (servidor por sessão); HTTP → raiz da sessão MCP (`roots/list`), senão recusa com "cwd is required". Graph: `cwd()` só é consultado sem `root`. Teste "shared daemon: tools acting on this project never fall back…" + 6 mutações (6/6 pegas).
- [x] **Achado (release 3.0.0) — release-guard deu DRIFT em vez de "pending" no push do release**: o guard data a versão pelo commit que fez o bump (`git log -S` no arquivo de versão), não pelo momento em que ela chegou ao `main` remoto. Com o fluxo `develop` → `main`, o bump é commitado horas antes do push e a janela de 45 min já passou → vermelho em todo release até a tag sair (visto no push de 3011bb0/a3aca32). Não bloqueia (some com a tag), mas é o "alarme que sempre dispara" que o AGENTS.md quer evitar. Proposta: datar pela entrada do commit de bump no `main` (ex.: `git log --first-parent main` + data do merge/ff, ou o horário do push via evento do workflow) em vez da data do commit.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): o guard casa o commit do bump com o PUSH que o trouxe para a main (API de atividade do repositório, `GET /repos/{o}/{r}/activity`, contrato conferido em docs.github.com; o workflow passa `GITHUB_TOKEN` com `contents: read`); `pushArrival` é pura e testada. Sem token (local) data pelo commit e diz isso na nota (só pode adiantar o alarme, nunca esconder). Replay real do push da 3.0.0 (atividade verdadeira da API, agora = push + 10 min, sem tag): antigo `untagged` (bump de 750 min), novo `pending` (10 min). AGENTS.md atualizado. Teste + mutação (sem checar o `before`) pega.
- [x] **Refatoração 3.0.1 — duplicações apontadas pelo smart-tool (verificadas contra o HEAD c240d4a; fora do escopo da 3.0.0 por ser refatoração pura)**: o índice do smart-tool estava na visão `release/2.29.1` e o projeto em erro ("Não foi possível listar uma pasta do escopo", desde ~2026-10-01) — achados do `error-store` (removido no O11) e do `tick` (já delega ao `session-counter`) estão obsoletos. Duplicação real restante: `main()` de CLI dos hooks (stdin → run → `additionalContext`) em ~9 scripts (curation-session, doctor-/policy-inject/project-identity-/tuning-advisory, brain-health, review-checklist-advisory, dispatchers) → helper único em `lib/hook-io.js`; família dos journals (`appendEntry`/`readEntries`/`clearEntries`/`sweepOld` em retrieval-/failure-/verify-/turn-journal) → um journal genérico; `load`/`save`/`list` de stores JSON (adjudication-store, revision-ledger, trigger-evidence-store, policy-store); `withTimeout` (2 dispatchers + retrieve-core); `writeJsonSafe` (decision-detect/-promote/-scan-response); `onCooldown` (doctor-/review-checklist-/tuning-advisory); `decision()` de PreToolUse (curation-/error-/graph-guard, + rf-reviewer); `deepMerge` (brain-config/hooks-config); `blobToVector`/`rowToEntry` (brain-store/consolidate-datadirs); `tokenMatches`/`ensureToken`/`readRouterToken` (dashboard-auth, daemon-common, model-router). Antes de começar: reindexar o projeto no smart-tool (sair do estado de erro) e rodar `duplicates` de novo na visão atual; pares de mesma forma intencional (getScriptsDir/getShellsConfigPath, embed/embedBatch, getCites/getCitedBy) → `duplicates_dismiss` com `intentional`.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`, `e062491`…`d3fd603`): smart-tool reindexado na view atual (estava preso em `release/2.29.1`) e `duplicates` rodado de novo: 10 grupos idênticos + 45 pares parecidos + 11 semânticos (≥0,90, calculados depois) → 0 + 0 + 0 depois do trabalho (correção: uma 1ª versão desta nota dizia "0 + 0" antes de o nível semântico terminar de calcular). Novos módulos compartilhados: `hook-io` (`runTextCli` — o comentário citava um `runTextCli` que não existia —, `sideEffectDispatch`, `preToolUseDecision`), `config-merge`, `cooldown-stamp`, `json-file` (+ `saveJson`), `settle-within`, `kb-row`, `token-compare`, `session-journal`, `json-list-store`, `file-hash`, `secret-file`, `http-health`, `mcp-registry`, `config-merge.loadLayered` (load em camadas do brain-config/hooks-config), um só `pidAlive` (5 cópias), um só contador de ocorrências (a medição shadow e a adjudicação não podem divergir) e o `asyncRoute` do dashboard. Mudanças de comportamento deliberadas (fail-loud): o stamp de cooldown e a persistência de segredo passaram a LOGAR falha em vez de engolir; o decode de linha da KB é o tolerante (coluna nula → fallback, tags → `[]`); o token do daemon é gravado no `dirname` do próprio arquivo (antes criava `dataDir` e gravava em `canonicalDataDir`). Testes novos por módulo; os testes de guarda (atomic-write, data-dir) passaram a aceitar as rotas compartilhadas e verificam que elas mesmas cumprem a regra (mutação pega). 26 pares restantes dispensados no smart-tool com motivo (`intentional`: mesma forma, contrato diferente — embed/embedBatch, getCites/getCitedBy, getScriptsDir/getShellsConfigPath, callers/references…; `false_positive`: wrappers de getters distintos e pares abaixo do corte 0,90; o `main` do `dashboard-command` ficou de fora de propósito: o caminho de erro dele precisa BLOQUEAR, um wrapper comum engoliria isso). Suítes verdes a cada commit; prova real (sandbox isolado, HEAD d3fd603): todos os hooks rodaram sem degradar, worker sem erro.
- [x] **Melhoria — token no `/mcp` do brain daemon**: o cliente MCP do Claude Code conecta numa URL estática; um header com token via `${VAR}` no `.mcp.json` fecharia o risco de squatter na 38217 (hoje aceito e documentado em `docs/SECURITY.md`). Verificar suporte do Claude Code a headers com interpolação de env no `.mcp.json` antes de implementar.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`, `273583e`): `${VAR}` não serve (o plugin não injeta env no Claude Code), mas a doc oficial (code.claude.com/docs/en/mcp) tem `headersHelper` — comando rodado antes de CADA conexão, com `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` substituídos. `scripts/mcp-headers.js` imprime `Authorization: Bearer <token do data dir>` e o `/mcp` passou a exigir o token (outro usuário do SO não lê/grava mais a KB nem aciona as tools de hook). `BRAIN_HTTP_TOKEN` fixado é sincronizado no arquivo (o Claude Code tira variáveis com TOKEN do env do helper). **Limite medido** (plugin-sonda no Claude Code 2.1.283): helper que falha (exit 1 ou JSON inválido) NÃO impede a conexão — o cliente conecta sem header —, então o squatter que ocupa a porta antes do daemon continua fora do alcance de qualquer config do cliente; documentado no SECURITY.md e no README do brain-server. Prova real (sandbox isolado, HEAD 273583e): hooks e tools funcionam via `/mcp` com o token; `curl` sem token → 401. Smoke local `brain-http-auth` atualizado (7/7). Testes: contrato do `/mcp` (sem/errado → 401, Origin estranha → 403, certo → sessão), helper (API + CLI + prazo), token fixado; 4 mutações pegas.
- [x] **Achado externo (Token Guard, projeto do usuário) — `blindRead` barra leitura de imagem por "tamanho sem faixa de linhas"**: visto na C5 ao ler um PNG de 67 KB (screenshot do painel); imagem não tem linhas, a sugestão "releia uma faixa" não se aplica. Proposta: isentar extensões de imagem (png/jpg/gif/webp) do `blindRead` ou aplicar um limite próprio de bytes. Contornado reduzindo o JPEG. **Repassado em 2026-10-08** à sessão do Token Guard (`lib/rules.cjs` `ruleBlindRead` só olha `st.size` vs `readBytesWithoutRange` 51200, sem considerar o tipo) para corrigir lá com teste. **Correção aplicada lá** (imagens isentas; `hasReadRange` passa a aceitar `pages` de PDF; 4 casos de teste), sem commit e não publicada — o daemon instalado ainda roda o código antigo. Fecha quando o Token Guard publicar.
  **FECHADO em 2026-10-09**: a correção ("liberar imagem raster e PDF lido com pages", commit `5426153` do Token Guard) saiu na tag
  **v2.6.0** do Token Guard. Nada pendente no boss.
- [x] **C-achado — hooks `mcp_tool` pulados em silêncio no boot a frio do daemon (fora do escopo da Fase C; decisão de arquitetura)**: visto no stress real da C4c. Com o daemon parado, a 1ª sessão: o `brain-daemon-ensure` sobe o daemon em ~0,8 s, mas a 1ª conexão MCP do cliente já falhou e ele espera o backoff (1 s, 2 s, 4 s…); nesse intervalo o Claude Code **pula** os hooks `mcp_tool` sem erro visível. Medido: run `-p` a frio — UserPromptSubmit (`correction_detect`, `active_research_detect`) sempre perdido; PreToolUse/PostToolUse perdidos num turno rápido (c4c: 0 de 1), presentes num turno lento (cold: 3 de 3); daemon quente, sessão nova → nada perdido (c4c2). Impacto: fail-open — avisos/curadoria/error-guard ausentes nos primeiros segundos após boot/update/reload; nada bloqueia indevidamente. Opções: (a) shim stdio no `.mcp.json` que garante o daemon e faz proxy (conecta na 1ª tentativa; muda o transporte); (b) aceitar e documentar a janela; (c) os hooks críticos (curation/error guard) voltarem a `command` com caminho rápido quando o daemon não responde. Recomendação: (b) para a major, (a) avaliado depois. Nota (binário 2.1.283): o cliente ESPERA um servidor em estado `pending` antes de pular um hook `mcp_tool` ("is waiting up to …ms … for MCP server to finish connecting"), exceto para um conjunto de eventos — a perda observada é a janela em que o servidor já falhou a 1ª conexão e aguarda o backoff.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`, `273583e`) — nenhuma das opções (a)(b)(c): o mesmo `headersHelper` do token. O Claude Code ESPERA o helper (até 10 s) antes de conectar, e o helper garante o daemon (`brain-daemon-ensure.run`, prazo 8 s; sai logo após imprimir) → a 1ª tentativa já encontra o daemon de pé, sem backoff. Medido no plugin-sonda: servidor parado → helper sobe e espera → 1ª requisição do cliente 13 ms depois do helper, zero tentativas falhas. **Prova real** (sandbox isolado, daemon PARADO antes de cada run, 3 de 3): `correction_detect` e `active_research_detect` (UserPromptSubmit — antes SEMPRE perdidos a frio) rodaram, além de `curation_guard`/`error_guard`/`stop_dispatcher`.
- [x] **C5 — dashboard** (feito: painel "Curation & guards", ver o item C5 detalhado acima): uso por script, redirecionamentos, scripts sem uso, economia; corrigir o rótulo invertido; limpeza de scripts sem uso.

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
- [x] **G9 — bench de aceite realista** (depende de G8): 6–8 sessões MCP, transcripts
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
- [x] **O12 — 39 pastas `_boss-backup-*` (2,4 GB) acumuladas em
  `~/.claude/plugins/data/`** (vistas em 2026-10-02, de 2026-07-18 a 2026-08-01).
  Parecem backups da consolidação de data-dirs sem poda. Verificar quem cria
  (`consolidate-datadirs`?), limitar retenção (ex.: últimos N / X dias) e oferecer
  limpeza no doctor/dashboard.
  **RESOLVIDO em 2026-10-02**: quem cria é o `consolidate-datadirs` (backup antes de cada fusão), sem poda. Agora, após uma consolidação 100% bem-sucedida, `pruneBackups` apaga só os backups com mais de 30 dias E fora dos 5 mais novos (relatório mostra `pruned`). Teste com dirs reais e mtimes. Nota: sem pastas irmãs a consolidar a poda não roda — os 39 dirs atuais da máquina do usuário (jul–ago) ficam até a próxima fusão ou limpeza manual autorizada.
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
- [x] **G11 — rajada de 60 `PreToolUse` simultâneos ainda com p95 ~220 ms.**
  (Após o G10: p95 103 ms, praticamente na meta de 100 ms.) Fica aberto só para
  confirmar no bench do ambiente real (máquina mais fraca); nada a otimizar antes
  dessa medição.
  120 chamadas MCP (2 guards irmãos × 60) serializadas na thread principal: o que
  sobra é ~1,6 ms de CPU do `curation_guard` + o overhead por requisição do SDK
  MCP/HTTP. Próximos passos: perfilar o `curation_guard` (shells.json / assinatura)
  e medir o custo fixo do SDK por chamada.
  **MEDIDO em 2026-10-02 (fechado)**: bench com transcript real de 90 MB, 8 sessões, rajada de 60 PreToolUse + 8 Stop. Todos os núcleos: rajada p95/máx 90/94 ms (meta < 100 ms atingida). Máquina fraca simulada (daemon preso a 1 núcleo, `BENCH_AFFINITY=1`): rajada p95/máx 134/141 ms, PreToolUse em regime p95 55 ms, Stop p95 719 ms, zero hooks expirados — longe do timeout de 8 s.

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
- [x] **O14 — 1ª sessão com o daemon parado: o MCP falha ao conectar
  (ECONNREFUSED) no início** e os hooks `mcp_tool` só passam a funcionar depois
  que o `brain-daemon-ensure` (UserPromptSubmit) sobe o daemon — os do 1º
  prompt podem ser perdidos (vistos: os efeitos da sessão apareceram, a janela
  inicial não foi medida). Medir na instalação real (1ª sessão após boot) e
  avaliar subir o daemon já no `SessionStart` ou no logon (como o token-guard).
  **MEDIDO em 2026-10-02 (G16)**: o cliente tem retentativas de conexão inicial (0,5/1,5/4 s) e depois reconecta; no experimento C a sessão fria passou de ECONNREFUSED a conectada sozinha; num `-p` de 1 turno, só o 1º turno fica sem MCP. O `SessionStart` já roda o `brain-daemon-ensure`. Sem ação adicional (logon/keeper recusados pelo usuário).
- [x] **O13 — RSS do daemon com backend local: ~533 MB parado** em sessão real
  (bench sem embedder: ~440 MB). Medir a divisão (embedder na thread principal,
  N slots do pool do KB, hook worker) antes de otimizar.
  **MEDIDO em 2026-10-02**: processo só com o embedder carregado = 594 MB; o modelo (~400 MB com onnxruntime) é a maior parte, em UMA cópia (o pool do KB não carrega o embedder — só store/index/graph/metrics). Com backend mcp-memory o modelo não carrega: daemon real ~203 MB. É o custo inerente da busca semântica local; mover de thread (G12) não muda a memória. Sem ação adicional.
- [x] **G12 — inferência do embedder na thread principal do daemon** a cada
  prompt (`brain_retrieve_context`, backend local): trava os guards durante a
  inferência. Medir o tempo por prompt; se relevante, mover para worker.
  **RESOLVIDO em 2026-10-02**: medido — cada embed bloqueava o laço 18–33 ms (prompt longo, máquina rápida; ollama usa execFileSync). Agora `embed-worker.js` + `embed-worker-client.js`: o daemon instala o worker como delegate do `brain-embedder` (`setDelegate`), sem mudar os pontos de chamada; falha/timeout → null (keyword) com log, worker morto é recriado; módulo ausente não impede o boot. Modelo real no worker: 384 dims, atraso máximo do laço 32,5 → 3,0 ms em 10 embeds longos. Testes: stub com 600 ms síncronos sem travar o laço, crash → null + respawn, roteamento do delegate.

### Validação na instalação REAL (install-local, 2026-10-02)

- [x] **G13 — upgrade não trocava o daemon (achado e corrigido na hora)**. Depois do
  `install-local` + `/reload-plugins`, a porta 38217 seguia com o daemon antigo
  (2.29.0, cache `44a9ff6e1264`), sem as tools `hook_*` que os hooks novos chamam.
  Causa: `daemon-supervisor.js` `ensureDaemon` compartilhava qualquer daemon cujo
  `pluginRoot` ainda existe no disco, e o Claude Code mantém a pasta da versão
  anterior no cache. Correção: uma instalação **estritamente mais nova** (semver do
  `package.json` contra o `version` do `/health`) troca o daemon; versão igual,
  mais velha ou ilegível continua compartilhando (nunca faz downgrade). Testes:
  dono mais velho com pasta presente → `started`; versão igual → compartilha sem
  sinal; dono mais novo → compartilha sem sinal.
- [x] **G14 — teste G7 tocava estado global (achado e corrigido na hora)**. O teste
  "dispatcher CLI exits on its own" rodava o `user-prompt-submit-dispatcher.js` real
  com o env herdado: o `brain-daemon-ensure` agia na porta real 38217 e o
  `model-router-ensure` no router/settings reais. Com o G13 isso apareceu: a suíte
  trocou o daemon real por um de teste (dataDir temporário). Visto por `/health`;
  rastreado instrumentando `ensureDaemon`. Correção: o teste roda com HOME/config
  temporários, `CCB_ISOLATED=1`, `BRAIN_HTTP_AUTOSTART=0` e porta inválida. Prova:
  units 1299/0 e hooks 117/0 sem nenhuma resolução da porta 38217 no trace.
- [x] **G15 — daemon de outra instalação é compartilhado mesmo servindo OUTRO
  dataDir**. `ensureDaemon` (`daemon-supervisor.js`, bloco "sharing daemon owned by
  another install") só olha `pluginRoot`/versão: se o dono serve um dataDir
  diferente do pedido, as sessões desta instalação gravam no KB do outro. Visto
  durante o G14 (daemon de teste com dataDir temporário foi "compartilhado").
  Proposta: compartilhar só quando o dataDir canônico coincide; senão tratar como
  conflito visível (erro com diagnóstico), sem derrubar o outro.
  **RESOLVIDO em 2026-10-02 (achado e corrigido na hora)**: com dataDir canônico
  diferente o `ensureDaemon` devolve `error` com o dono, os dois dataDirs e a saída
  (fechar a outra instalação ou outro `BRAIN_HTTP_PORT`); o `brain-daemon-ensure`
  mostra como aviso `[BRAIN]`. Teste: mesma versão + outro dataDir → `error`, sem
  sinal ao outro daemon. Units 1300/0.

- [x] **G16 — sessões não reconectam ao brain-server depois de update/reload** (resolvido: 404 + install-local + G13; risco residual aceito — ver nota).
  Relato do usuário: depois de atualizar/reload, o MCP nunca volta sozinho; precisa
  `/mcp` manual. Medido no Claude Code real 2.1.283 (sandbox isolado, A/B):
  daemon reiniciado (~2,5 s fora), sessão reapada e cold start com ECONNREFUSED →
  **reconecta sozinho**; daemon fora por 150 s → `failed` para sempre (60 s depois
  do daemon voltar, ainda `ECONNREFUSED`; hooks `mcp_tool` não religam). Causa no
  cliente (binário 2.1.283): `d9=5` tentativas, backoff `min(1000·2^(n−1),30000)` →
  janela de ~15 s, depois `Max reconnection attempts (5) reached, giving up`.
  Causa do nosso lado: o daemon pode ficar fora > 15 s — `.claude/scripts/install-local.mjs`
  `killStaleBrainServers` mata o daemon e ninguém sobe outro até o próximo prompt
  (premissa da era stdio: "o Claude Code relança o MCP"); crash/kill externo idem.
  Também: o daemon responde **400** a `mcp-session-id` desconhecido; a spec MCP
  2025-06-18 (Transports › Session Management, itens 3–4) exige **404**, que obriga
  o cliente a reinicializar.
  Decisão (usuário, 2026-10-02): sem processo residente (keeper/tarefa de logon);
  o ensure segue no SessionStart/UserPromptSubmit e cada caminho que derruba o daemon
  tem de subi-lo de novo dentro da janela. Feito: 404 para sessão desconhecida
  (`http-daemon.js`, teste com daemon real); `install-local` derruba o daemon de outra
  instalação e sobe o novo na hora (antes só matava). Risco residual aceito: crash do
  daemon com o usuário parado > 15 s deixa as sessões `failed` até `/mcp`.
- [x] **G17 — `ensureDaemon` devolve `error` mas deixa vivo o daemon recém-criado**
  quando ele resolve outro dataDir (`daemon-supervisor.js`, ramo "did not become OUR
  daemon"): o processo segue segurando a porta. Visto no harness isolado (start com
  HOME real → dataDir real na porta 38219; matei à mão). Proposta: encerrar o filho
  que nós mesmos criamos antes de devolver o erro.
  **RESOLVIDO em 2026-10-02 (achado e corrigido na hora)**: se o pid do `/health` é o
  do filho criado agora, ele é encerrado e o erro diz "stopped it". Teste com o
  daemon real (preload troca o `--plugin-data`): `error` + porta liberada.
- [x] **Teste "port blocked (listen EACCES)" era falso positivo (achado e corrigido
  na hora)**: no Windows, `NODE_OPTIONS --require "C:\..."` perde as barras e o preload
  nunca carregava; o teste passava porque a dica do netsh contém "EACCES". Agora o
  caminho vai com `/` e o teste exige `listen EACCES: permission denied` (a causa real).
- [x] **U14 — `brain_count` com `project` explícito responde "project is required in
  HTTP mode"**. Visto 9× nos experimentos do G16 (`project: "iso/smoke"` passado em
  todas). Verificar se o argumento se perde no schema/dispatch da tool.
  **RESOLVIDO em 2026-10-02**: mesma causa do item `owner/repo` (seção Brain/Retrieval): o `resolveProject` usava o sanitizador de nome de arquivo (`sanitizeProjectId`, que recusa `/`). Agora usa `sanitizeLogicalProjectId` (aceita `owner/repo`; recusa `..`, barra invertida, dois-pontos, segmento vazio/borda). Teste com o `dispatch` real em modo HTTP.
- [x] **O15 — sessão com o daemon fora no início levou 269 s para 9 turnos** (45 s de
  sleep pedido). Suspeita: hooks `mcp_tool` esperando o timeout enquanto o servidor
  está "connecting". Medir quanto cada hook espera nesse estado.
  **MEDIDO em 2026-10-02 — não é do plugin**: `duration_api_ms` 221 s de 268 s; a transcrição tem 11 `api_error` 401 ("Invalid proxy server token") do gateway de inferência herdado no env do sandbox, com o backoff do próprio Claude Code. Os hooks não respondem pelos buracos (todos os gaps > 8 s antecedem retentativas de API).

- [x] **G18 — Stop de uma sessão mostrava commits de OUTRA sessão (relato do usuário;
  achado e corrigido na hora)**. `decision-detect`/`decision-scan-response` gravavam em
  `.runtime/decision-pending.json` (um arquivo para o daemon inteiro) sem dono, e o
  `decision-promote` do Stop de qualquer sessão exibia e esvaziava tudo. Correção: cada
  entrada leva `sessionId`; o Stop só exibe as da própria sessão, mantém as das outras
  (expiram em 24 h) e descarta as legadas sem dono; teto 10 → 50. Mesma classe: a
  cadência "a cada N Stops" de `pattern-detect`/`refine-research` era um contador global
  (os Stops de uma sessão disparavam o lembrete em outra) → `lib/session-counter.js`
  (por sessão, TTL 24 h, teto 200). Varredura dos outros estados em `.runtime`: os
  demais já são por sessão ou são throttles da máquina (doctor/tuning/consolidate).
  Testes: hooks com duas sessões no mesmo data dir (a outra não vê nem consome; a dona
  vê e consome), cadência por sessão, unit do `session-counter`. Units 1303/0, hooks 120/0.

- [x] **G19 — `curation-guard` negava LER um script curado com pipe (achado e corrigido na hora)**.
  `grep -n … .vscode/scripts/test-hooks.mjs | head` foi negado como "curated script invoked with a
  pipe": `pipesCuratedScript` contava o caminho em qualquer posição do 1º trecho do pipe. Agora
  só conta como programa (1º token, ou argumento de um interpretador — node/bash/python/pwsh…,
  exceto `--check`/`-c`). Testes: grep do script + pipe → allow; `node --no-warnings script | tail` → deny;
  `powershell … -File script | tail` segue deny.

- [x] **Limpeza dos backups antigos (autorizada pelo usuário em 2026-10-02)**: `pruneBackups` aplicado em `~/.claude/plugins/data`: 34 dirs (jul) apagados, 5 mais novos mantidos; 2,38 GB → 133 MB.

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
- [x] **U3 — script curado proíbe pipe e trunca a saída ("--full to see")**,
  forçando nova execução. E a detecção de pipe olha o comando INTEIRO, não o
  segmento: `… test-hooks.mjs && node release-audit.mjs check | tail -2` foi
  bloqueado como "script curado com pipe" — o pipe era do `release-audit`.
  **Parte do bug RESOLVIDA em 2026-10-02**: `pipesCuratedScript` só nega quando o
  pipe está no MESMO segmento, à direita da chamada do script curado. Teste em
  `test-hooks.js` (falha no código antigo, passa no novo). **Aberto (decisão de
  desenho)**: a política "script curado nunca com pipe" + saída truncada continua
  — o atrito de rodar de novo com `--full` é do contrato da curadoria.
  **RESOLVIDO na 3.0** (verificado em 2026-10-03 no inventário do backlog zero; estava marcado `[~]` por esquecimento): a decisão de desenho foi tomada na Fase C — `62acdd0` (C4/C6): rodar o script curado COM pipe é permitido (sem negar, sem round-trip); o pipe vira a métrica `curation.piped` por script e o piped→refine pede UMA vez para ajustar o script, em vez de bloquear o agente. Replay no histórico real: 99 das 243 negações do guard antigo eram esta regra. Testes: `test-units` "C4 curation-guard: a pipe on the curated script is ALLOWED and measured" e `test-hooks` "curated-script+pipe→abstain".
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
- [x] ~~U4 — assinatura de uso único genérica demais~~ (`ls lib` de um comando
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
- [x] ~~U5 — comandos de subagente entram na curadoria do `Stop` do pai~~ (o `find`
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
- [x] **U7 — recall injeta lição de outro projeto/irrelevante** ("Memory convergence…
  hermes… develop 92 commits" numa sessão do claude-code).
  **Investigado em 2026-10-02**: parte do ruído vinha de recall sobre
  `<task-notification>` (resolvido no U6). A lição "hermes" NÃO aparece no
  `brain_search` do projeto (`scope: both`) — logo não vem do KB do projeto: veio
  do caminho do `brain_retrieve_context`, que em `mcp-memory` chama o
  `compose_recall` do servidor externo (blocos de escopo global/ancestral). A
  causa está no lado do servidor (`native-java`), fora deste plugin. Próximo
  passo: capturar o trace do `compose_recall` (bloco/escopo/score da entrada) no
  teste em ambiente real e abrir o achado no projeto do servidor.
  **2026-10-02 — evidência para o servidor (o usuário corrige lá)**: o schema real do `compose_recall` aceita só `query`/`setup`/`includeLifecycleState`/`metadata`; os blocos home (`procedural`, `skill_global`) vêm "ALWAYS present" e o `metadata` "NEVER" os filtra — o cliente não controla relevância do home. Amostra real (pergunta sobre o daemon de hooks): home trouxe "Memory consolidation completed with 3119 documents" (0,672), "The directory is now empty" (0,649/0,606), "IPv6 monitor" (0,617) — lixo na MESMA faixa de score das relevantes, então piso de score no cliente não discrimina. Pedido do usuário: corte por qualidade/relevância no home no servidor (o home é a "skill global" para todas as IDEs). Itens de `compose_recall` abaixo (custo por bloco, FTS por tamanho, post-filter de escopo, blocos sem docs do boss, Dreaming) são todos do servidor.
  **2026-10-08 — repassado** à sessão do native-java (evidência + mitigações do boss + pedido de corte por qualidade no home). Fecha quando o servidor publicar.
  **2026-10-08 — servidor corrigiu**: espaços com `project_id` começando com `__` (exceto `__user__`) saem da leitura padrão e só voltam com `metadata.project_id` explícito. Verificado no boss (varredura exata dos arquivos versionados): nenhum fluxo cita `__lessons__`/`__quarentena__`, e o braço de projeto já filtra `project_id IN (foco, ancestrais, __user__)` — sem ajuste necessário. Fecha quando a versão do servidor for publicada e o ruído sumir no uso real.
  **FECHADO em 2026-10-09**: correção do servidor ativa e conferida AO VIVO (mcp-memory 2.46.1): buscas padrão pelas frases do ruído
  original ("memory consolidation completed", "directory is now empty"…) = 60 hits, **0** vindos dos espaços internos `__*`.
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
- [x] **F1 — (feature, resgatada da `dev`) `execution-guard-detect`.** **ARQUIVADO em 2026-10-02** após reavaliação (0,06% dos turnos com modelos atuais; regra no AGENTS.md custa menos que um hook em todo Stop; detector resgatado não funcionaria no Claude Code).
  **Decisão do dono (2026-10-02)**: ENTRA na nova major, mas precisa ser melhor
  desenhada antes (ainda está crua) — não analisar agora. Quando for: redesenhar,
  reaplicar sobre o HEAD (o `stop-dispatcher` mudou), testes, fila pesada do daemon.
  Os patches seguem em `docs/plans/salvage/` (local) caso precise consultar.
  **Análise em 2026-10-02**: o detector resgatado não funciona no Claude Code — lê `event.history`/`event.tool_calls`, que o Stop não envia (só `transcript_path`), e escreve `console.log` no stdout (corrompe o protocolo do hook); padrões frouxos ("a solução consiste em"). Replay (`.claude/scripts/replay-execution-guard.mjs`, local) nas 115 transcrições mais recentes, 3.124 turnos: heurística ingênua 14 disparos (quase todos adiamentos legítimos: "vou aplicar quando o tester terminar"); refinada (frase da promessa entre as 2 últimas, sem adiamento/pergunta, sem escrita no turno) 2 disparos (0,06%), 1 inércia clara. Fenômeno raro e regex frágil → decisão de produto pendente com o usuário (bloquear vs. só avisar vs. não incluir).
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
- [x] ~~O7 — `kb-worker.js:14-17` afirma "uma mensagem por vez", mas o handler é~~
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

## Queda do brain-server de 05/10/2026 (branch `fix/curadoria-redirect-args`)

Visto pelo usuário: depois de reiniciar a máquina, as sessões ficaram sem o boss.
Linha do tempo pelos logs MCP do Claude Code: às 09:00:18 uma pasta nova de cache foi
criada e às 09:00:19 o daemon morreu; o registro foi reescrito sem backup às 09:00:37;
as sessões desistiram às 09:00:35 (5 tentativas em ~16 s); o daemon voltou às 09:00:42.
Além disso, todas as sessões perdiam o stream SSE a cada ~6 min.

- [x] **Q1 — stream SSE ocioso caía a cada ~6 min** (`servers/brain-server/lib/http-daemon.js`).
  O cliente do Claude Code 2.1.283 corta um GET SSE ocioso em ~6 min e, depois de 3 cortes,
  fecha o transporte. **Achado e corrigido na hora**: comentário `: keepalive` a cada 30 s
  no GET aberto. Teste com daemon real + mutação; prova no Claude Code real (sandbox): 447 s
  conectado, zero `SSE stream disconnected`.
- [x] **Q2 — `scripts/install-local.js` derrubava o daemon de todas as sessões.** Fazia
  `rmSync` da pasta de cache (de onde o daemon rodava), sem backup do registro e sem subir o
  daemon de novo. **Achado e corrigido na hora**: nunca apaga pasta existente (usa
  `<sha>-<sufixo>`), faz backup de `installed_plugins.json` e passa o daemon para a
  instalação nova (para o antigo, roda `brain-daemon-ensure`, confere `/health`). Teste
  unitário + e2e com HOME isolado rodado 2×: pasta nova, antiga preservada, 2 backups,
  daemon da instalação nova.
  Na 1ª instalação real (05/10) o daemon novo subiu em 3 s, mas a verificação final (uma consulta
  de 2 s, com todas as sessões reconectando) acusou "no answer". **Corrigido na hora**: espera até
  15 s e leva o stderr do ensure no erro. Reinstalação real: OK, sessões reconectaram em ~8 s.
  O script de dev do `/release` (`.claude/scripts/install-local.mjs`, local) tinha o mesmo `rmSync` e
  aceitava o `{}` do ensure sem conferir o daemon. **Corrigido na hora**: reusa o `chooseTarget` do
  instalador do plugin e confere `/health`. E2e isolado 2×: OK; daemon real intocado.
- [x] **Q3 — primeiro `ensure` numa instalação nova não subia o daemon**
  (`servers/brain-server/lib/daemon-supervisor.js` `acquireSpawnLock`). Sem a pasta de
  dados, o `mkdir` da trava falhava com ENOENT, era lido como "trava ocupada" e, após
  9 s, culpava "another process holds the spawn lock". Visto no e2e do Q2. **Achado e
  corrigido na hora**: cria a pasta de dados antes; erro de I/O real agora sobe com a causa.
  Teste + mutação.
- [x] **Q4 — mesma versão compartilha o daemon, então uma instalação de dev nova continua
  servida pelo código antigo** (`ensureDaemon`: só troca com versão estritamente maior).
  Mitigado pelo Q2 (o `install-local` passa o daemon explicitamente); no marketplace toda
  atualização muda a versão. Sem mudança de regra.
- [x] **Q5 — arquivos de runtime e de planejamento versionados por engano.** 39 dumps
  `.token-guard/results/*.txt` (14 em `claude-code-boss/`, 25 na raiz) e `docs/PLAN-route-manager.md`
  entraram em 2e145694 (15/09); as regras do `.gitignore` vieram depois (818980f4, 26/09), e regra
  nova não tira do índice o que já foi commitado. Visto ao limpar a pasta durante o Q2.
  **RESOLVIDO em 05/10** (pedido do usuário): `git rm --cached` nos 40 (cópias locais mantidas);
  `.runtime/` e `coverage/` passam a valer para qualquer plugin; novo check `no-tracked-ignored` no
  `release-audit` (CI) bloqueia a recorrência. Prova: o check reprovou os 40 antes e passou depois.
- [x] **Q6 — avaliação de ciclo de vida (pedido do usuário, 05/10): reboot, queda, atualização.**
  Provado em Claude Code real, sandbox isolado, HEAD 60dd520: (1) queda de energia — daemon morto
  com `taskkill /F`, trava velha no disco → sessão nova sobe o daemon e usa o brain; (2) daemon
  morto NO MEIO da sessão → o `headersHelper` roda na 1ª tentativa de reconexão, religa o daemon
  em 0,4 s, sessão volta sozinha (a instalação das 09:00 não tinha `headersHelper`: por isso
  morreu); (3) atualização 3.0.0 → 3.0.1 com sessão aberta → daemon trocado, sessão antiga segue;
  (4) porta ocupada por outro programa → o agente explica ao usuário em linguagem simples.
- [x] **Q7 — sessão abandonada pelo cliente não avisava ninguém.** Depois de 5 tentativas (~16 s)
  o Claude Code desiste e a sessão fica sem brain_* mesmo com o daemon de volta. **Corrigido na
  hora**: `scripts/lib/mcp-link.js` lê o log MCP do próprio Claude Code (sessionId) e o hook do
  prompt avisa usuário e agente (`/mcp` → Reconnect). Teste + mutação; provado com log real de
  sessão abandonada (microclaw) e silêncio para sessão reconectada (cerne).
- [x] **Q8 — orientação de recuperação apontava script de dev.** O aviso do `brain-health` mandava
  o agente rodar `.vscode/scripts/install-local.mjs` (inexistente no usuário). **Corrigido na
  hora**: o setup automático também cobre deps do brain-server faltando, com lock (uma instalação
  por vez), e o aviso diz ao agente o que dizer ao usuário (reinstalar via /plugin se persistir).
  Teste + 2 mutações.
- [x] **Q9 — instalação limpa pelo marketplace mostrava "1 userConfig option not yet set".**
  Visto na instalação isolada (`claude plugin install`). `language` era `required` com padrão e o
  código não lê a opção. `required: false` não bastou (o aviso segue para opção sem valor):
  **corrigido removendo o `userConfig`**; reinstalação limpa sem o aviso.
- [x] **Q10 — `scripts/install-local.js` público.** Ferramenta de dev no plugin e no README.
  **Removido** (dev usa `.claude/scripts/install-local.mjs`, local; docs públicas → `--plugin-dir`).
- [x] **Q11 — auto-update desligado para o nosso marketplace (padrão do Claude Code para
  terceiros).** Fonte: code.claude.com/docs/en/plugins/loading ("When auto-update runs"), acesso
  05/10/2026. Sem ligar, o usuário nunca recebe versão nova. Decisão do dono pendente: o plugin
  liga sozinho (`autoUpdate` em `known_marketplaces.json`) ou só orienta.
  **RESOLVIDO em 05/10** (decisão do dono: ligado por padrão, avisando): `lib/marketplace-autoupdate.js`
  liga uma vez (known_marketplaces + entrada declarada em settings), respeita escolha explícita, avisa
  no prompt seguinte. Teste cobre ligar, uma vez, escolha explícita, arquivo ilegível intocado.
- [x] **Q12 — pasta sem project id = memória desligada + aviso a cada turno.** Visto na instalação
  limpa: numa pasta comum o usuário não-dev recebe pergunta sobre "project id owner/repo". Decisão
  do dono pendente (regra de 2026-10-02).
  **RESOLVIDO em 05/10** (decisão do dono): a memória segue desligada sem id, mas o agente
  examina a pasta, lista os projetos (`project_list`), pergunta "novo ou continuação?" e grava com
  `project_set` (nome repetido exige `link:true`). Git remote segue automático. Provado em Claude
  Code real: pasta nova com o código do `loja-online` → agente sugeriu, usuário confirmou, pasta
  vinculada e a memória antiga ("checkout usa Stripe") lembrada.
- [x] **Q13 — onboarding do servidor de memória (pedido do dono, 05/10).** Só o dashboard
  instalava, e o wizard estava quebrado: `--transport http` desliga o modo daemon desde a 2.43
  (sem `daemon.json`), timeout de 15 s menor que o 1º download do modelo (~430 MB), Java recém-
  instalado fora do PATH não era achado, transport ficava `stdio`, "completed" antes de gravar o
  backend, `projectId` do dashboard sempre `default`. **Corrigido** + tools `backend_status` /
  `backend_setup` / `backend_setup_status` + aviso de SessionStart. Provado em Claude Code real
  (sandbox com Java confinado por `-Duser.home`): o agente ativou e `graph_status` respondeu.
- [x] **Q14 — config do brain em cache eterno no daemon.** Achado na prova do Q13 (o daemon
  ignorou um `javaArgs` salvo por fora). **Corrigido**: cache válido enquanto o mtime/tamanho do
  `user-config.json` não mudar. Teste + mutação.
- [x] **Q15 — backup/restore no dashboard (pedido do dono, 05/10).** `lib/backup.js` (snapshot
  `VACUUM INTO`, sem modelos/.runtime/segredos), rotas + card na aba Brain, contrato remoto
  `docs/BACKUP-CONTRACT.md` (`backup_export`/`backup_import` no native-java). Testes: ida e volta
  com WAL aberto (mutação: cópia crua perde a linha), e2e com 2 dashboards reais, adaptador
  remoto. Prova com os dados reais: 495 itens, 2,2 MB, sem segredos, remoto "não incluído".
- [x] **Q16 — native-java: o auto-update no boot relança o servidor SEM os argumentos da JVM**
  (perde `-Xmx512m` e qualquer `-D`). Visto na prova do Q13 (2.44.3 → 2.45.0). Externo (repo
  native-java): repassar os args da JVM no relaunch.
- [x] **Q17 — native-java: `backup_export` / `backup_import`** conforme `docs/BACKUP-CONTRACT.md`
  (o dono faz). Ao sair, o backup do dashboard passa a incluir os dados do servidor sozinho.
- [x] **Q18 — `pages/claude-code-boss/tech.html` desatualizada:** lista `graph_reindex` e
  `graph_tag_node` (não existem) e diz que as graph tools são "Independentes do KB local" (exigem
  mcp-memory). Fora do escopo (só o agente `vitrine` escreve em `pages/`). Visto no levantamento.
  **RESOLVIDO em 05/10** (dono pediu; fluxo do vitrine): tools inexistentes removidas, graph = backend
  mcp-memory, backends local × mcp-memory explicados, identidade de projeto atual; landing ganhou a seção
  "Quando quiser ir além". Render desktop+mobile, Dark+Light: sem overflow, sem erro de JS.
- [x] **Q19 — resolver de release duplicado em `scripts/mcp-client.js:337-350`** (sem detecção de
  GPU) ao lado de `lib/mcp-release-resolver.js`. Fora do escopo: remover e usar o resolver único.

  **RESOLVIDO em 05/10**: `_resolveLatestUrl` delega a `lib/mcp-release-resolver.js` (GPU + `.sha256`
  publicado aplicado no download). Teste com resolvedor injetado: URL e GPU repassados, checksum
  divergente apaga o jar.
- [x] **Q20 — coletor de sessões ociosas derrubava sessão conectada** (`http-daemon.js`, reaper de
  30 min). Visto pelo dono na tela: "UserPromptSubmit hook error / Connection closed" ×3 no prompt.
  Log MCP: 31,9 min após conectar o stream SSE caiu com "Not Found" (sessão coletada — o keepalive não
  conta como atividade), o cliente desistiu do stream e o próximo POST dos hooks `mcp_tool` levou
  "Session not found". **Corrigido na hora**: sessão com stream aberto nunca é coletada; ao fechar, o
  relógio de ociosidade recomeça. Teste com daemon real + mutação (reproduz o 404).
- [x] **Q21 — branch redundante `fix/curadoria-args-hotfix` (outra sessão) removida a pedido do dono.**
  Os 2 commits únicos (f6e04da = mesma correção de 1f7a4d1, código idêntico, só o cabeçalho do
  CHANGELOG difere; 37c3fcb = bump 3.0.1, já feito aqui) e o `package-lock.json` sujo do worktree
  (+1 linha) salvos em `docs/plans/salvage/fix-curadoria-args-hotfix-20261005/`. Worktree removido.
- [x] **Q22 — teste só-Windows quebrou o CI Linux no PR #68:** "mcp-memory backend: scope routes to
  __user__" usava o `cwd` temporário como "caminho de usuário" (no Windows o Temp fica no HOME; no Linux é
  `/tmp`, que o sanitizador corretamente não toca). Entrou em 54dfc76, depois da v3.0.0 — nunca tinha rodado no
  CI. **Corrigido**: o teste usa caminhos de usuário explícitos (`/home/alice`, `C:Usersalice`).
- [x] **Q23 — `brain-status` com projeto errado e vazando `CCB_PROJECT_ID`.** Visto no smoke do `/release`
  3.0.1 (sessão real): a skill mostrou `project: default` enquanto o `brain_search` resolvia o id do repo.
  Usava `basename(cwd)`/`default` (regra anterior à 2.29.1) e o `run()` — que roda DENTRO do dispatcher do
  prompt — gravava `process.env.CCB_PROJECT_ID`, o 1º degrau do resolvedor, para os outros detectores do
  mesmo processo. **Corrigido na hora**: resolvedor estrito, projeto passado ao `probeHealth`, env intocado;
  sem id → "memory is off in this folder". Teste + mutação.
- [x] **Q24 — model-router × gateway próprio do usuário.** Visto no smoke do `/release` 3.0.1: nesta máquina
  as sessões usam `ANTHROPIC_BASE_URL=http://100.124.248.83` (token `local-…`) forçado pelo launcher; o
  `model-router-ensure` grava `env.ANTHROPIC_BASE_URL=127.0.0.1:13456` no `settings.json` e o router, sem
  upstream configurado, repassa para `api.anthropic.com` → um `claude -p` de terminal (que aplica o
  settings) leva **401 Invalid bearer token**. Não é regressão (o router antigo fazia o mesmo; os smokes
  anteriores usavam config isolada). Proposta: ao ativar, se o `ANTHROPIC_BASE_URL` do processo já aponta
  para um gateway que não é o router, adotá-lo como upstream (`upstream.baseUrl`) ou não sequestrar.
  **Resolvido em 2026-10-08** (aprovado pelo dono: não sequestrar): `model-router-ensure` detecta o gateway da
  sessão (`sessionGateway`: `ANTHROPIC_BASE_URL` do processo que não é o proxy nem `https://api.anthropic.com`,
  que o Desktop força), grava `model-router/gateway-defer.json` e sai pelo caminho do modo off (settings.json e
  url.txt limpos — o shim, sem url.txt, mantém o env como veio). Persistente: uma sessão sem o env do launcher não
  religa; o "Salvar & aplicar" (`BOSS_ROUTER_FORCE_RESTART=1`) reavalia. `upstream.enabled` = escolha explícita →
  não adia. Achado junto: o shim (`servers/model-router/wrapper.cs:111`) troca QUALQUER `ANTHROPIC_BASE_URL` pela do
  url.txt — coberto pela remoção do url.txt no adiamento. Testes: `sessionGateway` + `run()` hermético (limpa,
  persiste sem o env); mutação (adiamento desligado) reprova.
- [x] **Q25 — 1 falha intermitente numa rodada completa do gate (05/10, durante o `/release` 3.0.1).** A
  saída foi cortada (`tail`) e o nome do teste se perdeu. Não reproduziu em 2 rodadas completas do gate
  nem em 35 rodadas isoladas dos testes novos sensíveis a tempo (reaper, keepalive, backup e2e,
  brain-status, mcp-link, setup self-heal, wizard spawn). Próxima ocorrência: guardar o log inteiro e
  registrar o nome do teste aqui antes de rodar de novo.
  **Fechado em 2026-10-08 como não reproduzido** (aprovado pelo dono): ~20 rodadas completas do gate em 08/10 sem
  nenhuma falha intermitente. Se voltar: log inteiro + nome do teste num item novo.
- [x] **Q26 — sessão de versão antiga ressuscitava o daemon com código antigo.** Visto no smoke do
  `/release` 3.0.1: depois de instalar fb0d90d o daemon rodava de 4ac5858 (3.0.0) — sessões abertas
  antes mantêm o pluginRoot antigo e, com o daemon fora por um instante, o `headersHelper`/hook delas
  subia o daemon da própria pasta. **Corrigido na hora**: no caminho "nenhum daemon", o supervisor sobe
  a versão mais nova instalada na mesma pasta de cache (ignora `.orphaned_at`; versão igual = a própria).
  Teste + mutação; os 24 testes do supervisor passam.
- [x] **Q27 — native-java 2.45.1 travou no relançamento do auto-update** (processo vivo sem porta,
  `daemon.json` apontando para o pid morto da 2.44.3). Visto no smoke do `/release` 3.0.1. Externo
  (repo native-java), provavelmente o mesmo caminho do Q16. O boss reporta corretamente "instalado mas
  não rodando".
- [x] **Q16/Q17/Q27 resolvidos no native-java** (commit b7a5422, servidor 2.45.4): relaunch com os args da
  JVM, `backup_export`/`backup_import` exatamente no contrato `docs/BACKUP-CONTRACT.md` (conferido no
  `BackupHandler`: mesmos campos e erros; exige caminhos absolutos e destino inexistente — o adaptador já usa),
  boot com rastro. O backup do dashboard passa a incluir os dados do servidor sem mudança no plugin.
- [x] **Q28 — migração para o inicializador oficial (contrato `daemon-launcher-contract.md`, ADR-023).**
  Nenhum caminho do plugin sobe o jar: `lib/mcp-launcher.js` (roda o inicializador, 1 linha JSON, `[FATAL]`
  sem fallback, `--install-launcher` uma vez, jar X.Y.Z pela regra C-3); wizard, `mcp-client` (queda →
  inicializador; stdio → HTTP), `mcp-daemon-restart` (update → kill + inicializador; rollback tira o jar novo
  do caminho) e SessionStart (dispara o inicializador). Download sempre o jar CPU com nome exato em
  `~/.mcp-memory/lib` (o inicializador ignora `-gpu`). Testes + mutações; e2e com o inicializador REAL do
  native-java (build da develop, HOME isolado + `-Duser.home`): instalou, subiu, 56 tools; e na máquina real
  o inicializador devolveu o servidor 2.45.5 em 2 s (`spawned:false`).
- [x] **Q29 — GATE DE RELEASE: a próxima versão do boss só sai com o servidor 2.45.5 público.** A release
  pública mais nova é 2.45.4 (sem `--install-launcher`); até lá a ativação local falha com o motivo claro.
- [x] **Q30 — native-java: `--install-launcher` sobrescreve a chave global de logon (HKCU `McpMemoryServer`)
  mesmo quando roda com outro `user.home`.** Visto no e2e do Q28 (a chave real passou a apontar para o HOME
  temporário; restaurada à mão). Proposta lá: não sobrescrever uma chave que aponta para outro HOME, ou avisar.
  **RESOLVIDO no native-java** (PR #199, sai na 2.45.7): a chave só é gravada/removida quando o `user.home` é o
  `USERPROFILE`; fora dele avisa que o logon não mudou (C-8). E o Latest do repo público passa a ser sempre o
  servidor (C-9 manda o cliente listar as releases — o resolvedor do boss já faz isso).
- [x] **Q31 — teste de hooks não-hermético** (`test-hooks.js`, graph-guard "Bash scoped grep -r"): lia o
  `~/.claude/settings.json` real (Token Guard instalado hoje na máquina) — falhava inclusive no develop limpo.
  **Corrigido**: HOME do teste = a pasta temporária que contém o cwd.
- [x] **Q32 — backup não escalava para o servidor real (bug da 3.0.1).** Visto ao testar o `backup_export` real
  (servidor 2.45.5): memory.db de 6 GB → snapshot de 4,2–5,6 GB; o `.tar.gz` era montado em memória
  (`gzipSync`/`readFileSync`), a restauração tinha teto de 1 GB e lia tudo em memória, o timeout de 120 s
  estourava e o erro do remoto escapava sem tratamento (derrubaria o backup local). **Corrigido na hora**:
  `lib/backup.js` em stream (snapshots em arquivo temporário, tar via gzip com backpressure, manifesto no fim,
  extração em stream para staging com checksum antes de trocar), adaptador remoto com timeout de 1 h e erro →
  "não incluído + motivo", dashboard com jobs (`/api/backup/status`) e upload em stream. Teste com snapshot
  de 64 MB + caminho inseguro + corrompido; e2e com 2 dashboards; prova real: 1,2 GB, 109 s, pico 120 MB RSS.
- [x] **Q33 — servidor 2.45.6 (retorno do native-java).** Verificado: (1) `-gpu.jar` — o testador de
  configuração (`config-testers/mcp-memory.js`) ainda pedia o asset `-gpu` com NVIDIA → **corrigido**;
  `mcp-release-resolver.js` sem variante GPU/`detectGpu`; texto do `backend_setup` sem "530 MB GPU". (2) todo
  `initialize` manda `projectId` (brain-backend = projeto resolvido; wizard/setup-tools/backup = `default`;
  auto-update = `__ccb_auto_update__`). (3) gravação passa `project_id` explícito ou o do handshake — não
  depende de defaults do workspace. (4) parsers tolerantes (sem `memory_health`). (5) daemon só pelo
  inicializador; sidecar nunca tocado. Achado extra **corrigido**: `releases/latest` às vezes é um sidecar
  (Sidecar v1.6.1 em 05/10) → o resolvedor lista as releases e pega a maior X.Y.Z com o jar. Teste + mutação.
- [x] **Q34 — `scripts/lib/plugin-updater.js:228` usa `releases/latest` do repo do próprio boss**, onde também
  saem releases `rf-v*` (rf-reviewer): a "latest" pode ser do rf-reviewer. Visto na verificação do Q33. Fora do
  escopo. Proposta: listar releases e filtrar a tag `v<X.Y.Z>` mais alta (mesma regra do release-guard).
  **RESOLVIDO em 07/10** (decisão do dono: o repositório é de vários plugins, nenhum é prioritário):
  `pickPluginRelease` lista as releases e escolhe a maior `<prefixo><X.Y.Z>` do plugin (boss `v`, rf-reviewer
  `rf-v`), sem draft/prerelease; `release.yml` publica TODA release com `make_latest: "false"`. Teste + mutação.
- [x] **Q29 — gate da release (servidor 2.45.5+ público)** — satisfeito: v2.45.5 e v2.45.6 publicadas em 06/10.
- [x] **Q35 — compactação controlada (pedido do Allan, 07/10; spike F0 feito; implementada em `feat/compaction`, 08/10).**
  Ideia: compactar na hora certa (limiar de tokens + cache do provedor frio), mantendo literal o que vale
  (prompts, decisões) e podando só resultado de ferramenta velho; memória como referência. Tentativa anterior
  = `contextTuning` (só o limiar `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, conteúdo = resumo nativo). Spike em
  `smoke/compaction-spike/` (local): function hook `session.compact` + timer de TTL, 13 testes puros + 4 no
  engine. Provado no Claude Code 2.1.291 real: o hook substitui o `/compact` manual e o auto-compact
  (`trigger auto`) — 8–16 ms, 0 token, 55k→4k, decisão literal (o nativo leva 19 s, US$ 0,017 e parafraseia);
  na sessão viva o prefixo system+tools segue em cache (só a conversa compactada é regravada); o cache que o
  Claude Code grava aqui é de **1 h** (`ephemeral_1h`), não 5 min; plugin instalado de marketplace carrega o
  módulo (inclusive sem telemetria/provedor terceiro — gate de rollout no servidor `tengu_plugin_hooks_modules`,
  que em 04/10 estava desligado). **Momento da compactação (desenho do dono, provado no modo INTERATIVO real
  via ConPTY/pywinpty)**: nunca compacta sozinho; no `prompt.submit` de uma pessoa (sessão ociosa), se passou do
  limiar e o cache esfriou, SEGURA o prompt (`{drop}`), roda `$.command.run({command:'compact'})` e REENVIA o
  mesmo texto (`$.prompt.submit({text, asUser:true})`) — 118.723→7.089 tokens em 20 ms, resposta literal.
  Regras do engine descobertas: `session.compact` é recusado DENTRO do `prompt.submit` ("would compact under
  the turn this hook is holding"); `$.session.compact()` pula o hook do próprio chamador (cai no resumo nativo)
  — por isso o `/compact` via `command.run`; o reenvio do plugin não passa pelo próprio hook (sem loop);
  prompt com anexo não é segurado (o reenvio perderia o anexo). **Retomada (defeito do engine, CONTORNADO
  localmente)**: depois de uma compactação respondida por hook, `--resume` E `--continue`/`-c` recarregam o
  histórico ORIGINAL (proxy: tool_results de 69k/72k sem a poda; o nativo respeita a fronteira; o AgentLauncher
  retoma com `--continue`, `core.py:698-699`). Contorno provado no interativo real com `--continue` + proxy:
  o `SessionStart` clássico (hookado do módulo como `classic.SessionStart`) dispara em `-c` e `--resume` com
  `source:"resume"`, `context_tokens` (= tamanho da última resposta, já podado) e `seconds_since_last_response`;
  no 1º prompt o gate compara o histórico recarregado com esse tamanho — reinflado → segura, poda de novo e
  reenvia ANTES de qualquer envio. Medido: a requisição real levou o histórico podado (3 notas, maior
  tool_result 3.024 caracteres). `$.session.messages` não está disponível no SessionStart (lido no 1º prompt);
  o `session.start` de function hook dispara nos 3 modos mas não diz qual. **Ressalva restante**: leitura de tokens: no
  interativo `session.measure` vem `null` e `$.session.usage()` traz o valor; no headless o inverso — ler os
  dois (usage primeiro).
  **IMPLEMENTADO em 08/10** (`feat/compaction`): `hooks/compaction.mjs` + `scripts/lib/compaction-core.mjs`;
  métricas por `POST /hook/compaction-event` (daemon, token do `/mcp`; as `hook_*` são deslistadas e um módulo
  não as alcança por `$.mcp.call`) → `compaction.*`/`cache.turn` → `/api/metrics/compaction` + painel da Home.
  Provado no sandbox isolado (`isolated-smoke`, interativo real via ConPTY): gate por teto e por cache frio,
  TTL aprendido por host (gateway 5 min), poda 96–98%, `settled` medido, retomada repodada sem erro. Achados
  corrigidos na hora, cada um com teste: `USE_BEDROCK=0` lido como ligado; observação perdida no `-p`; atribuição
  "última linha" errada (cópias com usage zerado + linha gravada depois do `turn.complete` → agora por
  `message.id`); última chamada da sessão perdida (observa no `session.end`); primeira chamada após a fronteira
  perdida num processo novo; `settled` negativo na retomada (agora `prevented`); **falso positivo** de retomada
  por tamanho (sessão sem compactação podada com cache quente → agora pelas cópias do engine); cópias
  **intercaladas** (não contíguas) e thinking duplicado (dedupe por bloco de resposta; fixture real 52 → 32);
  boot do daemon dependia do `hook-tools.js` (rota criada sob demanda, 503 se faltar).
  **Limiar configurável (08/10, decisão do dono)**: só limiar, em % da janela que o engine aplica (`rawMaxTokens` do
  `usage({breakdown})`: limite do modelo ou `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), padrão 30%, faixa 10–80, e **nunca com o
  cache quente** (o teto saiu: se não esfriar, age o auto-compact do engine, também pela poda). Slider no painel,
  `GET/PUT /api/compaction/config` gravando no user-config (à prova de update); sessões abertas pegam no próximo turno.
  Provado no sandbox interativo: janela 200k (env), limiar 20k, 420 s ocioso → `cache-cold` → 58.517 → 31.303 tokens.
- [x] **Q37 — nome "claude-code-boss" é reservado para o `claude plugin validate`** (prefixo `claude-`), visto ao
  validar o módulo de compactação. Hoje só o validador reprova: em execução o engine carrega e admite o módulo
  (provado com plugin instalado de marketplace e `--plugin-dir`, 2.1.291). Risco: se a regra passar a valer na
  carga, os módulos do boss deixam de rodar. Proposta: decidir com o dono um nome não reservado antes disso.
  **DECIDIDO pelo dono em 2026-10-08: adiar, sem renomear; monitorar.** Sem impacto hoje. Gatilho para reabrir: nota de versão do
  Claude Code aplicando a regra de nome reservado na carga de plugins (ou o módulo deixar de carregar num smoke).
- [x] **Q38 — `scripts/dashboard.js` `saveHooksConfig` (PUT /api/hooks/config) grava o `config/hooks-config.json` SHIPPED** (pasta do
  plugin), que o auto-update substitui: o que o usuário ajusta por essa rota some na próxima versão. Visto ao planejar o
  controle de limiar da compactação (08/10). O perfil já faz certo (`saveProfile` → `<globalDir>/hooks/user-config.json`).
  Proposta: a rota mescla e grava no user-config (como o perfil); o shipped fica só como default.
  **Resolvido em 2026-10-08**: `hooks-config.saveOverrides` grava no user-config SÓ a diferença em relação à config
  efetiva (shipped ⊕ user), preservando o que já estava lá; remover chave falha alto (não dá para expressar como
  override); o GET passa a servir a config efetiva. Teste: só a mudança é gravada, o perfil fixado sobrevive, o
  shipped fica intocado, save sem mudança não escreve, remoção/não-objeto falham alto.
- [x] **Q39 — frontmatter YAML inválido em `skills/brain-status/SKILL.md`** (`description: … USE FOR: …` sem aspas: `: `
  dentro de escalar simples não é YAML válido). Visto no debug das sessões do sandbox da compactação (08/10): "Failed to parse
  YAML frontmatter … brain-status/SKILL.md" — o skill perdia a descrição. **Corrigido na hora** (description entre aspas) +
  teste que faz o parse de TODO `SKILL.md` com js-yaml (o arquivo antigo reprova). Os outros 8 skills já eram válidos.
- [x] **Q40 — gateway herdado recusa a 1ª requisição: `400 thinking.enabled.display: Input should be summarized/omitted`**
  (LiteLLM → `vertex_ai.anthropic.claude-haiku-4-5`). Visto em todas as sessões interativas do sandbox (08/10), com e sem o
  boss compactando; o Claude Code repete e segue. Externo (parâmetro de thinking que o gateway/modelo não aceita), relacionado
  ao Q24 (gateway próprio do dono). Ação: confirmar com o dono se o gateway deve aceitar `display` ou o modelo dele não usa thinking.
  **2026-10-08 — causa exata** (debug log do sandbox, 12:32:45Z): `invalid_request_error … thinking.enabled.display:
  Input should be 'summarized', 'omitted'`, `request_id: req_vrtx_011CfpmwxaMM4QugvqUQZW5u` — quem recusa é a **Vertex**
  (o LiteLLM só repassa). Logo depois o Claude Code registra `[betas] the API refused thinking-display-updates-2026-08-18;
  not sent again … in this process`: ele desliga o beta sozinho → custo de 1 tentativa por PROCESSO, não por pedido.
  O corpo da requisição não é logado (o valor de `display` enviado não é visível sem capturar). Nada a corrigir no
  boss nem no gateway; aguardando o dono decidir se fecha como externo.
  **2026-10-09 — outra variante, mesma família** (smoke real do release 3.1.0, `claude -p` pelo gateway): `400 messages.1.output_config:
  Extra inputs are not permitted` (`req_vrtx_011Cfqj8NXwKMudqfb4f7uRp`, `vertex_ai.anthropic.claude-opus-5-5`); o Claude Code repetiu e a sessão
  concluiu. Também externo (a Vertex recusa um campo novo do cliente).
  **FECHADO em 2026-10-09 como externo** (decisão técnica minha, delegada pelo dono): é a Vertex recusando campos novos do cliente
  (`thinking.display`, `output_config`); o próprio Claude Code desliga o beta/repete e a sessão segue. Nada a fazer no boss nem no gateway.
- [x] **Q36 — `ANTHROPIC_BASE_URL` no ambiente de usuário do Windows (HKCU\Environment)** desta máquina, visto
  no spike do Q35 (valor não lido). O boss não grava HKCU (grep em `scripts/`: nenhum `setx`/`reg add`); afeta
  qualquer app, não só o Claude Code. Relacionado ao Q24. Ação: confirmar com o dono quem gravou e se é intencional.
  **2026-10-08**: lido — o valor era VAZIO (REG_SZ de 0 caracteres; o endereço das sessões vem do env do launcher).
  Não é do boss (o `cleanupGlobalEnv` só apaga valores localhost, e apaga a variável inteira). **Removido** com
  aprovação do dono (`reg delete`; `reg query` confirma ausência).
- [x] **Q41 — papel de ORQUESTRADOR como capacidade do boss (pedido do dono, 2026-10-08, via Jarvis).** O orquestrador
  agia como ponte pura (repassava achado → esperava decisão → repassava), inclusive quando a ação óbvia já estava clara.
  Regras pedidas, para QUALQUER agente no papel: (1) release só com todo item não-ambíguo resolvido; o ambíguo (escolha de
  produto/arquitetura) vai ao dono, o resto o orquestrador decide e manda executar; (2) teste quebrado/erro de log/dúvida
  técnica rotineira: investiga, pesquisa, decide, só reporta; (3) mudança no comportamento do usuário final: SEMPRE escala,
  com pesquisa + validação (spike) + 1 a 3 sugestões validadas com trade-off; (4) ciência proativa do fim de sessão
  (commits/build) ligada ao self-forge, sem polling a pedido; (5) memória de decisão por padrão recorrente no Brain/MCP
  memory (do PAPEL, não da sessão); (6) curadoria periódica (a cada poucos dias) do que foi aprendido/decidido.
  **Status: proposta pronta (2026-10-08)** — levantamento + pesquisa com fontes + 5 fases (F0 spike, F1 kit do papel, F2 eventos de
  fim de sessão, F3 memória de decisão, F4 curadoria) em `docs/plans/orchestrator-role-design.md` (local). Aguardando o dono decidir
  D1 (como a sessão vira orquestradora), D2 (limiar de re-aplicação automática), D3 (cadência/autonomia da curadoria), D4 (interface
  de eventos do self-forge agora ou na migração para runners efêmeros).
  **2026-10-08 — MOVIDO para o projeto "orchestrador"** (correção de escopo do dono): a implementação não acontece no boss.
  O documento de design/pesquisa fica como referência a repassar. O sistema de aprendizado próprio do boss (ações autônomas
  dele) é outra frente, a revisitar depois. O Q42 segue válido aqui.
- [x] **Q42 — `capture_lesson` funde por similaridade sem olhar o tipo** (`servers/brain-server/lib/mcp-server.js:996-1005`): com
  cosine ≥ 0,9 contra o top-1, uma `decision` vira `recurrence++` de uma `lesson` parecida (e vice-versa) — perde-se o registro da
  decisão. Visto no levantamento do Q41 (2026-10-08). Proposta: só fundir com o mesmo tipo (ou comparar o top-k do mesmo tipo); teste
  com uma lição e uma decisão quase iguais. Pré-requisito da F3 do Q41.
  **Resolvido em 2026-10-08**: a busca de dedup passa `type` (o `brain-store` já filtra por tipo ANTES do `topK`, nos
  dois armazenamentos). Testes: decisão quase idêntica a uma lição é admitida, repetição do mesmo tipo ainda funde; o
  `brain-store.search` honra `opts.type`. Mutação (sem o `type`) reprova.
- [x] **Q43 — o liga/desliga de hook do dashboard renomeia o script DENTRO da pasta do plugin** (`scripts/dashboard.js:1223`
  `toggleHook`: `scripts/<nome>` → `.disabled`). Mesma família do Q38: o auto-update instala uma pasta nova e o hook volta
  ligado sem aviso; e desligar um dispatcher (`stop-dispatcher.js` etc.) tira TODOS os detectores daquele evento, com erro de
  "Cannot find module" a cada disparo, em vez de desligar só o detector. Visto ao levantar features irmãs do Q38 (2026-10-08).
  (Path traversal verificado e descartado: o `new URL` normaliza `..`/`%2e%2e`.) Proposta: o botão grava `<detector>.enabled`
  no user-config (os detectores já leem `enabled` via `hooks-config`), sem tocar arquivo do plugin; teste de sobrevivência ao update.
  **Resolvido em 2026-10-08**: `disabledHooks` no user-config (`hooks-config.setHookDisabled`/`isHookDisabled`); o
  `hook-tools.handle` responde `{}` sem rodar um hook desligado (vale para os 13 `hook_*` do `hooks.json`). Achado junto: nos
  hooks `mcp_tool` (a maioria) o botão antigo dava 404 — procurava `scripts/hook_x`. As 4 entradas de comando (dispatchers de
  SessionStart/UserPromptSubmit, ensure do roteador, `/dashboard`) e o `brain_retrieve_context` ficam sem botão: são infraestrutura
  (raiz da sessão, ensure do daemon/roteador) e a API recusa com o motivo (400). Testes: unitário com hook-sonda (não roda quando
  desligado, volta quando religado, nenhum arquivo do plugin renomeado) + smoke do dashboard real; mutação reprova.
- [x] **Q44 — ajuste do usuário em `kb.skillPromotion` é ignorado**: `scripts/brain-promote.js:45` (comportamento) e
  `scripts/dashboard.js:1008` (painel) leem só o `config/brain-config.json` que vem no plugin, sem o user-config
  (`<globalDir>/user-config.json`) que o `brain-config.load()` já mescla. Visto no mesmo levantamento. Proposta: ler pelo
  `brain-config`; teste com override de `minRecurrence`.
  **Resolvido em 2026-10-08**: `brain-config.getSkillPromotion()` (shipped ⊕ user) é o leitor único do `brain-promote` e do
  painel. Teste: override de `minRecurrence` chega à promoção, o resto mantém o padrão; mutação (getter sem o override) reprova.
- [x] **Q45 — o painel do roteador não mostra quando ele se recusou a passar por cima do gateway do usuário (Q24)**: hoje o
  adiamento só aparece no log e num aviso por sessão; o painel continua mostrando o roteador como configurado. Proposta: o status
  do roteador expõe `gateway-defer.json` (URL, desde quando) e o painel mostra "Não ativado: gateway próprio X — Salvar &
  aplicar reavalia". Melhoria (visibilidade), não defeito.
  **Resolvido em 2026-10-08**: `/api/router/status` devolve `gatewayDeferred` ({url, at} ou null) e o painel mostra a mensagem
  (PT/EN) no lugar do "reload pendente" (que ali seria enganoso). Premissa conferida: o "Salvar & aplicar" roda o ensure com
  `BOSS_ROUTER_FORCE_RESTART=1`, que limpa e reavalia o adiamento. Testes: invariante na suíte + smoke do dashboard real (com e
  sem o arquivo; página servida com as duas mensagens).
- [x] **Q46 — o detector de decisões lia um heredoc qualquer como mensagem do commit** (`scripts/decision-detect.js`
  `extractCommitMsg`/`extractPrBody`): num comando `cat > f <<'EOF' … EOF && git commit -m "…"`, o padrão do heredoc casava o
  conteúdo do ARQUIVO; o lembrete de decisão do Stop citou um script de patch como "commit" (visto em 2026-10-08, nos commits
  Q42–Q45). **Corrigido na hora**: só o que vem depois do `git commit`/`gh pr` é lido, e o heredoc só conta quando alimenta o
  `-m`/`--body` (`"$(cat <<…`). Teste: reproduzido no código anterior (extraía `const fs = require('fs');`), passa após a correção.
- [x] **Achado externo (Smart Tool 0.9.4) — `affected_tests` diz "nenhum teste" para código do boss** (visto em 2026-10-08 ao adotar
  graph/affected_tests): o `scripts/test-units.js` (1,42 MB, ~1.430 testes) cai no teto de tamanho do índice; uma mudança só em
  `scripts/lib/hooks-config.js` deu `tests: []`, `run_all: false`; `graph` com symbol devolve `tests: []` para funções testadas.
  Também: nenhum runner inferido apesar do `npm test`; `register` devolve 128k caracteres; `degraded` sem motivo. **Repassado** à sessão
  do Smart Tool. Até corrigir: no boss, o gate continua sendo a suíte inteira (`test-units` + `test-hooks`), nunca só o que o
  `affected_tests` listar.
  **Resolvido no Smart Tool 0.9.5 (validado aqui em 2026-10-08)**: a mesma reprodução agora lista `test-units.js` (1 passo) e `test-hooks.js`
  (2 passos) com os comandos; `graph` vê os testes; status curto. Pontos menores repassados: `duplicates` lê o índice velho sem avisar; teste
  aparece como "callback" em vez do título.
- [x] **Q47 — o embedder ignora a escolha feita no painel** (`scripts/brain-embedder.js:43-55` `loadConfig`): lê só o
  `config/brain-config.json` que vem no plugin; o painel "Embedder" grava provedor/modelo no user-config via `brain-config.save`.
  **Provado** (HOME temporário): salvo `ollama/nomic-embed-text/768` → o embedder carrega `transformers/paraphrase-multilingual/384`.
  Visto na varredura da classe Q38/Q43/Q44 (2026-10-08). Proposta: `loadConfig` lê `brain-config.load().embedder`; teste com override.
  **Resolvido em 2026-10-08**: `loadConfig` lê `brain-config.load().embedder`. Teste: escolha salva pelo caminho do painel é a que o
  embedder carrega; mutação (voltar a ler o arquivo do plugin) reprova.
- [x] **Q48 — o Q44 ficou incompleto: `scripts/skill-promote-trigger.js:36` `loadCfg`** lê `kb.skillPromotion` só do arquivo do plugin
  (é quem decide se o scan roda). Proposta: usar `brain-config.getSkillPromotion()`.
  **Resolvido em 2026-10-08**: `loadCfg()` usa `brain-config.getSkillPromotion()` (o mesmo leitor do Q44). Teste reescrito no contrato
  novo (o usuário desliga o scan pelo arquivo dele); mutação reprova.
- [x] **Q49 — `scripts/brain-store.js` `loadRerankConfig` (:56) e `loadKbLimits` (:158)** leem `kb.rerank`/`kb.maxEntriesPerProject`/
  `kb.archiveAfterDays` só do arquivo do plugin — override do usuário ignorado. Proposta: ler pelo `brain-config.load()`.
  **Resolvido em 2026-10-08**: `kbConfig()` lê o `kb` do `brain-config.load()`; o cache do rerank segue a identidade do objeto (antes
  ficava fixo para sempre no processo). Teste: override mesclado sobre os padrões, limites honrados, mudança posterior vista; mutação
  reprova.
- [x] **Q50 — `hashFile` duplicada** (`scripts/lib/backup.js:88` e `scripts/lib/backup-remote.js:24`, cópia exata — Smart Tool
  duplicates). Proposta: exportar de `backup.js` e reusar.
## Testes

  **Resolvido em 2026-10-08**: as duas cópias saíram; ambos usam o `sha256File` do `scripts/lib/file-hash.js` que já existia (mesma
  semântica: SHA-256 em stream, hex, erro propaga). Coberto pelos testes de backup existentes (manifesto e checksum).
- [x] **Q53 — no backend mcp-memory, a promoção a skill (e o checklist de revisão) só enxerga a KB LOCAL, que não recebe mais nada**
  (`scripts/brain-promote.js:25,101-102`: `require('./brain-store.js')` + `project = basename(cwd)`). Com `backend: mcp-memory` o
  `capture_lesson` grava no servidor (id estrito `AllanSantos-DV/claude-code-plugins`); a recorrência que dispara a promoção nunca
  cresce localmente. **Medido em 2026-10-09** nesta máquina: KB local `claude-code` = 14 entradas, a mais nova de 16/06; id estrito
  local = 0; lições capturadas hoje estão só no servidor. Os 4 drafts em `skills-pending` são de 02/08 e 15/09 — nada novo desde a troca
  de backend. Dois defeitos: (1) fonte errada no mcp-memory; (2) id de projeto pelo nome da pasta (regra anterior à 2.29.1, não o
  resolvedor estrito). Provável mesmo problema no `brain-consolidate` semanal e no `.claude/brain-review-checklist.md` (a verificar).
  Proposta: no mcp-memory, o scan consulta o servidor (lições/padrões com recorrência — conferir o que o servidor expõe) pelo id estrito;
  no local, usar o id estrito também. Visto ao levantar o estado do loop de aprendizado a pedido do dono (via Jarvis).
  **Resolvido em 2026-10-09** (pedido do dono): achado a mais — no mcp-memory o `capture_lesson` não fazia dedup (toda captura era
  `admit`), então NEM no servidor havia recorrência. Agora: (1) dedup remoto igual ao local (`findRemoteDuplicate`: busca candidatos do
  mesmo tipo/projeto no servidor e decide pelo cosseno local ≥ 0,9; merge = upsert no mesmo documento com `recurrence` nos metadados);
  (2) `brain-promote scan` lê o servidor (`brain-backend.listDocuments`, filtrado por `project_id` — sem o filtro a listagem traz todos
  os projetos) pelo id ESTRITO (`tryResolveProjectId` do `--cwd`; o gatilho não manda mais o nome da pasta). Testes: dedup remoto,
  normalização das entradas do servidor, scan no mcp-memory (draft + checklist); mutações reprovam. **Teste real** contra o servidor
  desta máquina (projeto isolado, `smoke/q53-real.mjs`): admit → merge(2) → merge(3) no mesmo documento, servidor com `recurrence=3`,
  scan real gera o draft e o checklist; documentos de teste apagados.
- [x] **Q54 — a consolidação semanal (`scripts/brain-consolidate.js`) também só enxerga a KB local** (`require('./brain-store.js')` +
  `project = basename(cwd)`): no mcp-memory não consolida nada. Visto ao fechar o Q53. Corrigir no servidor é destrutivo (apaga os
  documentos absorvidos) e exige re-embedar (os vetores do servidor não são expostos) — o dedup na captura (Q53) já cobre o caso ≥ 0,9.
  Proposta: no mcp-memory, listar pelo id estrito, embedar localmente, agrupar na faixa 0,7–0,9 e aplicar só com `--apply` (o gatilho
  semanal já usa `--apply`: decidir com o dono se no servidor fica em dry-run por padrão).
  **Resolvido em 2026-10-09** — dono decidiu: exclusão de verdade, sem dry-run por padrão (meses de dry-run sem perda). No mcp-memory,
  `consolidateRemote` lista o projeto (id ESTRITO do `--cwd`; o gatilho semanal passa `--cwd`, não o nome da pasta), embeda cada
  entrada localmente (título+resumo), agrupa com o mesmo planner e, por grupo, PRIMEIRO grava o sobrevivente com a recorrência somada
  e DEPOIS apaga os absorvidos. Sem embedder → `ok:false` com o motivo, nada apagado. Teste unitário + mutação; **teste real** contra o
  servidor (`smoke/q54-real.mjs`, projeto isolado): par a 0,789 → 1 grupo, sobrevivente rec=3, absorvido apagado, o não relacionado
  intacto. Achado junto: o texto do painel ("no servidor, a deduplicação é feita no servidor") era falso — corrigido (EN/PT).
- [x] **Q55 — o inverso do Q53/Q54: quem volta do servidor (mcp-memory) para o backend LOCAL perde de vista tudo que capturou no
  servidor.** Só existe migração local → servidor (`brain-migrate.js` `migrateLocalToMcp`, botão "Migrar agora"); não há servidor → local.
  **Provado com teste real** (`smoke/inverse-real.mjs`, projeto isolado, troca de modo em processo sem tocar a config): a lição capturada
  no servidor aparece na busca (1 hit); após voltar para local, busca = 0 e contagem local = 0; a lição segue no servidor (1). Além disso
  as entradas locais antigas gravadas pelo NOME da pasta (pré-2.29.1, ex.: `claude-code` = 14) também não são vistas pelo id estrito.
  Proposta: migração espelho `migrateMcpToLocal` (`list_projects` + `list_documents` por projeto → store local com o mesmo id, embedding
  local + índice de palavras) + gatilho no painel ao trocar para local; decidir com o dono a forma (ver relato ao Jarvis).
  **FECHADO em 2026-10-09 — NÃO é bug, por decisão do dono:** o mcp-memory é um agregador (curadoria, correlação…); quem desliga e fica
  só no local perde isso por natureza, não há como recriar do zero no local. Opções A e B descartadas, nada implementado; local → servidor
  segue pelo "Migrar agora".
- [x] **Q56 — config de usuário ilegível trocava o backend para LOCAL em silêncio** (`scripts/lib/config-merge.js` `loadLayered`: o
  parse que falhava caía num `catch { void err }` e o merge usava só o arquivo do plugin, que vem com `backend.type: local`). Visto ao
  investigar "a troca de backend é sempre explícita?" (pedido do dono, 2026-10-09); **provado** num HOME temporário (vírgula a mais →
  `backend: local`, sem nenhuma mensagem). **Corrigido na hora** com recuperação ativa: toda leitura válida guarda `<arquivo>.last-good`;
  ilegível → a cópia corrompida vai para `<arquivo>.corrupt-<ts>`, a boa é restaurada e o SessionStart (`brain-health`) avisa uma vez;
  sem cópia boa → aviso ALTO a cada SessionStart (roda nos padrões até corrigir). Vale para o Brain e para os hooks. Teste + mutação.
- [x] **Q57 — a consolidação semanal rodava para UM projeto por semana** (`scripts/curation-session.js`: carimbo único
  `.runtime/brain-consolidate-last.json` para toda a pasta de dados — o primeiro projeto a abrir sessão consumia a semana dos outros).
  Visto ao investigar "por que nenhuma promoção" (pedido do dono, 2026-10-09). **Corrigido na hora**: carimbo por id ESTRITO de projeto
  (`consolidationDue`/`markConsolidated`; carimbo antigo `{ts}` conta como pendente). Teste.
- [x] **Q58 — o painel, no backend servidor, mostrava a memória LOCAL antiga** (`scripts/dashboard.js`: `/api/status` e
  `/api/brain/projects` contavam as pastas SQLite locais; `/api/brain/list` usava o `list()` do servidor, que ignora o projeto; o painel de
  skills oferecia as pastas locais). Relato do dono (\"grava 500 lições no servidor e o painel não mostra\"), 2026-10-09. **Provado ao vivo**:
  painel = 458 entradas locais (270 de um projeto de teste antigo), sem o id oficial; o servidor tinha 103 só deste projeto. **Corrigido**:
  no mcp-memory os quatro leem o servidor (`brain-backend.listProjects` + `listDocuments` por projeto, cache de 60 s; falha do servidor
  aparece como erro, nunca volta para as pastas locais calado). Prova real (`smoke/dash-server-mode.mjs`): painel = 15.047 documentos em
  142 projetos do servidor, lista com o id oficial, listagem do projeto = 103 = servidor. Teste de invariante + mutação.
- [x] **Q59 — a 1ª chamada de memória depois de o servidor cair estoura o tempo** enquanto o launcher o sobe (visto no teste do watchdog,
  2026-10-09: o servidor voltou numa porta nova e a 2ª chamada funcionou). Proposta: no circuito aberto, disparar o launcher em segundo
  plano e responder rápido com \"servidor de memória reiniciando\" em vez de esperar até o timeout da ferramenta.
  **Resolvido em 2026-10-09**: o cliente MCP ganhou `restartMode: 'background'` (o brain daemon liga via `CCB_MCP_RESTART_MODE`):
  servidor fora → o launcher sobe em segundo plano e a chamada responde NA HORA com "reiniciando, tente de novo em alguns segundos"
  (`MEMORY_SERVER_RESTARTING`); CLIs continuam esperando. Teste + mutação; prova real no smoke do release 3.1.1.
- [x] **Auditoria pré-release 3.1.1 (camada adversarial) — achados conferidos e corrigidos antes da tag**:
  - **[HIGH, confirmado no servidor] a consolidação reescreveria o sobrevivente a partir da listagem**: medido no mcp-memory 2.46.1 —
    `list_documents` devolve um PREVIEW de ~200 caracteres (4.824 → 203) e `add_document` com `documentId` SUBSTITUI os metadados
    (chaves extras somem). O `--apply` semanal truncaria o conteúdo das lições sobreviventes e apagaria metadados. **Corrigido**:
    `brain-backend.patchMetadata` (relê com `get_document` e regrava o MESMO conteúdo com os metadados mesclados); a consolidação só toca
    documentos escritos pelo boss (`bossWritten` = metadados title+type); o merge da captura (Q53) leva os metadados existentes
    (`baseMetadata`); o rascunho de skill vem do documento inteiro (`get_document`), não do preview. Prova real (`smoke/q54-real.mjs`
    ampliado): sobrevivente com 2.541 caracteres antes e depois, chave extra preservada, documento de fora com o mesmo texto intacto.
  - **[MEDIUM] painel: corrida no singleton do backend** (o loop de projetos e `/api/brain/list` re-iniciavam o mesmo cliente) **e bloqueio
    de até 60 s com o servidor fora**: o resumo do servidor tem CLIENTE PRÓPRIO em modo `background`, chamada em voo compartilhada e
    falha guardada por 10 s. Prova real repetida (`smoke/dash-server-mode.mjs`).
  - **[MEDIUM] recuperação da config podia tomar conta de um save em andamento**: arquivo mexido há < 5 s → usa a cópia boa só em memória,
    sem tocar no arquivo; arquivo vazio = reset deliberado (padrões, nada restaurado); `ENOENT` no rename (outro processo restaurou) →
    relê; symlink restaurado no alvo real. Teste + mutação.
  - **[LOW] delete que falha contava a recorrência de novo toda semana**: o sobrevivente registra `absorbedIds`; a próxima rodada só apaga
    os pendentes, sem somar. Teste.
  - **[LOW] a semana era gasta mesmo com a consolidação falhando**: falha (inclusive servidor fora) devolve a semana do projeto
    (`unmarkConsolidated`); a CLI sai com código 1. Teste.
  - **[LOW] egress com embedder remoto**: documentado no CHANGELOG (com o embedder local, padrão, nada sai).
  - **[INFO] texto do aviso**: o arquivo de hooks não diz mais "backend: local".
  - **Limitação conhecida (aceita)**: capturas/consolidação simultâneas do mesmo documento podem perder um incremento de recorrência
    (última escrita vence) — só o contador, nunca conteúdo.
- [x] **Q61 — deploy das páginas falhou no release 3.1.1** (`.github/workflows/pages-deploy.yml`, job único): o upload terminou, mas o
  deploy consultou os artefatos 0,4 s depois e viu 0 (atraso de consistência do GitHub); re-rodar o job no mesmo run deixou 2 artefatos
  "github-pages" e o deploy recusou. Contornado no release com um run novo (`workflow_dispatch`, verde). **Corrigido**: dois jobs (build →
  deploy com `needs`), o modelo oficial do GitHub. Entra no main na próxima release. Validado em 2026-10-09 com um run no `develop`:
  job de build verde (artefato enviado); o deploy foi recusado pela política do ambiente `github-pages` (só `main`), como esperado —
  a validação do deploy em si acontece no próximo push ao `main`.
- [x] **Q60 — teste intermitente `audit: shape-output STREAMS`** (`scripts/test-units.js`): esperava 400 ms fixos pela cabeça da saída;
  sob carga a subida do processo filho passava disso (visto 1 vez em 2026-10-09; a rodada seguinte passou). **Corrigido na hora**:
  espera ativa até 10 s com o stdin ainda aberto (a prova "cabeça antes do EOF" continua).
- [x] **Decisão (2026-10-09) — `backend_setup` (ferramenta do agente que liga o servidor de memória) fica como está.** Chamá-la é ação
  deliberada do usuário via agente (não troca silenciosa), só liga o servidor (sem perda) e a descrição exige perguntar antes; a troca
  para LOCAL só existe no painel. Decidido por mim por delegação do dono.
- [x] **Q51 — Release Guard vermelho a cada 6 h sem drift** (`.github/scripts/release-guard.mjs` `isAncestor`): a atividade da main
  ainda lista um push de histórico reescrito (`5fd0028`, de nenhum branch); no clone do CI esse commit não existe, o `git merge-base`
  sai com 128 e o guard caía (visto 2026-10-08: 3 cron seguidos em falha). **Corrigido na hora**: commit fora do histórico = não-ancestral,
  com aviso no stderr. Teste com SHA inexistente (o git real dá 128); o caso normal segue.
- [x] **Auditoria pré-release 3.1.0 (camada adversarial, `release-auditor`) — todos os achados conferidos no código e corrigidos na hora**:
  - **[HIGH] perfil `free` não desligava a compactação**: o `config/hooks-config.json` trazia `compaction.enabled: true`, e o arquivo
    mescla POR CIMA do preset do perfil. Removido do shipped (ligado por padrão vem do `!== false`). Teste resolvendo o perfil sobre o
    arquivo REAL (o teste antigo resolvia sem ele); mutação reprova.
  - **[MEDIUM] embedder: escolha antiga passa a valer no update (Q47)** e os vetores locais de outra dimensão viram score 0 em silêncio:
    aviso de início de sessão (`brain-health` `embedderDimMismatch`) com a contagem e o `brain-reembed.js`; nota no CHANGELOG (inclui
    a ida à API da Voyage quando ela é a escolhida). Teste com banco temporário; mutação reprova.
  - **[MEDIUM] módulo de compactação agia com o padrão "ligado" quando o daemon não respondia** (o usuário podia ter desligado):
    sem config, não age (`prompt.submit` e `session.compact`). Teste no engine; mutação reprova.
  - **[MEDIUM] gateway LOCAL do usuário confundido com o roteador** (`isOurProxyUrl` = qualquer localhost): o roteador se ligava por
    cima e o disable apagava a URL do usuário. Agora só a porta do roteador (configurada + a do roteador vivo). Teste; mutação reprova.
  - **[LOW→corrigido] token lido de um caminho dito pelo `/health` aberto**: investigado a fundo (cobrança do dono — "já existia" não
    basta): além do risco aceito (token a quem atende a porta), um ocupante podia apontar caminho UNC e ler o arquivo faria o Windows
    entregar o hash NTLM. Pasta agora só local (`CLAUDE_PLUGIN_DATA`/ponteiro), caminho não local recusado, token só se o `/health`
    nomear a mesma pasta. 3 testes no engine (pasta diferente não envia; UNC nunca é lido; ponteiro não local recusado); mutação
    reprova. `docs/SECURITY.md` atualizado.
  - **[LOW] user-config corrompido trocado em silêncio** pelos 4 gravadores (perfil, slider, editor, liga/desliga): leitura estrita
    única (`readUserConfigForWrite`) falha alto e preserva o arquivo. Teste dos 4; mutação reprova.
  - **[LOW] prompt segurado podia se perder** se o reenvio falhasse: o texto volta no log + evento de erro. Teste no engine; mutação reprova.
  - Pré-existente (só doc): comentários em `servers/brain-server/lib/daemon-common.js:88-97`/`:136-144` dizem que o
    `/mcp` só tem guarda de origem, mas `http-daemon.js:175` exige o token — **comentários corrigidos na hora**.
- [x] `scripts/test-units.js`, teste `plano B: stream com várias linhas SSE somando mais de 32 MiB termina completo (o teto é por linha)` (~9361): flake intermitente sob carga (anotado em 2026-09-30, durante a Fase G da 2.29.1, que não toca o model-router): falhou com `nvidia: conteúdo perdido (867 chars)` em 1 de 3 rodadas completas da suíte, e outra rodada teve 2 falhas da família `plano B`; a terceira passou limpa. Mesma família de timing do item de FIN/reset abaixo. Investigar se o stream de >40 MiB é cortado por prazo do teste ou do router quando a máquina está carregada.
  **INVESTIGADO em 2026-10-02 (não reproduz)**: 867 chars com `message_stop` = a mensagem de ERRO do próprio router (`reportFailure` → `respondAnthropicText`), não perda silenciosa nem timeout (TTFB é desarmado após a resposta). Sonda com 60 execuções e fatiamento variado (1 B a ~1 MB, com yields): zero perdas — fronteira de chunk descartada. O teste agora imprime o texto do router na falha, para a próxima ocorrência nomear a causa.
- [x] `scripts/test-units.js`, teste `plano B: corpo de RECUSA cortado (FIN, reset) ou parado no meio…` (~8898): flake intermitente, 1 falha em cerca de 17 execuções completas da suíte (anotado em 2026-09-25 pelo tester da r28 do gate da 2.29.1, numa rodada lenta de 111,9 s contra ~86 s). Isolado, inclusive sob 32 processos ocupando a CPU, passa. Hipótese não confirmada: a janela `ms >= 4500 && ms <= 7500` (~8930) é apertada sob carga; a mensagem não foi capturada porque o wrapper `.vscode/scripts/test-units.mjs` (no ramo de falha, ~74) só repassa as linhas `✗`; o runner cru (`scripts/test-units.js`, ~18975) imprime na linha seguinte a primeira linha do erro, que traz os ms medidos se a falha for a da janela (~8930). Próximo passo: capturar essa mensagem (rodando o runner cru ou fazendo o wrapper repassar a linha) e medir do lado do servidor falso ou alargar o limite superior.
  **RESOLVIDO em 2026-10-02**: a hipótese da janela de tempo estava certa — o teste fixa tetos próprios (inatividade 1 s, total 20 s) e aceita 0,9–10 s: prova o mesmo (saiu pela inatividade, não pelo prazo total) com 9 s de folga para carga, e ficou ~12 s mais rápido. Tetos default restaurados no finally.
- [x] `.vscode/scripts/i18n-audit.mjs` falha em `dashboard/index.html` já no HEAD `44a9ff6` (anotado em 2026-09-25, durante o `byok.openaiCompat` da 2.29.1, que não criou nenhuma das chaves abaixo): 6 chaves usadas no HTML sem tradução em EN nem PT (`brain.migrateTitle`, `brain.migrateHint`, `brain.migrateBtn`, `brain.editorTitle`, `brain.reembedHint`, `router.oneMillionWarn`) e 62 chaves órfãs por idioma (várias são usadas por `t()` em JS, o que o audit talvez não enxergue — confirmar antes de apagar). Corrigir as traduções ausentes e separar órfã real de falso positivo do audit.
  **RESOLVIDO em 2026-10-02**: as 6 chaves sem tradução eram bug visível (o `applyI18n` troca o texto por `t(key)`, que devolve a chave crua — o dashboard mostrava "brain.migrateTitle" etc.); ganharam EN+PT. As "62 órfãs" eram falso positivo do audit (só via `data-i18n`): ele agora conta `t('k')` e `i18n: 'k'`; as 6 realmente mortas (wizard Java/JAR/Daemon/Handshake/Project, `mode.current`) saíram. Audit: 267/267/267, PASS. Novo teste no CI: toda chave usada tem EN e PT (mutação: tirar `brain.migrateBtn` EN → falha nomeando a chave).
- [x] `scripts/test-units.js` (`runTest`, ~58-70) e o wrapper `.vscode/scripts/test-units.mjs` (`execSync`, ~53) não têm timeout: um teste que nunca resolve pendura a suíte inteira sem dizer qual é (o tester da r30 do gate da 2.29.1 viu isso com um mutante, 2026-09-25). Dar um prazo por teste no `runTest` que falha com o nome do teste, e um teto no `execSync` do wrapper.
  **RESOLVIDO em 2026-10-02**: `runTest` com prazo por teste (`CCB_TEST_TIMEOUT_MS`, padrão 120 s) que falha com o nome e segue a suíte; wrappers locais com teto do run inteiro (units 20 min, hooks 10 min) e mensagem explícita. Validado com uma sonda que nunca resolve (falhou por nome, suíte foi até o fim).
- [x] `scripts/test-units.js` (`FASE-E e2e: POST /v1/messages/count_tokens responde…`, ~7027): o processo filho do router não fixa o upstream e abre conexões reais com `api.anthropic.com:443` mandando `x-api-key: test-not-real` (~7076, ~7086): o count_tokens, o `GET /v1/models` do aquecimento do catálogo (o passthrough chama `maybeWarmCatalog` antes) e os dois `POST /v1/messages` (~7083-7093). Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pelo tester da r32 do gate da 2.29.1, que rodou a suíte com uma trava de rede. Correção: passar `ROUTER_UPSTREAM_HOST/PORT/PROTOCOL` apontando para um servidor falso em 127.0.0.1, como o teste ~7399 já faz.
  **RESOLVIDO em 2026-10-02**: o filho do router sobe com `ROUTER_UPSTREAM_HOST/PORT/PROTOCOL` apontando para um upstream falso local, e o teste confere que count_tokens e as 2 mensagens chegaram nele.
- [x] A suíte (`node .vscode/scripts/test-units.mjs`) baixa o modelo do embedder de `huggingface.co` quando ele não está em cache (visto pelo tester da r32 do gate da 2.29.1, 2026-09-25, com a trava de rede). Teste unitário que depende de rede externa falha offline e varia com o cache. Localizar o teste que carrega o embedder e decidir entre modelo fixo local, skip explícito sem cache, ou mock.
  **RESOLVIDO em 2026-10-02**: trava de egress da suíte (`scripts/lib/test-egress-guard.cjs`, carregada no processo e nos filhos via `NODE_OPTIONS`): qualquer host fora do loopback falha localmente com o host no erro. O embedder sem cache cai para keyword (sem download); a suíte inteira passa sem rede. Opt-out deliberado: `CCB_TEST_ALLOW_NET=1`. Teste prova o bloqueio no processo e num filho.
- [x] `scripts/test-units.js`: o caso (b) do teste `BYOK on-limit: openaiCompat inválido só é lido quando o destino é o BYOK…` (~10112) e o teste `BYOK cooldown: geração e count_tokens desviados aplicam mapeamento e injeção…` (~10494) dependem do `UPSTREAM_FALLBACK` real do router; se um mutante (ou um bug) mandar a request ao fallback, o teste tenta sair para a rede em vez de falhar localmente (tester da r32 do gate da 2.29.1, mutante X13, 2026-09-25). Opcional: apontar o fallback para um servidor falso nesses testes.
  **RESOLVIDO em 2026-10-02** pela mesma trava de egress: um desvio para o fallback real agora falha localmente (`ECCB_EGRESS`) em vez de sair para a rede.
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

- [x] Resolução git síncrona duplicada: o daemon (`resolveDispatchProjects` e o handler de `brain_retrieve_context`) e o Stop (`stop-dispatcher.dispatch` e `project-id-stop.run`) chamam `tryResolveProjectId`/`resolveProjectChain` mais de uma vez para o mesmo `cwd` na mesma chamada, e cada uma pode rodar `git remote`. Resolver uma vez e repassar, ou cachear por `cwd` dentro da chamada.
  **JÁ RESOLVIDO** pela memória de git da Fase G (`project-id.js` `defaultGit`, por `(cwd, args)`, TTL 30 s): medido em 2026-10-02 — 8 resoluções do mesmo cwd (`tryResolveProjectId` + `resolveProjectChain` ×4) dispararam 2 processos git (toplevel + remote).
- [x] Id `host/owner/repo` vindo do git remote (ex.: `github.com/owner/repo`) vira uma KB local aninhada em `brain/github.com/owner/repo`, que o dashboard e o `brain-migrate` não listam (eles varrem só um nível). Listar recursivamente ou achatar o id no nome do diretório.
  **RESOLVIDO em 2026-10-02**: `lib/brain-projects.js` (`listBrainProjects`, recursivo até 4 níveis, ignora pastas com ponto) substitui as 5 varreduras de um nível (dashboard: data dir preferido, status, `/api/brain/projects`, skills; `brain-migrate`). Os endpoints do dashboard passaram ao sanitizador lógico (senão a KB aninhada aparecia mas não abria); o nome do arquivo exportado troca `/` por `__`. Testes: listagem aninhada + guarda R1 atualizada.
- [x] `resolveProject` (chamadas sem `cwd`) ainda usa o `CCB_PROJECT_ID` do env do daemon HTTP, que é o env da sessão que subiu o daemon, não o da sessão que chama. Pré-existente; em HTTP essa chamada deveria recusar ou usar só o `project` explícito.
  **JÁ RESOLVIDO** (verificado em 2026-10-02): em modo HTTP o `resolveProject` nunca lê `CCB_PROJECT_ID` e sem `cwd`/`project` recusa com PROJECT_REQUIRED; o `spawnDaemon` também remove a variável. Provas: testes "CCB_PROJECT_ID is never honored" e "spawnDaemon: never forwards CCB_PROJECT_ID".
- [x] O inverso: um `CCB_PROJECT_ID` definido só na sessão chamadora não chega à resolução por `cwd` no daemon HTTP (o `cwdResolveEnv` só repassa o `sessionRoot`). A sessão com id por env fica com memória off se a pasta não tiver `.memory/project.json` nem git remote. Repassar o id da sessão no payload (como o `sessionRoot`) se isso for um caso real.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): era caso real — o `CCB_PROJECT_ID` é documentado (README, CONFIGURATION, TROUBLESHOOTING) e não chegava a NADA servido pelo daemon (hooks `mcp_tool` e tools MCP; o daemon remove a variável do próprio env). O SessionStart (hook de comando, que vê o env) grava o id junto da raiz da sessão (`lib/session-root.js`); os hooks servidos pelo daemon o recebem no env da chamada (por `session_id`); as tools MCP pelo `session_id` quando houver, senão pela pasta da sessão — só se TODAS as sessões gravadas daquela pasta declararem o mesmo id (uma sessão sem o override nunca o herda). Teste nas 3 camadas + 4 mutações pegas; **prova no Claude Code real** (sandbox novo, HEAD 273583e, sessão com `CCB_PROJECT_ID=iso/envid-proof` numa pasta com id declarado `iso/smoke`): `brain_count` sem argumentos → `iso/envid-proof`. Num sandbox onde a pasta já tinha 3 sessões sem o override, devolveu `iso/smoke` — a regra de unanimidade agindo como desenhado.
- [x] No modo HTTP, um agente num subdiretório de um projeto sem git, chamando sem `sessionRoot`, é recusado: sem o teto `CLAUDE_PROJECT_DIR`, o `findProjectRoot` (`scripts/lib/project-id.js` ~198) só olha o próprio `cwd` e o toplevel git, e não sobe até o `.memory/project.json` da raiz. Fazer os clientes mandarem sempre o `sessionRoot`, ou subir até achar um marker quando não há teto.
  **RESOLVIDO em 2026-10-02** (decisão do usuário, revertendo a regra da F1): sem teto e sem git, o `findProjectRoot` sobe até 8 níveis procurando `.memory/project.json` e para ANTES da home (marcador em `~` nunca é adotado). Testes: subida até o marcador, home não adotada, limite de 8 níveis.
- [x] Quem fixou `backend.mcpMemory.projectId` na config passa a ver o aviso de "sem project id" nas pastas sem id, porque essa config deixou de valer como id da pasta. Decidir se o aviso deve citar essa config (ela não liga mais a memória) ou se ela deve voltar a contar como degrau da escada.
  **RESOLVIDO em 2026-10-02** (decisão do usuário): o aviso cita o valor de `backend.mcpMemory.projectId` e explica que ele não liga mais a memória da pasta. Teste.

## Config/Hooks

- [x] Curadoria (Stop hook): o comando de subagente `cd …/model-router && cat protocols/anthropic.js protocols/index.js; grep -n "wireProtocol…" upstream-profile.js` foi reportado com a sig de OUTRO comando (`sed 1452,1620p ".../r9-v228.diff"`), que já é alias do `read-slice` — contagem 6/3 acumulada numa sig errada força curadoria sem saída. Investigar a derivação da sig em comandos compostos/`cd &&` (achado 2026-09-24). Recorrência em 2026-09-24: `git diff HEAD … CHANGELOG.md` veio com a sig `ssh mac-ts "echo '--- listening ports` (50/3), `wc -l byok-model.js …` com a sig `sed 1452,1620p …r9-v228.diff` e `cat -n byok-model.js` com `grep "function mergeRouterSection" upstream-profile.js`. Como essas sigs erradas já passaram do teto, `curation_mark_oneoff` as recusa e o Stop hook bloqueia sem saída válida. Nova recorrência em 2026-09-25: `cd …; git diff servers/model-router/protocols/openai-chat.js | head -150; sed -n 150,215p …` veio de novo com a sig `ssh mac-ts "echo '--- listening ports` (50/3); `curation_mark_oneoff` recusou. Mais uma em 2026-09-25 (sessão retomada): `git diff --quiet refs/ccb-snap/r21 -- claude-code-boss && echo …; test -f …byok-model.js` e o `git diff refs/ccb-snap/r20 refs/ccb-snap/r21 --stat …` do tester r21, ambos com a mesma sig `ssh mac-ts …` (50/3); e o `s=$(git stash create) && git update-ref refs/ccb-snap/r22 …` com a sig `git show HEAD:claude-code-boss/servers/model-router/index.js` (6/3). Na r23, três `git diff` r22↔r23 do orquestrador caíram de novo na sig `ssh mac-ts …`. Na r24, um composto do tester (`mkdir -p $S && ls …; ls .vscode/scripts/test-units.mjs; head -40 .vscode/scripts/test-units.mjs`) foi atribuído ao script curado `test-units.mjs` e gerou um pedido de REFINE "curated-success-noisy" sem o script ter rodado. Na r26 repetiu com uma leitura pura (`sed -n '1,60p' .vscode/scripts/test-units.mjs`). Na r27 o Stop hook gerou a sig de 1 token `/tmp/r27rev` (composto `W=$(cygpath -w /tmp/r27rev …); node -e …`) e o `curation_mark_oneoff` recusou essa mesma sig como "too broad": o hook pede uma sig que o próprio tool não aceita. Na r28 o mesmo aconteceu com a sig `ls` já no teto (17/3, vinda de comandos compostos de subagentes como `cd …; ls -a; du -sh …`): o hook exige curar, o `curation_mark_oneoff` recusa, e um script curado para `ls` não faz sentido. Na r29 apareceram mais dois casos: a sig `"$TEMP")/r29rev"` (8/3) é um pedaço da atribuição `D="$(cygpath -u "$TEMP")/r29rev"` e junta comandos diferentes (recusada por ter 1 token); e `node iso.js` (4/3) é o harness de mutantes que cada tester recria em `$TEMP` a cada rodada — o tool recusa marcar e exige curar um arquivo temporário. O REFINE do `.vscode/scripts/test-units.mjs` voltou a vir de uma leitura pura (`read-slice.mjs .vscode/scripts/test-units.mjs 1 80`). Na r33, um `sleep 240; grep -v … full-mut.txt | cut …` de subagente veio com a sig `sed '621,625p' servers/model-router/index.js` (3/3, no teto, recusada), e três `git diff refs/ccb-snap/r32 refs/ccb-snap/r33` com a sig `ssh mac-ts …` de novo. Em 2026-09-25 (spike S0, `launcher-genai`), um `cat > s0-inject.js <<'EOF' … EOF` que cria um arquivo com heredoc virou a sig de 1 token `cat` (15/3): o hook exige curar e o `curation_mark_oneoff` recusa por ser "too broad", o mesmo impasse da r27/r28. No mesmo dia, na sessão do patch "pasta sem id = memória off", a sig `cat` chegou a 20/3 (heredocs `cat > …` e leituras `cat arquivo | …`). Continua sem saída; as outras 37 sigs da rodada foram marcadas one-hit normalmente. Na rodada seguinte da mesma sessão, o `curation_mark_oneoff` recebeu a sig `git diff docs/BACKLOG.md` (1/3) e a recusou respondendo com a sig `ssh mac-ts …` (50/3). Como ela veio num lote, o lote inteiro de 20 foi recusado; marcadas uma a uma, as outras 19 passaram. O problema está no próprio tool, que mapeia a sig recebida para outra, não só no Stop hook.
  **JÁ RESOLVIDO**: comando de subagente não entra mais na curadoria do pai (U5, `agent_id`) e o composto assina por segmento de trabalho (U4) — a sig não pode mais vir de outro comando.

- [x] `.vscode/scripts/git-diff-files.mjs` (script curado): argumento que não casa com nenhum arquivo, ou opção desconhecida, vira pathspec e o script responde `OK: no diff` — falso negativo mudo. Ex.: `git-diff-files.mjs refs/ccb-snap/r21 refs/ccb-snap/r22 --stat` disse "no diff" com 4 arquivos diferentes entre os snapshots (achado em 2026-09-25). Recusar opção desconhecida e caminho que não existe nem no disco nem no git, com `FAIL`.
  **RESOLVIDO em 2026-10-02** (local): opção desconhecida → FAIL; caminho que não existe na árvore nem nas refs comparadas → FAIL com dica ("parece uma ref — use -r"). Validado: README sem diff → OK; o caso do relato (`refs/... refs/... --stat`) → FAIL; arquivo apagado mas presente na ref antiga → mostra o diff.

- ~~`claude-code-boss/hooks/hooks.json`'s bloco Stop hook referencia um caminho absoluto específico da máquina do Allan~~ — **RESOLVIDO em 2026-09-16**, diagnóstico corrigido em relação à entrada original: `execution-guard-stop.js` não existe em lugar nenhum dentro do plugin (`claude-code-boss/scripts/`), só em `C:\Users\allan\Desktop\Projetos\claude-code\.claude\scripts\` — a pasta `.claude` pessoal de Allan, um nível ACIMA do repo do plugin. Ou seja, trocar pelo placeholder `${CLAUDE_PLUGIN_ROOT}` (como a entrada original sugeria) teria só trocado um caminho quebrado por outro (`MODULE_NOT_FOUND` pra todo usuário, já que o arquivo não é distribuído com o plugin). Correção real: a entrada de hook inteira foi removida do `Stop` array em `hooks/hooks.json` — era um script de debug pessoal vazado pro arquivo versionado, não uma dependência do plugin.

## Docs

- [x] `docs/CONFIGURATION.md`: a tabela do router não tem linhas para `byok.modelMap` nem `byok.modelInjection` (só o README e o CHANGELOG da 2.29.1 descrevem). Achado em 2026-09-25 durante o `byok.openaiCompat`, que ganhou a sua linha; acrescentar as duas com tipo, default (`[]`/`null`) e o resumo das regras de validação.
  **RESOLVIDO em 2026-10-02**: linhas de `byok.modelMap` (objeto origem→destino ou lista; ordem de casamento, limites) e `byok.modelInjection` (placeholder `{model}`, campos recusados), conferidas contra `byok-model.js`.

- ~~`claude-code-boss/CHANGELOG.md`'s entrada `[2.25.0]` não menciona a mudança de timeout BYOK/`fixedEndpoint`~~ — **RESOLVIDO em 2026-09-16**: entrada "Added — BYOK: timeout por tipo de endpoint, sem limite opcional, e log de latência" adicionada ao `[2.25.0]`, cobrindo `fixedEndpoint`, `fixedTimeoutMs`/`rotatingTimeoutMs` (incluindo a semântica de `0` = sem limite) e `logLatency`, junto dos 4 env vars novos.

## Arquitetura

- [x] Fase G (2.29.1, anotado em 2026-09-30) — `.mcp.json` tem a porta do brain-server fixa na URL (`http://127.0.0.1:38217/mcp`): quem define `BRAIN_HTTP_PORT` precisa editar o `.mcp.json` à mão, e a edição some a cada atualização do plugin. Sincronizar a URL com a porta efetiva exige mudança de arquitetura (o Claude Code lê o `.mcp.json` estático).
  **RESOLVIDO em 2026-10-02**: url `http://127.0.0.1:${BRAIN_HTTP_PORT:-38217}/mcp` — o Claude Code expande `${VAR:-default}` na `url` (docs MCP › env var expansion, https://code.claude.com/docs/en/mcp, acesso 2026-10-02). Prova no Claude Code real: sandbox com `BRAIN_HTTP_PORT=38219` só no env → `brain_count` respondeu do daemon 38219 (`iso/smoke`), daemon real intocado.
- [x] Fase G (2.29.1, anotado em 2026-09-30) — timeout de `mcp_tool` sem abort no daemon: movido para **G5** acima (resolvido lá).
- [x] Fase G (2.29.1, anotado em 2026-09-30) — as 12 tools `hook_*` aparecem na lista de tools do modelo (descrição marca como internas). Avaliar esconder do `tools/list` sem quebrar a chamada via `mcp_tool`.
  **RESOLVIDO em 2026-10-02**: fora do `tools/list` (o `mcp_tool` chama pelo nome). Provado no Claude Code real 2.1.283 (sandbox): o modelo não as enxerga, o PostToolUse seguiu gravando o journal e o error-guard (PreToolUse bloqueante) negou a 3ª execução. Teste com o daemon real via HTTP: não listadas, mas chamáveis.
- [x] Fase G (2.29.1, anotado em 2026-09-30) — o `user-prompt-submit-dispatcher` ainda sobe 1 processo Node por prompt para `brain-daemon-ensure`/`brain-health`/`brain-status` (excluídos por dependência circular com o daemon), e `policy-inject`/`model-router-ensure` seguem como `command`. Desenhar o tratamento próprio deles.
  **RESOLVIDO em 2026-10-02 (desenho final)**: `policy-inject` já é `mcp_tool` no SubagentStart (G6); o `model-router-ensure` entrou no mesmo processo (G7). O processo único por prompt fica por desenho — health/status/ensure checam o PRÓPRIO daemon (dependência circular). Medido: ~120 ms por prompt (75 ms são só o boot do Node); é 1 por prompt, não por ferramenta, então não gera fan-out. Novo: em prompt sintético (`<task-notification>` de subagente) os avisos (health/status) são pulados e só os ensures rodam. Teste.
- ~~`servers/model-router/protocols/openai-chat.js`: um turno assistant só com blocos `thinking` (sem texto nem `tool_use`) vira `{"role":"assistant","content":null}` sem `tool_calls`, fora da spec do Chat Completions.~~ — **RESOLVIDO em 2026-09-25, na própria 2.29.1** (o reviewer r19 apontou que estava dentro do botão da feature `assistantEmptyContent`): sem `tool_calls` o turno sai sempre com `content: ""`; `null` só com `tool_calls` e a opção no padrão. Teste `openai-chat: assistant sem texto e sem tool_use (só thinking ou vazio) sai com content "" em qualquer opção`.
- [x] `servers/model-router/index.js` (`handleLimitExceeded`, ~1833) + `byok.js` (`resolveUpstream`, ~152): no fallback `on-limit`/cooldown, BYOK ligado com Base URL (ou, sem ela, o primeiro endpoint) ausente ou inválida vira `misconfigured` e o plano B segue para a NVIDIA só com `logger.error` — o usuário não vê a causa. Já um perfil de protocolo inválido (`openaiCompat`, `wireProtocol`, URL de operação) responde com a causa (2.29.1). Pré-existente; anotado em 2026-09-25 pelo tester r19. Decidir se o `misconfigured` também responde com a causa em vez de ceder à NVIDIA. Caso vizinho (tester r21): sem Base URL, `endpoints.generate: '   '` (só espaços) com `endpoints.models` válido vira `misconfigured` em `resolveUpstream`, que não apara a string, enquanto `resolveOperationProfile` apara e trataria `generate` como ausente — as duas funções discordam sobre o mesmo valor. Variantes (reviewer e tester r22): Base URL `'   '` com `endpoints.generate` válido vai para a NVIDIA (`resolveUpstream` não apara), enquanto o perfil usaria o `generate`; e `endpoints.generate` que não é texto (`123`, `true`, `{}`) é descartado sem aviso por `resolveOperationProfile` (`upstream-profile.js:151`) — com Base URL válida o router deriva o endpoint e chama o BYOK em silêncio, sem Base URL vira `misconfigured`. Fail-loud pediria `{ok:false}` para `endpoints[op]` presente que não é texto.
  **RESOLVIDO em 2026-10-02**: a causa (BYOK mal configurado ou falha ao iniciar) vira `note` exibida na resposta que o usuário lê — no aviso da NVIDIA, na falha da NVIDIA e na mensagem sem chave. Teste nos dois casos; mutação: a resposta saía só com "Plano B ativo".
- [x] `servers/model-router/index.js` (rota `local:catalog`, ~3262): quando o perfil `models` é inválido (qualquer causa, inclusive `byok.openaiCompat` inválido), `GET /v1/models` encurtado para o catálogo local responde `200 {"data": []}` e a rota não loga nada (o aviso só aparece se outra request passar por `maybeWarmCatalog`) — lista vazia silenciosa. Pré-existente para qualquer erro de perfil; anotado em 2026-09-25 na revisão r19. Decidir se responde `502` com a causa, como o passthrough.
  **RESOLVIDO em 2026-10-02**: perfil de models inválido (não a falta opcional de credencial) → aviso no log, `/v1/models` 502 com a causa e `/catalog` com `error`. Teste; mutação: sem a correção, 200 com lista vazia.
- [x] `servers/model-router/index.js` (`byokFallback` → `reportFailure`, ~1765): no fallback `on-limit`/cooldown, as falhas de transporte do BYOK ("resposta passou do teto", "conexão caiu no meio da resposta", "está inacessível") saem sem o hint de quando o Claude volta; só as recusas locais e as do endpoint (`byok.userAdvice(..., hint)`) trazem. Pré-existente; anotado em 2026-09-25 pela revisão r20. Decidir se essas mensagens também anexam o hint.
  **RESOLVIDO em 2026-10-02**: as 3 falhas de transporte do BYOK (teto, conexão caída, inacessível) levam o mesmo `⏳ hint` das recusas. Teste; mutação: "inacessível" saía sem o hint.
- ~~`servers/model-router/index.js` (rotas `passthrough`, ~3285-3310): `/v1/models` e `/v1/messages/count_tokens` são declaradas com `auth: 'signature'` (~189-190), mas o ramo `passthrough` retorna antes da checagem de assinatura (~3328-3334).~~ — **RESOLVIDO em 2026-09-25, na 2.29.1**: a checagem de auth foi movida para o início do despacho declarativo; teste `router: rotas passthrough com auth signature … → 401, BYOK não é chamado`. Registro original: Request sem `x-api-key` nem `authorization` é aceita, e sob BYOK o router anexa a credencial configurada do usuário. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pela revisão r30 do gate da 2.29.1. Possível problema de segurança: mover a checagem de assinatura para antes do passthrough. Na correção, o teste `BYOK openaiCompat inválido no catálogo local…` precisa mandar o header de assinatura no `GET /v1/models`.
- [x] `servers/model-router/index.js` (cooldown com custom upstream): a geração só aplica o cooldown quando o upstream é a Anthropic real (`isRealAnthropic`, ~2944-2948), mas count_tokens, catálogo e classify remoto usam `cooldownActive` sem essa checagem (~2858, ~3147, ~468/~585). Com o custom upstream ligado e um cooldown ainda ativo (ex.: restaurado de `cooldown.json`, `loadCooldown` ~2021), a geração vai ao gateway e as rotas laterais vão ao BYOK. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pelo tester r31 do gate da 2.29.1. Decidir se `cooldownActive` também exige a Anthropic real como upstream.
  **RESOLVIDO em 2026-10-02** (decisão: sim): o cooldown é a janela da assinatura Anthropic; `cooldownActive` agora exige a Anthropic real como upstream base (mesma regra da geração), então count_tokens/catálogo/classify não divergem mais para o BYOK com gateway custom. Teste no `cooldownActive` (gateway → false; Anthropic real → true).
- [x] `servers/model-router/byok.js` (`resolveUpstream`, ~120-131): com `upstream.enabled: true` e uma URL operacional inválida (Base URL ou, sem ela, o primeiro endpoint), `parseBaseUrl` devolve `null` e o bloco é pulado sem log: a request segue para a Anthropic real, com o usuário achando que está no custom upstream. Pré-existente no HEAD `44a9ff6`; anotado em 2026-09-25 pela revisão r32 do gate da 2.29.1. Fail-loud pediria erro visível (`misconfigured` com a causa) em vez de cair na Anthropic em silêncio.
  **RESOLVIDO em 2026-10-02**: `resolveUpstream` marca `upstreamMisconfigured`; geração e passthrough (count_tokens/models) respondem 502 com a causa e o catálogo devolve erro — nunca seguem para a Anthropic real (destino que o usuário não escolheu, com a credencial dele). Teste sob a trava de egress; mutação: sem a correção o alvo virava api.anthropic.com sem marca.

- ~~`CCB_PROJECT_ID` (env, documentado como o jeito de "fixar" o projeto quando lições somem ao trocar de pasta/máquina — `CONFIGURATION.md`/`TROUBLESHOOTING.md`) seria silenciosamente ignorado por `brain_retrieve_context`.~~ — **RESOLVIDO em 2026-09-21 (achado da auditoria original era FALSO-POSITIVO — não havia bug no código atual)**: a entrada original (2026-09-20, auditoria Fase 0 do ADR-014) alegava que `resolveProjectChain`'s `tryResolveProjectId({cwd})` "nunca olha `CCB_PROJECT_ID`". Investigação (2026-09-21) releu `scripts/lib/project-id.js`'s `_resolveWithStrength({cwd, env=process.env, ...})` (linhas 260-285): o "Rung 1 — env override (explicit, wins over everything)" checa `CCB_PROJECT_ID` incondicionalmente ANTES de qualquer inspeção de `cwd` (`const forced = sanitize(env && env.CCB_PROJECT_ID); if (forced) return {id: forced, strength:'env'};`). Verificado empiricamente com dois scripts `node -e`: um passando `env` explícito, outro reproduzindo a assinatura EXATA usada em produção por `resolveProjectChain({cwd, sessionRoot})` (sem `env` explícito, dependendo do default `process.env`) — ambos confirmam que `focusId` (usado como `focusId || project` no handler de `brain_retrieve_context`, `mcp-server.js:917-923`) honra corretamente o override. `git log --oneline -- scripts/lib/project-id.js` mostra que essa lógica já existia antes da data da auditoria original — a auditoria leu o código errado, não um comportamento que foi corrigido depois. **O gap real, genuíno, era só de cobertura de teste**: nenhum dos 3 testes existentes com `CCB_PROJECT_ID` (`scripts/test-units.js`) cobria especificamente `resolveProjectChain`'s `focusId` (cobriam só `resolveProjectId`/`projectIdStrength`/`pia.needsNudge`). Fechado com um teste de regressão novo (`project-id resolveProjectChain: env CCB_PROJECT_ID wins as focusId over the cwd's own git-remote/marker identity, not just resolveProjectId`), usando um `cwd` isolado com git-remote fake próprio (`fakeGitWithRemote`) pra provar que o override vence mesmo quando o cwd teria uma identidade PRÓPRIA e diferente — trava o comportamento correto atual, não corrige nada. Nota: `chain` (a spine de ancestrais pra recall) continua incluindo o git-remote real do `cwd` mesmo com o override — isso é intencional (ancestor-spine é sobre a árvore de diretórios real, não sobre a identidade ativa forçada) e não contradiz a garantia testada, que é só sobre `focusId`. Suite completa: 1033 passed / 0 failed.

- ~~`brain-config.js`'s `save()` sem proteção contra "lost update" entre saves concorrentes~~ — **RESOLVIDO em 2026-09-17** via CAS/versionamento otimista. Uma entrada anterior deste item afirmava que só existia um call-site (`mcp-wizard.js`'s `start()`) e que ele já era seguro; isso estava **errado** — revisão adversarial encontrou um segundo call-site independente, `dashboard.js`'s `saveBrainConfig` (rota `PUT /api/brain/backend-config`), que duplicava a mesma lógica de `deepDiff(shipped, parsed)` contra o MESMO arquivo (`globalDir()/user-config.json`) sem passar por `save()`. Uma primeira tentativa de correção (merge do override atual antes de diffar) foi **revertida** por estar quebrada: `config` é sempre um snapshot COMPLETO do caller (nunca um delta), então o merge não conseguia distinguir "mudança intencional" de "visão stale" e acabava reproduzindo o mesmo bug relocado (provado por teste + reprodução isolada). **Correção real**: um inteiro `_v` é gravado junto do diff dentro do PRÓPRIO `user-config.json` (`_onDiskVersion`, `load()`/`loadWithVersion()` em `brain-config.js`) — `loadWithVersion()` retorna `{config, version}` atomicamente (Node é single-thread, cache-populate e version-capture no mesmo bloco síncrono); `save(config, {expectedVersion})` só aceita a escrita se o `_v` em disco ainda for esse mesmo baseline, senão lança `err.code='BRAIN_CONFIG_CONFLICT'` (fail-loud, nunca sobrescreve às cegas) — `expectedVersion` é opcional, então callers antigos (helpers de teste que escrevem o override direto via `fs`) continuam com o comportamento last-write-wins sem precisar mudar. `_v` é estritamente um campo de wire/persistência: `load()` o extrai e remove antes do merge (nunca vaza pros getters), e o wire protocol HTTP usa `_version` como campo irmão (GET inclui, PUT exige e `dashboard.js` faz `delete parsed._version` antes de validar/persistir). Os dois call-sites de produção foram migrados: `mcp-wizard.js`'s `start()` (via `loadBrainConfigWithVersion()` + `saveBrainConfig(cfg, {expectedVersion})`, propagando o conflito pro catch existente) e `dashboard.js`'s `getBrainConfig`/`saveBrainConfig` (retornam HTTP 409 no conflito). Corrigido de brinde um bug fail-loud pré-existente e não relacionado descoberto ao implementar isso: `dashboard/index.html`'s `saveBrainBackendConfig()` nunca checava `result.error` — qualquer erro do servidor (validação OU o novo 409 de CAS) era tratado como sucesso silencioso ("Salvo!"); agora checa `result.error` explicitamente e adota `result.version` como novo baseline pro próximo save da mesma página. 5 testes novos em `scripts/test-units.js` (seção "item 5: brain-config CAS"), incluindo a reprodução direta do lost-update original (caller A carrega em v0, caller B salva primeiro bumpando pra v1, A tenta salvar com seu baseline v0 stale e é rejeitado — mudança de B verificada intacta em disco). Suite completa: 1017 passed / 0 failed.

- ~~Um único `kb-worker` (worker_thread) serve TODOS os projetos do daemon — throughput serial entre projetos, não só dentro de um projeto.~~ — **RESOLVIDO em 2026-09-21 (ADR-014, implementação completa)**: item original (2026-09-17, fix do bug de `/health` travando) marcava isso como YAGNI sem pesquisa. Investigação completa (agente `researcher`, fontes: docs oficiais Node, docs oficiais `better-sqlite3` — que **recomenda oficialmente** pool de N workers via `os.availableParallelism()` para exatamente este caso — issue público `openclaw/openclaw#138474`) reverteu a decisão. **ADR-014** (`docs/adr/ADR-014-kb-worker-pool.md`) e o **Plano de implementação** (`docs/plans/PLAN-kb-worker-pool.md`) passaram por gate de 5 rodadas de revisão adversarial+testabilidade independentes, fechando com **ZERO achados**. Implementado: pool de N `worker_threads` (mesmo `kb-worker.js`, sem alteração de conteúdo) com roteamento sticky por projeto (`workerIndex = hash(canonicalProject) % N`, função `canonicalProject`/`workerIndexFor` em `kb-worker-client.js`) e lock por worker (não mais global), cobrindo os 4 módulos singleton (`brain-store.js`/`brain-index.js`/`brain-graph.js`/`metrics-store.js`). Fases 0-3 (auditoria, roteamento, lock, testes) concluídas com suíte automatizada; **Fase 4 (smoke manual)** validada com evidência real: dois projetos concorrentes caem em workers diferentes (`workerIndex A=0 B=1`), suas janelas `[startedAt,finishedAt]` genuinamente se sobrepõem (não só "ambos rápidos"), e `/health` responde em `max=5ms` sob carga concorrente (< 200ms). Ressalvas registradas no próprio Plan: a validação exigiu forçar o backend `local` in-process (monkeypatch de `backend.peekMode()`, nunca persistido em disco) porque a config de produção real desta máquina usa `backend.type: 'mcp-memory'` (remoto) — o pool não é exercitado pelas sessões do dia a dia aqui; e a amostragem de latência do `/health` no smoke ficou fina (`samples=2`) por limitação do harness (cliente+servidor no mesmo processo Node). Commit feito em 2026-09-21 (`52a8d30`).
- ~~`withLock` (`mcp-server.js:390-396`) serializa KB_TOOLS só DENTRO de uma sessão HTTP, não ENTRE sessões~~ — **RESOLVIDO em 2026-09-17**: achado de forma independente tanto por um agente `reviewer` quanto pelo agente `tester` (revisão de testabilidade do patch de `kb-worker`), CRÍTICO — verificado por leitura direta do código (não só relatado pelos agentes): `_chain` era uma variável de closure dentro de `createBrainServer()`, e `http-daemon.js` chama `createBrainServer(...)` UMA VEZ POR SESSÃO NOVA, então cada sessão MCP tinha seu próprio mutex, todas compartilhando o MESMO singleton de módulo `_db`/`_project`/`_index`/`_graph` (`brain-store.js`/`brain-index.js`/`brain-graph.js`) que `getKB(project)` troca a cada chamada — Sessão A rodando `getKB('projA')`→`store.search(...)` podia ser intercalada pela Sessão B trocando `_project`/`_db` pro projeto B no meio, lendo/escrevendo no banco ERRADO. Pré-existente ao patch de `kb-worker` (mesmo singleton, mesmo mutex por-sessão já era assim antes), mas o patch alargou MUITO a janela: antes cada chamada SQLite era síncrona e monopolizava a thread principal (bloqueio "acidentalmente" serializava tudo); depois do worker, cada `await store.X()` é um round-trip de mensagem real que cede o event loop pela duração inteira da chamada. **Correção**: nova factory exportada `createKbLock()` em `mcp-server.js`, instanciada UMA VEZ por processo daemon em `http-daemon.js` (ao lado do `kbWorker`, já único-por-processo) e passada como `kbLock` pra TODO `createBrainServer({..., kbLock})` — todas as sessões agora compartilham o mesmo mutex (`mode:'stdio'`, que nunca tem sessões concorrentes no mesmo processo, continua caindo no fallback `kbLock || createKbLock()`, seguro). **Provado empiricamente** (não só por leitura de código): 2 testes novos em `scripts/test-units.js` (seção "kbLock cross-session serialization") — um positivo (duas instâncias reais de `createBrainServer({mode:'http', kbLock:sharedLock})` disparando `brain_count` concorrente pra dois projetos diferentes NUNCA intercalam) e um controle negativo (as MESMAS duas instâncias SEM `kbLock` compartilhado intercalam de fato — prova que o teste tem poder de detecção real, não é um falso-negativo estrutural). Suite completa: 1007 passed / 0 failed após o fix. Corrigido também de brinde o handler `policy_shadow_report` (`mcp-server.js`), que fazia `require('metrics-store.js')` síncrono direto no main thread (mesma classe do bug original de `/health` travando) — agora roteia por `kbWorker.metricsClient` como os demais call-sites, com teste dedicado provando o roteamento. **Rodada de revisão fresca subsequente (obrigatória pela regra de gate — correção não fecha sem revisão independente com zero achados) encontrou um TERCEIRO call-site da MESMA classe de bug**: `brain_retrieve_context` — o `KB_TOOLS` de maior frequência, dispara em TODO `UserPromptSubmit` — chamava `retrieve-core.js`'s `retrieve()`, que fazia `require('../brain-store.js')` direto no topo do arquivo e rodava `store.init()`/`searchTwoPass()` (SQLite síncrono via better-sqlite3) na main thread do daemon, ignorando o `kbWorker` por completo. Corrigido: `retrieve()` ganhou um 3º parâmetro `deps` (mesmo padrão já usado por `retrieveRemote`), com `deps.store` sobrepondo o require direto; o call-site em `mcp-server.js` (`case 'brain_retrieve_context'`) agora passa `kbWorker ? { store: kbWorker.storeClient } : {}`, espelhando o padrão de `getKB`/`recordLessonMetric`/`policy_shadow_report`. Teste dedicado adicionado (`brain_retrieve_context: routes retrieve-core's local search through kbWorker.storeClient when kbWorker is present`) que substitui `retrieve-core.js`'s `retrieve` exportado por um espião (mesmo módulo via cache do `require`, mesmo caminho absoluto que o handler usa) e prova que `deps.store === kbWorker.storeClient` chega até ele. Suite completa após este segundo fix: 1008 passed / 0 failed. **A rodada de revisão fresca subsequente DE FATO rodou** (via agente `reviewer` independente, background) — confirmou o fix do `withLock`/`kbLock` e do `brain_retrieve_context` corretos, mas achou um **QUARTO call-site da MESMA classe de bug, ainda não coberto**: `getKB()` (`mcp-server.js`) gateava `store` por `kbWorker` mas fazia `require(...brain-index.js)`/`require(...brain-graph.js)` incondicional — `index.init()`/`graph.init()` (chamados em TODA invocação de `getKB()`, ou seja em `brain_search`, `brain_store`, `capture_lesson`, `brain_related` e até `brain_count`) rodavam `fs.readFileSync`/`writeFileAtomic` síncronos na main thread do daemon, reproduzindo o bug original pra dois módulos que usam `fs` em vez de SQLite. (Nota: a mensagem do commit anterior alegava uma segunda rodada limpa já concluída — isso era falso; o texto acima, mantido sem edição até esta revisão, estava certo.) **Corrigido em 2026-09-18**: `servers/brain-server/lib/kb-worker.js` ganhou `index`/`graph` no mapa `modules` (mesmo worker_thread do `store`/`metrics`); `servers/brain-server/lib/kb-worker-client.js` ganhou `INDEX_METHODS`/`GRAPH_METHODS` (extraídos dos `module.exports` reais de `brain-index.js`/`brain-graph.js`) e `indexClient`/`graphClient` no retorno de `createKbWorkerClient()`; `getKB()` agora gateia `index`/`graph` exatamente como já gateava `store`: `kbWorker ? kbWorker.indexClient : require(...)`. Zero mudança nos call-sites (`kbIndex.*`/`kbGraph.*` em `mcp-server.js`) — já eram `await`-based, mesmo padrão que permitiu migrar `store` sem tocar call-sites. Testes novos: o teste de sincronia de arrays (`STORE_METHODS/METRICS_METHODS stay in sync...`) foi estendido pra `INDEX_METHODS`/`GRAPH_METHODS` contra os exports reais dos dois módulos; teste de roteamento dedicado (`capture_lesson: getKB() routes index/graph through kbWorker.indexClient/graphClient...`) prova via `kbWorker` fake que `capture_lesson` (que usa `store`+`index`+`graph` na mesma chamada) realmente atravessa os clients do worker e não cai no require direto. Suite completa após este terceiro fix: 1018 passed / 0 failed. **Rodada de revisão independente fresca sobre este terceiro fix RODOU (agente `reviewer`, background, 2026-09-18) e retornou APPROVE com ZERO achados**: leu por completo o estado atual (não o relato) de `kb-worker.js`, `kb-worker-client.js`, `getKB()`+todos os call-sites `kbIndex.`/`kbGraph.` em `mcp-server.js`, `brain-index.js`/`brain-graph.js` inteiros (conferiu `INDEX_METHODS`/`GRAPH_METHODS` manualmente linha a linha contra os `module.exports` reais, não só confiou no teste automatizado), `retrieve-core.js`, `http-daemon.js`; grepou o repo inteiro por outros `require` diretos de `brain-index.js`/`brain-graph.js` fora do daemon compartilhado (achou vários em `dashboard.js`/`brain-cli.js`/scripts standalone/hooks — todos em processos separados, fora do escopo do bug ADR-001, confirmado que nenhum roda dentro do processo do daemon); traçou manualmente o teste de roteamento novo pra confirmar que ele de fato falharia sem o fix (não é vacuous); confirmou que `save()` é privado em ambos os módulos e só é chamado internamente por métodos já cobertos pela lista `INDEX_METHODS`/`GRAPH_METHODS`; confirmou que nenhum call-site faz `instanceof`/comparação de referência que quebraria com o proxy do worker; confirmou o fallback simétrico em modo `stdio`; e confirmou que o `kbLock` único-por-processo ainda cobre corretamente os 3 `await`s sequenciais de `getKB()` (`store.init`/`index.init`/`graph.init`, agora 3 round-trips de mensagem separados) contra intercalação entre sessões. **Gate fechado — item RESOLVIDO por completo, sem pendência.**
- ~~`dashboard.js`'s `normalizeTimeoutMs` duplica a mesma lógica de validação de `byok.js`'s `normalizeTimeoutOverride`~~ — **RESOLVIDO em 2026-09-18**: extraída pra `scripts/lib/normalize-timeout.js` (função única `normalizeTimeoutMs`). A premissa original ("dashboard.js não importa `servers/model-router/*`") apontava pra direção errada de dependência — `servers/model-router/index.js` já importa de `scripts/lib/*` (`router-mode.js`, `router-config-path.js`, `router-fingerprint.js`), então o util compartilhado foi colocado em `scripts/lib/` (onde já mora o resto do código reusável) e ambos os lados passaram a importar de lá: `byok.js` agora tem `normalizeTimeoutOverride` como alias do import (mantém o nome exportado — usado por `scripts/test-units.js` — sem quebrar call-sites existentes), e `dashboard.js` removeu sua cópia local e importa direto. Suite completa: 1017 passed / 0 failed.

- [x] `scripts/dashboard.js` (declaração de `resolveRouterFlags`) — `}function resolveRouterFlags() {` colado na chave de fechamento da função anterior (pré-existente no HEAD `44a9ff6`; achado em 2026-09-23 durante o mapeamento de modelo do BYOK). Só formatação: quebrar a linha.
  **RESOLVIDO em 2026-10-02**: linha quebrada.
- [x] `.vscode/scripts/diff-router-copies.mjs` (local, fora do git) — `resolveCachePath` devolve o PRIMEIRO diretório de `plugins/cache/.../claude-code-boss/` que tiver `servers/model-router/index.js`, não o SHA ativo em `installed_plugins.json`. Com várias cópias em cache, compara contra uma versão velha. Corrigir lendo `installPath` de `~/.claude/plugins/installed_plugins.json` (achado em 2026-09-23).
  **RESOLVIDO em 2026-10-02** (local): lê o `installPath` de `installed_plugins.json`; falha alto se o registro estiver ilegível. Rodado: idêntico à instalação ativa.
- [x] `scripts/dashboard.js` (POST `/api/router/config`, normalização do `byok` em `writeRouterOverride`, ~1527-1616) — um `byok` parcial sem `enabled` (ex.: `{byok:{mode:'always'}}`) desliga o BYOK, e com isso o padrão KEEP preserva sem aviso uma `modelMap`/`modelInjection` inválida já gravada. O teste em `test-units.js` (~13304) não confere `enabled`. Achado em 2026-09-24 no gate r6 do `byok.modelMap` (2.29.1).
  **RESOLVIDO em 2026-10-02**: `enabled` e `mode` agora seguem o preserve-on-absent dos outros campos (um `byok` parcial mantinha nada: desligava o BYOK e voltava o modo a on-limit). Com o BYOK preservado ligado, o `modelMap` inválido salvo volta a ser recusado (400). A UI manda `enabled` explícito nos dois caminhos (salvar e "Desligar tudo" via `byokEnabled:false`). O teste que fixava o defeito ("enabled NAO sobrevive") passou a exigir o correto.
- [x] `servers/model-router/index.js` (plano B BYOK, `reportFailure`/`settleRefusal`, ~1750-1795) — o log e a mensagem usam `upstreamTarget.host` em vez de `operationTarget.host`; com `endpoints.generate` num host diferente da `baseUrl`, o texto `Revise a Base URL` cita o host errado. Achado em 2026-09-24 no gate r6 do `byok.modelMap` (2.29.1).
  **RESOLVIDO em 2026-10-02**: as 9 referências do `byokFallback` usam `operationTarget.host`; a dica cita Base URL ou `endpoints.generate`. Teste: Base URL num host, generate numa porta fechada → a mensagem nomeia 127.0.0.1 (antes: "BYOK (base-host.example) está inacessível: connect ECONNREFUSED 127.0.0.1").
- [x] `servers/model-router/index.js` (handler de `/v1/messages`, ~linha 3344) — o `req.on('end', async …)` não tem try/catch nem há `process.on('unhandledRejection')` no router: qualquer exceção inesperada no fluxo encerra o processo em vez de virar um 500 para aquela request. O caso concreto (corpo JSON não-objeto: `null`, `"texto"`, `1`, `[]`) foi corrigido no hotfix 2.29.1; falta a rede de segurança geral (achado r8, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: os dois níveis assíncronos (callback do `createServer` e o `end` do corpo) passam por `failRequest` — 500 no formato de erro Anthropic (ou corte do stream se os headers já saíram), com log; e `process.on('unhandledRejection')` loga e mantém o router de pé. Teste: config que lança no meio da request → 500, `/health` segue 200, nenhuma rejeição solta; sem a correção a request pendurava (timeout).
- [x] `servers/model-router/index.js` (`anthropicToOpenAI`, tradutor do plano B NVIDIA, ~linha 1075-1094) — usa `b.text || ''` e converte tipos em silêncio: número vira string (`0` vira vazio), objeto vira `"[object Object]"` e `null` vira vazio, enquanto o adaptador OpenAI (`protocols/openai-chat.js`) já recusa com 400 desde o 2.29.1. Alinhar o tradutor NVIDIA ao mesmo contrato (achado r12, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: `shapeText` — `text` não-string (system, conteúdo, tool_result) lança `REQUEST_SHAPE` com o tipo; o catch do `nvidiaOrMessage` responde com a causa e o NIM não é chamado; `""` segue válido. Teste com 0/null/objeto; mutação: a request ia ao NIM com o texto coagido.
- [x] `servers/model-router/index.js` (`nvidiaFallback`, `byokFallback`) — quando o cliente desconecta no meio do plano B, a request ao upstream (NVIDIA ou BYOK) não é abortada: o endpoint continua gerando e gastando cota (o tester viu 30 de 30 frames enviados depois de o cliente sair). Abortar o request upstream no `'close'` da resposta ao cliente (achado r13, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: `abortOnClientClose` destrói a request ao NVIDIA/BYOK quando a resposta ao cliente fecha antes do fim; os `reportFailure` ignoram resposta já destruída. Teste: stream de 60 frames, cliente sai no 1º → upstream fechado em < 1,5 s; sem a correção o upstream seguiu até 41+ frames.
- [x] `servers/model-router/index.js` (`handleLimitExceeded`) — com `res` já destruído (o cliente saiu enquanto o router lia o corpo do 429), o plano B ainda é acionado e faz uma chamada inútil à NVIDIA/BYOK. Checar `res.destroyed` no guard do topo (achado r13, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: guarda `res.destroyed` no topo — nenhuma chamada de plano B para cliente que já saiu (teste: zero hits no upstream).
- [x] `servers/model-router/index.js` (caminho principal: leitura do corpo do 429/trigger, ~2997-3014, e ramo `>=400` de `proxyOpenAIResponse`, ~1518-1534) — corpo de erro que para de chegar sem a conexão fechar pendura o cliente: não há teto de inatividade nem prazo total, como o `armRefusalIdle` já dá às recusas do plano B no 2.29.1. Reusar o mesmo helper (achado r15, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: `armBodyDeadline` (generalização do `armRefusalIdle`) no corpo do limite (o `error` ainda dispara o plano B) e no ramo `>=400` do OpenAI-compat (agora responde 502 no formato Anthropic). Teste com tetos curtos; mutação sem os prazos → cliente pendurado.
- [x] `servers/model-router/index.js` (resposta 200 não-stream do plano B: `jsonNvidiaToAnthropic` ~1187 e o ramo não-stream de `proxyOpenAIResponse` ~1609-1645) — corpo que para de chegar sem a conexão fechar pendura o cliente (o `setTimeout(0)` depois dos headers tira o timeout do corpo). Precisa de teto de inatividade e prazo total como o da recusa (achado r15, 2026-09-24).
  **RESOLVIDO em 2026-10-02**: o 200 não-stream do NVIDIA (`jsonNvidiaToAnthropic`) e do OpenAI-compat ganha prazo de corpo próprio (`successBodyLimits`: inatividade 30 s, total 120 s — mais folgado que a recusa); o `error` cai no `reportFailure` que responde ao cliente. Mesmo teste.
- [x] `servers/model-router/index.js` (fim de stream SSE OpenAI/NVIDIA, `sseTailFrame`) — limite conhecido: um corpo delimitado pelo fechamento da conexão (sem `content-length`/chunked) que é cortado exatamente entre duas linhas completas parece um fim limpo. Só dá para detectar exigindo `[DONE]` ou `finish_reason`, o que quebraria upstreams compatíveis que não mandam nenhum dos dois. Avaliar exigir um dos dois quando o upstream já mandou antes na mesma sessão (achado r15, 2026-09-24).
  **RESOLVIDO em 2026-10-02** (meio-termo preciso): só um corpo SEM enquadramento (sem content-length, sem chunked) pode esconder o corte — para ele, o fim exige `[DONE]` ou `finish_reason`; senão é corte (conexão destruída, log). Corpo enquadrado sem marcadores segue como fim limpo (compat com upstreams que não mandam nenhum). Teste com servidor TCP cru (NVIDIA e OpenAI) + caso enquadrado; mutação: o corte sem marcador fechava com message_stop.

## Brain / Retrieval

Achados do spike S0 (2026-09-25, sessão no `launcher-genai`, medição do que o `brain_retrieve_context` injeta de fato):

- ~~`servers/brain-server/lib/mcp-server.js` (`case 'brain_retrieve_context'`)~~ — **SUPERADO no 2.29.1**: numa pasta sem id o recall agora é desligado de propósito (vazio explícito, antes de qualquer busca); numa pasta com id o braço de projeto roda sempre e o smoke pelo `createBrainServer` no repo do boss devolve o hit do projeto em ~1 s. O stderr mudo do `catch` fail-open continua valendo como item à parte. Texto original: o hook devolveu vazio em 31 de 31 prompts reais (3 sessões) e em duas chamadas diretas pela tool; não existe nenhum `retrieval-turn-*` em `brain-data/.runtime/`, então o servidor nunca teve `entries` não-vazio. O mesmo `retrieve-core.retrieve` + `filterInjectableEntries` + `formatContext`, rodado num processo Node avulso com o mesmo `project`/`chain`, devolve 1 fato + 1 capability em 7 de 10 prompts. Causa não isolada. O `catch` fail-open (~951) só escreve no stderr do daemon, que não fica em lugar nenhum: o erro some. Tornar visível (motivo no recall-health ou no journal) antes de depurar.
- ~~`scripts/lib/project-id.js` (`resolveProjectChain`)~~ — **RESOLVIDO no 2.29.1** pela opção "avisar que o projeto não tem id": pasta sem id = memória desligada, com aviso no SessionStart e no Stop (`project-id-stop`). Texto original: num diretório sem git nem marcador (`launcher-genai`), devolve `chain: []` e `focusId: null`. O recall sai sem escopo de projeto: os 7 fatos acima vieram todos de outros projetos e nenhum servia ao prompt. Com `brain_search` escopado em `launcher-genai`, as entradas certas aparecem (score 0,79). Usar o `project` resolvido pelo cwd como foco quando não houver `focusId`, ou avisar que o projeto não tem id.
- ~~`scripts/lib/retrieve-core.js` (`retrieveRemote` → `compose_recall`)~~ — **RESOLVIDO no cliente no 2.29.1**: query truncada em 800 chars (`maxQueryChars`); prompt de 4,7k chars caiu de 11–14 s para 1,6–2,4 s. A causa do lado do servidor segue nos itens do native-java abaixo. Texto original: 3 de 10 prompts, os mais longos, estouraram os 8000 ms; os demais levaram 0,4 a 7,6 s, dentro do caminho síncrono do UserPromptSubmit. O `recall-health.json` mostra 70% degradado nas últimas 50 chamadas (221 timeouts, 55 remote-error, 25 ancestor-timeout no acumulado). Truncar o prompt antes do compose ou medir onde o memory-server gasta o tempo.
- [x] `user-prompt-submit-dispatcher.js` (BRAIN-STATUS) — injeta "mcp-memory backend unreachable" (`http://127.0.0.1:64817`) enquanto a porta está escutando e `brain_search`/`brain_count` respondem pela MCP. O aviso está errado ou mede outra coisa; conferir qual probe ele usa.
  **RESOLVIDO em 2026-10-02**: o probe usa a mesma URL do cliente (`daemon.json`, hoje 53300) e responde `connected` com a config real; o falso alarme não se reproduz — causa provável: mcp-memory reiniciando em porta nova (o `daemon.json` é reescrito) ou /health lento. Agora: 1 nova tentativa relendo o `daemon.json` e o motivo vai no aviso (`tcp-closed`, `health-timeout-or-unparseable`, `health-bad:…`). Testes: porta trocada no meio do probe → connected; porta fechada → reason.
- [x] `servers/brain-server/lib/mcp-server.js` (`catch` fail-open do `brain_retrieve_context`) — o erro só vai para o stderr do daemon, que não fica em lugar nenhum. Registrar o motivo no recall-health ou no journal.
  **RESOLVIDO em 2026-10-02**: o catch grava `retrieve-error` (novo motivo degradado) no recall-health com a mensagem em `lastDegraded.detail`; segue fail-open. Teste: handler real forçado a lançar → contexto vazio + registro com a mensagem.

Achados da correção de recall do 2.29.1 (medições no memory-server native-java 2.44.3, 2026-09-25) — lado do servidor, repo do native-java:

- `compose_recall` roda os blocos tipados em sequência (procedural[home], skill, knowledge[active]…) e refaz embed + FTS por bloco: o custo soma por bloco. Embedar a query uma vez e rodar os blocos em paralelo.
- O custo de FTS cresce com o tamanho da query (4,7k chars → 14 s no compose, 800 → 1,1 s). O cliente trunca em 800, mas o servidor devia limitar sozinho.
- Filtro de escopo aplicado depois do top-K (post-filter): com muitos docs de outros escopos, o bloco volta vazio mesmo tendo docs do projeto. Filtrar antes do ranking.
- Os blocos tipados nunca devolvem os docs que o boss grava (lessons/patterns/decisions): só o `search_memory` com `metadata.project_id` os traz. Avaliar um bloco "project docs" no compose e aposentar o braço paralelo do cliente.
- O spine home (procedural[home]) injeta procedurais graduados pelo Dreaming que são lixo (textos genéricos de sessão), com score 0,47–0,52 em prompts sem relação e 0,60–0,70 nos relevantes. Limpar o critério de graduação do Dreaming; do lado do cliente, avaliar um piso de score para o spine home (hoje sem piso — `fastTopK=1` limita o estrago a 1 fato).

Lacunas conhecidas do gate de project id (2.29.1):

- [x] `servers/brain-server/lib/mcp-server.js` (`resolveKbProject`) — sem `cwd`, um `project` explícito continua aceito sem verificação (o daemon HTTP não sabe a pasta do chamador). Ideia: amarrar a sessão MCP ao `cwd` no handshake e recusar `project` que não bata.
  **RESOLVIDO em 2026-10-02** (decisão do usuário): a sessão MCP é amarrada aos `roots` do cliente — o Claude Code 2.1.283 declara `roots` e o `roots/list` devolve a pasta do projeto quando o stream SSE já está aberto (logo após o handshake dá timeout; medido no sandbox). O daemon busca em segundo plano (1/3/8 s, refaz em `roots/list_changed`); sem `cwd`, resolve a pasta da sessão; `project` explícito diferente do id da sessão → `PROJECT_MISMATCH`; pasta da sessão sem id → memória off dito em voz alta. Sem roots: comportamento anterior. Teste (seam `_setSessionRoots`) + prova no Claude Code real.
- [x] `servers/brain-server/lib/mcp-server.js` (`handleRemoteKbTool`) — no backend `mcp-memory`, `scope: user` não é roteado para `__user__` (grava sob o projeto do handshake) e o `brain_search` ignora `scope`. O caminho local já faz isso. Rotear via `metadata.project_id` no `saveMcp` e `projectIds` no `search`, depois de confirmar que o servidor aceita `__user__` declarado pelo chamador.
  **RESOLVIDO em 2026-10-03** (`fix/backlog-zero`): contrato confirmado AO VIVO no native-java 2.44.3 (schema do `add_document`/`search_memory` + doc descartável: gravado com `project_id:"__user__"`, achado pela busca `["__user__"]`, NÃO achado pela do projeto; removido em seguida). O handler remoto espelha o local: escopo efetivo (`inferDefaultScope` no auto), `user` → `metadata.project_id = __user__` com o mesmo sanitizador e recusa de segredo; `brain_search` mapeia `scope` → `project_id` [projeto] / [`__user__`] / ambos. *Achado e corrigido na hora* (mesma classe de paridade): o `capture_lesson type:"skill"` remoto pulava a validação que o schema promete (fora da faixa → nada gravado). O backend ativo do usuário é o `mcp-memory`, então o bug era do setup real. Testes (handler remoto + `saveMcp` no fake daemon) + 6 mutações pegas.
- [x] `servers/brain-server/lib/mcp-server.js` (`resolveProject`) — no modo HTTP, um `project` explícito no formato `owner/repo` (o formato que a escada estrita produz) é zerado pelo `sanitizeProjectId` (barra recusada) e a chamada falha com `PROJECT_REQUIRED`. Visto ao vivo em 2026-09-25 com `capture_lesson project:"AllanSantos-DV/claude-code-plugins"`. Com `cwd` (2.29.1) funciona; validar `project` explícito com `assertSafeProjectId` em vez do sanitizador legado.
  **RESOLVIDO em 2026-10-02** junto com o U14 (Fase G).
- [x] `scripts/project-id-stop.js` — pastas de exploração recebem o aviso a cada turno sem opção de "não é um projeto, pare de pedir" além do opt-out global. Avaliar um opt-out por pasta.
  **RESOLVIDO em 2026-10-02** (decisão do usuário): o aviso agora também sai a cada prompt (`UserPromptSubmit`, pulado em `<task-notification>`), além do SessionStart e do Stop, até o id existir; se o usuário RECUSAR, o agente cria `.memory/memory-off.json` e os avisos param (memória segue off ali; marcador mais próximo vence). Testes.

## UX

- ~~`dashboard/index.html`'s `testMcpMemory()` esconde `mcp-wizard-btn` em todo `r.ok === true`, inclusive nos casos `will-download`/`will-auto-download`~~ — **RESOLVIDO em 2026-09-20**: `testMcpMemory()` agora verifica `details.action` e só esconde o botão quando NÃO é `will-download`/`will-auto-download` (nesses dois casos o botão permanece visível como único controle de ação). `renderWizard` anti-XSS `escapeHtml` já coberto nesta release.

## CI/Infra

- ~~`actions/setup-node@v4` sendo forçado a rodar em Node 24 mesmo mirando Node 20~~ — **RESOLVIDO em 2026-09-20**: `actions/setup-node@v4` → `@v6` em `ci.yml`, `release-audit.yml`, `release-guard.yml`, `pages-guard.yml` (runtime Node 24 nativo, elimina warning `forced to run on Node.js 24` em toda run).

## Curation / command-signature

- [x] **RESOLVIDOS em 2026-10-02 (os 2 itens abaixo)**: `command-signature` trata `(`/`{` iniciais e `)`/`}` finais sem par como estrutura, e `VAR=$(cmd …)` assina pelo `cmd` interno (`$((` segue sendo atribuição aritmética; `VAR=$(cat <<EOF` é setup). Casos: `(cd /p && git diff)` → `git diff`, `(cd /p && npm test)` → `npm test`, `(\ncd x\nnpm test\n)` → `npm test`, `{\n git log\n} > f` → `git log`, `X=$(git diff HEAD)` → `git diff HEAD`, `OUT=$(python3 - <<EOF …)` → `python3 heredoc-<digest>` (era vazio). Replay no histórico: 150 de 9.627 assinaturas mudaram, todas para melhor (ex.: `stash create)` → `git stash create`, `root 2` → `npm root 2`).
- [x] **Subshell/grupo `(...)`/`{...}` funde comandos não relacionados** (achado pré-existente, revisão round 2 do fix de misattribution, 2026-09-24): `(cd /p && git diff)` e `(cd /p && npm test)` assinam ambos `(cd /p` (NAV_SEGMENT não casa por causa do `(`); `(\ncd x\nnpm test\n)` e `{\n git log\n} > f` assinam `(`/`{` — 1 token não-programa: MCP recusa, não é ceiling-exempt, não é curável. Fix provável: `stripPrefixes` remover `(`/`{` iniciais (e `GROUP_CLOSE` já pula o fechamento). `scripts/lib/command-signature.js`.
  **JÁ RESOLVIDO** pelo U4 (`workSegments`/`_ungroup`/`GROUP_CLOSE`): verificado ao vivo em 2026-10-02 — `(cd /p && git diff)` → `git diff`, `(cd /p && npm test)` → `npm test`, subshell multilinha → `npm test`, `{ git log } > f` → `git log`.
- [x] **`ENV_ASSIGN` (`\S*`) come `$(` de command substitution** (pré-existente): `OUT=$(python3 - <<EOF ...)` → sig `''` (sinalizado sem sig, nada limpa); `X=$(git diff HEAD)` → `diff HEAD)` (perde o programa). Fix provável: tratar `VAR=$(cmd ...)` assinando pelo `cmd` interno.
  **JÁ RESOLVIDO** pelo U4 (`SUBST_ASSIGN`): `X=$(git diff HEAD)` → `git diff HEAD`; `OUT=$(python3 - <<EOF…)` → `python3 heredoc-<digest>` (verificado em 2026-10-02).
- [x] **Programa chamado por caminho (`./gradlew`) não é ceiling-exempt** (pré-existente): `PROGRAM_NAME` exige nome sem `/`; `./gradlew | tail` → sig 1-token recusada pelo MCP. Ainda curável registrando o script. Avaliar aceitar `./x`/`bin/x` em `isCeilingExempt` (`scripts/lib/oneoff-store.js`).
  **RESOLVIDO em 2026-10-02**: `PROGRAM_NAME` aceita caminho relativo (`./x`, `bin/x`, `../x`); absoluto, `..` no meio e programa vazio seguem com teto. Teste em `isCeilingExempt`.
