# ADR-011 — Multi-tenant router: design para implementação futura

**Status:** Aceito e IMPLEMENTADO (2026-08-23 — carrier: header `X-CCB-Tenant` via `ANTHROPIC_CUSTOM_HEADERS`; commit c3b4259) | **Data:** 2026-08-23 | **Escopo:** Model Router

## Contexto

Roadmap pedia isolamento por projeto/team. Hoje o proxy é single-tenant: uma config global, um daemon, sem auth entre tenants.

## Design proposto

1. **Escopo de config**: `user-config.json` ganha mapa `tenants: { <projectId>: {sticky, fallback, byok…} }`; **CC NÃO envia projectId ao proxy hoje** (só body; sessionKey = system+1ªmsg) — carrier obrigatório a decidir na implementação: header custom injetado por projeto via settings (`ANTHROPIC_CUSTOM_HEADERS`) ou via shim; fallback para o config global atual (backward compat total)
2. **Sticky pins por tenant**: o mapa sessionKey→modelo já existe em memória; passa a ser namespaced por projectId (hoje só system+1ªmsg)
3. **Métricas por tenant**: `metrics-history.jsonl` ganha campo `tenant`; agregações do dashboard filtram
4. **Auth**: fora de escopo v1 — loopback-only permanece; tenants são projetos da MESMA máquina, não usuários remotos
5. **Não-goals v1**: quotas por tenant; roteamento cross-máquina

## Por que PLANNED

~~Toca resolução de config, sticky, métricas e dashboard de vez — merece sessão dedicada com gate próprio.~~ **Implementado em sessão dedicada (Fase E)** — ver `docs/backlog/PHASE-E-multi-tenant-router.md` para a decisão do carrier (spike E2E) e notas da implementação.
