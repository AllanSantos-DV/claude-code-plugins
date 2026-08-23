# Backlog — itens prontos para iniciar

> Cada item aqui é um **dossiê auto-suficiente**: uma sessão nova (ou pós-compact) consegue
> iniciar e executar sem re-fazer descoberta. Processo obrigatório por item:
>
> 1. Ler o dossiê + ADR referenciado
> 2. Revisão adversarial do plano (subagente) em loop até aprovar
> 3. Executar fase a fase com `npm run gate` verde por fase + revisor por fase
> 4. Atualizar este README (status) + FUNCTIONAL-SPEC roadmap no fechamento

## Itens

| Item | Dossiê | ADR | Status |
|------|--------|-----|--------|
| **Fase E** — Multi-tenant Router | [PHASE-E-multi-tenant-router.md](./PHASE-E-multi-tenant-router.md) | [ADR-011](../adr/ADR-011-multi-tenant-design.md) | ✅ DONE (2026-08-23 — carrier provado, gate 909 verde) |
| **Fase F** — Brain Web UI | [PHASE-F-brain-web-ui.md](./PHASE-F-brain-web-ui.md) | [ADR-012](../adr/ADR-012-brain-web-ui-design.md) | 🟢 READY |

## Regras de ouro (do dono)

- **Não existe "fase futura"**: tudo validado durante um trabalho fica registrado aqui para continuidade.
- Sessões longas: rodar `/compact` ao fim do escopo e dar sequência nos itens dedicados deste backlog.
- Meia-boca não entra: cada fase só sai com gate verde + revisor adversarial PASS.
