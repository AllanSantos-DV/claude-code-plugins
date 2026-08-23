# Fase F — Brain Web UI (aba "Brain Manager" no dashboard)

> **Status: READY TO START.** Design aprovado por revisão adversarial (2026-08-23).
> Dossiê auto-suficiente — não depende de contexto de chat.

## Referências

- **Design:** [ADR-012-brain-web-ui-design.md](../adr/ADR-012-brain-web-ui-design.md)
- **Código base:** `scripts/dashboard.js`, `dashboard/index.html`, `scripts/brain-backend.js`, `scripts/brain-store.js`
- **Fatos verificados (revisão 2026-08-23):**
  - `withLock` vive no daemon brain-server (`servers/brain-server/lib/mcp-server.js:380`) e **não alcança o dashboard em backend local** — serialização local é responsabilidade desta fase
  - Backend `local` = SQLite via `node:sqlite` com fallback JSON (`brain-store.js`); backend `mcp-memory` = Java daemon HTTP
  - Dashboard já tem auth (token + Host allowlist) e padrão de abas/tabs

## Decisões estruturais já fechadas

1. **NÃO criar app novo** — aba "Brain Manager" no dashboard existente
2. **CRUD seguro**: deletar exige **backup one-click antes** (export jsonl do subset); verify-before-delete obrigatório (ler de volta após write, senão NÃO deleta fonte)
3. **Operações pesadas continuam CLI**: reembed/consolidate/migrate têm progresso+locks próprios; a UI só dispara e mostra status
4. **Serialização de escrita**:
   - backend `mcp-memory` → rotear escritas pelo daemon (lock server-side)
   - backend `local` → file-lock CAS próprio no dashboard (mesmo padrão do curation-queue `_save` CAS)

## Tarefas

1. **API `/api/brain/*`** no `dashboard.js`: `search` (delega brain-backend search), `list` (paginado por projeto, filtros type/scope/tag), `get`, `update` (title/summary/tags/detail — re-embed se summary/title mudarem), `delete` (com `backup:true` obrigatório no payload), `export`. Todas atrás da auth existente
2. **Serialização**: implementar o CAS local (temp+rename com compare-and-swap por mtime/hash) ou roteamento pelo daemon — decidir na task com spike de 2 cenários de escrita concorrente
3. **UI — aba Brain Manager**: busca (caixa + resultados com score), lista paginada com filtros, editor inline de entrada, delete com confirm duplo + download do backup, botão export
4. **Re-embed awareness**: editar entrada marca embedding stale; badge na UI apontando para `node scripts/brain-reembed.js`
5. **Testes**: CRUD round-trip hermético (temp CLAUDE_PLUGIN_DATA), concorrência de escrita (CAS rejeita stale), delete sem backup é recusado, verify-before-delete mantém fonte quando write falha
6. **Docs**: CONFIGURATION/FEATURES/FUNCTIONAL-SPEC

## Fora de escopo v1

Edição manual de embeddings; multi-usuário; import de jsonl (só export).

## Critérios de aceite

- [ ] Buscar/listar/editar/deletar funcionam nos DOIS backends (local e mcp-memory)
- [ ] Delete sem backup prévio: recusado pela API (fail-loud)
- [ ] Escrita concorrente: CAS rejeita stale (teste prova)
- [ ] Suite inteira verde + gate PASS + revisor adversarial PASS

## Processo

Revisão adversarial do plano em loop até aprovar → executar task a task com gate → revisor por fase → commit. Atualizar backlog README no fechamento.
