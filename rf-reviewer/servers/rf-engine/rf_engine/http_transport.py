"""
rf_engine.http_transport — casca de transporte Streamable HTTP do MCP (daemon único).

Serve o MESMO núcleo (`rf_engine.dispatch`) que a casca stdio, mas como um DAEMON
ÚNICO compartilhado: N sessões do Claude Code viram clientes HTTP finos (o próprio
cliente MCP do Claude conecta na URL — zero processo por sessão), em vez de 1
processo stdio por sessão. É o piloto da unificação dos MCPs do CrowdCode.

Só stdlib (`http.server`), espelhando o `com.sun.net.httpserver.HttpServer` do
native-java: sem framework, sem dependência nova além de openpyxl.

Endpoints (loopback 127.0.0.1):
  POST   /mcp     — JSON-RPC 2.0 (initialize / tools/list / tools/call / ...)
  DELETE /mcp     — encerra a sessão (Mcp-Session-Id)
  GET    /health  — liveness (porta, pid, uptime, sessões)

Segurança (reúso do padrão daemon-common.js do brain-server):
  - Origin loopback obrigatório quando presente (guarda anti DNS-rebinding).
  - Token compartilhado em arquivo (Authorization: ****** ou X-RF-Token) —
    loopback NÃO é autorização: qualquer processo local poderia chamar /mcp.
  - Limite de tamanho de corpo; timeout de request; Content-Length nas respostas.

Sessão: Mcp-Session-Id (UUID) gerado no initialize, exigido nos requests seguintes,
com TTL e limpeza periódica (clientes que caem sem DELETE).

Singleton: bind em porta determinística (sha256 do data-dir); EADDRINUSE => outro
daemon já é dono (sai 0). Roda com: `python -m rf_engine.http_transport`.

Concorrência: ThreadingHTTPServer (1 thread/conexão). O núcleo executa a TOOL sob
um lock global (openpyxl não é thread-safe); parse/auth/roteamento seguem paralelos.
"""
from __future__ import annotations

import errno
import hashlib
import hmac
import json
import os
import re
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from . import dispatch
from .paths import get_data_dir

HOST = "127.0.0.1"
MAX_BODY = 8 * 1024 * 1024          # 8 MB (tools recebem CAMINHOS, não conteúdo — folga grande)
SESSION_TTL = int(os.environ.get("RF_ENGINE_SESSION_TTL", str(30 * 60)))    # 30 min (override p/ teste)
CLEANUP_INTERVAL = int(os.environ.get("RF_ENGINE_CLEANUP_INTERVAL", "60"))  # varre a cada 60 s (override p/ teste)
REQUEST_TIMEOUT = 30                # timeout de socket por request

_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────────────────
# Config compartilhada (data-dir, porta determinística, token) — reusada pelo
# ensure_daemon. Fonte única, sem duplicação. `get_data_dir` vem de `paths` (o
# LUGAR ÚNICO do estado por-usuário, importado acima).
# ─────────────────────────────────────────────────────────────────────────────
def resolve_port(data_dir: Path) -> int:
    """Porta determinística por data-dir (faixa 40000-49999). Override: RF_ENGINE_HTTP_PORT."""
    env = os.environ.get("RF_ENGINE_HTTP_PORT")
    if env and env.strip().isdigit() and int(env) > 0:
        return int(env)
    h = hashlib.sha256(str(data_dir).encode("utf-8")).digest()
    return 40000 + (int.from_bytes(h[:2], "big") % 10000)


def lock_file(data_dir: Path) -> Path:
    return data_dir / "rf-engine-http.lock.json"


def token_file(data_dir: Path) -> Path:
    return data_dir / "rf-engine-http.token"


def health_url(data_dir: Path) -> str:
    return f"http://{HOST}:{resolve_port(data_dir)}/health"


def mcp_url(data_dir: Path) -> str:
    return f"http://{HOST}:{resolve_port(data_dir)}/mcp"


def read_token(data_dir: Path) -> str | None:
    env = os.environ.get("RF_ENGINE_HTTP_TOKEN", "").strip()
    if env:
        return env
    try:
        tok = token_file(data_dir).read_text(encoding="utf-8").strip()
        return tok or None
    except OSError:
        return None


def ensure_token(data_dir: Path) -> str:
    """Lê o token compartilhado ou cria um novo (no boot do daemon)."""
    existing = read_token(data_dir)
    if existing:
        return existing
    tok = uuid.uuid4().hex + uuid.uuid4().hex  # 64 hex chars
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        p = token_file(data_dir)
        p.write_text(tok, encoding="utf-8")
        try:
            os.chmod(p, 0o600)  # best-effort (no Windows não garante ACL; documentado)
        except OSError:
            pass
    except OSError:
        pass  # falha de fs -> token ainda vale para este processo
    return tok


def _origin_ok(origin: str | None) -> bool:
    # Clientes nativos (Claude/ensure_daemon) não mandam Origin; navegador manda.
    return origin is None or bool(_LOCAL_ORIGIN.match(origin))


def _token_ok(headers, token: str | None) -> bool:
    if not token:
        return True  # token OPT-IN: sem token, loopback + Origin guard são a fronteira (padrão do plugin)
    given = headers.get("X-RF-Token")
    if not given:
        auth = headers.get("Authorization") or ""
        m = re.match(r"^Bearer\s+(.+)$", auth, re.IGNORECASE)
        given = m.group(1).strip() if m else ""
    return bool(given) and hmac.compare_digest(str(given), str(token))


# ─────────────────────────────────────────────────────────────────────────────
# Handler HTTP
# ─────────────────────────────────────────────────────────────────────────────
class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_TIMEOUT
    server_version = f"rf-engine/{__version__}"

    def log_message(self, fmt, *args):  # tudo no stderr, NUNCA no stdout
        sys.stderr.write("[rf-http] " + (fmt % args) + "\n")

    # -- helpers de resposta -------------------------------------------------
    def _json(self, status: int, obj: dict, extra: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("MCP-Protocol-Version", dispatch.PROTOCOL_VERSION)
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _err(self, status: int, rid, code: int, message: str) -> None:
        # Erro fecha a conexão: evita desync de keep-alive quando o corpo não foi drenado.
        self.close_connection = True
        self._json(status, {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})

    def _origin_guard(self) -> bool:
        if not _origin_ok(self.headers.get("Origin")):
            self._err(403, None, -32600, "forbidden origin (DNS-rebinding guard)")
            return False
        return True

    # -- verbos --------------------------------------------------------------
    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self._err(404, None, -32600, "not found")
            return
        srv = self.server
        self._json(200, {
            "status": "ok", "server": dispatch.SERVER_NAME, "version": __version__,
            "port": srv.server_address[1], "pid": os.getpid(),
            "uptime_s": round(time.time() - srv.start_time, 1),
            "sessions": len(srv.sessions), "protocolVersion": dispatch.PROTOCOL_VERSION,
        })

    def do_DELETE(self):
        if self.path.split("?", 1)[0] != "/mcp":
            self._err(404, None, -32600, "not found")
            return
        if not self._origin_guard():
            return
        sid = self.headers.get("Mcp-Session-Id")
        if sid:
            self.server.sessions.pop(sid, None)
        self._empty(200)

    def do_POST(self):
        srv = self.server
        if self.path.split("?", 1)[0] != "/mcp":
            self._err(404, None, -32600, "not found")
            return
        if not self._origin_guard():
            return
        if not _token_ok(self.headers, srv.token):
            self._err(401, None, -32600, "missing/invalid token")
            return
        try:
            clen = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            clen = 0
        if clen > MAX_BODY:
            self._err(413, None, -32600, "request body too large")
            return
        raw = self.rfile.read(clen) if clen > 0 else b""
        try:
            msg = json.loads(raw.decode("utf-8")) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._err(400, None, -32700, "parse error")
            return
        if msg is None:
            self._err(400, None, -32600, "empty body")
            return

        is_init = isinstance(msg, dict) and msg.get("method") == "initialize"
        rid = msg.get("id") if isinstance(msg, dict) else None

        # Sessão exigida em tudo menos initialize (contrato Streamable HTTP).
        if not is_init:
            sid = self.headers.get("Mcp-Session-Id")
            if not sid or sid not in srv.sessions:
                self._err(400, rid, -32600, "invalid or missing session id")
                return
            srv.sessions[sid]["ts"] = time.time()

        resp = dispatch.handle(msg, tool_lock=srv.tool_lock)
        if resp is None:
            self._empty(202)  # notificação: sem corpo
            return

        extra = None
        if is_init and "error" not in resp:
            new_sid = uuid.uuid4().hex
            srv.sessions[new_sid] = {"ts": time.time()}
            extra = {"Mcp-Session-Id": new_sid}
        self._json(200, resp, extra)


# ─────────────────────────────────────────────────────────────────────────────
# Daemon
# ─────────────────────────────────────────────────────────────────────────────
class RfHttpDaemon(ThreadingHTTPServer):
    daemon_threads = True
    # WINDOWS: SO_REUSEADDR permite REBIND de porta em uso (semântica diferente do
    # Unix). Desligar é o que faz o EADDRINUSE do singleton funcionar de verdade.
    allow_reuse_address = False

    def __init__(self, addr, data_dir: Path, token: str):
        super().__init__(addr, _Handler)
        self.data_dir = data_dir
        self.token = token
        self.sessions: dict[str, dict] = {}
        self.tool_lock = threading.Lock()
        self.start_time = time.time()


def _purge_expired(sessions: dict, now: float, ttl: float) -> list:
    """Remove as sessões cujo último acesso passou do TTL. Pura e testável (sem I/O)."""
    expired = [s for s, d in list(sessions.items()) if now - d.get("ts", 0) > ttl]
    for s in expired:
        sessions.pop(s, None)
    return expired


def _cleanup_loop(srv: RfHttpDaemon) -> None:
    while True:
        time.sleep(CLEANUP_INTERVAL)
        expired = _purge_expired(srv.sessions, time.time(), SESSION_TTL)
        if expired:
            sys.stderr.write(f"[rf-http] sessões expiradas removidas: {len(expired)} "
                             f"(ativas: {len(srv.sessions)})\n")


def _write_lock(data_dir: Path, port: int) -> None:
    try:
        lock_file(data_dir).write_text(json.dumps(
            {"port": port, "pid": os.getpid(), "started_at": time.time(), "version": __version__}),
            encoding="utf-8")
    except OSError:
        pass


def _remove_lock(data_dir: Path) -> None:
    try:
        lock_file(data_dir).unlink()
    except OSError:
        pass


def start_daemon(data_dir: Path | None = None) -> RfHttpDaemon | None:
    """Sobe o daemon (bloqueante). Retorna None se a porta já está tomada (singleton)."""
    data_dir = data_dir or get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("RF_ENGINE_HTTP_TOKEN", "").strip() or None  # OPT-IN só por ENV: sem env => loopback-only. Ignora arquivo de token residual.
    port = resolve_port(data_dir)

    try:
        srv = RfHttpDaemon((HOST, port), data_dir, token)
    except OSError as e:
        if e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) == 10048:
            sys.stderr.write(f"[rf-http] porta {port} já em uso — outro daemon é dono; saindo 0.\n")
            sys.stderr.flush()
            return None
        raise

    _write_lock(data_dir, port)
    threading.Thread(target=_cleanup_loop, args=(srv,), daemon=True).start()

    def _stop(_signum=None, _frame=None):
        # shutdown() precisa rodar fora da thread do serve_forever.
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    try:
        signal.signal(signal.SIGTERM, _stop)
    except (ValueError, AttributeError):
        pass  # SIGTERM pode não existir/ser settable em alguns contextos Windows

    sys.stderr.write(f"[rf-http] daemon rf-engine v{__version__} em http://{HOST}:{port}/mcp "
                     f"({len(dispatch.TOOLS)} tools, TTL {SESSION_TTL // 60}min)\n")
    sys.stderr.flush()
    try:
        srv.serve_forever()
    finally:
        _remove_lock(data_dir)
        sys.stderr.write("[rf-http] daemon parado.\n")
        sys.stderr.flush()
    return srv


def _print_config() -> None:
    """Imprime o bloco .mcp.json (type:http) pronto para ESTA máquina — porta (e token, se houver)."""
    dd = get_data_dir()
    tok = read_token(dd)
    entry = {"type": "http", "url": mcp_url(dd)}
    if tok:
        entry["headers"] = {"Authorization": f"Bearer {tok}"}
    sys.stdout.write(json.dumps({"mcpServers": {"rf-engine": entry}}, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    args = sys.argv[1:]
    if "--print-url" in args:
        sys.stdout.write(mcp_url(get_data_dir()) + "\n")
        return
    if "--print-config" in args:
        _print_config()
        return
    start_daemon()


if __name__ == "__main__":
    main()
