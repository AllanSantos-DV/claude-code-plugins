# ADR-012 — Brain Web UI: design para implementação futura

**Status:** Proposto (PLANNED — implementação agendada) | **Data:** 2026-08-23 | **Escopo:** Brain / Dashboard

## Contexto

Roadmap pedia UI web para gerenciar a KB. Decisão estrutural primeiro: **não** criar um app novo — estender o dashboard existente (mesma auth, mesmo ciclo de release).

## Design proposto

1. **Aba "Brain Manager" no dashboard**: busca (semântica via daemon/local), lista paginada por projeto com filtros type/scope/tag
2. **CRUD seguro**: editar título/summary/tags/detail; deletar com backup local one-click (jsonl export antes); criar entrada manual
3. **Operações pesadas delegadas**: reembed/consolidate/migrate continuam CLI (já têm progresso e locks) — a UI só dispara e mostra status
4. **API**: endpoints `/api/brain/*` no dashboard.js falando com brain-backend (local sqlite ou daemon). **Serialização:** `withLock` vive no daemon brain-server e não alcança o dashboard em backend local — local-mode precisa de serialização própria (file-lock no estilo curation-queue CAS) ou rotear operações de escrita pelo daemon
5. **Não-goals v1**: editor de embeddings na mão; multi-usuário

## Por que PLANNED

Superfície de UI + API nova grande; merece gate adversarial próprio (CRUD em KB é caminho de destruição de dados — verify-before-delete obrigatório).
