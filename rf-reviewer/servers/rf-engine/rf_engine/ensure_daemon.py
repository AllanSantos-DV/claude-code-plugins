"""
rf_engine.ensure_daemon — garante que EXISTE 1 daemon HTTP vivo (idempotente).

No modelo HTTP puro, o Claude Code só CONECTA numa URL — não spawna o servidor.
Então alguém precisa ser dono do ciclo de vida do daemon. Este módulo é esse dono,
fora-de-banda (não é transporte): faz health-check na porta determinística; se o
daemon já está vivo, é NOOP; se não, sobe um processo detached e espera o /health.

Reúso da ideia `ensureDaemon` do brain-server, adaptada (Python/stdlib). Pensado
para ser chamado por um SessionStart hook (ou o primeiro cliente) sem bloquear.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import http_transport as ht

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _health(url: str, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 (loopback)
            if r.status == 200:
                return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
        return None
    return None


def ensure_daemon(data_dir: str | Path | None = None, wait_s: float = 15.0) -> str:
    """Garante 1 daemon vivo e retorna a URL /mcp. Idempotente (2ª chamada = noop)."""
    ddir = Path(data_dir) if data_dir else ht.get_data_dir()
    hurl = ht.health_url(ddir)
    murl = ht.mcp_url(ddir)

    if _health(hurl):
        return murl  # já vivo — noop

    ddir.mkdir(parents=True, exist_ok=True)
    log_path = ddir / "rf-engine-http.log"
    logf = open(log_path, "a", encoding="utf-8")  # noqa: SIM115

    kwargs: dict = {"stdout": logf, "stderr": logf, "stdin": subprocess.DEVNULL,
                    "cwd": str(_REPO_ROOT),
                    "env": {**os.environ,
                            "PYTHONPATH": str(_REPO_ROOT) + os.pathsep + os.environ.get("PYTHONPATH", "")}}
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — sobrevive à sessão-pai.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True

    try:
        subprocess.Popen([sys.executable, "-m", "rf_engine.http_transport"], **kwargs)
    finally:
        logf.close()  # o filho herdou seu próprio handle; o pai fecha a cópia (sem leak)

    deadline = time.time() + wait_s
    while time.time() < deadline:
        time.sleep(0.3)
        if _health(hurl):
            return murl
    raise RuntimeError(f"daemon rf-engine não respondeu ao /health em {wait_s}s ({hurl})")


def main() -> None:
    url = ensure_daemon()
    sys.stdout.write(url + "\n")


if __name__ == "__main__":
    main()
