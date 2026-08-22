# ADR-005 — Shim do claude.exe no Claude Desktop (Windows)

**Status:** Aceito | **Data:** 2026-07 | **Escopo:** Model Router / Desktop entrypoint

## Contexto

Provado em campo (CC Desktop 2.1.197+): o app FORÇA `ANTHROPIC_BASE_URL=api.anthropic.com` no processo claude-code, que passa a IGNORAR o bloco `env` do settings.json. O roteamento via settings funciona só no CLI.

## Decisão

No Desktop: renomear o binário (`claude.exe` → `claude-real.exe`) e instalar um wrapper compilado de `wrapper.cs` (C# via csc.exe, cache local) que lê a URL viva de `~/.claude/model-router-url.txt` e injeta a base URL só para este binário. Fail-open: sem url.txt ou router morto → chamada direta.

## Consequências

- Roteamento funciona nos dois entrypoints (CLI=settings.json, Desktop=shim)
- Manutenção via `maintainShim` (re-aplica após update do app que rebaixa o binário)
- Modo OFF remove todos os shims (`removeShimAll`, verificação por resultado)
