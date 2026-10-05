"""Fingerprints and molecular similarity."""
from __future__ import annotations

from typing import Iterable

from ..core.molecule import Molecule, MoleculeError, have_rdkit

if have_rdkit():  # pragma: no cover
    from rdkit import DataStructs
    from rdkit.Chem import rdMolDescriptors


def morgan_fingerprint(mol: Molecule, radius: int = 2, n_bits: int = 2048):
    """ECFP-like Morgan fingerprint as an RDKit bit vector."""
    if not have_rdkit():
        raise MoleculeError("fingerprints require RDKit")
    return rdMolDescriptors.GetMorganFingerprintAsBitVect(mol.rdmol, radius, nBits=n_bits)


def tanimoto(a: Molecule, b: Molecule, radius: int = 2, n_bits: int = 2048) -> float:
    """Tanimoto similarity in [0, 1] between two molecules."""
    fa = morgan_fingerprint(a, radius, n_bits)
    fb = morgan_fingerprint(b, radius, n_bits)
    return float(DataStructs.TanimotoSimilarity(fa, fb))


def nearest(query: Molecule, library: Iterable[Molecule], k: int = 5,
            radius: int = 2, n_bits: int = 2048) -> list[tuple[Molecule, float]]:
    """Return the k most similar molecules from a library (desc by similarity)."""
    if not have_rdkit():
        raise MoleculeError("similarity search requires RDKit")
    fq = morgan_fingerprint(query, radius, n_bits)
    scored: list[tuple[Molecule, float]] = []
    for m in library:
        try:
            fm = morgan_fingerprint(m, radius, n_bits)
        except MoleculeError:
            continue
        scored.append((m, float(DataStructs.TanimotoSimilarity(fq, fm))))
    scored.sort(key=lambda t: t[1], reverse=True)
    return scored[:k]


def diversity(library: list[Molecule], radius: int = 2, n_bits: int = 2048) -> float:
    """Mean pairwise Tanimoto *distance* (1 - similarity); higher = more diverse."""
    if len(library) < 2:
        return 0.0
    fps = [morgan_fingerprint(m, radius, n_bits) for m in library]
    total = count = 0.0
    for i in range(len(fps)):
        sims = DataStructs.BulkTanimotoSimilarity(fps[i], fps[i + 1 :])
        for s in sims:
            total += 1.0 - s
            count += 1
    return round(total / count, 4) if count else 0.0
