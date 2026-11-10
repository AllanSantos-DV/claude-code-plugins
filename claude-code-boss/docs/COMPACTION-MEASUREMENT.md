# Compactação: como os limiares padrão foram medidos

Medição por trás dos tetos opcionais `thresholdMaxTokens` = 150 000 (corte a frio) e `warmCeilingTokens` = 200 000 (corte no fim do turno com cache quente). Os dois vêm desligados (`0`) por padrão: o limiar padrão é só o percentual da janela (30%). Arquivo independente: o texto vale sem o resto da documentação.

## Dados

- **Origem**: transcritos reais do Claude Code (`~/.claude/projects/*/*.jsonl`) e a trilha do Boss (`compaction.gate`, `compaction.run`, `compaction.cold`) de **2026-11-02**, de duas sessões principais com seus subagentes: `orchestrador-24` (238 chamadas à API no principal + 13 subagentes, 867 chamadas) e `native-java-28` (597 chamadas + 4 subagentes, 255 chamadas). Só leitura.
- **Medida**: tokens de contexto da chamada = entrada + leitura de cache + escrita de cache (o que se paga a cada chamada).
- **Custo**: a tabela de preços por modelo do gateway; o corte simulado cobra a regravação do contexto reduzido e, no corte com resumo do modelo, a leitura do contexto mais 3 mil tokens de saída.

## O que foi observado

| Fato | Número |
|---|---|
| Custo acima de 100k de contexto (análise de custo do mesmo dia) | 88% |
| Cortes do Boss no dia (antes → tamanho do resumo ou brief) | 317k → 9,8k · 341k → 40k · 481k → 19k · 307k → 35k · 333k → 35k |
| Chamadas das sessões principais com ≥ 150k | 84% (orq-24) · 76% (nj-28) |
| Pausas de 5 min ou mais entre chamadas (o cache esfria) | 5,9% (orq-24) · 1,5% (nj-28) · **0 em 1 122 chamadas de subagente** |
| Tempo entre cruzar 300k e o corte a frio | 11 a 26 minutos |

Com o limiar antigo (30% de uma janela de 1M = 300k, só com cache frio) a sessão passava 11–26 minutos lendo 300k+ a cada chamada, esperando uma pausa que quase nunca vem.

## Replay do corte por limiar (economia sobre o custo real de cada grupo)

| Limiar | orq-24 só frio | orq-24 frio+quente | nj-28 só frio | nj-28 frio+quente | subagentes orq-24 (quente) | subagentes nj-28 (quente) |
|---|---|---|---|---|---|---|
| 100k | 43,5% | 46,2% | 16,5% | 50,7% | 35,5% | 12,8% |
| 125k | 40,7% | 44,1% | 12,1% | 47,4% | 33,1% | 12,0% |
| **150k** | 36,4% | 40,2% | 12,4% | 44,4% | 29,3% | 9,7% |
| 200k | 27,8% | 31,0% | 7,2% | 36,2% | 21,6% | 9,8% |
| 300k (antes) | 0,0% | 11,7% | 3,5% | 20,1% | 2,5% | 0,0% |

Custo real replayado: orq-24 principal US$ 15,98; subagentes US$ 52,41; nj-28 principal US$ 40,20; subagentes US$ 29,08.

Com o corte a frio em 150k e o teto quente em 200k, as duas sessões principais caem 36,4% e 36,9% (US$ 15,98 → ~10,2 e US$ 40,20 → ~25,4). Subir o teto quente para 250k ou 300k derruba o ganho da segunda sessão para 29,5% e 28,5%. Baixá-lo para 175k dá 37,1% e 40,4%, ao custo de cortes com resumo do modelo em maior número. 200k guarda quase todo o ganho com cerca de metade desses cortes.

**Estes percentuais são um limite superior, não um número geral.** O replay usou como contexto depois do corte o tamanho do resumo ou do brief (9,8k a 40k). A primeira chamada à API depois de um corte também recarrega o system prompt, as ferramentas, os arquivos de instrução e as listagens. Medida nessa chamada, a base que fica é de 55k a 64k numa pasta comum e de 100k a 121k na pasta do orchestrador, onde um `CLAUDE.md` de ~140 mil caracteres pesa sozinho ~63k tokens. A economia real de cada corte é proporcional a (antes − base), não a (antes − resumo): com 150k de limiar e base de 110k, um corte remove ~40k tokens, não ~140k. O `doctor --cost` (check `compaction-floor`) mostra essa base por pasta, medida nos cortes registrados.

## Qualidade

A simulação mede dólares, não qualidade. Em 6 compactações reais, o corte a frio sem modelo (brief) manteve **81%** do conteúdo que os turnos seguintes citaram, contra **73%** do resumo do engine. O corte com cache quente usa o resumo do engine (ou a poda, quando ela corta 85% ou mais). Texto do usuário nunca é alterado.

## Limites desta medição

- Um dia, duas sessões principais e 17 subagentes: é amostra, não população.
- O contexto depois do corte foi o tamanho do resumo ou do brief, não a primeira chamada medida depois dele: a economia acima é teto.
- Subagentes não são alcançados pelo Boss; o ganho deles depende da compactação do próprio engine.
- A preferência do usuário vence: ambos os números são editáveis no painel (**Compaction & cache**) e `0`, o padrão, desliga cada um.

Ver o que o Boss cortou na sua máquina: `node scripts/compaction-report.js 14 --cache`. O script de replay por limiar foi escrito para esta medição e não é distribuído com o plugin.
