"""Mutation and crossover operators for the genomes.

Molecular operators act on RDKit mols with validity checks so every child is a
parseable molecule. Composition operators do bounded Gaussian perturbation and
blending of element fractions.
"""
from __future__ import annotations

import random
from typing import Sequence

from ..core.molecule import have_rdkit
from .genome import CompositionGenome, MoleculeGenome

if have_rdkit():  # pragma: no cover
    from rdkit import Chem
    from rdkit.Chem import RWMol

# Atom substitution palette (organic-ish) and small appendable fragments.
_ATOM_SWAPS = {6: [7, 8], 7: [6, 8], 8: [6, 7, 16], 16: [8], 9: [17, 35], 17: [9, 35]}
_APPEND_FRAGMENTS = ["C", "O", "N", "F", "Cl", "C(=O)O", "CO", "CN", "c1ccccc1"]


def _sanitize(mol) -> str | None:
    try:
        Chem.SanitizeMol(mol)
        smi = Chem.MolToSmiles(mol)
        parsed = Chem.MolFromSmiles(smi)
        if parsed is None:
            return None
        # Keep only the largest connected fragment so operators never emit
        # salts / stray fragments (the critics gate also enforces this).
        if "." in smi:
            frags = Chem.GetMolFrags(parsed, asMols=True, sanitizeFrags=True)
            if not frags:
                return None
            largest = max(frags, key=lambda m: m.GetNumHeavyAtoms())
            smi = Chem.MolToSmiles(largest)
            if Chem.MolFromSmiles(smi) is None:
                return None
        return smi
    except Exception:
        return None


def mutate_molecule(genome: MoleculeGenome, rng: random.Random | None = None,
                    max_tries: int = 25) -> MoleculeGenome:
    """Return a mutated child genome (or a copy if no valid mutation is found)."""
    if not have_rdkit():
        return MoleculeGenome(genome.smiles, genome.generation + 1, [genome.smiles])
    rng = rng or random.Random()
    base = Chem.MolFromSmiles(genome.smiles)
    if base is None:
        return MoleculeGenome(genome.smiles, genome.generation + 1, [genome.smiles])

    ops = ["swap_atom", "append_fragment", "remove_atom", "toggle_bond"]
    for _ in range(max_tries):
        op = rng.choice(ops)
        rw = RWMol(base)
        smi = None
        if op == "swap_atom" and rw.GetNumAtoms() > 0:
            atom = rw.GetAtomWithIdx(rng.randrange(rw.GetNumAtoms()))
            z = atom.GetAtomicNum()
            if z in _ATOM_SWAPS and not atom.GetIsAromatic():
                atom.SetAtomicNum(rng.choice(_ATOM_SWAPS[z]))
                smi = _sanitize(rw)
        elif op == "append_fragment":
            frag = Chem.MolFromSmiles(rng.choice(_APPEND_FRAGMENTS))
            if frag is not None:
                combo = Chem.CombineMols(base, frag)
                rwc = RWMol(combo)
                # bond a random atom of base to first atom of fragment
                n_base = base.GetNumAtoms()
                a = rng.randrange(n_base)
                b = n_base  # first atom of fragment
                try:
                    if _can_bond(rwc, a) and _can_bond(rwc, b):
                        rwc.AddBond(a, b, Chem.BondType.SINGLE)
                        smi = _sanitize(rwc)
                except Exception:
                    smi = None
        elif op == "remove_atom" and rw.GetNumAtoms() > 3:
            idx = rng.randrange(rw.GetNumAtoms())
            try:
                rw.RemoveAtom(idx)
                smi = _sanitize(rw)
            except Exception:
                smi = None
        elif op == "toggle_bond" and rw.GetNumBonds() > 0:
            bond = rw.GetBondWithIdx(rng.randrange(rw.GetNumBonds()))
            if not bond.GetIsAromatic() and bond.GetBondType() == Chem.BondType.SINGLE:
                bond.SetBondType(Chem.BondType.DOUBLE)
                smi = _sanitize(rw)

        if smi and smi != genome.smiles:
            return MoleculeGenome(smi, genome.generation + 1, [genome.smiles])
    return MoleculeGenome(genome.smiles, genome.generation + 1, [genome.smiles])


def _can_bond(mol, idx: int) -> bool:
    atom = mol.GetAtomWithIdx(idx)
    return atom.GetImplicitValence() > 0 or atom.GetNumImplicitHs() > 0


def crossover_molecules(a: MoleculeGenome, b: MoleculeGenome,
                        rng: random.Random | None = None) -> MoleculeGenome:
    """Fragment-and-recombine crossover via breaking one bond in each parent.

    Falls back to returning a copy of the fitter-looking parent if no valid
    recombination is produced.
    """
    if not have_rdkit():
        return MoleculeGenome(a.smiles, max(a.generation, b.generation) + 1,
                              [a.smiles, b.smiles])
    rng = rng or random.Random()
    ma, mb = Chem.MolFromSmiles(a.smiles), Chem.MolFromSmiles(b.smiles)
    if ma is None or mb is None:
        return MoleculeGenome(a.smiles, max(a.generation, b.generation) + 1,
                              [a.smiles, b.smiles])

    frag_a = _random_fragment(ma, rng)
    frag_b = _random_fragment(mb, rng)
    if frag_a is None or frag_b is None:
        return MoleculeGenome(a.smiles, max(a.generation, b.generation) + 1,
                              [a.smiles, b.smiles])
    for _ in range(20):
        combo = Chem.CombineMols(frag_a, frag_b)
        rw = RWMol(combo)
        n_a = frag_a.GetNumAtoms()
        cand_a = [i for i in range(n_a) if _can_bond(rw, i)]
        cand_b = [i for i in range(n_a, rw.GetNumAtoms()) if _can_bond(rw, i)]
        if not cand_a or not cand_b:
            break
        try:
            rw.AddBond(rng.choice(cand_a), rng.choice(cand_b), Chem.BondType.SINGLE)
            smi = _sanitize(rw)
            if smi:
                return MoleculeGenome(smi, max(a.generation, b.generation) + 1,
                                      [a.smiles, b.smiles])
        except Exception:
            continue
    return MoleculeGenome(a.smiles, max(a.generation, b.generation) + 1,
                          [a.smiles, b.smiles])


def _random_fragment(mol, rng: random.Random):
    """Break one acyclic single bond and return one random resulting fragment."""
    single_acyclic = [
        b.GetIdx() for b in mol.GetBonds()
        if b.GetBondType() == Chem.BondType.SINGLE and not b.IsInRing()
    ]
    if not single_acyclic:
        return mol
    bidx = rng.choice(single_acyclic)
    try:
        frag_mol = Chem.FragmentOnBonds(mol, [bidx], addDummies=False)
        frags = Chem.GetMolFrags(frag_mol, asMols=True, sanitizeFrags=True)
        if not frags:
            return mol
        return rng.choice(frags)
    except Exception:
        return mol


def mutate_composition(genome: CompositionGenome, sigma: float = 0.1,
                       rng: random.Random | None = None) -> CompositionGenome:
    """Perturb element fractions with bounded Gaussian noise, then renormalise."""
    rng = rng or random.Random()
    new = {k: max(0.0, v + rng.gauss(0, sigma)) for k, v in genome.fractions.items()}
    child = CompositionGenome(new, genome.generation + 1,
                              [str(sorted(genome.fractions.items()))])
    return child.normalised()


def crossover_composition(a: CompositionGenome, b: CompositionGenome,
                          rng: random.Random | None = None) -> CompositionGenome:
    """Blend two compositions at a random mixing ratio."""
    rng = rng or random.Random()
    t = rng.random()
    keys = set(a.fractions) | set(b.fractions)
    new = {k: t * a.fractions.get(k, 0.0) + (1 - t) * b.fractions.get(k, 0.0) for k in keys}
    child = CompositionGenome(new, max(a.generation, b.generation) + 1,
                              [str(sorted(a.fractions)), str(sorted(b.fractions))])
    return child.normalised()
