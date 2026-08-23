# ADR-008 — contextTuning ganha toggle no dashboard

**Status:** Aceito | **Data:** 2026-08-23 | **Escopo:** Dashboard / env-tuning

## Contexto

O env-tuning (`ENABLE_TOOL_SEARCH` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) era opt-in só via edição manual do user-config — invisível para quem não lê docs. O pipeline server-side já existia (write/resolve/apply), faltava a superfície de UI.

## Decisão

Checkbox na aba Router, persistindo em `user-config.json` como `contextTuning.enabled`. GET `/api/router/config` passa a expor o estado. O ensure aplica/remove o tuning **sem publicar base_url** (decisão pré-existente ADR-003: preserva janela 1M).

## Consequências

- Ganho de token acessível a quem usa modelos 1M sem pagar o teto de 200K
- Toggle independente dos modos do proxy (ortogonal por design)
- disableAllRouter continua zerando o toggle (master-off)
