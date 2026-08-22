# Model Router — Proxy de Roteamento de Modelos

> `servers/model-router/` — proxy HTTP Anthropic-compatível. Este documento cobre os internos.

## Visão Geral

O Claude Code fala com `ANTHROPIC_BASE_URL=http://127.0.0.1:13456` (injetado pelo `model-router-ensure.js`). Este server e o processo Node detached que ocupa essa porta.

```
Claude Code --> model-router (13456) --+--> api.anthropic.com  (passthrough, default)
                                       +--> NVIDIA NIM          (fallback no 429)
                                       +--> BYOK endpoint       (usuario configura)
```

## Arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.js` | HTTP server, roteamento por modo, classificacao sticky/per-turn, fallback chain |
| `byok.js` | Resolve upstream BYOK, headers, classificacao de resposta (429 vs fail-loud) |
| `catalog.js` | Catalogo dinamico via GET /v1/models (familia -> modelo mais novo + effort levels) |
| `cache-cycle.js` | Observabilidade do prompt cache: hits/misses, fronteiras frias, premio de reconstrucao |
| `wrapper.cs` | Fonte C# compilada em runtime pelo shim (Windows) |

## Modos de Operacao

Fonte unica: `scripts/lib/router-mode.js` (compartilhada ensure/dashboard/server).

| Modo | Gatilho | Comportamento |
|------|---------|---------------|
| `off` | nenhum flag | Ensure limpa footprint; server fora do caminho |
| `sticky-tier` | `sticky.enabled===true` | Classifica UMA vez por sessao (turno 0), fixa modelo. Inclui plano B no 429 |
| `routing` | `enabled===true` | DEPRECADO: reclassifica a cada request (quebra prompt cache) |
| `fallback-only` | so `fallback.enabled` | Passthrough byte-identical; intervem SOMENTE no 429 |
| `byok-direct` | `byok.enabled && mode='always'` | Tudo vai ao endpoint BYOK |

## Classificacao (Sticky)

- **Local (default):** MiniLM multilingual embarcado contra ancoras haiku/sonnet/opus (`anchors.*` no config). Nenhum dado sai da maquina.
- **Remota (opt-in):** se `nim.classifyRemote===true` e ha apiKey, ~500 chars do prompt vao para o NIM (`qwen2.5-1.5b-instruct`).

Calibracao: `classifier.minScore` (0.3), `opusMinScore` (0.4), `opusMargin`, `defaultTier: sonnet`. Na duvida cai em sonnet; opus so com sinal forte.

## Fallback Chain (no 429)

1. **BYOK** (`mode: on-limit`) — se configurado, entra ANTES da NVIDIA
2. **NVIDIA** (`nim.fallbackModel`) — se houver apiKey
3. **Mensagem orientando /dashboard** — sem chave

Fail-loud: 401/404/5xx ou corpo "model is not supported" do BYOK NAO caem para a NVIDIA (erro de config precisa aparecer). Cooldown/circuit-breaker: reset deterministico por headers (retry-after), corpo (rate_limit_event) ou janela deslizante.

## Ceiling

Nunca escala acima do modelo escolhido no dropdown; so rebaixa. `routing.ceiling: true`. O esforco (`effort`) e reconciliado por suporte do modelo destino (ex.: opus xhigh -> sonnet high -> haiku sem effort).

## Prompt Cache (por que sticky existe)

Cache da Anthropic e POR MODELO: trocar modelo invalida o prefixo inteiro (vira input cheio + cache-write). Sticky classifica no turno 0 (sem cache = gratis) e fixa — modelo constante = cache quente (0.1x read).

Limitacao do cliente: com qualquer `ANTHROPIC_BASE_URL` custom, o Claude Code orca a sessao em 200K mesmo em modelos 1M. Quem precisa de 1M: router off + `contextTuning`.

## Metricas

Acumuladas em memoria + flush periodico para `DATA_DIR/model-router/metrics.json`: totalRequests, downgrades, ceilingHits, planBRequests, estimatedSavingsUSD, cache hits/misses, fronteiras frias, premio de reconstrucao.
