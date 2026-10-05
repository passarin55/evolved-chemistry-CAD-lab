"""Molecular descriptors (RDKit-backed)."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from ..core.molecule import Molecule, MoleculeError, have_rdkit

if have_rdkit():  # pragma: no cover - import guard
    from rdkit.Chem import Descriptors, Crippen, Lipinski, rdMolDescriptors


@dataclass
class DescriptorSet:
    mol_weight: float
    logp: float                 # Crippen logP (lipophilicity)
    tpsa: float                 # topological polar surface area, A^2
    h_donors: int
    h_acceptors: int
    rotatable_bonds: int
    rings: int
    aromatic_rings: int
    heavy_atoms: int
    fraction_csp3: float
    formal_charge: int
    num_heteroatoms: int

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def compute_descriptors(mol: Molecule) -> DescriptorSet:
    """Compute a standard descriptor panel. Requires RDKit + a structure."""
    if not have_rdkit():
        raise MoleculeError("descriptors require RDKit")
    rd = mol.rdmol
    return DescriptorSet(
        mol_weight=round(Descriptors.MolWt(rd), 3),
        logp=round(Crippen.MolLogP(rd), 3),
        tpsa=round(rdMolDescriptors.CalcTPSA(rd), 2),
        h_donors=Lipinski.NumHDonors(rd),
        h_acceptors=Lipinski.NumHAcceptors(rd),
        rotatable_bonds=Lipinski.NumRotatableBonds(rd),
        rings=rdMolDescriptors.CalcNumRings(rd),
        aromatic_rings=rdMolDescriptors.CalcNumAromaticRings(rd),
        heavy_atoms=rd.GetNumHeavyAtoms(),
        fraction_csp3=round(rdMolDescriptors.CalcFractionCSP3(rd), 3),
        formal_charge=sum(a.GetFormalCharge() for a in rd.GetAtoms()),
        num_heteroatoms=rdMolDescriptors.CalcNumHeteroatoms(rd),
    )
