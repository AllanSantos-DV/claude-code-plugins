# ADR-010 — BYOK Classify: classificação remota pelo endpoint do usuário

**Status:** Aceito | **Data:** 2026-08-23 | **Escopo:** Model Router / classificador

## Contexto

A classificação de tier tinha dois caminhos: MiniLM local (default, zero egress) ou NIM remoto (opt-in, exige chave NVIDIA). Usuário BYOK (`mode: always`) já manda TODO o tráfego ao próprio endpoint — não faz sentido exigir chave NVIDIA para ter classificação remota de qualidade superior ao MiniLM.

## Decisão

Novo opt-in `byok.classifyRemote: true`: quando o upstream BYOK está ativo, o classificador envia um prompt mínimo (~500 chars + instruções fixas) via `POST /v1/messages` ao PRÓPRIO endpoint pedindo um tier único (haiku|sonnet|opus), com timeout curto e parse tolerante. Falha/timeout/resposta inválida → fallback silencioso para MiniLM local (fail-open). Resultado entra no mesmo cache sticky por sessionKey (uma classificação por sessão, como hoje).

## Consequências

- Cada sessão custa 1 request minúscula no endpoint do usuário (custo dele, consciente)
- Privacidade: prompt parcial vai ao endpoint que já recebe tudo em mode=always; em on-limit NÃO classifica remotamente a menos que o cooldown esteja ativo (mesmo gate do fallback)
- Sem dependência nova; sem chamada quando `classifyRemote !== true`
