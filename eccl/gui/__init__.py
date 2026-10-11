"""ECCL GUI: a local, offline web application over the lab.

A zero-dependency HTTP server (stdlib ``http.server``) serves a JSON API over
the Workbench plus a plain-JavaScript single-page frontend. It binds to
``127.0.0.1`` by default and needs no network access.

    eccl gui [--host 127.0.0.1] [--port 8765] [--no-browser]
    python -m eccl.gui [same flags]

See ``docs/gui.md`` for the architecture and the API contract.
"""
from __future__ import annotations

__all__ = ["launch", "make_server"]


def __getattr__(name: str):
    # Lazy so the entry points can block signals before numpy/RDKit start
    # threads (see eccl/gui/_signals.py).
    if name in __all__:
        from . import server

        return getattr(server, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
