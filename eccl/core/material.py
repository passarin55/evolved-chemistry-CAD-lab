"""The :class:`Material` domain object: a bulk/crystalline substance.

Where :class:`~eccl.core.molecule.Molecule` is about discrete molecules,
``Material`` describes compositions and (optionally) crystal structure, and is
the handle the semiconductor / photonics / plasmonics / quantum modules
attach computed properties to.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import formula as _formula
from .elements import by_symbol


@dataclass
class Lattice:
    """A crystallographic unit cell (lengths in angstrom, angles in degrees)."""

    a: float
    b: float
    c: float
    alpha: float = 90.0
    beta: float = 90.0
    gamma: float = 90.0
    system: str = "cubic"

    def volume_ang3(self) -> float:
        import math

        al, be, ga = (math.radians(x) for x in (self.alpha, self.beta, self.gamma))
        cosa, cosb, cosg = math.cos(al), math.cos(be), math.cos(ga)
        vol = (
            self.a
            * self.b
            * self.c
            * math.sqrt(
                max(0.0, 1 - cosa**2 - cosb**2 - cosg**2 + 2 * cosa * cosb * cosg)
            )
        )
        return vol

    def to_dict(self) -> dict[str, Any]:
        return {
            "a": self.a, "b": self.b, "c": self.c,
            "alpha": self.alpha, "beta": self.beta, "gamma": self.gamma,
            "system": self.system,
        }


@dataclass
class Material:
    """A material defined by composition, optional crystal structure, and props.

    ``properties`` is an open bag that physics modules write into (``bandgap_eV``,
    ``n_at_589nm``, ``lspr_nm`` ...), so a material accrues knowledge as it moves
    through the lab.
    """

    composition: dict[str, float]
    name: str | None = None
    lattice: Lattice | None = None
    formula_units_per_cell: int = 1
    properties: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_formula(cls, formula: str, name: str | None = None, **kw: Any) -> "Material":
        return cls(composition=_formula.parse_formula(formula), name=name or formula, **kw)

    @property
    def formula(self) -> str:
        return _formula.hill_formula(self.composition)

    @property
    def formula_mass(self) -> float:
        """Molar mass of one formula unit, g/mol."""
        return _formula.molar_mass(self.composition)

    def mass_fractions(self) -> dict[str, float]:
        return _formula.mass_fractions(self.composition)

    def average_electronegativity(self) -> float:
        """Composition-weighted Pauling electronegativity (ignores undefined)."""
        num = den = 0.0
        for sym, cnt in self.composition.items():
            en = by_symbol(sym).electronegativity
            if en is not None:
                num += en * cnt
                den += cnt
        if den == 0:
            raise ValueError("no electronegativity data for this composition")
        return num / den

    def electronegativity_spread(self) -> float:
        """Max-min Pauling EN across constituent elements (ionicity proxy)."""
        ens = [
            by_symbol(s).electronegativity
            for s in self.composition
            if by_symbol(s).electronegativity is not None
        ]
        if len(ens) < 2:
            return 0.0
        return max(ens) - min(ens)

    def density_g_cm3(self) -> float | None:
        """Crystallographic density if a lattice is set, else None."""
        if self.lattice is None:
            return None
        from .units import N_A

        mass_g = self.formula_mass * self.formula_units_per_cell / N_A
        vol_cm3 = self.lattice.volume_ang3() * 1e-24
        return mass_g / vol_cm3

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "formula": self.formula,
            "composition": dict(self.composition),
            "formula_units_per_cell": self.formula_units_per_cell,
            "lattice": self.lattice.to_dict() if self.lattice else None,
            "properties": dict(self.properties),
            "meta": dict(self.meta),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Material":
        lat = None
        if d.get("lattice"):
            lat = Lattice(**d["lattice"])
        return cls(
            composition=dict(d["composition"]),
            name=d.get("name"),
            lattice=lat,
            formula_units_per_cell=d.get("formula_units_per_cell", 1),
            properties=dict(d.get("properties", {})),
            meta=dict(d.get("meta", {})),
        )

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Material({self.formula!r})"
