"""``python -m eccl.gui`` - launch the ECCL web GUI."""
from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m eccl.gui",
                                description="Evolved Chemistry CAD Lab - local web GUI")
    p.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8765, help="port (default 8765; 0 = any free)")
    p.add_argument("--no-browser", action="store_true", help="do not open a web browser")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from . import launch

    try:
        launch(host=args.host, port=args.port, open_browser=not args.no_browser)
    except OSError as e:
        print(f"eccl gui: cannot start server on {args.host}:{args.port}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
