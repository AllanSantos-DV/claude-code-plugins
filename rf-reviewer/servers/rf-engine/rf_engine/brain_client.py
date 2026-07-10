"""
rf_engine.brain_client — ponte MECÂNICA com o servidor de memória (MCP /mcp http).

Espelha o protocolo do plugin (scripts/mcp-client.js):
  POST <url>/mcp  JSON-RPC 2.0
  1) initialize {protocolVersion, capabilities:{}, clientInfo, projectId}  (guarda Mcp-Session-Id)
  2) notifications/initialized
  3) tools/call search_memory {query, topK, minScore?}  -> {results:[{text,score,documentId,chunkIndex}]}
Sem header Origin (o daemon 403 um Origin não-loopback; ausente = liberado).

Isto é a PARTE MECÂNICA da referência cruzada: dado um RF, traz os top-K trechos
candidatos do banco escopado por project_id. O JULGAMENTO (o que usar, virar gap,
severidade) continua sendo do AGENTE.

Uso:
  python -m rf_engine.brain_client --url http://127.0.0.1:38080 --project la-positiva --query "autenticación"
  python -m rf_engine.brain_client --enrich analysis.json --url ... --project la-positiva --top-k 5
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


class BrainClient:
    def __init__(self, server_url: str, project_id: str = "", timeout: int = 30):
        self.base = server_url.rstrip("/")
        self.project_id = project_id or ""
        self.timeout = timeout
        self._sid: str | None = None
        self._rid = 0
        self._connected = False

    def _post(self, method: str, params: dict | None, notification: bool = False):
        url = self.base + "/mcp"
        payload = {"jsonrpc": "2.0", "method": method}
        if not notification:
            self._rid += 1
            payload["id"] = self._rid
        if params is not None:
            payload["params"] = params
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self._sid:
            headers["Mcp-Session-Id"] = self._sid
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            sid = resp.headers.get("mcp-session-id") or resp.headers.get("Mcp-Session-Id")
            if sid:
                self._sid = sid
            body = resp.read().decode("utf-8", "ignore")
        if notification:
            return None
        return self._parse(body, method)

    @staticmethod
    def _parse(body: str, method: str):
        text = body.strip()
        # suporte a resposta SSE (event/data:)
        if text.startswith("event:") or text.startswith("data:"):
            for line in text.splitlines():
                if line.startswith("data:"):
                    text = line[5:].strip()
                    break
        try:
            msg = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"MCP '{method}' resposta não-JSON: {exc}: {text[:200]}")
        if isinstance(msg, dict) and msg.get("error"):
            raise RuntimeError(f"MCP '{method}' erro: {msg['error']}")
        return msg.get("result") if isinstance(msg, dict) else msg

    def connect(self) -> None:
        if self._connected:
            return
        params = {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "rf-engine-brain", "version": "0.1.0"},
        }
        if self.project_id:
            params["projectId"] = self.project_id
        self._post("initialize", params)
        self._post("notifications/initialized", None, notification=True)
        self._connected = True

    @staticmethod
    def _unwrap(result) -> list[dict]:
        """search_memory devolve {results:[...]} — possivelmente embrulhado em content[].text."""
        if result is None:
            return []
        data = result
        if isinstance(result, dict) and "content" in result and isinstance(result["content"], list):
            for part in result["content"]:
                if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
                    try:
                        data = json.loads(part["text"])
                        break
                    except json.JSONDecodeError:
                        data = {"results": []}
        if isinstance(data, dict) and "results" in data:
            return data["results"] or []
        if isinstance(data, list):
            return data
        return []

    def search(self, query: str, top_k: int = 5, min_score: float = 0.0) -> list[dict]:
        if not self._connected:
            self.connect()
        args = {"query": query, "topK": top_k}
        if min_score > 0:
            args["minScore"] = min_score
        result = self._post("tools/call", {"name": "search_memory", "arguments": args})
        hits = self._unwrap(result)
        out = []
        for h in hits:
            out.append({
                "text": (h.get("text") or "")[:600],
                "score": h.get("score"),
                "documentId": h.get("documentId") or h.get("id"),
                "chunkIndex": h.get("chunkIndex"),
            })
        return out

    def close(self) -> None:
        if self._sid:
            try:
                req = urllib.request.Request(self.base + "/mcp", headers={"Mcp-Session-Id": self._sid}, method="DELETE")
                urllib.request.urlopen(req, timeout=5).read()
            except Exception:
                pass
        self._connected = False


def _query_for(rec: dict) -> str:
    h = rec.get("hint", {})
    parts = [rec.get("rf_id", ""), h.get("requerimiento", ""), h.get("descripcion", ""), h.get("proceso", "")]
    return " ".join(p for p in parts if p).strip()[:400]


def enrich(analysis_path: str, url: str, project: str, top_k: int, limit: int | None) -> dict:
    data = json.loads(Path(analysis_path).read_text(encoding="utf-8"))
    client = BrainClient(url, project)
    client.connect()
    recs = [r for r in data["records"] if not r.get("na")]
    if limit:
        recs = recs[:limit]
    filled = 0
    for r in recs:
        q = _query_for(r)
        if not q:
            continue
        try:
            r["candidate_refs"] = client.search(q, top_k=top_k)
            filled += 1
        except Exception as exc:  # noqa: BLE001
            r["candidate_refs"] = [{"error": str(exc)}]
    client.close()
    out = Path(analysis_path).with_name("analysis.enriched.json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"enriched": filled, "out": str(out)}


def main() -> None:
    p = argparse.ArgumentParser(description="Ponte de memória (retrieval mecânico) — estágio opcional.")
    p.add_argument("--url", required=True, help="serverUrl do daemon (ex.: http://192.168.18.13:38080)")
    p.add_argument("--project", default="la-positiva", help="project_id (escopo do recall)")
    p.add_argument("--query", default=None, help="teste: busca única e imprime hits")
    p.add_argument("--enrich", default=None, help="analysis.json a enriquecer com candidate_refs")
    p.add_argument("--top-k", type=int, default=5)
    p.add_argument("--limit", type=int, default=None, help="enriquecer só os N primeiros (teste)")
    args = p.parse_args()

    if args.query is not None:
        c = BrainClient(args.url, args.project)
        c.connect()
        hits = c.search(args.query, top_k=args.top_k)
        c.close()
        print(f"OK search project={args.project!r} query={args.query!r} -> {len(hits)} hits")
        for h in hits:
            print(f"  score={h['score']} doc={h['documentId']} :: {h['text'][:120]!r}")
    elif args.enrich:
        res = enrich(args.enrich, args.url, args.project, args.top_k, args.limit)
        print(f"OK enrich: {res}")
    else:
        p.error("informe --query ou --enrich")


if __name__ == "__main__":
    main()
