# Migration Guide

> Mudanças entre versões que exigem ação do usuário.

## Regra geral

O plugin migra sozinho sempre que possível: backfills de config legacy→global rodam one-time sem sobrescrever, e o user-config sobrevive a updates (vive em `~/.claude/claude-code-boss/`, fora do pacote). As exceções — onde VOCÊ precisa agir — estão abaixo.

## Trocar o modelo de embedding

**Quando:** mudou `embedder.model` no dashboard ou config.

```powershell
node scripts/brain-reembed.js
```

**Obrigatório.** Embeddings do modelo antigo ficam inválidos — sem reembed, a busca vetorial degrada silenciosamente. A dimensão muda junto com o modelo.

## Trocar backend do Brain (local ↔ mcp-memory)

1. `/dashboard` → Brain KB → Backend
2. Use **Test connection** antes de salvar (mcp-memory exige Java 21+)
3. Migre a KB com **Migrate now** — idempotente (documentId = entry id), seguro re-executar

Nota: o daemon remoto não modela escopo-user. Entradas do shard local `__user__` migram como um projeto comum chamado `__user__` — perdem o caráter global (não são mais visíveis de qualquer projeto).

## Consolidar data-dirs fragmentados

**Sintoma:** doctor avisa ">1 populated data-dir" (ex.: `claude-code-boss` + `claude-code-boss-inline`).

```powershell
node scripts/consolidate-datadirs.js            # dry-run: mostra plano, não escreve nada
node scripts/consolidate-datadirs.js --apply    # executa: backup → absorve → deleta siblings
```

- A pasta ativa NUNCA é deletada; pinne com `--active-dir <path>` se necessário
- Lock vivo bloqueia o apply; lock stale é tomado
- Falha em qualquer entry mantém o sibling vivo (verify-before-delete)

## Configs legadas (backfill automático)

Configs antigas em `DATA_DIR/*/user-config.json` são copiadas one-time para o caminho global estável (`~/.claude/claude-code-boss/...`) no próximo boot. O backfill **nunca sobrescreve** um global existente. Se algo parecer perdido, procure siblings de DATA_DIR antes de reconfigurar.

## Identidade de projeto legada

`.claude-boss-project` na raiz ainda funciona (read-only), mas está **deprecado**: o mecanismo atual é `.memory/project.json` (`metadata.defaults.project_id`). O advisory de SessionStart avisa quando encontrar o marker antigo. Sem fallback por nome de pasta — pasta não-git sem markers erro com instrução.

## Router após update grande

Se o comportamento do proxy parecer antigo:

1. Confira o modo no dashboard (hero card) vs o esperado
2. `/dashboard` → Router → **Salvar & aplicar** — o ensure compara fingerprint da config e mata daemon desatualizado
3. Persistindo: reinicie o Claude Code completamente

## Checklist pós-update

```
[ ] npm install && npm run gate (dev checkout)
[ ] /reload-plugins ou restart completo do CC
[ ] node scripts/doctor.js  → tudo ✓?
[ ] Dashboard abre e mostra o modo correto?
[ ] brain_search encontra lições antigas? (projectId estável?)
```
