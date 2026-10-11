"""HTTP layer for the ECCL GUI (stdlib ``http.server`` only).

``/`` and ``/static/*`` serve the frontend; ``/api/*`` is routed to
:mod:`eccl.gui.api`. This module owns transport concerns only: request parsing,
body limits, DNS-rebinding and CSRF checks, security headers, status codes and
logging.
"""
from __future__ import annotations

import ipaddress
import json
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from .. import __version__
from ..core.molecule import MoleculeError
from . import _signals, api

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY_BYTES = 2 * 1024 * 1024
ALLOWED_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'")
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP,
}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}
JSON_TYPE = "application/json; charset=utf-8"


def _split_host(value: str) -> tuple[str, str | None]:
    """``'Example:80'`` -> ``('example', '80')``; ``'[::1]:8765'`` -> ``('[::1]', '8765')``."""
    value = value.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return value, None
        rest = value[end + 1:]
        return value[:end + 1], (rest[1:] if rest.startswith(":") else None)
    if value.count(":") == 1:
        host, port = value.split(":")
        return host, port
    return value, None


def _printable(text: str, limit: int = 200) -> str:
    return "".join(c if c.isprintable() else "?" for c in text[:limit])


def _status_for(exc: BaseException) -> int:
    if isinstance(exc, api.ApiError):
        return exc.status
    if isinstance(exc, (ValueError, KeyError, TypeError, MoleculeError)):
        return 400
    return 500


def _message_for(exc: BaseException) -> str:
    if isinstance(exc, KeyError) and exc.args and isinstance(exc.args[0], str):
        return exc.args[0]  # str(KeyError) adds quotes
    return str(exc) or type(exc).__name__


class GUIServer(ThreadingHTTPServer):
    """Threaded HTTP server carrying the GUI's static dir and loopback flag."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], static_dir: Path) -> None:
        self.static_dir = static_dir
        super().__init__(address, GUIRequestHandler)
        try:
            self.loopback = ipaddress.ip_address(self.server_address[0]).is_loopback
        except ValueError:
            self.loopback = False


class GUIServerV6(GUIServer):
    address_family = socket.AF_INET6


class GUIRequestHandler(BaseHTTPRequestHandler):
    """Routes requests to static files or the JSON API."""

    server: GUIServer
    server_version = f"ECCL-GUI/{__version__}"
    protocol_version = "HTTP/1.1"
    timeout = 120  # seconds an idle keep-alive connection may linger

    def version_string(self) -> str:
        return self.server_version

    # ---- method entry points ----
    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._handle("OPTIONS")

    # ---- core ----
    def _handle(self, method: str) -> None:
        self._t0 = time.perf_counter()
        self._quiet = False
        self._status: int | None = None
        self._headers_done = False
        try:
            path = urlsplit(self.path).path
            # Consume the (size-capped) body first so a rejected request never leaves
            # unread bytes on a keep-alive connection.
            body = self._read_body()
            if not self._host_allowed():
                raise api.Forbidden("forbidden: unexpected Host header")
            if method not in ("GET", "HEAD") and not self._origin_allowed():
                raise api.Forbidden("forbidden: cross-origin request")
            if path == "/api" or path.startswith("/api/"):
                self._handle_api(method, path, body)
            else:
                self._handle_static(method, path)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001 - mapped to an HTTP status
            self._send_exception(exc)
        finally:
            self._log()

    def _send_exception(self, exc: BaseException) -> None:
        status = _status_for(exc)
        if status >= 500:
            sys.stderr.write(f"[eccl-gui] error handling {self.command} "
                             f"{_printable(self.path)}:\n")
            traceback.print_exc(file=sys.stderr)
        if self._headers_done:  # response already started; nothing sane to add
            self.close_connection = True
            return
        headers = {}
        if isinstance(exc, api.MethodNotAllowed):
            headers["Allow"] = ", ".join(exc.allowed)
        try:
            self._send_json(status, {"error": _message_for(exc), "type": type(exc).__name__},
                            headers)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _handle_api(self, method: str, path: str, body: bytes) -> None:
        handler, params = api.resolve("GET" if method == "HEAD" else method, path)
        payload = self._parse_json(body) if method not in ("GET", "HEAD") else {}
        query = dict(parse_qsl(urlsplit(self.path).query, keep_blank_values=True))
        self._send_json(200, api.invoke(handler, payload, query, params))

    # ---- request parsing ----
    def handle_expect_100(self) -> bool:
        """Refuse an oversized upload before the client sends it."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            self._t0, self._quiet, self._status = time.perf_counter(), False, None
            self._headers_done = False
            self.close_connection = True
            self._send_exception(api.PayloadTooLarge(
                f"request body is {length} bytes; the limit is {MAX_BODY_BYTES} bytes"))
            self._log()
            return False
        return super().handle_expect_100()

    def _read_body(self) -> bytes:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            raise api.ApiError("chunked request bodies are not supported; send Content-Length",
                               411)
        raw = self.headers.get("Content-Length")
        if raw is None or not raw.strip():
            return b""
        try:
            length = int(raw)
            if length < 0:
                raise ValueError
        except ValueError:
            self.close_connection = True
            raise api.ValidationError("invalid Content-Length header") from None
        if length > MAX_BODY_BYTES:
            self.close_connection = True  # the unread body makes the connection unusable
            raise api.PayloadTooLarge(f"request body is {length} bytes; the limit is "
                                      f"{MAX_BODY_BYTES} bytes")
        data = self.rfile.read(length) if length else b""
        if len(data) < length:
            self.close_connection = True
            raise api.ValidationError("incomplete request body")
        return data

    @staticmethod
    def _parse_json(body: bytes) -> dict[str, Any]:
        if not body.strip():
            return {}  # empty POST body == {}
        try:
            obj = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError) as e:
            raise api.ValidationError(f"malformed JSON body: {e}") from None
        if not isinstance(obj, dict):
            raise api.ValidationError("request body must be a JSON object")
        return obj

    # ---- security ----
    def _host_allowed(self) -> bool:
        """DNS-rebinding defence: on loopback, only accept local Host names."""
        if not self.server.loopback:
            return True
        host, _port = _split_host(self.headers.get("Host") or "")
        if host in ALLOWED_HOSTS:
            return True
        # the literal loopback address we are bound to (e.g. --host 127.0.0.2); an IP
        # literal cannot be re-pointed by DNS, so rebinding protection is kept
        bound = str(self.server.server_address[0]).lower()
        return host in (bound, f"[{bound}]")

    def _origin_allowed(self) -> bool:
        """CSRF defence: an Origin header, if present, must match the Host."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        o = urlsplit(origin.strip())
        if o.scheme not in ("http", "https") or not o.netloc:
            return False  # includes the opaque "null" origin
        o_host, o_port = _split_host(o.netloc)
        h_host, h_port = _split_host(self.headers.get("Host") or "")
        o_port = o_port or ("443" if o.scheme == "https" else "80")
        return bool(h_host) and o_host == h_host and o_port == (h_port or "80")

    # ---- static files ----
    def _handle_static(self, method: str, path: str) -> None:
        if method not in ("GET", "HEAD"):
            raise api.MethodNotAllowed(f"method {method} not allowed for {path}",
                                       ["GET", "HEAD"])
        if path in ("/", "/index.html"):
            target = self._resolve_static("index.html")
        elif path == "/favicon.ico":
            target = self._resolve_static("favicon.ico")
            if target is None:  # avoid a console 404 when the frontend has no icon
                self._quiet = True
                self._send(204, b"", None)
                return
        elif path.startswith("/static/"):
            target = self._resolve_static(path[len("/static/"):])
        else:
            target = None
        if target is None:
            raise api.NotFound(f"not found: {path}")
        self._quiet = True
        self._send(200, target.read_bytes(),
                   CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream"))

    def _resolve_static(self, rel: str) -> Path | None:
        """Map a URL path below /static/ to a file inside the static dir, or None."""
        rel = unquote(rel)  # decodes %2e%2e, %2f, ...
        if not rel or "\x00" in rel or "\\" in rel or rel.startswith("/") or ":" in rel:
            return None
        if any(part in ("", ".", "..") or part.startswith(".") for part in rel.split("/")):
            return None
        base = self.server.static_dir.resolve()
        try:
            target = (base / rel).resolve()
        except (OSError, RuntimeError):
            return None
        if not target.is_relative_to(base) or not target.is_file():
            return None
        return target

    # ---- responses ----
    def _send_json(self, status: int, obj: Any, headers: dict[str, str] | None = None) -> None:
        try:
            data = json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError):  # handlers are sanitised already; belt and braces
            data = json.dumps(api.to_jsonable(obj), ensure_ascii=False, allow_nan=False,
                              separators=(",", ":"))
        self._send(status, data.encode("utf-8"), JSON_TYPE, headers)

    def _send(self, status: int, data: bytes, content_type: str | None,
              headers: dict[str, str] | None = None) -> None:
        self._status = status
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self._headers_done = True
        if self.command != "HEAD" and data and status != 204:
            self.wfile.write(data)

    def end_headers(self) -> None:
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        super().end_headers()

    def send_error(self, code: int, message: str | None = None,
                   explain: str | None = None) -> None:
        """Protocol-level failures (bad request line, 414, ...) as JSON errors."""
        try:
            phrase = HTTPStatus(code).phrase
        except ValueError:
            phrase = "error"
        self._headers_done = False
        self.close_connection = True
        try:
            self._send_json(code, {"error": message or phrase, "type": "HTTPError"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.log_message("%s -> %s", _printable(getattr(self, "requestline", "") or "-"), code)

    # ---- logging ----
    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        pass  # one line per request is written by _log()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        sys.stderr.write(f"[eccl-gui] {self.address_string()} {format % args}\n")

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        if "timed out" not in (format % args):
            self.log_message(format, *args)

    def _log(self) -> None:
        status = getattr(self, "_status", None) or 0
        if getattr(self, "_quiet", False) and 200 <= status < 300:
            return
        ms = (time.perf_counter() - getattr(self, "_t0", time.perf_counter())) * 1000
        self.log_message("%s %s %s %.0fms", self.command or "-",
                         _printable(self.path or "-"), status or "-", ms)


def make_server(host: str = "127.0.0.1", port: int = 8765,
                static_dir: str | Path | None = None) -> tuple[GUIServer, str]:
    """Build (but do not start) the GUI server; ``port=0`` picks a free port.

    Returns ``(server, url)`` where ``url`` (no trailing slash) reflects the bound port.
    """
    sdir = Path(static_dir).resolve() if static_dir is not None else STATIC_DIR
    cls = GUIServerV6 if ":" in host else GUIServer
    server = cls((host, port), sdir)
    bound_port = server.server_address[1]
    if host in ("", "0.0.0.0"):
        url_host = "127.0.0.1"
    elif host == "::":
        url_host = "[::1]"
    elif ":" in host:
        url_host = f"[{host}]"
    else:
        url_host = host
    return server, f"http://{url_host}:{bound_port}"


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001 - a missing browser is not an error
        pass


def _wait_for_jobs(timeout: float) -> None:
    """Give cancelled jobs a moment to reach their next cancellation check.

    Exiting while a worker is still inside RDKit's C++ code can abort the
    interpreter, so wait (bounded) for running jobs to wind down.
    """
    deadline = time.monotonic() + timeout
    while api.JOBS.active_count() and time.monotonic() < deadline:
        time.sleep(0.1)
    if api.JOBS.active_count():
        print(f"note: a background job did not stop within {timeout:.0f}s", file=sys.stderr,
              flush=True)


def launch(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    """Serve the GUI until Ctrl-C (prints the URL, optionally opens a browser)."""
    server, url = make_server(host, port)
    # Synchronous signal handling only when the entry point blocked the signals
    # before numpy/RDKit started threads (see _signals); otherwise fall back to
    # KeyboardInterrupt, which works whenever no job is inside RDKit.
    watcher = (_signals.SignalWatcher(server)
               if _signals.blocked_early() and _signals.supported() else None)
    print(f"ECCL GUI running at {url}/  (press Ctrl-C to stop)", flush=True)
    if not server.loopback:
        print("warning: bound to a non-loopback address; anyone who can reach this host "
              "can use the lab", file=sys.stderr, flush=True)
    if open_browser:
        threading.Thread(target=_open_browser, args=(url + "/",), daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.25)
        if watcher is not None and watcher.received is not None:
            print("\nshutting down ECCL GUI...", flush=True)
    except KeyboardInterrupt:
        print("\nshutting down ECCL GUI...", flush=True)
    finally:
        server.server_close()
        api.JOBS.shutdown(wait=False)
        _wait_for_jobs(timeout=10.0)
        if watcher is not None:
            watcher.close()
