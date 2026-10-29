# Economia: valor que cresce com o uso

O claude-code-boss não existe para baratear a sessão do primeiro dia. Ele existe para que a sessão de um mês depois **resolva
mais, com menos repetição e menos decisão tomada no improviso pelo modelo**. Sem ele, a sessão perde:

- **memória** entre sessões e entre projetos (o que deu certo, o que o usuário corrigiu);
- **curadoria de comandos** (o comando que enche a tela vira um script que devolve o resumo, escolhido por regra e não por sugestão);
- **compactação na hora certa** (só com o cache do provedor já frio, quando regravar já seria pago);
- **inteligência coletada** de outros agentes que usam o mesmo servidor de memória;
- **experiência entre projetos**.

Numa máquina nova, sem sessões na memória, o gasto pode até subir: não há lição para lembrar nem script para reaproveitar, e o único
ganho imediato é a compactação no momento certo. O ganho cresce com o uso, e o plugin trabalha para transformar decisões que o
modelo tomava toda vez em decisões mecânicas, baseadas na análise de uso de cada projeto.

Custo em dólar por sessão não mede isso: duas sessões custam o mesmo e uma delas errou duas vezes a mesma coisa. Por isso a
medida principal é de **resultado** (`node scripts/outcome-report.js`); o custo continua medido (`economy-report.js`), como régua
de que nada piorou. A descrição função por função, com os dois loops, está em [FUNCOES.md](FUNCOES.md).

## Os resultados e como cada um é medido

| Resultado | Evento medido | O que prova | O que não prova |
|---|---|---|---|
| **Decisões que viraram regra** (redirect para script curado, reescrita de comando, guards, corte de contexto) | `curation.redirected`, `shell-escape.rewritten`, `powershell.rewritten`, `error-guard.denied`, `graph-guard.fired`, `compaction.run`… contra o que voltou ao modelo (`nudge.emitted`, `capture.offered`, `curation.stop.blocked`, `curation.flagged`) | A participação mecânica, por semana e por tempo de uso do projeto | Que cada regra acertou; só que decidiu |
| **Curadoria** | `curation.redirected` × `curation.flagged`; scripts em uso; `curation.uncovered` | Quantos comandos recorrentes já são resolvidos por script e quantos ainda entram crus no contexto | Tokens poupados por comando (isso é o `raw-report`, medido por corte) |
| **Aprendizado** | `lesson.captured` (novo × recorrência × escopo), `retrieve.injected`, `retrieve.cited` | Lições novas, lições que reapareceram, quantas foram lembradas e quantas a resposta usou | Correção evitada: um recall é *oportunidade* de evitar a repetição, uma citação é *evidência de uso*; nenhum dos dois prova que o erro deixou de ocorrer |
| **Reaproveitamento entre sessões e projetos** | `retrieve.cited` por `entryId`, sessão e projeto; origem do recall (`own`, `ancestor`, `other`, `home`) | Lições citadas em mais de uma sessão ou projeto; quanto do que é lembrado veio de outro projeto | O efeito de uma promoção para o escopo do usuário: a origem só é gravada a partir deste build |
| **Promoção de lição ao escopo do usuário** | `lesson.promoted`, `lesson.promotion.reverted`; `retrieve.cited` com `origin: other` nas cópias | Quantas lições passaram a valer em todos os projetos (por regra, ativas e desfeitas) e se foram citadas em projetos que não eram fonte | Que a citação evitou um erro; a comparação com as demais lições é aproximada (não se grava o que entrou em cada recall) |
| **Compactação** | `compaction-report.js`: cortes, contexto depois, custo da reescrita; `--cache`: `compaction.run` × `compaction.cold` | O que cada corte custou; quantas compactações rodaram com o cache quente e quantas com ele frio | O ganho contra não compactar (isso é replay, um modelo) |

```
node scripts/outcome-report.js                 # os quatro resultados, por semana e por tempo de uso do projeto
node scripts/outcome-report.js --since 2026-10-01 --json
node scripts/economy-report.js --days 30       # custo por sessão, cache hit, modelos sem preço
node scripts/subagent-report.js                # contexto dos subagentes por tipo e se vale ajustar a janela
node scripts/compat-check.js                   # o Claude Code instalado ainda tem tudo de que o plugin depende?
```

Regras de honestidade do relatório: capturas de lição numa semana acima de 40 por projeto são carga em massa e entram à parte; uma
semana anterior ao registro dos eventos de regra mostra "n/a", não 0%; a curva por tempo de uso compara só sessões da janela em que
todos os eventos são guardados (14 dias) e é transversal — projetos com mais sessões também diferem em tamanho e tipo de trabalho.

## O que os dados reais mostram (esta máquina, 2026-10-16)

Fonte: `node scripts/outcome-report.js` sobre 202 projetos e 573 sessões com eventos, de 2026-06 a 2026-10-12.

- **Participação mecânica cresce com o tempo de uso do projeto** (sessões iniciadas nos últimos 14 dias, agrupadas pelo número de
  sessões que o projeto já tinha): 48% (1–3 sessões), 66% (4–10), 66% (11–30), 91% (31+). Decisões por regra por sessão: 2,8 → 4,5 → 12,1 → 10,2.
- **Curadoria:** de 24% (projeto novo) a 97% (31+ sessões) dos comandos recorrentes resolvidos por script. No total, 27 scripts em uso;
  218 comandos redirecionados contra 3.733 que entraram crus no contexto desde agosto, e 552 comandos ruidosos ainda sem script.
- **Por semana, a participação mecânica passou de 1% (semana de 28/09) para 28% (05/10) e 88% (12/10)**; as semanas anteriores não
  têm registro dos eventos de regra, e o salto coincide com os redirects automáticos entrarem em uso.
- **Aprendizado:** 886 lições capturadas em semanas normais (mais 966 em semanas de carga em massa), 29 delas uma lição conhecida que
  reapareceu (3%); 17% nasceram no escopo do usuário. 1.480 lições lembradas em prompts, 269 citadas na resposta (18%).
  75 lições distintas foram citadas, 16 em mais de uma sessão e 10 em mais de um projeto.
- **Compactação:** 47 cortes em 30 dias, todos do plugin (o engine não precisou agir), reescrita de US$ 0,12 a 0,32 por corte.

Limites: é uma máquina, um dono; a curva é transversal; os eventos de regra existem desde ~3/10. O que cresce com o tempo aparece
melhor repetindo o comando daqui a um mês. A origem do recall (de outro projeto) começa a ser gravada com este build.

## Subagentes

683 execuções de subagente em 30 dias custaram ~6% do total. O engine compacta cada uma a ~167 mil tokens (janela de 200 mil); só 7%
passam de 150 mil e 1% de 200 mil. `node scripts/subagent-report.js` olha cada tipo de agente e só recomenda `autoCompactWindow` no arquivo do agente
quando 25% das execuções (de ≥ 10) passam de 150 mil tokens e o tipo é um arquivo do usuário: hoje isso vale para o `researcher` (3
de 12 execuções) e para nenhum outro. A janela global (env, `/autocompact`) mexeria na sessão principal, o que já foi recusado. O TTL
de 1 h para subagentes não compensa: medido, 37 regravações a frio (5 milhões de tokens) contra 63 milhões de tokens de escrita.

## O que o grupo de controle ainda vale

Como método principal, nada: o valor aqui não é custo por sessão, e sortear sessões sem as funções as privaria justamente do que
cresce com o uso. Continuam valendo: (1) a comparação observacional com intervalo de confiança (`economy-report.js --split`) como
checagem de que o custo por chamada não piorou, com a limitação de que não prova causa; (2) a validação do método com efeito
conhecido (testes); (3) um grupo de controle por *função* (por exemplo, sessões sem o redirect de curadoria), só se o dono quiser
provar o efeito de uma função específica.

## Compatibilidade com o que o Claude Code já faz

`node scripts/compat-check.js` confere se o Claude Code instalado ainda contém cada nome do qual o plugin depende (variáveis de
ambiente, eventos de hook, API de módulos, chaves de settings, campos do transcript). Prova que o nome existe, não que o
comportamento é o mesmo — para isso há o smoke em sessão real.

- **Compactação ociosa do engine** (2.1.286+, `idleCompaction`): compacta a sessão parada a ~90% do TTL de 1 h, com o cache ainda
  quente. Chega por flag remota e só funciona com TTL de 1 h; quando ligada, o `folder-ttl` do plugin **não** troca a pasta para 5
  min (isso a desligaria).
- **`/autocompact`** (por modelo em `modelSettings`) e `autoCompactWindow`: o ajuste de janela do plugin
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) continua desligado por padrão e, ligado, ganha do `/autocompact` do usuário (a env tem precedência).
- **TTL de cache**: `promptCacheTtl` virou chave de settings e `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` controla subagentes à parte.
