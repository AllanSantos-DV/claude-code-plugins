# ADR-003 — Sticky Router no lugar do routing per-turn

**Status:** Aceito | **Data:** 2026-07 | **Escopo:** Model Router

## Contexto

O roteador original reclassificava o modelo a CADA request. O prompt cache da Anthropic é POR MODELO: cada troca (haiku↔sonnet↔opus) invalida o prefixo inteiro — vira input cheio (1.0x) + cache-write (1.25–2x) em vez de cache-read (0.1x). Custo SUBIA em vez de cair.

## Decisão

Classificar UMA vez por sessão (turno 0 — sem cache, custo zero) e FIXAR o modelo: `sticky.enabled`. O modo per-turn (`enabled`) fica deprecado. Precedência em `lib/router-mode.js`: sticky > routing > fallback-only > byok.

## Consequências

- Cache quente preservado (modelo constante)
- Ceiling mantém controle do usuário (nunca escala acima do dropdown)
- Classificação local MiniLM = zero egress; NIM remoto é opt-in
- Limitação aceita: com proxy no caminho, cliente orça 1M como 200K → `contextTuning` entrega ganho sem publicar base_url
