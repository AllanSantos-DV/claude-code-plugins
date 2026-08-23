# ADR-009 — Kill de daemon órfão no SessionStart sem FORCE_RESTART

**Status:** Aceito | **Data:** 2026-08-23 | **Escopo:** model-router-ensure

## Contexto

Usuário que editava `user-config.json` à mão para desligar o router ficava com o daemon vivo segurando a porta: o kill só acontecia via dashboard (`BOSS_ROUTER_FORCE_RESTART=1`). Limitação documentada virou ponto em aberto.

## Decisão

No bloco `mode === 'off'`, o **SessionStart** (janela segura — roda antes do primeiro request da sessão) mata o daemon órfão mesmo sem FORCE_RESTART, desde que `servesThisBuild(pid)` confirme que é nosso build. Em **UserPromptSubmit** o kill continua proibido: derrubar a porta no meio do turno corta a API da própria sessão.

## Consequências

- Edição manual passa a surtir efeito completo no próximo boot do CC
- Fail-safe preservado: build desconhecido/PID ilegível → não mexe
- Dashboard mantém o caminho síncrono imediato (FORCE_RESTART)
