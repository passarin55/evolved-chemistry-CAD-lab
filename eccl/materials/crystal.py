"""Crystal-structure helpers and a small reference database.

Enough to build common lattices (diamond, zincblende, rocksalt, perovskite)
and to estimate geometric descriptors used elsewhere (e.g. the Goldschmidt
tolerance factor for perovskite stability).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..core.material import Lattice, Material

# Shannon-ish ionic radii (angstrom), 6-coordinate unless noted. Small set.
IONIC_RADII: dict[str, float] = {
    "Li+": 0.76, "Na+": 1.02, "K+": 1.38, "Rb+": 1.52, "Cs+": 1.67,
    "Mg2+": 0.72, "Ca2+": 1.00, "Sr2+": 1.18, "Ba2+": 1.35,
    "Pb2+": 1.19, "Sn2+": 1.10, "Ge2+": 0.73, "Fe2+": 0.78, "Mn2+": 0.83,
    "Ti4+": 0.605, "Zr4+": 0.72, "Nb5+": 0.64, "Ta5+": 0.64,
    "O2-": 1.40, "S2-": 1.84, "Se2-": 1.98, "Te2-": 2.21,
    "F-": 1.33, "Cl-": 1.81, "Br-": 1.96, "I-": 2.20,
    # Molecular A-site cations for hybrid perovskites (effective radii)
    "MA+": 2.17, "FA+": 2.53,
}


@dataclass
class ToleranceFactor:
    t: float          # Goldschmidt tolerance factor
    octahedral_mu: float  # octahedral factor r_B / r_X
    verdict: str

    def as_dict(self) -> dict[str, Any]:
        return {"t": round(self.t, 4), "octahedral_mu": round(self.octahedral_mu, 4),
                "verdict": self.verdict}


def goldschmidt_tolerance(a_ion: str, b_ion: str, x_ion: str) -> ToleranceFactor:
    """Goldschmidt tolerance factor for an ABX3 perovskite.

    t = (rA + rX) / (sqrt(2) * (rB + rX)). 0.8 < t < 1.0 tends to be a stable
    perovskite; t ~ 0.9-1.0 cubic; <0.8 non-perovskite; >1 hexagonal.
    """
    import math

    try:
        rA, rB, rX = IONIC_RADII[a_ion], IONIC_RADII[b_ion], IONIC_RADII[x_ion]
    except KeyError as exc:
        raise KeyError(f"no ionic radius for {exc.args[0]!r}") from exc
    t = (rA + rX) / (math.sqrt(2.0) * (rB + rX))
    mu = rB / rX
    if t < 0.71:
        verdict = "non-perovskite (t<0.71)"
    elif t < 0.8:
        verdict = "distorted / non-cubic (0.71<=t<0.8)"
    elif t <= 1.0:
        verdict = "likely perovskite (0.8<=t<=1.0)"
    else:
        verdict = "hexagonal / non-perovskite (t>1.0)"
    if not (0.41 <= mu <= 0.90):
        verdict += "; octahedral factor out of ideal band"
    return ToleranceFactor(t=t, octahedral_mu=mu, verdict=verdict)


def cubic(a: float) -> Lattice:
    return Lattice(a, a, a, 90, 90, 90, system="cubic")


def diamond_silicon() -> Material:
    """Diamond-cubic Si, 8 atoms/cell."""
    return Material.from_formula(
        "Si", name="silicon",
        lattice=cubic(5.431), formula_units_per_cell=8,
        properties={"structure": "diamond"},
    )


def zincblende(formula: str, a: float, name: str | None = None) -> Material:
    """Zincblende AB compound, 4 formula units/cell (e.g. GaAs a=5.653)."""
    return Material.from_formula(
        formula, name=name, lattice=cubic(a), formula_units_per_cell=4,
        properties={"structure": "zincblende"},
    )


def rocksalt(formula: str, a: float, name: str | None = None) -> Material:
    """Rocksalt AB compound, 4 formula units/cell (e.g. NaCl a=5.640)."""
    return Material.from_formula(
        formula, name=name, lattice=cubic(a), formula_units_per_cell=4,
        properties={"structure": "rocksalt"},
    )


def cubic_perovskite(formula: str, a: float, name: str | None = None) -> Material:
    """Cubic ABX3 perovskite, 1 formula unit/cell (e.g. SrTiO3 a=3.905)."""
    return Material.from_formula(
        formula, name=name, lattice=cubic(a), formula_units_per_cell=1,
        properties={"structure": "perovskite"},
    )
