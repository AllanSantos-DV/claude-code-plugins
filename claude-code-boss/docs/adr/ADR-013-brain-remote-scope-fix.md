# ADR-013 — Correção do adaptador remoto do Brain: tradução de scope, sanitização e idempotência

**Status:** Proposto (revisado em loop — r4, sign-off) | **Data:** 2026-08-23 | **Escopo:** Brain / MCP Memory Server (remoto) | **Baseline de server: 2.39.1 (sem retrocompat)**

## Premissa de versão

Server **2.39.1+** é o alvo. Plugin não suporta servidor desautorizado: se detectar desatualizado, aciona o autoupdate existente em vez de fazer workaround. Spike, integração e aceite rodam contra 2.39.1 vivo.

## Contexto

Validação cruzada em 3 máquinas (claude-code-boss 2.21.10 + MCP Memory Server 2.36.1, backend `mcp-memory` via `http://192.168.18.13:38080`) provou que gravações com `scope="user"` caem no projeto ativo (`project_id=la-positiva`, `metadata.scope="user"` como resíduo), sem roteamento para o home global, sem sanitização e sem `documentId` estável. `brain_search` com `scope=user|project` retorna conjuntos idênticos — o scope não é traduzido para a chamada remota.

**Análise server-side (fonte `native-java` @ v2.39.1, revisão 2026-08-24) confirmou:**
- `scope:"global"` é **diretiva de wire top-level** consumida no handler e nunca persistida (`MemoryHandler.handleAddDocument`); escrita global = `project_id` AUSENTE + client-free + tipo `procedural|skill` + `documentId` estável OBRIGATÓRIO (fail-loud em tudo, inclusive ownership guard no overwrite).
- **Spine home no recall** (`RecallComposer`): `recall = procedural[home] + skill_global + blocos do projeto ativo` — home é documento SEM `project_id`, checado em Java; blocos home NUNCA são filtrados por sub-scope e entram no recall de todo projeto via `compose_recall`.
- **Duas superfícies de recall com semântica home diferente**: `compose_recall` sempre inclui home; `search_memory` cru só inclui home com `includeHome:true` (aditivo, ADR-017). Nem `search_memory` nem os itens de bloco do `compose_recall` retornam `project_id`/escopo por item — a projeção de escopo no plugin precisa ser DERIVADA (rótulo do bloco: `procedural`/`skill_global` ⇒ home) ou resolvida via lookup extra.
- **Parser de ingestão já tolera string E blocos** (`TemplateParser.extractText`: `content.isTextual()` → texto direto) — não há gap de strictness do seed; falha de extração vem de linhas sem bloco `type:text` (thinking/tool_use), não do formato.
- `metadata.scope="user"` **nunca foi diretiva** server-side — sempre foi resíduo persistido verbatim.
- Consequência: **salvo o que o spike da Decisão 5 apontar, nenhuma mudança no server é necessária**; o elo quebrado é o adaptador no plugin.

## Decisão

Fatorar a **preparação da entry antes da bifurcação local/remoto** e corrigir o adaptador remoto:

1. **Resolver escopo efetivo** antes de escolher backend: `scope in {project,user} ? scope : inferDefaultScope(type, tags)`.
2. **`effectiveScope=user`:** `prepareForUserScope()` + rejeitar segredo + sanitizar caminho/e-mail/identidade do projeto + gerar `documentId` estável + mapear `type` Boss → `procedural` (ou `skill` somente com `type==='skill'` explícito) + preservar `bossType` + enviar `scope:"global"` top-level em `add_document`. **Escritas globais NÃO enviam chaves de isolamento** (`agentId`/`channel`/`sessionKey`). Sem chaves, o ownership guard do server não tem contra o que comparar — na prática ele rejeita QUALQUER overwrite cross-agente de doc client-free; isso é seguro aqui porque o `documentId` derivado de conteúdo garante que edição ⇒ novo ID (retry legítimo é byte-idêntico, mesmo ID, mesma sessão). Esclarecer o mecanismo exato do guard no spike antes de codar esse caminho.
3. **`effectiveScope=project`:** handshake no projeto, omitir `scope` top-level, preservar tipo Boss, também gerar `documentId` estável.
4. **`documentId` estável:** derivado de `windowId` quando houver, senão hash normalizado (trim + colapso de whitespace + JSON estável de {title,type,tags,bossType,content}) de título+tipo+tags+bossType+conteúdo normalizado; mesma oferta gera mesmo ID (idempotência de retentativa e timeout). **Nota:** edição de conteúdo muda o hash → nova entrada em vez de update — aceitável para idempotência de retentativa (a retentativa é byte-idêntica); edição legítima passa pelo fluxo de update do dashboard.
5. **`brain_search`:** traduzir `scope` para chamada remota — `project` sem `includeHome`, `both` com `includeHome:true`, `user` conforme primitiva provada no spike 2.39.1 (home-only via compose_recall adaptado ou nova operação; decidir no spike antes de codar).
6. **Projeção de tipo/escopo:** `normalizeSearchItem()` prefere `bossType` quando existir. **Derivação de escopo**: a resposta do server não traz `project_id` por item — `compose_recall` deriva pelo RÓTULO DO BLOCO (`procedural`/`skill_global` ⇒ home); para `search_memory` cru a exposição de scope fica CONDICIONADA ao spike (ou lookup extra via `get_document`, ou abandona-se a promessa para esse caminho e documenta-se a limitação).

Ingestão (`ingest_conversation`) permanece fora — é rota interna distinta, sem `project_id`, já correta.

## Consequências

- Gravações `user` passam a cair no home global, sanitizadas e idempotentes → entram no spine home e são entregues a todos os projetos via `compose_recall`.
- `brain_search` por escopo retorna conjuntos coerentes e diferentes (validável).
- `isError:true` continua fail-closed, sem ACK fantasma.
- Resíduos antigos (`metadata.scope="user"` em docs já gravados) continuam nos projetos de origem — estado conhecido, sem migração nesta etapa.
- Nenhuma migração/limpeza de dados existentes nesta etapa — só novas gravações corrigidas.

## Alternativas consideradas

- Sanitizar só no server: rejeitado — o adaptador já tem a lógica local e deve aplicá-la antes do envio; e o server já valida fail-loud o que recebe.
- Manter `metadata.scope` como diretiva: rejeitado — fonte do server prova que a diretiva é wire-only top-level; metadata vaza por update/PATCH/reclassify/batch.
- Corrigir strictness do seed p/ user-as-string: retirado — o parser já tolera (análise server-side).
