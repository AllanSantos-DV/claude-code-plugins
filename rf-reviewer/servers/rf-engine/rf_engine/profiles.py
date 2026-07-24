"""
rf_engine.profiles — PERFIS de coluna (o "molde" da saída).

A mecânica do motor é fixa; o PERFIL diz QUAIS colunas saem: nome do cabeçalho,
chave canônica (no analysis.json), largura, cor do cabeçalho, dropdown (enum) e se
a célula é colorida por valor. Trocar de perfil = trocar o molde, sem tocar no motor.

Perfis embutidos:
  - "rf-end": modelo maduro/aprovado (8 validação + 5 consultivas).

Perfis específicos de cliente NÃO vêm embutidos (o plugin é agnóstico): registre o
seu em runtime com a tool rf_perfil_definir. Ele PERSISTE em ~/.rf-engine/
profiles_custom.json — no lar GLOBAL por-usuário (rf_engine.paths), FORA do plugin,
para sobreviver a updates e ser compartilhado por todas as sessões (o daemon único).
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import model
from .paths import get_data_dir


@dataclass
class ColumnDef:
    header: str                 # texto do cabeçalho na planilha
    key: str                    # chave no registro de análise (o agente preenche)
    width: float = 40.0
    header_fill: str = model.COLOR_HEADER_BG
    enum: list[str] | None = None   # se definido -> vira dropdown
    colored: bool = False           # célula colorida por valor (criticidad/prioridad)


@dataclass
class ColumnProfile:
    id: str
    name: str
    lang: str                   # 'es' | 'pt'
    columns: list[ColumnDef] = field(default_factory=list)
    build_resumo: bool = True
    build_leyenda: bool = True
    notes: str = ""

    @property
    def headers(self) -> list[str]:
        return [c.header for c in self.columns]

    @property
    def keys(self) -> list[str]:
        return [c.key for c in self.columns]

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ── perfil 1: rf-end (o modelo maduro — 8 validação + 5 consultivas) ─────────
def _rf_end() -> ColumnProfile:
    cols: list[ColumnDef] = []
    enums = {
        "criticidad": model.ENUM_CRITICIDAD,
        "tipificacion": model.ENUM_TIPIFICACION,
        "compatible": model.ENUM_COMPATIBLE,
        "prioridad": model.ENUM_PRIORIDAD,
        "tipo_mejora": model.ENUM_TIPO_MEJORA,
    }
    colored = {"criticidad", "prioridad"}
    for header, key, width in zip(model.ALL_ANALYSIS_COLUMNS, model.ALL_ANALYSIS_KEYS, model.ALL_ANALYSIS_WIDTHS):
        cols.append(ColumnDef(
            header=header, key=key, width=width,
            enum=enums.get(key), colored=(key in colored),
        ))
    return ColumnProfile(
        id="rf-end", name="RF_END (8 validación + 5 consultivas)", lang="es", columns=cols,
        notes="Modelo maduro/aprovado (rf-end-format-standard + proactive-consultant-columns).",
    )


# ── perfil 2 (exemplo cliente): registrado em runtime via rf_perfil_definir ──
# Perfis específicos de cliente NÃO são embutidos (o plugin é agnóstico); quem
# usa registra o seu com rf_perfil_definir (persiste em profiles_custom.json).


_BUILTIN = {p.id: p for p in (_rf_end(),)}
_CUSTOM: dict[str, ColumnProfile] = {}


def _custom_store() -> Path:
    """Store dos perfis custom — no diretório GLOBAL por-usuário (~/.rf-engine),
    FORA do plugin: sobrevive a updates e é compartilhado pelo daemon único."""
    return get_data_dir() / "profiles_custom.json"


def _legacy_store() -> Path:
    """Local ANTIGO (dentro da pasta do plugin) — só para a migração one-shot."""
    return Path(__file__).resolve().parent / "profiles_custom.json"


def _migrate_legacy_if_needed() -> None:
    """Move o store antigo (dentro do plugin, que se perdia a cada update) para o
    lar global, UMA vez. Fail-loud: erro de I/O propaga — nunca mascara silencioso."""
    new = _custom_store()
    old = _legacy_store()
    if new.exists() or not old.exists() or old.resolve() == new.resolve():
        return
    new.parent.mkdir(parents=True, exist_ok=True)
    new.write_text(old.read_text(encoding="utf-8"), encoding="utf-8")
    sys.stderr.write(f"[rf-engine] perfis migrados p/ lar global: {old} -> {new}\n")


def _load_custom() -> None:
    p = _custom_store()
    if not p.exists():
        return
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return
    for pid, pdata in raw.items():
        try:
            cols = [ColumnDef(**c) for c in pdata.get("columns", [])]
            _CUSTOM[pid] = ColumnProfile(
                id=pdata["id"], name=pdata.get("name", pid), lang=pdata.get("lang", "es"),
                columns=cols, build_resumo=pdata.get("build_resumo", True),
                build_leyenda=pdata.get("build_leyenda", True), notes=pdata.get("notes", ""),
            )
        except Exception:
            continue


def _save_custom() -> None:
    data = {pid: p.to_dict() for pid, p in _CUSTOM.items()}
    store = _custom_store()
    store.parent.mkdir(parents=True, exist_ok=True)
    store.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


_migrate_legacy_if_needed()
_load_custom()


def list_profiles() -> list[dict]:
    out = []
    for src, store in (("builtin", _BUILTIN), ("custom", _CUSTOM)):
        for pid, p in store.items():
            out.append({"id": pid, "name": p.name, "lang": p.lang,
                        "columns": len(p.columns), "source": src,
                        "headers": p.headers})
    return out


def get_profile(profile_id: str | None) -> ColumnProfile:
    pid = profile_id or "rf-end"
    if pid in _CUSTOM:
        return _CUSTOM[pid]
    if pid in _BUILTIN:
        return _BUILTIN[pid]
    raise KeyError(f"perfil desconhecido: {pid!r}. Disponíveis: {[x['id'] for x in list_profiles()]}")


def define_profile(spec: dict) -> ColumnProfile:
    """Registra/atualiza um perfil custom a partir de um dict e persiste."""
    cols = [ColumnDef(**c) for c in spec["columns"]]
    p = ColumnProfile(
        id=spec["id"], name=spec.get("name", spec["id"]), lang=spec.get("lang", "es"),
        columns=cols, build_resumo=spec.get("build_resumo", True),
        build_leyenda=spec.get("build_leyenda", True), notes=spec.get("notes", ""),
    )
    _CUSTOM[p.id] = p
    _save_custom()
    return p
