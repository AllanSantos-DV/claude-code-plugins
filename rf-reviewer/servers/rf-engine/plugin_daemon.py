"""
plugin_daemon.py — launcher do daemon rf-engine para o plugin rf-reviewer.

Chamado pelo hook SessionStart do plugin. Garante que EXISTE 1 daemon HTTP único
do rf-engine vivo (idempotente: sobe se preciso, no-op se já está de pé), na porta
fixa do plugin. As sessões do Claude Code conectam nesse daemon por HTTP
(.mcp.json type:http) — sem 1 processo Python por sessão.

Auto-resolve o sys.path (não depende de PYTHONPATH do ambiente do hook) e fixa a
porta em RF_ENGINE_HTTP_PORT antes de subir o daemon. Nada vai ao stdout (não
polui o contexto do Claude); erros vão ao stderr.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# servers/rf-engine no sys.path (este arquivo mora lá) — importa rf_engine sem PYTHONPATH
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Porta fixa do plugin (override consciente via env). Casar com a url do .mcp.json.
os.environ.setdefault("RF_ENGINE_HTTP_PORT", "19847")


def main() -> None:
    try:
        from rf_engine.ensure_daemon import ensure_daemon
        ensure_daemon(wait_s=20)
    except Exception as exc:  # noqa: BLE001 — hook nunca deve derrubar a sessão
        sys.stderr.write(f"[rf-reviewer] falha ao garantir o daemon rf-engine: {exc}\n")


if __name__ == "__main__":
    main()
