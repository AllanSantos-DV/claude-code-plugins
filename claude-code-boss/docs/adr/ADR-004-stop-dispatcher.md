# ADR-004 — stop-dispatcher: detectors in-process (1 spawn)

**Status:** Aceito | **Data:** 2026-07 | **Escopo:** Hooks Stop

## Contexto

O evento Stop disparava 11+ scripts Node separados por turno — spawn overhead, fan-out de telemetria, ordem não determinística entre blockers.

## Decisão

Um único entrypoint (`stop-dispatcher.js`) com 16 **detectores in-process**, ordenados por prioridade (curation > failure-retro > resto), merge determinístico dos blocks (`mergeBlocks`), telemetria agregada e shadow-mode para experimentos.

## Consequências

- 1 spawn por Stop em vez de 11+
- Ordem de blockers estável e testável (`rank`, `DETECTORS`)
- Adicionar detector = registrar no array + teste; sem tocar hooks.json
