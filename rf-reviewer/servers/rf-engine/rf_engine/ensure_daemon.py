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
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__
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


def _spawn(ddir: Path) -> None:
    """Sobe o daemon detached (singleton garantido via EADDRINUSE no start_daemon)."""
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


def _stop_stale(pid: int, hurl: str, timeout: float = 8.0) -> None:
    """Encerra um daemon OBSOLETO (versão != código instalado) e espera a porta
    liberar. FAIL-LOUD: sem pid, sem permissão ou porta que não libera => erro
    explícito — nunca segue servindo código velho como se estivesse tudo ok."""
    if pid <= 0:
        raise RuntimeError(f"daemon rf-engine obsoleto sem pid no /health ({hurl}); "
                           "não dá para substituir com segurança")
    try:
        os.kill(pid, signal.SIGTERM)  # Windows: TerminateProcess; POSIX: shutdown gracioso
    except ProcessLookupError:
        pass  # já morreu — ótimo
    except PermissionError as e:
        raise RuntimeError(f"sem permissão para encerrar o daemon rf-engine obsoleto "
                           f"(pid {pid}): {e}") from e

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.25)
        if _health(hurl) is None:      # parou de escutar -> porta a caminho de liberar
            time.sleep(0.5)            # respiro p/ o SO soltar o socket de escuta
            return
    raise RuntimeError(f"daemon rf-engine obsoleto (pid {pid}) não encerrou em {timeout}s "
                       f"({hurl}); porta ainda ocupada")


def ensure_daemon(data_dir: str | Path | None = None, wait_s: float = 15.0) -> str:
    """Garante 1 daemon vivo E NA VERSÃO do código instalado; retorna a URL /mcp.

    Idempotente. Se o daemon vivo for de uma versão ANTIGA (após o update do plugin),
    ele é reiniciado automaticamente — o update "pega" sem reinício manual da máquina.
    """
    ddir = Path(data_dir) if data_dir else ht.get_data_dir()
    hurl = ht.health_url(ddir)
    murl = ht.mcp_url(ddir)

    info = _health(hurl)
    if info is not None:
        if info.get("version") == __version__:
            return murl  # vivo e ATUAL — noop
        sys.stderr.write(f"[rf-engine] daemon v{info.get('version')} obsoleto "
                         f"(código v{__version__}); reiniciando…\n")
        _stop_stale(int(info.get("pid") or 0), hurl)

    _spawn(ddir)

    deadline = time.time() + wait_s
    respawned = False
    while time.time() < deadline:
        time.sleep(0.3)
        info = _health(hurl)
        if info is not None and info.get("version") == __version__:
            return murl
        # rede de segurança: se logo após matar o antigo o filho saiu por EADDRINUSE
        # transitório, tenta subir de novo UMA vez ao passar da metade do prazo.
        if not respawned and info is None and time.time() > deadline - wait_s / 2:
            _spawn(ddir)
            respawned = True
    raise RuntimeError(f"daemon rf-engine v{__version__} não respondeu ao /health "
                       f"em {wait_s}s ({hurl})")


def main() -> None:
    url = ensure_daemon()
    sys.stdout.write(url + "\n")


if __name__ == "__main__":
    main()
