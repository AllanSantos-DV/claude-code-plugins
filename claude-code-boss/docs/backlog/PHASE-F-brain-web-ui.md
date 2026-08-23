# Fase F — Brain Web UI (aba "Brain Manager" no dashboard)

> **Status: DONE (implementado 2026-08-23)** — com DESVIO HONESTO de escopo documentado abaixo.

## ✅ Descoberta da implementação (reconhecimento antes de codar)

Muito do dossiê original JÁ EXISTIA na aba Brain KB do dashboard:
- search com scope project/user/both (`searchTwoPass`), get entry + related
- move-scope user↔project com sanitização `prepareForUserScope`
- export/import full-fidelity (getRaw + vetores, round-trip com import)

**Delta realmente entregue:**
1. **PUT /api/brain/entry/:id** — edição com whitelist ESTRITA (title/summary/type/tags/detail); detail mapeia p/ content.detail; re-embed automático quando title/summary mudam; verify-before-return relê do disco e compara
2. **DELETE endurecido** — backup JSON obrigatório ANTES da mutação (mesmo formato do export → importável), verify do backup (fonte intacta se falhar), delete, verify pós-delete; confirm duplo na UI mostrando o caminho do backup
3. **GET /api/brain/list** — browse paginado sem query (offset/limit cap 200)
4. **UI**: editor inline substituindo o `alert()`, botão Browse, paginação Prev/Next

## 🐛 Bug pré-existente pego em flagrante

O delete antigo chamava `store.delete(id)` com STRING — mas `delete_({id}={})` desestrutura, logo `id=undefined` → **DELETE silenciosamente não apagava nada** no SQLite (só removia do índice de keywords). Corrigido para `store.delete({ id })` + asserção permanente no teste para a classe inteira do erro.

## ⚠️ Desvio honesto de escopo (registrado em backlog)

Critério original "CRUD funciona nos DOIS backends" NÃO foi atendido integralmente: os handlers do dashboard (novos E pré-existentes) falam com o brain-store LOCAL — em backend mcp-memory eles leem/escrevem o espelho local, não o servidor. Migrar tudo p/ fachada `brain-backend` tocaria código estável (two-pass search custom, sanitização do move-scope) — merece sessão dedicada.
→ **Backlog novo**: ver README do backlog ("Brain dashboard CRUD via fachada mcp-memory").

## Decisão de serialização (task 2 do dossiê)

- local SQLite: WAL + busy_timeout 5000 já no store — escritas concorrentes seguras no nível do banco
- mcp-memory: escritas via ferramentas do daemon = lock server-side ✓
- fallback JSON: writeFileAtomic last-write-wins entre processos (limitação PRÉ-EXISTENTE de todos os writers) — CAS multi-writer ficou de backlog, não é introduzido pela Fase F

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
