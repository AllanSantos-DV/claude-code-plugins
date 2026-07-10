"""
rf_engine.scaffold — ESTÁGIO 2 (mecânico): extract.json -> esqueleto de análise.

Gera um analysis.json com UM registro por linha de requisito, contendo:
  - identidade (sheet, row_idx, rf_id);
  - um bloco `hint` com os campos-chave já extraídos (o agente lê daqui, não do xlsx);
  - as 13 chaves de análise VAZIAS para o agente preencher;
  - flags determinísticas (na, forced_bloqueante) calculadas pela tool.

O AGENTE preenche os 13 campos + a lista `gaps`. Depois `apply` materializa o Excel.

Uso:
  python -m rf_engine.scaffold _work/base/extract.json [-o analysis.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import model


def _get(fields: dict, *needles: str) -> str:
    """Busca fuzzy por cabeçalho dentro do dict de campos da linha."""
    for k, v in fields.items():
        if not k or k.startswith("_"):
            continue
        low = k.lower()
        if any(n in low for n in needles):
            return "" if v is None else str(v)
    return ""


def build_record(sheet: str, row: dict, keys: list[str]) -> dict:
    f = row.get("fields", {})
    hint = {
        "forced_bloqueante": bool(row.get("forced_bloqueante")),
        "requerimiento": _get(f, "requerimiento funcional", "requerimiento"),
        "descripcion": _get(f, "descrip"),
        "proceso": _get(f, "proceso e2e", "proceso"),
        "actor": _get(f, "actor"),
        "tipo": _get(f, "tipo"),
        "insuremo": _get(f, "insuremo"),
        "componente": _get(f, "componente", "component"),
        "complejidad": _get(f, "complej", "complex"),
        "alcance": _get(f, "alcance"),
        "hyperlinks": f.get("_hyperlinks", []),
    }
    rec = {
        "sheet": sheet,
        "row_idx": row["row_idx"],
        "rf_id": row.get("rf_id", ""),
        "na": bool(row.get("is_na")),
        "hint": hint,
        "candidate_refs": [],  # preenchido opcionalmente pela ponte de memória (brain_client)
    }
    for key in keys:
        rec[key] = ""
    return rec


INSTRUCTIONS = (
    "Preencha, para CADA registro não-N/A, as 13 chaves de análise (8 de validação + "
    "5 consultivas) usando SOMENTE a referência cruzada com a memória do projeto "
    "(project_id=la-positiva). Regras duras: nenhum dado das colunas novas pode vir do "
    "próprio arquivo base; 'referencia' nunca aponta para .md nem para o output; se o "
    "hint.forced_bloqueante=true, a tipificacion deve ser 'Bloqueante' e o comentario "
    "começar por 'BLOQUEANTE:'; texto em espanhol acentuado; sem markdown nas células. "
    "Enums: criticidad∈" + str(model.ENUM_CRITICIDAD) + "; tipificacion∈" + str(model.ENUM_TIPIFICACION) +
    "; compatible∈" + str(model.ENUM_COMPATIBLE) + "; prioridad∈" + str(model.ENUM_PRIORIDAD) +
    "; tipo_mejora∈" + str(model.ENUM_TIPO_MEJORA) + ". Adicione os gaps citados em 'gaps' "
    "(codigo G-XX-NN, descripcion, accion_esperada, responsable, rf_relacionado, criticidad)."
)


def run(extract_path: str, out_path: str, profile_id: str | None = None) -> dict:
    from . import profiles
    src = Path(extract_path)
    if not src.exists():
        sys.exit(f"ERRO: extract.json não encontrado: {src}")
    data = json.loads(src.read_text(encoding="utf-8"))
    profile = profiles.get_profile(profile_id or "rf-end")
    keys = profile.keys

    records = []
    for s in data["sheets"]:
        if not s["analyzable"]:
            continue
        for row in s["rows"]:
            records.append(build_record(s["name"], row, keys))

    n_na = sum(1 for r in records if r["na"])
    n_forced = sum(1 for r in records if r["hint"]["forced_bloqueante"])
    out = {
        "source_file": data["source_file"],
        "source_name": data["source_name"],
        "generated_by": "rf_engine.scaffold",
        "profile": profile.id,
        "profile_columns": profile.headers,
        "instructions": INSTRUCTIONS if profile.id == "rf-end"
        else f"Preencha, para cada registro não-N/A, as chaves {keys} (perfil '{profile.id}'). "
             "Todo conteúdo vem da referência cruzada com a memória (project_id=la-positiva), "
             "nunca do arquivo base; 'fonte'/'referencia' nunca aponta para .md nem para o output; "
             "espanhol acentuado, sem markdown nas células. Registre gaps citados em 'gaps'.",
        "schema_keys": keys,
        "analyzable_sheets": data["analyzable_sheets"],
        "counts": {"records": len(records), "na": n_na, "forced_bloqueante": n_forced},
        "records": records,
        "gaps": [],
    }
    outp = Path(out_path)
    outp.parent.mkdir(parents=True, exist_ok=True)
    outp.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Gera o esqueleto de análise (estágio 2 do motor).")
    p.add_argument("extract", help="Caminho do extract.json (estágio 1)")
    p.add_argument("-o", "--out", default=None, help="analysis.json de saída (default: ao lado do extract)")
    p.add_argument("--perfil", default=None, help="id do perfil de colunas (default: rf-end)")
    args = p.parse_args()
    out_path = args.out or str(Path(args.extract).with_name("analysis.json"))
    res = run(args.extract, out_path, args.perfil)
    c = res["counts"]
    print(f"OK scaffold: {res['source_name']} | perfil: {res['profile']}")
    print(f"  registros: {c['records']} | N/A: {c['na']} | bloqueante forçado: {c['forced_bloqueante']}")
    print(f"  saída: {Path(out_path).resolve()}")


if __name__ == "__main__":
    main()
