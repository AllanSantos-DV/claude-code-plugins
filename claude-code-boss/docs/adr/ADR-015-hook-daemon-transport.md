# ADR-015 — Hooks migram de spawn efêmero para transporte via daemon já residente

**Status:** Implementado (não lançado — sai no próximo pacote major) | **Data:** 2026-09-24 | **Atualizado:** 2026-10-02 | **Escopo:** os 14 scripts de hook registrados em `hooks/hooks.json`

> **Atualização 2026-10-02 (hardening, `docs/BACKLOG.md` G1–G9):** a classe 4
> deixou de estar pendente — `policy-inject` no `SubagentStart` virou
> `hook_policy_inject` (G6) e o `model-router-ensure` do `UserPromptSubmit` roda
> dentro do `user-prompt-submit-dispatcher` (G7, 1 processo por prompt). No daemon,
> `Stop` e os hooks de efeito colateral rodam num worker próprio com fila FIFO (G2);
> os que sempre devolvem `{}` respondem na hora (G4, como esta ADR decidiu na
> classe 1); cada hook tem prazo de `timeout − 1 s` (G5).

## Contexto

`ADR-001` já fez do `brain-server` e do `model-router` daemons singleton residentes
(uma instância serve N sessões). O que ficou de fora: os **hooks continuam
clientes efêmeros** — cada evento (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
etc.) spawna um `node.exe` novo que lê stdin, roda sua própria lógica do zero
(inclusive, em vários casos, refazendo checagens que o daemon já sabe responder) e
morre.

Investigação empírica nesta sessão (`.ccb-daemon-bench/`, ver
`project_claude_code_boss_daemon_validation` na Brain) mediu duas coisas
diferentes:

1. **Latência por chamada isolada** — já corrigida por 3 fixes de código nesta
   mesma sessão (2 spawns de PowerShell incondicionais eliminados): mediana caiu
   de ~4,3s pra ~700ms sem precisar de daemon. Isso NÃO motiva esta ADR.
2. **Degradação sob concorrência real** — o motivo real desta ADR. Sob N=60
   spawns simultâneos (cenário medido: 6-8 sessões com fan-out de subagentes,
   cada retorno de tool contando como novo disparo de hook), o wall-time é
   **38,9× o custo unitário isolado** (não 60×, não 1×) — degradação
   **superlinear**, e o p95 de UMA chamada dentro do burst chega a **18,5s**,
   perto do timeout de 30s configurado. Bate com o incidente real relatado pelo
   usuário (timeout generalizado em várias sessões ao mesmo tempo). O mesmo
   burst contra um daemon já vivo (via `tools/list`) mostrou wall-time
   praticamente plano até N=15 (não fechado a N=30/60 por um erro de modelo de
   teste, não do produto — ver dossiê da Fase).

Mapeamento dos 14 hooks (ver dossiê) mostra que boa parte da lógica hoje
recomputada do zero a cada spawn cai em padrões reaproveitáveis:

- **Silencioso-exceto-alerta**: `correction-detect.js`, `active-research-detect.js`
  (heurísticas puras sobre o prompt) e `policy-glob-inject.js` (advisory puro)
  retornam `null`/vazio na grande maioria dos turnos — pagam o custo do spawn
  todo turno só pra confirmar "nada a dizer".
- **Side-effect puro**: `posttoolusebash-dispatcher.js`, `file-edit-detect.js`,
  `skill-metric.js`, `posttoolusefailure-dispatcher.js` sempre emitem `{}` —
  o turno nunca lê o resultado, o bloqueio síncrono de hoje é só um artefato do
  tipo de hook (`command` sempre espera o processo terminar), não uma
  necessidade real.
- **Exclusão arquitetural permanente (achado do Portão de Plano, rodada 1)**:
  `brain-daemon-ensure.js`, `brain-health.js` e `brain-status.js` (3 dos 5
  sub-detectors de `user-prompt-submit-dispatcher.js` que também retornam
  `null` na maioria dos turnos) **não entram em nenhuma classe migrável**. Os
  três fazem probe deliberadamente FORA DE BANDA do canal MCP/daemon — é
  citado no próprio cabeçalho de cada arquivo que a função deles é continuar
  funcionando quando esse canal está morto (`brain-health.js` chama os mesmos
  módulos in-process que o servidor MCP usa, sem passar pelo servidor;
  `brain-status.js`/`lib/mcp-health.js` faz `net.createConnection` TCP raw;
  `brain-daemon-ensure.js` existe justamente pra SUBIR o daemon antes do
  cliente MCP tentar conectar). Migrar o transporte deles pra `mcp_tool`
  criaria uma dependência circular: a checagem de "o daemon está morto" só
  chegaria a rodar se o daemon já estivesse vivo. Ficam `command` para
  sempre — não é "fora de escopo desta fase", é restrição arquitetural.

## Decisão

Migrar os hooks em **3 classes**, por ordem de risco/retorno (detalhe tarefa a
tarefa no dossiê [PHASE-G-hook-daemon-transport.md](../backlog/PHASE-G-hook-daemon-transport.md)):

1. **Async-elegível** (sempre `{}`, side-effect puro) → viram `mcp_tool`
   fire-and-forget: o hook manda o evento pro daemon (`brain-server`, que já é
   singleton por `ADR-001`) e recebe um ack imediato; o trabalho real
   (journal/métrica/cache) roda depois, dentro do daemon, sem o turno esperar.
2. **Silencioso-exceto-alerta** (`correction-detect.js`, `active-research-detect.js`,
   `policy-glob-inject.js` — 3 itens, corrigido do rascunho original que
   incluía por erro os 3 scripts de daemon-liveness) → o daemon passa a manter
   o estado relevante computado continuamente em background (loop interno já
   residente); o hook faz uma leitura síncrona BARATA desse estado via
   `mcp_tool`, em vez de recomputar do zero a cada spawn. Preserva o caso raro
   em que há algo a dizer.
3. **Sync-real / bloqueia de fato** (`pretooluse-bash-dispatcher.js`,
   `graph-guard.js`, `stop-dispatcher.js` — exatamente 3, verificado por grep
   de `permissionDecision`/`decision:'block'`) → migra só o TRANSPORTE pra
   `mcp_tool` (elimina o spawn), mantendo a MESMA lógica de decisão síncrona
   que existe hoje.
4. **Context-bearing, não bloqueia** (`policy-inject.js`, `model-router-ensure.js`
   no evento `UserPromptSubmit`) — achado do Portão de Plano: nenhum dos dois
   emite `permissionDecision`/`decision:'block'` em nenhum ponto do código
   (só `additionalContext`), então não cabem na classe 3 pela própria
   definição desta ADR, apesar de terem sido listados lá no rascunho original.
   Não são "silenciosos" como a classe 2 (`model-router-ensure.js` quase
   sempre tem algo a dizer). Tratamento pendente de decisão (ver dossiê §S4)
   — não migram até essa classe ser desenhada explicitamente.

`brain_retrieve_context` já está correto (já é `mcp_tool`) — sem mudança.

`SessionStart` no lançamento da sessão é a única exceção real de viabilidade
(`mcp_tool` não roda ali — MCP ainda não conectado, ver Brain
`claude_code_mcp_tool_hook_event_support`): `session-start-dispatcher.js` e a
metade SessionStart de `model-router-ensure.js`/`policy-inject.js` continuam
`command` nesse evento específico. A mesma lógica registrada em
`UserPromptSubmit`/`SubagentStart`/`PreToolUse`/`PostToolUse`/`Stop` não tem essa
restrição.

## Decisões do dono do repo (Portão de Plano, rodada 1 → respostas)

- **Fallback `mcp_tool`→`command` (P2): nem (a) fail-open silencioso, nem (b)
  dual-registro.** Decisão real: **fail-open VISÍVEL** — se a chamada ao
  daemon falhar (timeout/conexão recusada/etc.), o próprio `mcp_tool` responde
  na hora (sem travar o turno) MAS com um sinal explícito de degradação
  (`additionalContext`/motivo dizendo "hook X não alcançou o daemon,
  seguindo sem essa checagem") — nunca um `{}`/allow silencioso que esconde a
  falha do agente. Elimina o spawn de verdade (não precisa registrar as duas
  entradas) E não esconde degradação (não é fail-open cego). Os testes de
  paridade da task 6 passam a ter DOIS casos, não um só: (i) daemon vivo →
  saída idêntica à `command` de hoje; (ii) daemon inacessível → saída inclui
  o sinal de degradação (não precisa ser byte-idêntica ao path de erro da
  versão `command`, que hoje pode nem ter um).
- **Granularidade dos dispatchers (P3): dividir em entradas `mcp_tool`
  separadas, não manter 1 processo consolidado.** Confirmado por grep nos
  próprios arquivos: a consolidação (`user-prompt-submit-dispatcher.js`,
  `session-start-dispatcher.js`, `pretooluse-bash-dispatcher.js` etc.) foi
  desenhada EXPLICITAMENTE como mitigação de custo de spawn ("Consolidates 5
  per-prompt Node spawns... into ONE in-process pass — same 'N spawns → 1'
  pattern" — comentário literal do código). Como `mcp_tool` elimina o spawn
  por chamada de qualquer forma, essa motivação desaparece pros sub-detectors
  que migram: cada um vira sua própria entrada em `hooks.json`, não uma
  chamada interna dentro do processo dispatcher. Ressalva de implementação
  (não bloqueia o plano, mas registrar pra Fase G tratar): alguns dispatchers
  (`stop-dispatcher.js`) hoje aplicam uma regra de prioridade entre os
  sub-detectors quando mais de um quer bloquear (`curation-stop > failure-retro
  > outros`) — precisa confirmar que o harness do Claude Code com N hooks
  separados no MESMO evento resolve isso com a mesma semântica (qualquer
  `deny` vence), não assumir sem testar.
- **Reprodutibilidade dos benchmarks (P4): não versionar.** Os números desta
  investigação (38,9×, p95 18,5s) ficam como referência histórica (memória da
  Brain + scratch local); a task 7 (bench pós-migração) remede do zero com a
  metodologia que fizer sentido no momento, sem exigir reprodução exata dos
  números originais.

## Consequências

- Elimina o comportamento superlinear sob concorrência real: N chamadas passam
  a ser N requisições a um daemon já vivo (sem spawn de processo por chamada),
  não N processos competindo pela validação de processo da máquina.
- Abre caminho pra desacoplar processamento pesado do turno (fire-and-forget de
  verdade), não só mover trabalho pra depois dentro do mesmo processo efêmero.
- Ganho de latência por chamada isolada é secundário aqui (já resolvido antes
  desta ADR) — não é o critério de aceite principal.
- RAM sob carga concorrente **não tem medição própria confiável ainda**
  (tentativas de medir falharam por limitação de tooling nesta máquina —
  `wmic` descontinuado, amostragem via PowerShell contamina a própria medição
  de spawn-storm que se quer isolar); a Fase G trata isso como spike
  obrigatório antes de qualquer número entrar em critério de aceite.
- Cada hook migrado precisa de um par de testes de paridade (client via daemon
  vs. fallback efêmero local, saída byte-idêntica) e do fallback efêmero
  preservado — daemon inacessível nunca pode bloquear/degradar uma sessão
  (mesmo princípio fail-open de `ADR-001`).
- Exige novas ferramentas MCP no `brain-server` (uma por classe de hook ou uma
  genérica de dispatch) — não é só trocar `"type"` em `hooks.json`.
