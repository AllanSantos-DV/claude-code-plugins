# ADR-007 — user-config em diretório global estável

**Status:** Aceito | **Data:** 2026-07 | **Escopo:** Configuração persistente

## Contexto

Overrides do usuário (chave NVIDIA, toggles, headers BYOK) viviam em `DATA_DIR/model-router/user-config.json`. O DATA_DIR pode ser consolidado/recriado entre updates — credenciais viravam órfãs.

## Decisão

Toda config de usuário vai para caminho GLOBAL estável fora do pacote versionado: `~/.claude/claude-code-boss/model-router/user-config.json`, `~/.claude/claude-code-boss/hooks/user-config.json` e `~/.claude/claude-code-boss/user-config.json` (Brain — flat, sem subpasta) (`lib/router-config-path.js`, `lib/hooks-config.js`, `lib/brain-config.js`). Backfill one-time move configs legadas sem sobrescrever global existente.

## Consequências

- Escolhas sobrevivem a updates e consolidação de data-dirs
- Merge: router é **raso** (`mergeRouterConfig` — objetos como sticky/fallback/byok/contextTuning preservam chaves shipadas); hooks e brain usam **deepMerge** recursivo. Em ambos, o override vence
- Credenciais num único lugar conhecido, permissão 0600 best-effort
