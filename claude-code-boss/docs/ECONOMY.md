# Economia

O objetivo do claude-code-boss é **gastar menos token, dinheiro e limite do plano por tarefa concluída**, sem perder o que o
agente sabe. Este documento diz onde a economia vem, como medi-la e o que cada medida prova — e o que não prova.

## De onde vem a economia

| Alavanca | O que poupa | Como é medida | Evidência hoje |
|---|---|---|---|
| **Cache de 1 h** (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, escrito pelo doctor) | Regravar o contexto inteiro depois de uma pausa de mais de 5 min (teste, CI, agente em segundo plano) | `ephemeral_1h_input_tokens` na resposta; regravações de cache frio por sessão | Medida: 14 regravações de 450–770 mil tokens em um dia de sessão = ~US$ 46 de US$ 88 (`docs/research/cost-2026-10-11`). Um dia, uma máquina. |
| **Compactação no momento certo** (`hooks/compaction.mjs`) | Reler até a janela inteira a cada chamada; regravar o cache fora da hora | `compaction-report.js`: cortes, contexto depois do corte, custo do turno de reescrita | Medida por corte: 47 cortes em 30 dias (todos do boss), contexto depois do corte ~45–55 mil, reescrita US$ 0,12–0,32 cada. O ganho contra "não compactar" é **replay** (modelo): −12,7% em 7.049 chamadas reais. |
| **Curadoria de saída** (`curation-guard`, scripts curados) | Tokens de saída de comando que nunca entram no contexto | `raw-report` por corte; `economy-metrics` (R, E, T, η) | Medida por corte: 40 cortes medidos em 30 dias = 0,34% do consumo (η). Ganho real, pequeno frente ao consumo total. |
| **Custo fixo por mensagem** (doctor, `ENABLE_TOOL_SEARCH`) | Schemas de MCP, skills e plugins reenviados a cada mensagem | Tokens estimados por item × uso real dos últimos 30 dias | Estimada (tokens), aplicada com `--undo` disponível. |
| **Retomada = cache frio** | Esperar "cache quente" que não existe depois de `--resume` | `docs/research/relatorio-custo/resume-cache.js` | Medida: 5 de 5 retomadas grandes regravaram 88–100% do histórico. |
| **Guards** (`error-guard`, `graph-guard`) | Repetir às cegas um comando que falhou; Grep onde o grafo responde | Eventos `*.denied` | Contagem de ocorrências; **sem** valor em dólar medido. |

A sessão começa dizendo quanto a curadoria poupou nos últimos 7 dias (`value-digest`), e o painel mostra o resto.

## Como medir sem histórico anterior

Os transcripts do Claude Code já guardam o uso de cada chamada (`usage`, com a divisão de cache 1 h/5 min), então a **linha de base
existe desde o primeiro transcript no disco**; ela não precisa esperar dados novos.

```
node scripts/economy-report.js --days 30                          # custo por sessão, cache hit, modelos sem preço
node scripts/economy-report.js --split boss                       # sessões com hook do boss × sem
node scripts/economy-report.js --split before:2026-10-15T22:07Z   # antes × depois de um build/instalação
node scripts/economy-report.js --save                             # grava 1 registro por sessão em .runtime/economy-ledger.jsonl
```

O custo é a unidade de limite do plano (`economy-metrics`: entrada 1, leitura de cache 0,05, escrita 5 min 1,25, escrita 1 h 2,
saída 5 — "tokens equivalentes de entrada"), que dispensa tabela de preço e vale entre modelos; o dólar entra só para modelos com
preço (`economy-metrics.MODELS`, fonte: página oficial de preços, acesso 2026-10-16).

### O que cada método prova

| Método | Prova | Não prova |
|---|---|---|
| **Sintético controlado** (sessões geradas com efeito conhecido, `test-units`: `economy compareGroups`) | Que o **método** acerta: recupera um corte de 20%, não acusa efeito quando não há (intervalo de 95% cobre 0 em ≥ 88 de 100 repetições) e não se deixa enganar por diferença de tamanho de sessão | Que o Boss economiza; só que a régua mede certo |
| **Replay contrafactual** sobre transcripts reais (`docs/research/compaction-*`, `economy-metrics`) | O que o mesmo histórico custaria com outra regra, dado o modelo de cache | Causalidade: depende das premissas (permanência do item no contexto, preço) |
| **Linha de base desde já** (`--save`) | O custo por sessão **antes** de uma mudança, guardado além da limpeza dos transcripts | Efeito: sem comparação, é só um número |
| **Comparação observacional** (`--split boss`, `--split before:`) | Uma diferença de custo por chamada, com intervalo de 95% (bootstrap das sessões) e **estratificada por tamanho da sessão**, que remove a maior confusão | Causa: carga de trabalho, mistura de modelos e hábito também diferem entre os grupos |
| **A/B por sessão sorteada** (grupo de controle) | O efeito causal da economia | **Não implementado**: exige que parte das sessões rode sem as economias — decisão do dono |

Todo relatório imprime a `claim` e as `caveats` do método usado; uma comparação observacional diz sozinha que não estabelece causa.

### Resultado real hoje (2026-10-16, últimos 30 dias, 782 sessões, 87 mil chamadas)

- Com × sem hook do boss (357 × 425): −27,6% por chamada no bruto, **−6,6% por tamanho de sessão**, intervalo −41% … +59% → **sem diferença detectável**.
- Antes × depois da instalação de 15/10 (762 × 20): −43,3% bruto, −18,5% por tamanho, intervalo −29,5% … +5,5% → **sem diferença
  detectável ainda** (20 sessões depois; o intervalo estreita com o tempo). A diferença bruta é tamanho de sessão, não economia.

Ou seja: com os dados de hoje, a economia **por sessão inteira** não se distingue de zero. As economias por corte (tabela acima) são
reais e medidas, mas pequenas contra o consumo total; o que mais pesa (cache de 1 h, compactação) só ficará demonstrado por A/B
sorteado ou por mais sessões depois das mudanças.

## Compatibilidade com o que o Claude Code já faz

`node scripts/compat-check.js` confere se o Claude Code instalado ainda contém cada nome do qual o plugin depende (variáveis de
ambiente, eventos de hook, API de módulos, chaves de settings, campos do transcript). Prova que o nome existe, não que o
comportamento é o mesmo — para isso há o smoke em sessão real.

Funções que o Claude Code ganhou e se sobrepõem ao boss:

- **Compactação ociosa do engine** (2.1.286+, `idleCompaction`): compacta a sessão parada a ~90% do TTL de 1 h, com o cache ainda
  quente. Chega por flag remota (`tengu_sunny_locket`; nesta máquina está `off`) e só funciona com TTL de 1 h. Quando ligada, o
  `folder-ttl` do boss **não** troca a pasta para 5 min (isso desligaria a compactação do engine justamente nas sessões que ela ajuda).
- **`/autocompact`** (2.1.288, por modelo em `modelSettings`) e `autoCompactWindow`: o ajuste de janela do boss
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) continua desligado por padrão e, ligado, ganha do `/autocompact` do usuário (a env tem precedência).
- **TTL de cache**: `promptCacheTtl` virou chave de settings e `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` controla subagentes à parte.
