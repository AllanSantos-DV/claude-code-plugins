# Brain KB — Guia Completo

> Base de conhecimento semântica com busca vetorial, captura automatica de licoes e loop de aprendizado.

## O que e

O Brain e a memoria do plugin: persiste licoes entre sessoes e re-injeta contextualmente quando um prompt novo e parecido com algo ja aprendido. Tudo roda local por padrao.

```
Captura (Stop hook)            Recuperacao (UserPromptSubmit)
erro corrigido --+              novo prompt --> embedding --> busca vetorial
padrao notado ---+--> Brain KB  |                            |
decisao tomada --+   (SQLite)   |            <-- licoes relevantes injetadas
                    v
         consolidacao semanal (merge near-dups)
```

## Tipos de Entrada

| Tipo | Quando usar | Exemplo |
|------|-------------|---------|
| `note` (default) | Nota generica sem classificacao forte | Observacao solta de sessao |
| `lesson` | Voce corrigiu o agente ou ele errou | "Nunca usar head no PowerShell; use Select-Object -First" |
| `pattern` | Fluxo reutilizavel descoberto | "Para testar hooks isoladamente, use temp CLAUDE_PLUGIN_DATA" |
| `decision` | Escolha arquitetural + rationale | "Daemon unico por port-lock em vez de servidor por sessao (RAM)" |
| `research` | Finding externo validado | "MiniLM-L12-v2 cobre 50 idiomas a 384 dims" |
| `code` | Snippet/codigo de referencia | Wrapper .ps1 canonico |
| `reference` | Link/doc importante | URL da doc do Streamable HTTP |

## Como o Brain Aprende (captura automatica)

1. **Deteccao**: no fim do turno (`Stop` hook), detectors identificam correcao do usuario, falha recorrente, decisao explicita ou padrao curado.
2. **Oferta**: um review-block oferece capturar a licao (block-until-ack, max 5 tentativas antes de relentar — a licao nunca se perde).
3. **Capturacao**: o agente escreve titulo/sumario/detalhe/tags em ingles (KB e canonica em ingles para retrieval cross-lingual).
4. **Admission control**: near-duplicate e MERGEdo (recurrence sobe) em vez de duplicado. Recorrencia alta alimenta a promocao para skill global.
5. **Persistencia**: SQLite local (`node:sqlite` builtin, zero deps nativas) ou MCP Memory Server Java (opcional, multi-workspace).

## Como o Brain Recorda

- **Automatico**: cada UserPromptSubmit roda `brain_retrieve_context` — busca vetorial com gate de relevancia; licoes acima do score entram no contexto.
- **Manual**: tool MCP `brain_search` (semantico com fallback por keyword), `brain_related` (grafo de citacoes), `brain_count`.
- **Escopo**: `project` / `user (global)` / `both`. Entradas globais sao sanitizadas (sem paths/emails/segredos).

## Backends

| Backend | Quando | Custo |
|---------|--------|-------|
| `local` (default) | Um desenvolvedor, um projeto por vez | Zero; SQLite embutido |
| `mcp-memory` | Multi-workspace ou KB compartilhada | Java daemon (heap cap `-Xmx512m`), porta efemera |

Troca no `/dashboard` -> Brain KB -> Backend. Migracao local->server: botao "Migrate now" (idempotente, documentId = entry id).

## Embedder

| Provider | Caracteristica |
|----------|----------------|
| `transformers` (default) | Local/offline, MiniLM-L12-v2 multilingual 384d, download ~100-200MB uma vez |
| `ollama` | GPU local, HTTP externo |
| `voyage` | API paga, melhor qualidade multilingual |

**Trocou modelo? Rode `node scripts/brain-reembed.js`** — embeddings antigos ficam invalidos.

## Consolidacao

Near-duplicates (cosine 0.7–0.9, mesmo tipo) sao agrupados: recurrence somada no survivor e absorvidos sao deletados. A aplicacao roda em transacao atomica SQLite (tudo-ou-nada) mas **sem backup** — deletados nao sao recuperaveis. Preview sem aplicar:

```
/dashboard -> Home -> KB hygiene -> Preview
node scripts/brain-consolidate.js          # dry-run
node scripts/brain-consolidate.js --apply  # aplica (transacao atomica, sem backup)
```

Roda sozinho semanalmente tambem.

## Identidade de Projeto

Ordem de resolucao (fail-loud se nada resolver):

1. Env `CCB_PROJECT_ID`
2. Arquivo `.memory/project.json` (campo `metadata.defaults.project_id`) — mecanismo atual recomendado
3. Legacy `.claude-boss-project` na raiz — **deprecado**, ainda honrado (read-only)
4. Git remote origin normalizado (`host/owner/repo`)

Nao existe fallback por nome de pasta (removido por gerar escopo sujo). Em pasta nao-git sem markers o plugin erro com instrucao (`SCOPE_HELP`). O dashboard ainda grava o marker legacy; o advisory de SessionStart sugere migrar para `.memory/project.json`.

## Oramento de Memoria

Preset rapido no dashboard: lean (3k/45d), balanced (10k/90d), ample (30k/180d). Alem do teto: entradas antigas viram candidatos a arquivo.

## Troubleshooting Rapido

| Sintoma | Causa provavel |
|---------|----------------|
| Busca nao acha licoes obvias | minScoreFast muito alto (shipped: 0.50); embedder quebrado |
| Primeira execucao demora | Download do modelo embedding (uma vez) |
| Licoes "somem" apos trocar pasta | projectId mudou — fixe via `.memory/project.json` ou env `CCB_PROJECT_ID` |
| MCP DOWN no doctor | Java ausente ou daemon morto; troque p/ local |
