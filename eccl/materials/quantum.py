"""Quantum materials: tight-binding bands, DOS, and quantum confinement.

Small but real quantum models:
  * 1-D and 2-D nearest-neighbour tight-binding band structures,
  * a honeycomb (graphene-like) model with Dirac points,
  * particle-in-a-box / quantum-well sub-bands,
  * a quantum-dot confinement blue-shift (effective-mass approximation).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..core.units import HBAR, M_E, EV, ev_to_nm


def tight_binding_1d(onsite: float, hopping: float, n_k: int = 201) -> dict[str, Any]:
    """1-D chain: E(k) = onsite - 2 t cos(k a). Returns band and gap info."""
    ks = np.linspace(-math.pi, math.pi, n_k)
    e = onsite - 2.0 * hopping * np.cos(ks)
    return {
        "k": ks.tolist(),
        "energy": e.tolist(),
        "bandwidth": float(e.max() - e.min()),
        "e_min": float(e.min()),
        "e_max": float(e.max()),
    }


def tight_binding_square(onsite: float, hopping: float, n_k: int = 101) -> dict[str, Any]:
    """2-D square lattice: E = onsite - 2t(cos kx + cos ky)."""
    ks = np.linspace(-math.pi, math.pi, n_k)
    kx, ky = np.meshgrid(ks, ks)
    e = onsite - 2.0 * hopping * (np.cos(kx) + np.cos(ky))
    return {
        "bandwidth": float(e.max() - e.min()),
        "e_min": float(e.min()),
        "e_max": float(e.max()),
        "van_hove_energy": float(onsite),  # saddle point at (pi,0)
    }


def graphene_bands(hopping: float = 2.7, n_k: int = 300) -> dict[str, Any]:
    """Honeycomb tight-binding along Gamma-K-M-Gamma; reports the Dirac gap.

    E(k) = +/- t |f(k)|, f = sum over the three nearest-neighbour vectors.
    A gapless Dirac cone at K is the signature.
    """
    # Work in units of the C-C bond length (acc = 1). Nearest-neighbour vectors
    # and high-symmetry points are chosen in one consistent basis so that f(K)=0
    # (the Dirac point) comes out exactly.
    s3 = math.sqrt(3)
    d = [np.array([1.0, 0.0]),
         np.array([-0.5, s3 / 2]),
         np.array([-0.5, -s3 / 2])]
    # high-symmetry points (reciprocal space, same units)
    G = np.array([0.0, 0.0])
    K = np.array([2 * math.pi / 3, 2 * math.pi / (3 * s3)])
    M = np.array([math.pi / 3, math.pi / s3])

    def path(p0, p1, npts):
        return [p0 + (p1 - p0) * t for t in np.linspace(0, 1, npts)]

    kpath = path(G, K, n_k) + path(K, M, n_k) + path(M, G, n_k)
    upper, lower = [], []
    min_gap = math.inf
    for k in kpath:
        f = sum(complex(math.cos(k @ dv), math.sin(k @ dv)) for dv in d)
        band = hopping * abs(f)
        upper.append(band)
        lower.append(-band)
        min_gap = min(min_gap, 2 * band)
    return {
        "upper_band": upper,
        "lower_band": lower,
        "min_direct_gap": float(min_gap),
        "is_dirac_semimetal": bool(min_gap < 1e-6),
    }


@dataclass
class QuantumWell:
    levels_ev: list[float]
    well_width_nm: float
    confinement_ev: float

    def as_dict(self) -> dict[str, Any]:
        return {"levels_ev": [round(x, 4) for x in self.levels_ev],
                "well_width_nm": self.well_width_nm,
                "confinement_ev": round(self.confinement_ev, 4)}


def infinite_well(width_nm: float, m_eff_ratio: float = 1.0, n_levels: int = 4) -> QuantumWell:
    """Bound-state energies of an infinite square well (particle in a box).

    E_n = n^2 pi^2 hbar^2 / (2 m* L^2).
    """
    L = width_nm * 1e-9
    m = m_eff_ratio * M_E
    e1 = (math.pi**2 * HBAR**2) / (2 * m * L * L) / EV
    levels = [e1 * n * n for n in range(1, n_levels + 1)]
    return QuantumWell(levels_ev=levels, well_width_nm=width_nm, confinement_ev=levels[0])


def quantum_dot_shift(bulk_gap_ev: float, radius_nm: float,
                      me_eff: float, mh_eff: float, eps_r: float = 1.0) -> dict[str, Any]:
    """Brus-equation quantum-dot gap: confinement blue-shift + Coulomb term.

    E_gap(R) = Eg_bulk + (hbar^2 pi^2 / 2R^2)(1/me + 1/mh) - 1.8 e^2/(4 pi eps R).
    Returns the confined gap and the emission wavelength.
    """
    from ..core.units import E_CHARGE, EPS0

    R = radius_nm * 1e-9
    confinement = (HBAR**2 * math.pi**2) / (2 * R * R) * (
        1.0 / (me_eff * M_E) + 1.0 / (mh_eff * M_E)
    ) / EV
    coulomb = 1.8 * E_CHARGE / (4 * math.pi * eps_r * EPS0 * R)  # in volts*e => eV
    gap = bulk_gap_ev + confinement - coulomb
    return {
        "confined_gap_ev": round(gap, 4),
        "confinement_shift_ev": round(confinement, 4),
        "coulomb_ev": round(coulomb, 4),
        "emission_nm": round(ev_to_nm(gap), 2) if gap > 0 else None,
    }


def density_of_states_1d(energies: list[float], n_bins: int = 50) -> dict[str, Any]:
    """Histogram-based density of states from a sampled band."""
    arr = np.asarray(energies, dtype=float)
    hist, edges = np.histogram(arr, bins=n_bins)
    centers = 0.5 * (edges[:-1] + edges[1:])
    return {"energy": centers.tolist(), "dos": hist.tolist()}
