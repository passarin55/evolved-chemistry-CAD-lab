"""Genome representations for evolutionary search.

Two genomes:
  * :class:`MoleculeGenome` — a SMILES string (RDKit-validated), for drug /
    small-molecule discovery.
  * :class:`CompositionGenome` — a dict of element→fraction, for materials and
    semiconductor alloy design (e.g. In_x Ga_1-x As).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core.material import Material
from ..core.molecule import Molecule, have_rdkit


@dataclass
class MoleculeGenome:
    smiles: str
    generation: int = 0
    parents: list[str] = field(default_factory=list)

    def to_molecule(self) -> Molecule:
        return Molecule.from_smiles(self.smiles)

    def is_valid(self) -> bool:
        if not have_rdkit():
            return bool(self.smiles)
        try:
            Molecule.from_smiles(self.smiles)
            return True
        except Exception:
            return False

    def canonical(self) -> str:
        return self.to_molecule().canonical_smiles()

    def as_dict(self) -> dict[str, Any]:
        return {"smiles": self.smiles, "generation": self.generation,
                "parents": self.parents}


@dataclass
class CompositionGenome:
    """Element fractions that sum to 1.0 (continuous alloy space)."""

    fractions: dict[str, float]
    generation: int = 0
    parents: list[str] = field(default_factory=list)

    def normalised(self) -> "CompositionGenome":
        total = sum(max(0.0, v) for v in self.fractions.values())
        if total <= 0:
            raise ValueError("composition has no positive weight")
        return CompositionGenome(
            {k: max(0.0, v) / total for k, v in self.fractions.items()},
            self.generation, list(self.parents),
        )

    def to_material(self, scale: int = 100, name: str | None = None) -> Material:
        """Render as a Material with integer-ish stoichiometry (x100 by default)."""
        norm = self.normalised()
        comp = {k: round(v * scale, 3) for k, v in norm.fractions.items() if v > 1e-6}
        return Material(composition=comp, name=name)

    def is_valid(self) -> bool:
        return sum(1 for v in self.fractions.values() if v > 1e-6) >= 1

    def as_dict(self) -> dict[str, Any]:
        return {"fractions": self.fractions, "generation": self.generation,
                "parents": self.parents}


# A small, chemically-sane starter palette for de novo molecular runs.
SEED_SMILES: list[str] = [
    "CCO", "c1ccccc1", "CC(=O)O", "CCN", "c1ccncc1", "CC(C)O",
    "c1ccc(O)cc1", "CC(=O)N", "C1CCCCC1", "c1ccc(N)cc1", "CCOC(C)=O",
    "c1ccc2ccccc2c1", "CN1CCCC1", "c1ccc(C(=O)O)cc1",
]
