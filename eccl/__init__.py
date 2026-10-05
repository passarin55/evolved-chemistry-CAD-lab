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

from . import (  # noqa: E402
    chem,
    config,
    core,
    critics,
    evolve,
    llm,
    materials,
    search,
    spectro,
)
from .core import LabNotebook, Lattice, Material, Molecule, have_rdkit  # noqa: E402
from .lab import DiscoveryCampaign, Workbench, druglike_objective  # noqa: E402

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
