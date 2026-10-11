"""Command-line interface for the Evolved Chemistry CAD Lab.

    eccl info
    eccl molecule "CC(=O)Oc1ccccc1C(=O)O"
    eccl semiconductor Si --temp 350 --nd 1e17 --na 1e17
    eccl plasmon Au --radius 20 --medium-eps 1.77
    eccl qdot CdTe --radius 2.5
    eccl perovskite Cs+ Pb2+ I-
    eccl react "C3H8,O2" "CO2,H2O"
    eccl spectrum IR 3000 1715 1280
    eccl gate "CCO" "CC(=O)Oc1ccccc1C(=O)O" --harshness HARSH
    eccl evolve --target-mw 300 --generations 15 --gate
    eccl campaign "antioxidant lead" --target-mw 300 --ground "ferulic acid antioxidant"
    eccl search "perovskite solar cell stability"
    eccl gui --port 8765 --no-browser
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import __version__


def _print(obj: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, indent=2, default=str))
    else:
        print(_pretty(obj))


def _pretty(obj: Any, indent: int = 0) -> str:
    pad = "  " * indent
    if isinstance(obj, dict):
        lines = []
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.append(_pretty(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {v}")
        return "\n".join(lines)
    if isinstance(obj, list):
        return "\n".join(_pretty(x, indent) if isinstance(x, (dict, list))
                         else f"{pad}- {x}" for x in obj)
    return f"{pad}{obj}"


def _float(s: str) -> float:
    return float(s)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eccl", description="Evolved Chemistry CAD Lab")
    p.add_argument("--version", action="version", version=f"eccl {__version__}")
    p.add_argument("--json", action="store_true", help="emit JSON")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="environment & capability report")

    m = sub.add_parser("molecule", help="analyze a molecule from SMILES")
    m.add_argument("smiles")

    s = sub.add_parser("semiconductor", help="semiconductor property report")
    s.add_argument("name")
    s.add_argument("--temp", type=_float, default=300.0)
    s.add_argument("--nd", type=_float, default=0.0, help="donor conc (cm^-3)")
    s.add_argument("--na", type=_float, default=0.0, help="acceptor conc (cm^-3)")

    pl = sub.add_parser("plasmon", help="plasmonic nanosphere (LSPR + Mie)")
    pl.add_argument("metal")
    pl.add_argument("--radius", type=_float, default=20.0)
    pl.add_argument("--medium-eps", type=_float, default=1.77)

    qd = sub.add_parser("qdot", help="quantum-dot confinement (Brus)")
    qd.add_argument("name")
    qd.add_argument("--radius", type=_float, default=2.5)

    pv = sub.add_parser("perovskite", help="Goldschmidt tolerance factor for ABX3")
    pv.add_argument("a_ion")
    pv.add_argument("b_ion")
    pv.add_argument("x_ion")

    rx = sub.add_parser("react", help="balance a chemical reaction")
    rx.add_argument("reactants", help="comma-separated formulae")
    rx.add_argument("products", help="comma-separated formulae")

    sp = sub.add_parser("spectrum", help="interpret spectral peaks")
    sp.add_argument("modality", choices=["IR", "raman", "1H", "13C"])
    sp.add_argument("peaks", nargs="+", type=_float)

    g = sub.add_parser("gate", help="screen molecules through the critics gate")
    g.add_argument("smiles", nargs="+")
    g.add_argument("--harshness", default="HARSH",
                   choices=["LENIENT", "NORMAL", "HARSH", "BRUTAL"])
    g.add_argument("--llm-critic", action="store_true")

    ev = sub.add_parser("evolve", help="evolve drug-like molecules")
    ev.add_argument("--target-mw", type=_float, default=350.0)
    ev.add_argument("--similar-to", default=None, help="reference SMILES")
    ev.add_argument("--generations", type=int, default=15)
    ev.add_argument("--population", type=int, default=40)
    ev.add_argument("--seed", type=int, default=None)
    ev.add_argument("--gate", action="store_true", help="apply critics gate")
    ev.add_argument("--harshness", default="HARSH")

    cp = sub.add_parser("campaign", help="full discovery campaign")
    cp.add_argument("title")
    cp.add_argument("--target-mw", type=_float, default=350.0)
    cp.add_argument("--similar-to", default=None)
    cp.add_argument("--ground", default=None, help="deep-search grounding query")
    cp.add_argument("--generations", type=int, default=15)
    cp.add_argument("--no-gate", action="store_true")
    cp.add_argument("--seed", type=int, default=None)

    se = sub.add_parser("search", help="deep multi-provider web search")
    se.add_argument("query")
    se.add_argument("--per-provider", type=int, default=4)
    se.add_argument("--no-synthesis", action="store_true")

    gu = sub.add_parser("gui", help="launch the local web GUI")
    gu.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    gu.add_argument("--port", type=int, default=8765, help="port (default 8765; 0 = any free)")
    gu.add_argument("--no-browser", action="store_true", help="do not open a web browser")

    return p


def cmd_info() -> dict[str, Any]:
    from .config import DEFAULT
    from .core import have_rdkit
    from .llm.manager import get_client

    client = get_client(DEFAULT.llm_backend)
    return {
        "version": __version__,
        "rdkit_available": have_rdkit(),
        "llm_backend": client.name,
        "llm_reachable": client.name != "echo (offline, deterministic)",
        "config": DEFAULT.as_dict(),
        "modules": ["core", "chem", "materials", "evolve", "spectro",
                    "critics", "llm", "search", "lab"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = args.json
    if args.command == "gui":
        return _run_gui(args)

    try:
        result = _dispatch(args)
    except Exception as e:  # noqa: BLE001
        _print({"error": str(e), "type": type(e).__name__}, as_json)
        return 1
    _print(result, as_json)
    return 0


def _run_gui(args: argparse.Namespace) -> int:
    """Serve the web GUI (blocking); bypasses the JSON/pretty printer."""
    from .gui import _signals

    _signals.block_early()  # before numpy/RDKit start threads; see _signals
    try:
        from .gui import launch

        launch(host=args.host, port=args.port, open_browser=not args.no_browser)
    except OSError as e:
        print(f"eccl gui: cannot start server on {args.host}:{args.port}: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            _signals.unblock()
        except KeyboardInterrupt:  # a second Ctrl-C during shutdown
            pass
    return 0


def _dispatch(args: argparse.Namespace) -> Any:
    from .lab import Workbench

    cmd = args.command
    if cmd == "info":
        return cmd_info()

    wb = Workbench()
    if cmd == "molecule":
        return wb.analyze_molecule(args.smiles)
    if cmd == "semiconductor":
        return wb.analyze_semiconductor(args.name, temperature_k=args.temp,
                                        n_donor=args.nd, n_acceptor=args.na)
    if cmd == "plasmon":
        return wb.analyze_plasmonic_sphere(args.metal, args.radius, args.medium_eps)
    if cmd == "qdot":
        return wb.analyze_quantum_dot(args.name, args.radius)
    if cmd == "perovskite":
        from .materials.crystal import goldschmidt_tolerance
        return goldschmidt_tolerance(args.a_ion, args.b_ion, args.x_ion).as_dict()
    if cmd == "react":
        from .chem.reactions import balance
        r = [x.strip() for x in args.reactants.split(",") if x.strip()]
        p = [x.strip() for x in args.products.split(",") if x.strip()]
        return balance(r, p).as_dict()
    if cmd == "spectrum":
        from .spectro import interpret_peaks
        return interpret_peaks(args.peaks, args.modality).as_dict()
    if cmd == "gate":
        return wb.gate(args.harshness, use_llm=args.llm_critic).screen(args.smiles)
    if cmd == "evolve":
        from .evolve.engine import EvolutionConfig
        from .lab.pipeline import druglike_objective
        obj = druglike_objective(args.target_mw, args.similar_to)
        cfg = EvolutionConfig(population_size=args.population,
                              generations=args.generations, random_seed=args.seed)
        res = wb.evolve_molecules(obj, use_gate=args.gate, harshness=args.harshness,
                                  config=cfg)
        return {"best": res.best.as_dict(),
                "hall_of_fame": [i.as_dict() for i in res.hall_of_fame[:5]],
                "history": res.history, "evaluations": res.evaluations}
    if cmd == "campaign":
        from .evolve.engine import EvolutionConfig
        from .lab.pipeline import DiscoveryCampaign, druglike_objective
        obj = druglike_objective(args.target_mw, args.similar_to)
        camp = DiscoveryCampaign(wb)
        rep = camp.run(args.title, obj, ground_query=args.ground,
                       use_gate=not args.no_gate,
                       evo_config=EvolutionConfig(generations=args.generations,
                                                  random_seed=args.seed))
        return rep.as_dict()
    if cmd == "search":
        return wb.deep_search(args.query, per_provider=args.per_provider,
                              synthesise=not args.no_synthesis)
    raise ValueError(f"unknown command {cmd!r}")


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
