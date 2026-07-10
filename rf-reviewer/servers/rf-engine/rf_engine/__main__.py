"""
rf_engine.__main__ — entrypoint único do motor.

  python -m rf_engine extract  ARQUIVO.xlsx -o _work/caso
  python -m rf_engine scaffold _work/caso/extract.json
  python -m rf_engine brain    --enrich _work/caso/analysis.json --url http://192.168.18.13:38080 --project la-positiva
  python -m rf_engine apply     _work/caso/extract.json _work/caso/analysis.json -o _work/caso/out
  python -m rf_engine validate  _work/caso/analysis.json --xlsx SAIDA.xlsx --extract _work/caso/extract.json
  python -m rf_engine prep      ARQUIVO.xlsx -o _work/caso   (= extract + scaffold, para o agente preencher)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import extract as m_extract
from . import scaffold as m_scaffold
from . import apply as m_apply
from . import validate as m_validate


def _cmd_extract(a):
    res = m_extract.run(a.xlsx, a.out)
    print(f"OK extract: {res['n_sheets']} abas, analisáveis={res['analyzable_sheets']}")


def _cmd_scaffold(a):
    out = a.out or str(Path(a.extract).with_name("analysis.json"))
    res = m_scaffold.run(a.extract, out, getattr(a, "perfil", None))
    print(f"OK scaffold: {res['counts']} perfil={res.get('profile')} -> {out}")


def _cmd_apply(a):
    res = m_apply.run(a.extract, a.analysis, a.out, getattr(a, "perfil", None))
    print(f"OK apply -> {res['output']} | perfil={res['profile']} | totais={res['counts']}")


def _cmd_validate(a):
    code = m_validate.run(a.analysis, a.xlsx, a.extract)
    raise SystemExit(code)


def _cmd_brain(a):
    from . import brain_client as m_brain
    if a.query is not None:
        c = m_brain.BrainClient(a.url, a.project)
        c.connect()
        hits = c.search(a.query, top_k=a.top_k)
        c.close()
        print(f"OK search -> {len(hits)} hits")
        for h in hits:
            print(f"  {h['score']} {h['documentId']} :: {h['text'][:100]!r}")
    elif a.enrich:
        print("OK enrich:", m_brain.enrich(a.enrich, a.url, a.project, a.top_k, a.limit))
    else:
        sys.exit("brain: informe --query ou --enrich")


def _cmd_prep(a):
    ex = m_extract.run(a.xlsx, a.out)
    analysis = str(Path(a.out) / "analysis.json")
    sc = m_scaffold.run(str(Path(a.out) / "extract.json"), analysis, getattr(a, "perfil", None))
    print("=" * 60)
    print(f"PREP OK — {ex['source_name']} | perfil: {sc.get('profile')}")
    print(f"  abas analisáveis: {ex['analyzable_sheets']}")
    print(f"  registros p/ o agente preencher: {sc['counts']['records']} "
          f"(N/A={sc['counts']['na']}, bloqueante forçado={sc['counts']['forced_bloqueante']})")
    print(f"  colunas do perfil: {sc.get('profile_columns')}")
    print(f"  -> AGENTE: preencha {sc['schema_keys']} + 'gaps' em {analysis}")
    print(f"     depois: python -m rf_engine apply {Path(a.out)/'extract.json'} {analysis} -o {Path(a.out)/'out'}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="rf_engine", description="Motor de revisão de RF (La Positiva/InsureMO): parte mecânica como tool.")
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("extract", help="estágio 1: lê o Excel -> extract.json + md")
    pe.add_argument("xlsx"); pe.add_argument("-o", "--out", default="_work"); pe.set_defaults(func=_cmd_extract)

    ps = sub.add_parser("scaffold", help="estágio 2: extract.json -> analysis.json (esqueleto)")
    ps.add_argument("extract"); ps.add_argument("-o", "--out", default=None)
    ps.add_argument("--perfil", default=None); ps.set_defaults(func=_cmd_scaffold)

    pa = sub.add_parser("apply", help="estágio 3: materializa o Excel revisado")
    pa.add_argument("extract"); pa.add_argument("analysis"); pa.add_argument("-o", "--out", default=None)
    pa.add_argument("--perfil", default=None); pa.set_defaults(func=_cmd_apply)

    pv = sub.add_parser("validate", help="estágio 4: gate de qualidade")
    pv.add_argument("analysis", nargs="?", default=None); pv.add_argument("--xlsx", default=None)
    pv.add_argument("--extract", default=None); pv.set_defaults(func=_cmd_validate)

    pb = sub.add_parser("brain", help="opcional: ponte de memória (retrieval mecânico)")
    pb.add_argument("--url", required=True); pb.add_argument("--project", default="la-positiva")
    pb.add_argument("--query", default=None); pb.add_argument("--enrich", default=None)
    pb.add_argument("--top-k", type=int, default=5); pb.add_argument("--limit", type=int, default=None)
    pb.set_defaults(func=_cmd_brain)

    pp = sub.add_parser("prep", help="atalho: extract + scaffold (deixa pronto p/ o agente)")
    pp.add_argument("xlsx"); pp.add_argument("-o", "--out", default="_work")
    pp.add_argument("--perfil", default=None); pp.set_defaults(func=_cmd_prep)
    return p


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
