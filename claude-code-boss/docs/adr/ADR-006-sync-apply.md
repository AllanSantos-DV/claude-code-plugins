# ADR-006 — applyRouter síncrono com mutex (master-off do dashboard)

**Status:** Aceito | **Data:** 2026-08 | **Escopo:** Dashboard API

## Contexto

O "Salvar & aplicar" original era fire-and-forget: respondia ok antes do ensure terminar. O botão "Desligar tudo" exige garantia de cleanup completo — daemon morto, settings.json limpo, shim removido — antes de qualquer resposta. Cliques rápidos criavam corrida de kills e writes.

## Decisão

`POST /api/router/apply`: mutex in-memory (409 em chamada concorrente) → `writeJsonAtomic` do user-config → spawn **não-detached** do ensure com `BOSS_ROUTER_FORCE_RESTART=1`, capturando stderr, timeout 30s (SIGTERM→SIGKILL após 2s, guard `childExited` evita kill de processo já morto). Resposta só após exit 0.

## Consequências

- "ok" significa cleanup completo verificado
- Ensure no modo `off` faz cleanup FIRST + `waitPortFree` + remoção de shim verificada (`anySuccess`)
- Corrupt settings.json → backup + tentativa de recuperação da base_url
- Limitação documentada: edição manual do user-config não mata daemon (sem FORCE_RESTART)
