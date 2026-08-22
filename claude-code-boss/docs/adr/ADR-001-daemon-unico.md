# ADR-001 — Daemon único por port-lock para runtimes residentes

**Status:** Aceito | **Data:** 2026-05 | **Escopo:** Brain HTTP daemon, Model Router

## Contexto

Componentes residentes (embedding warm, KB compartilhada, proxy) rodavam por sessão. Com N sessões do CC abertas, N cópias do runtime subiam — RAM/CPU multiplicando.

## Decisão

Todo runtime vivo vinculado à sessão vira **daemon único**: singleton por port-lock (arquivo `daemon.json`/`state.json` em run-dir estável), com sessões como **clientes finos** via HTTP loopback.

## Consequências

- RAM constante independentemente do nº de sessões
- Registry (`~/.mcp-memory/run/daemon.json`, router `state.json`) permite descoberta e health-check
- Troca de build precisa de janela segura (SessionStart ou apply explícito) — kill no meio de turno derruba a API da própria sessão
