"""Fitness functions (objectives) for evolutionary search.

A fitness function maps a genome to a float in roughly [0, 1] where higher is
better. They are composable: :class:`WeightedObjective` blends several, and
:func:`target_property` builds a single-property matcher.

All objectives are defensive: an invalid or unscorable genome returns 0.0 so
the engine can keep running offline or without RDKit.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

from ..chem import druglike
from ..core.molecule import Molecule, have_rdkit
from .genome import MoleculeGenome

Objective = Callable[[MoleculeGenome], float]


def _safe_mol(genome: MoleculeGenome) -> Molecule | None:
    try:
        mol = genome.to_molecule()
        if not mol.has_structure():
            return None
        return mol
    except Exception:
        return None


def druglikeness() -> Objective:
    """Maximise the QED-like desirability (penalised by structural alerts)."""
    def f(genome: MoleculeGenome) -> float:
        mol = _safe_mol(genome)
        if mol is None:
            return 0.0
        try:
            rep = druglike.assess(mol)
        except Exception:
            return 0.0
        penalty = 0.15 * len(rep.alerts)
        return max(0.0, rep.qed_like - penalty)
    return f


def synthesizability() -> Objective:
    """Reward easy-to-make molecules (invert the SA proxy to [0,1])."""
    def f(genome: MoleculeGenome) -> float:
        mol = _safe_mol(genome)
        if mol is None:
            return 0.0
        try:
            d = druglike.compute_descriptors(mol)
            sa = druglike.synthetic_accessibility_proxy(d)
        except Exception:
            return 0.0
        return max(0.0, 1.0 - (sa - 1.0) / 9.0)
    return f


def target_property(prop: str, target: float, tolerance: float) -> Objective:
    """Gaussian reward for matching a scalar descriptor to a target value.

    prop is any attribute of :class:`~eccl.chem.descriptors.DescriptorSet`
    (e.g. 'mol_weight', 'logp', 'tpsa').
    """
    def f(genome: MoleculeGenome) -> float:
        mol = _safe_mol(genome)
        if mol is None:
            return 0.0
        try:
            d = druglike.compute_descriptors(mol)
            val = getattr(d, prop)
        except Exception:
            return 0.0
        return math.exp(-0.5 * ((val - target) / tolerance) ** 2)
    return f


def similarity_to(reference_smiles: str) -> Objective:
    """Reward Tanimoto similarity to a reference molecule (scaffold hopping)."""
    from ..chem.similarity import tanimoto

    ref = Molecule.from_smiles(reference_smiles)

    def f(genome: MoleculeGenome) -> float:
        mol = _safe_mol(genome)
        if mol is None or not have_rdkit():
            return 0.0
        try:
            return tanimoto(mol, ref)
        except Exception:
            return 0.0
    return f


def novelty_against(library_smiles: list[str]) -> Objective:
    """Reward being *dissimilar* to a known library (1 - max similarity)."""
    from ..chem.similarity import tanimoto

    refs = []
    for s in library_smiles:
        try:
            refs.append(Molecule.from_smiles(s))
        except Exception:
            continue

    def f(genome: MoleculeGenome) -> float:
        mol = _safe_mol(genome)
        if mol is None or not refs:
            return 0.0
        try:
            return 1.0 - max(tanimoto(mol, r) for r in refs)
        except Exception:
            return 0.0
    return f


@dataclass
class WeightedObjective:
    """A weighted blend of named objectives. Weights need not sum to 1."""

    terms: dict[str, tuple[float, Objective]]

    def __call__(self, genome: MoleculeGenome) -> float:
        total_w = sum(w for w, _ in self.terms.values())
        if total_w <= 0:
            return 0.0
        score = sum(w * fn(genome) for w, fn in self.terms.values())
        return score / total_w

    def breakdown(self, genome: MoleculeGenome) -> dict[str, float]:
        return {name: round(fn(genome), 4) for name, (_, fn) in self.terms.items()}
