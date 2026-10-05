"""Forward simulation of spectra from structures.

These are fast, physically-motivated approximations (not ab-initio):
  * IR/Raman: detect functional groups by SMARTS and place reference bands,
    broadened into a continuous spectrum.
  * UV-Vis: estimate the longest-wavelength absorption from conjugation length
    (a Kuhn free-electron / Woodward-Fieser-lite heuristic).
  * Powder XRD: Bragg angles of allowed cubic reflections from a lattice.

They give the lab something to *interpret* and to feed the critics gate.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..core.material import Material
from ..core.molecule import Molecule, MoleculeError, have_rdkit
from ..core.units import nm_to_ev

if have_rdkit():  # pragma: no cover
    from rdkit import Chem


# SMARTS -> characteristic IR band centers (cm^-1) for simulation.
_IR_SMARTS: list[tuple[str, str, float, float]] = [
    # (smarts, label, center_cm-1, rel_intensity)
    ("[OX2H]", "O-H stretch", 3350, 1.0),
    ("[NX3;H2,H1]", "N-H stretch", 3400, 0.6),
    ("[CX2]#[CX2]", "C≡C stretch", 2150, 0.4),
    ("[NX1]#[CX2]", "C≡N stretch", 2240, 0.7),
    ("[CX3]=[OX1]", "C=O stretch", 1715, 1.0),
    ("[CX3]=[CX3]", "C=C stretch", 1650, 0.5),
    ("c1ccccc1", "aromatic C=C", 1580, 0.6),
    ("[NX3](=O)=O", "N-O stretch (nitro)", 1520, 0.9),
    ("[#6][OX2][#6]", "C-O-C stretch", 1100, 0.8),
    ("[CX4H3]", "C-H bend (CH3)", 1375, 0.5),
    ("[#6][FX1]", "C-F stretch", 1150, 0.9),
    ("[#6][ClX1]", "C-Cl stretch", 700, 0.8),
]


@dataclass
class Spectrum:
    x: list[float]
    y: list[float]
    x_label: str
    y_label: str
    peaks: list[float]
    modality: str

    def as_dict(self) -> dict[str, Any]:
        return {"modality": self.modality, "x_label": self.x_label,
                "y_label": self.y_label, "peaks": self.peaks,
                "n_points": len(self.x)}


def _gaussian_sum(grid: np.ndarray, centers: list[float],
                  intensities: list[float], width: float) -> np.ndarray:
    y = np.zeros_like(grid)
    for c, a in zip(centers, intensities):
        y += a * np.exp(-0.5 * ((grid - c) / width) ** 2)
    return y


def simulate_ir(mol: Molecule, width: float = 25.0,
                grid: tuple[float, float, int] = (400, 4000, 1801)) -> Spectrum:
    """Simulate an IR transmission/absorbance-style spectrum from SMARTS groups."""
    if not have_rdkit():
        raise MoleculeError("IR simulation requires RDKit")
    rd = mol.rdmol
    centers, intens, peaks = [], [], []
    for smarts, _label, center, inten in _IR_SMARTS:
        patt = Chem.MolFromSmarts(smarts)
        if patt is None:
            continue
        matches = len(rd.GetSubstructMatches(patt))
        if matches:
            centers.append(center)
            intens.append(inten * min(1.0 + 0.1 * (matches - 1), 1.5))
            peaks.append(center)
    # always include a C-H stretch envelope if there are sp3/sp2 C-H
    if rd.GetNumAtoms():
        centers.append(2950)
        intens.append(0.7)
        peaks.append(2950)
    lo, hi, n = grid
    gx = np.linspace(lo, hi, n)
    gy = _gaussian_sum(gx, centers, intens, width)
    if gy.max() > 0:
        gy = gy / gy.max()
    return Spectrum(gx.tolist(), gy.tolist(), "wavenumber (cm^-1)",
                    "absorbance (norm.)", sorted(set(peaks)), "IR")


def estimate_uvvis_lambda_max(mol: Molecule) -> dict[str, Any]:
    """Estimate longest-wavelength UV-Vis absorption from conjugation length.

    Uses a free-electron 'particle in a box' (Kuhn) model over the longest
    conjugated path: lambda_max ~ 8 m c L^2 / (h (N+1)), with L from bond count.
    """
    if not have_rdkit():
        raise MoleculeError("UV-Vis estimation requires RDKit")
    rd = mol.rdmol
    # Longest chain of conjugated (aromatic or double) bonds.
    conj_bonds = 0
    for bond in rd.GetBonds():
        if bond.GetIsConjugated() or bond.GetIsAromatic() or \
           bond.GetBondType() == Chem.BondType.DOUBLE:
            conj_bonds += 1
    if conj_bonds == 0:
        return {"lambda_max_nm": None, "conjugated_bonds": 0,
                "note": "no conjugation; absorbs in deep UV (<200 nm)"}
    # Kuhn model: N pi-electrons over box length L = (k+1)*l_bond, l~0.139 nm.
    n_pi = conj_bonds + 1
    l_bond = 0.139e-9
    L = (conj_bonds + 1) * l_bond
    from ..core.units import M_E, C, H
    # transition from HOMO (n=n_pi/2) to LUMO (n_pi/2 + 1)
    j = n_pi // 2
    dE = (H ** 2) / (8 * M_E * L * L) * (2 * j + 1)
    lam = H * C / dE * 1e9
    return {"lambda_max_nm": round(lam, 1), "conjugated_bonds": conj_bonds,
            "pi_electrons": n_pi,
            "note": "free-electron (Kuhn) estimate; qualitative only"}


def simulate_powder_xrd(material: Material, wavelength_ang: float = 1.5406,
                        max_2theta: float = 90.0) -> dict[str, Any]:
    """Powder-XRD reflection positions for a cubic lattice (Cu K-alpha default).

    Returns allowed (hkl) reflections and their 2-theta angles via Bragg's law.
    Selection rules applied for the structure type if recorded in properties.
    """
    lat = material.lattice
    if lat is None:
        raise ValueError("material has no lattice for XRD")
    if lat.system != "cubic":
        raise ValueError("this simulator currently handles cubic lattices only")
    a = lat.a
    structure = str(material.properties.get("structure", "")).lower()
    reflections = []
    seen = set()
    for h in range(0, 6):
        for k in range(0, 6):
            for l in range(0, 6):
                if h == k == l == 0:
                    continue
                s = h * h + k * k + l * l
                if not _allowed(h, k, l, structure):
                    continue
                d = a / math.sqrt(s)
                arg = wavelength_ang / (2 * d)
                if arg > 1.0:
                    continue
                two_theta = 2 * math.degrees(math.asin(arg))
                if two_theta > max_2theta:
                    continue
                key = round(two_theta, 3)
                if key in seen:
                    continue
                seen.add(key)
                reflections.append({"hkl": (h, k, l), "two_theta": round(two_theta, 3),
                                    "d_spacing": round(d, 4)})
    reflections.sort(key=lambda r: r["two_theta"])
    return {"wavelength_ang": wavelength_ang, "lattice_a": a,
            "structure": structure or "cubic (no selection rules)",
            "reflections": reflections,
            "peaks_2theta": [r["two_theta"] for r in reflections]}


def _allowed(h: int, k: int, l: int, structure: str) -> bool:
    if structure in ("diamond",):
        # FCC rules + diamond: all even or all odd, and h+k+l != 2*(odd)
        all_odd = (h % 2 and k % 2 and l % 2)
        all_even = (h % 2 == 0 and k % 2 == 0 and l % 2 == 0)
        if not (all_odd or all_even):
            return False
        if all_even and ((h + k + l) % 4 != 0):
            return False
        return True
    if structure in ("zincblende", "rocksalt", "fcc"):
        return (h % 2 and k % 2 and l % 2) or (h % 2 == 0 and k % 2 == 0 and l % 2 == 0)
    if structure in ("bcc",):
        return (h + k + l) % 2 == 0
    return True  # simple cubic / perovskite: all reflections
