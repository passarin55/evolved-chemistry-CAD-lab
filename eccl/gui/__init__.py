"""ECCL GUI: a local, offline web application over the lab.

A zero-dependency HTTP server (stdlib ``http.server``) serves a JSON API over
the Workbench plus a plain-JavaScript single-page frontend. It binds to
``127.0.0.1`` by default and needs no network access.

    eccl gui [--host 127.0.0.1] [--port 8765] [--no-browser]
    python -m eccl.gui [same flags]

See ``docs/gui.md`` for the architecture and the API contract.
"""
from __future__ import annotations

from .server import launch, make_server

__all__ = ["launch", "make_server"]
