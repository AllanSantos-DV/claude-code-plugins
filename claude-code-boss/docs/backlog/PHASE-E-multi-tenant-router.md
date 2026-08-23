# Fase E — Multi-tenant Router

> **Status: READY TO START.** Design aprovado por revisão adversarial (2026-08-23).
> Dossiê auto-suficiente — não depende de contexto de chat.

## Referências

- **Design:** [ADR-011-multi-tenant-design.md](../adr/ADR-011-multi-tenant-design.md)
- **Código base:** `servers/model-router/index.js`, `scripts/model-router-ensure.js`, `scripts/dashboard.js`
- **Fatos verificados (revisão 2026-08-23):**
  - O Claude Code **NÃO envia projectId** ao proxy — o body só tem system+messages; `computeSessionKey` (index.js:580-599) hash-eia system+1ª user msg
  - Sticky pins vivem em `_stickyPins` Map em memória (index.js:601-651), key = sessionKey
  - `metrics-history.jsonl` (FASE D, já implementada) tem rows `{day, total, downgrades, planB, baselineUnits, actualUnits}`

## ⚠️ Decisão pendente NO INÍCIO da fase (task 1 = spike)

**Carrier do tenant**: como o proxy sabe de qual projeto é cada request? Duas opções a validar com spike:

| Opção | Mecanismo | Prós | Contras |
|-------|-----------|------|---------|
| **A** (preferida) | Header custom injetado por projeto via settings.json do projeto (`ANTHROPIC_CUSTOM_HEADERS="X-CCB-Tenant: <projectId>"`) — o CC já suporta headers custom por settings | Zero mudança no shim/proxy; header atravessa o router naturalmente | Só cobre projetos com o setting; fallback global para os demais |
| B | Shim/wrapper injeta o header lendo cwd | Cobre tudo no Desktop | Mexer no shim = risco alto (fail-open atual é sagrado) |

**Spike:** request de teste com header custom nos settings → logar no router e provar que chega. Se opção A funcionar E2E, fechar a decisão e seguir; senão reavaliar B ou cortar escopo.

## Tarefas (ordem de execução)

1. **Spike carrier** (acima) — decisão registrada neste arquivo antes de codar
2. **Config**: mapa `tenants: { <projectId>: {sticky?, fallback?, byok?…} }` no `user-config.json`; resolução: tenant explícito > global (backward compat total — quem não usa tenants não muda nada). Shallow-merge por tenant espelhando `mergeUserConfig`
3. **Server**: `resolveTenant(headers)` → projectId do header (validado contra allowlist `[a-z0-9-]`, cap 64 chars); namespace dos sticky pins (`tenant + ':' + sessionKey`); passagem do tenant até métricas
4. **Métricas**: row do history ganha campo `tenant` (default `'_'` = global); agregações do dashboard filtram por tenant
5. **Dashboard**: filtro/seletor de tenant na aba Router (métricas + histórico); GET `/api/router/history?tenant=`
6. **Testes** (herméticos, sem rede): resolução de tenant; namespaces de pin isolados; métricas por tenant; backward compat (sem header = comportamento atual byte-idêntico)
7. **Docs**: CONFIGURATION.md (seção tenants), MODEL-ROUTER.md, FUNCTIONAL-SPEC roadmap → Done

## Fora de escopo v1

Auth entre usuários remotos (loopback-only permanece); quotas por tenant; roteamento cross-máquina.

## Critérios de aceite

- [ ] Spike do carrier provado E2E (decisão documentada aqui)
- [ ] Sem header → comportamento idêntico ao atual (suite verde, zero diff funcional)
- [ ] Com header → sticky pins/métricas isolados por tenant
- [ ] Dashboard filtra por tenant
- [ ] Suite inteira verde + gate PASS + revisor adversarial PASS por fase executada

## Processo

Revisão adversarial do plano (subagente) em loop até aprovar → executar task a task com gate → revisor por fase → commit. Atualizar este arquivo (decisão do spike) e o backlog README no fechamento.
