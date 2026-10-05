"""The :class:`Molecule` domain object.

RDKit powers the real cheminformatics (canonical SMILES, descriptors,
fingerprints). When RDKit is not installed, a Molecule can still be created
from a chemical formula and carry metadata — the chemistry modules then raise
clear errors for operations that genuinely need a structure.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import formula as _formula

try:  # pragma: no cover - import guard
    from rdkit import Chem
    from rdkit.Chem import Descriptors, rdMolDescriptors
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")
    _HAVE_RDKIT = True
except Exception:  # pragma: no cover
    Chem = None  # type: ignore
    Descriptors = None  # type: ignore
    rdMolDescriptors = None  # type: ignore
    _HAVE_RDKIT = False


def have_rdkit() -> bool:
    return _HAVE_RDKIT


class MoleculeError(ValueError):
    """Raised for invalid molecules or structure-requiring ops without RDKit."""


@dataclass
class Molecule:
    """A chemical species, identified by SMILES and/or formula.

    Prefer the classmethods :meth:`from_smiles` / :meth:`from_formula` over the
    bare constructor.
    """

    smiles: str | None = None
    name: str | None = None
    _formula_counts: dict[str, float] | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    _rdmol: Any = field(default=None, repr=False, compare=False)

    # ---- constructors ----
    @classmethod
    def from_smiles(cls, smiles: str, name: str | None = None) -> "Molecule":
        if not _HAVE_RDKIT:
            # Keep the SMILES verbatim; structure-dependent calls will error.
            return cls(smiles=smiles, name=name)
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            raise MoleculeError(f"RDKit could not parse SMILES: {smiles!r}")
        canon = Chem.MolToSmiles(mol)
        return cls(smiles=canon, name=name, _rdmol=mol)

    @classmethod
    def from_formula(cls, formula: str, name: str | None = None) -> "Molecule":
        counts = _formula.parse_formula(formula)
        return cls(name=name or formula, _formula_counts=counts)

    @classmethod
    def from_inchi(cls, inchi: str, name: str | None = None) -> "Molecule":
        if not _HAVE_RDKIT:
            raise MoleculeError("InChI parsing requires RDKit")
        mol = Chem.MolFromInchi(inchi)
        if mol is None:
            raise MoleculeError(f"RDKit could not parse InChI: {inchi!r}")
        return cls(smiles=Chem.MolToSmiles(mol), name=name, _rdmol=mol)

    # ---- structure access ----
    @property
    def rdmol(self) -> Any:
        if self._rdmol is None and self.smiles and _HAVE_RDKIT:
            self._rdmol = Chem.MolFromSmiles(self.smiles)
        if self._rdmol is None:
            raise MoleculeError(
                "this operation needs a parsed structure; "
                "install rdkit and build the molecule from SMILES"
            )
        return self._rdmol

    def has_structure(self) -> bool:
        if self._rdmol is not None:
            return True
        return bool(self.smiles and _HAVE_RDKIT and Chem.MolFromSmiles(self.smiles))

    # ---- identity / composition ----
    @property
    def formula_counts(self) -> dict[str, float]:
        if self._formula_counts is not None:
            return dict(self._formula_counts)
        if self.has_structure():
            counts: dict[str, float] = {}
            mol = Chem.AddHs(self.rdmol)
            for atom in mol.GetAtoms():
                counts[atom.GetSymbol()] = counts.get(atom.GetSymbol(), 0) + 1
            self._formula_counts = counts
            return dict(counts)
        raise MoleculeError("no composition available (need SMILES+RDKit or a formula)")

    @property
    def formula(self) -> str:
        if self.has_structure():
            return rdMolDescriptors.CalcMolFormula(self.rdmol)
        return _formula.hill_formula(self.formula_counts)

    @property
    def molar_mass(self) -> float:
        """g/mol."""
        if self.has_structure():
            return Descriptors.MolWt(self.rdmol)
        return _formula.molar_mass(self.formula_counts)

    def canonical_smiles(self) -> str:
        if self.has_structure():
            return Chem.MolToSmiles(self.rdmol)
        if self.smiles:
            return self.smiles
        raise MoleculeError("no SMILES available")

    def inchi_key(self) -> str:
        if not _HAVE_RDKIT:
            raise MoleculeError("InChIKey requires RDKit")
        return Chem.MolToInchiKey(self.rdmol)

    def num_atoms(self, include_h: bool = True) -> int:
        if self.has_structure():
            m = Chem.AddHs(self.rdmol) if include_h else self.rdmol
            return m.GetNumAtoms()
        counts = self.formula_counts
        if not include_h:
            counts = {k: v for k, v in counts.items() if k != "H"}
        return int(round(sum(counts.values())))

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"name": self.name, "meta": dict(self.meta)}
        try:
            d["smiles"] = self.canonical_smiles()
        except MoleculeError:
            d["smiles"] = self.smiles
        try:
            d["formula"] = self.formula
            d["molar_mass"] = round(self.molar_mass, 4)
        except MoleculeError:
            pass
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Molecule":
        if d.get("smiles"):
            mol = cls.from_smiles(d["smiles"], name=d.get("name"))
        elif d.get("formula"):
            mol = cls.from_formula(d["formula"], name=d.get("name"))
        else:
            raise MoleculeError("dict needs 'smiles' or 'formula'")
        mol.meta = dict(d.get("meta", {}))
        return mol

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        ident = self.smiles or (self.name or "?")
        return f"Molecule({ident!r})"
