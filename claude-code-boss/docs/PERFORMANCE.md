# Performance Tuning

> Onde o tempo/memória vai e como ajustar.

## Brain KB

| Alavanca | Efeito |
|----------|--------|
| `embedder.provider: transformers` (default) | Local/offline, zero custo por query; primeiro uso baixa ~100-200MB uma vez |
| `ollama` | GPU local, embeddings mais rápidos em volume — requer serviço externo rodando |
| `voyage` | Melhor qualidade multilingual, custo por chamada + latência de rede |
| Tamanho da KB | Até ~10k entradas a busca vetorial local é fluida; acima disso considere backend mcp-memory |
| Consolidação | Near-dups diluem recall e incham o índice — consolidação mensal mantém o pool enxuto |

## Retrieval

- `fastTopK` shipado é **1** por design: injeção in-loop mínima, contexto barato. Pesquisa profunda usa `deepTopK` separado.
- `minScoreFast` 0.50 é calibrado para MiniLM multilingual. Baixar demais = ruído no contexto (custa tokens e qualidade).
- Pool-warming do embedder é fire-and-forget: recall nunca bloqueia esperando modelo.

## Model Router

| Alavanca | Ganho |
|----------|-------|
| Sticky Router | Cache quente = input cobrado a ~0.1x; maior economia individual do plugin |
| contextTuning | `ENABLE_TOOL_SEARCH` difere ~52k tokens/request (medido em campo) + auto-compact teta o contexto ativo (cache_read/turno 447k → 74–127k) |
| Daemon único | Um processo Node serve N sessões — RAM constante vs N cópias |
| TTL do sticky pin (6h) | Sessões longas reclassificam após ocioso — ajuste `sticky.ttlMs` se roda turnos >6h |

## Hooks

- Stop = **1 spawn** (`stop-dispatcher` com 16 detectores in-process) em vez de 11+ processos
- Cooldowns e budgets impedem detectors de dispararem toda hora (turn-budget, session-cap)
- Timeouts curtos nos hooks.json garantem que um hook lento nunca segure o turno

## Graph

- Status-first: leituras nunca indexam sozinhas (index é explícito, com cooldown)
- Fail-open quando daemon offline — zero bloqueio
- Em backend `local`, tools respondem orientação sem contato de rede

## Dashboard

- On-demand: só roda quando você pede `/dashboard`
- Ring buffer de logs limitado (500 entradas)
- Métricas agregadas em SQLite com cache por mtime (WAL-safe)

## Anti-padrões que custam caro

| Anti-padrão | Custo |
|-------------|-------|
| Routing per-turn (`enabled: true`) | Quebra prompt cache a cada troca — custo SOBE |
| minScoreFast muito baixo | Ruído injetado em todo turno |
| KB sem consolidação | Recall diluído + índice inflado |
| Múltiplos data-dirs fragmentados | Embedder/daemon duplicados, estado dividido |
