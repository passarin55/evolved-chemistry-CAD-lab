"""Evolved Chemistry CAD Lab (ECCL).

A modular, overengineered-on-purpose workbench for computational chemistry and
materials design:

  * core      — elements, units, formulae, molecules, materials, a lab notebook
  * chem      — descriptors, drug-likeness, similarity, reaction balancing
  * materials — semiconductors, photonics, plasmonics, quantum, crystals
  * evolve    — an evolutionary engine for molecular / materials design
  * spectro   — simulate & interpret IR / Raman / NMR / UV-Vis / MS / XRD
  * critics   — a harsh, skeptical accept/reject gate for candidates
  * llm       — local-first LLM integration (Ollama / OpenAI-compatible) + fallback
  * search    — deep multi-provider literature/data search
  * lab       — the Workbench and end-to-end discovery pipelines

Everything runs offline; network LLMs and web search are optional enhancements.
"""
from __future__ import annotations

__version__ = "0.1.0"

# Submodules and the convenience names below are imported lazily (PEP 562), so
# ``import eccl.cli`` / ``python -m eccl.gui`` stay light until the scientific
# stack is actually needed (the GUI entry point relies on this; see
# eccl/gui/_signals.py).
_SUBMODULES = frozenset({
    "chem", "config", "core", "critics", "evolve", "lab", "llm", "materials",
    "search", "spectro",
})
_ATTRS = {
    "LabNotebook": "core", "Lattice": "core", "Material": "core",
    "Molecule": "core", "have_rdkit": "core",
    "DiscoveryCampaign": "lab", "Workbench": "lab", "druglike_objective": "lab",
}


def __getattr__(name: str):
    import importlib

    if name in _SUBMODULES:
        return importlib.import_module(f"{__name__}.{name}")
    if name in _ATTRS:
        return getattr(importlib.import_module(f"{__name__}.{_ATTRS[name]}"), name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()) | _SUBMODULES | set(_ATTRS))


__all__ = [
    "__version__",
    "core",
    "chem",
    "materials",
    "evolve",
    "spectro",
    "critics",
    "llm",
    "search",
    "config",
    "Molecule",
    "Material",
    "Lattice",
    "LabNotebook",
    "have_rdkit",
    "Workbench",
    "DiscoveryCampaign",
    "druglike_objective",
]
