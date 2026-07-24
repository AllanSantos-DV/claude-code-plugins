"""
rf_engine.paths — LUGAR ÚNICO do diretório persistente por-usuário.

Todo estado que precisa SOBREVIVER a updates do plugin (perfis custom, token,
lock, log do daemon) mora aqui — FORA da árvore de código do plugin, que é
substituída a cada atualização. Um só lar, global ao usuário e compartilhado por
todas as sessões (o daemon único).

Sem dependências internas (só stdlib) de propósito: qualquer módulo do motor pode
importar isto sem risco de import circular.
"""
from __future__ import annotations

import os
from pathlib import Path


def get_data_dir() -> Path:
    """Diretório persistente por-usuário (perfis, lock, token, log).

    Override explícito por env `RF_ENGINE_DATA_DIR`; senão `~/.rf-engine`.
    """
    env = os.environ.get("RF_ENGINE_DATA_DIR")
    return Path(env) if env else (Path.home() / ".rf-engine")
