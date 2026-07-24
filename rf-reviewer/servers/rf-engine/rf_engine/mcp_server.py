"""
rf_engine.mcp_server — entry-point do MCP rf-engine (Streamable HTTP, daemon único).

O transporte **stdio foi REMOVIDO** (migração concluída): o rf-engine agora serve
MCP por **HTTP** a partir de um **daemon único compartilhado**
(`rf_engine.http_transport`), com as sessões do Claude Code como **clientes HTTP
finos** (o próprio cliente MCP do Claude conecta na URL — zero processo por sessão).
Isso elimina a multiplicação de 1 processo por sessão que travava a máquina.

Este módulo é só o entry-point de compatibilidade:
  python -m rf_engine.mcp_server            # sobe o daemon (== python -m rf_engine.http_transport)
  python -m rf_engine.http_transport --print-config   # gera o bloco .mcp.json (type:http) desta máquina

Wiring no Claude Code e ciclo de vida do daemon: veja MCP.md.
"""
from __future__ import annotations

from .http_transport import main

if __name__ == "__main__":
    main()
