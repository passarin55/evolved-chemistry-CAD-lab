"""Plasmonics: Drude dielectric functions, surface plasmons, LSPR, Mie.

For metal nanostructures and plasmonic sensors. The Drude model gives the
free-electron dielectric function; from it we get the surface-plasmon
dispersion, the quasistatic localised surface plasmon resonance (LSPR) of a
small sphere, and a dipole Mie cross-section.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from ..core.units import EPS0, HBAR, EV, ev_to_nm, nm_to_ev

# Drude parameters: plasma energy hbar*wp (eV), damping hbar*gamma (eV),
# and eps_inf (background from bound electrons). Classic fits.
@dataclass
class DrudeMetal:
    name: str
    wp_ev: float          # plasma energy, eV
    gamma_ev: float       # damping, eV
    eps_inf: float = 1.0


METALS: dict[str, DrudeMetal] = {
    "Au": DrudeMetal("Au", 9.03, 0.071, 9.84),
    "Ag": DrudeMetal("Ag", 9.01, 0.021, 3.70),
    "Al": DrudeMetal("Al", 14.98, 0.047, 1.00),
    "Cu": DrudeMetal("Cu", 8.82, 0.093, 10.0),
    "Na": DrudeMetal("Na", 5.71, 0.028, 1.00),
}


def get_metal(name: str) -> DrudeMetal:
    if name not in METALS:
        raise KeyError(f"unknown metal {name!r}; known: {sorted(METALS)}")
    return METALS[name]


def drude_epsilon(metal: str, photon_ev: float) -> complex:
    """Complex relative permittivity eps(w) = eps_inf - wp^2/(w^2 + i*gamma*w)."""
    m = get_metal(metal)
    w = photon_ev
    denom = complex(w * w, m.gamma_ev * w)
    return m.eps_inf - (m.wp_ev**2) / denom


def drude_index(metal: str, photon_ev: float) -> complex:
    """Complex refractive index n + ik from the Drude permittivity."""
    import cmath

    return cmath.sqrt(drude_epsilon(metal, photon_ev))


@dataclass
class SPPResult:
    neff: float              # effective mode index (Re of sqrt(eps_m eps_d/(eps_m+eps_d)))
    propagation_length_um: float
    confinement_nm: float    # 1/e decay into dielectric

    def as_dict(self) -> dict[str, Any]:
        return {"neff": round(self.neff, 4),
                "propagation_length_um": round(self.propagation_length_um, 3),
                "confinement_nm": round(self.confinement_nm, 2)}


def surface_plasmon(metal: str, photon_ev: float, eps_dielectric: float = 1.0) -> SPPResult:
    """Surface-plasmon-polariton at a metal/dielectric interface."""
    import cmath

    em = drude_epsilon(metal, photon_ev)
    ed = complex(eps_dielectric, 0)
    lam_nm = ev_to_nm(photon_ev)
    k0 = 2 * math.pi / lam_nm  # 1/nm
    beta = k0 * cmath.sqrt(em * ed / (em + ed))  # complex propagation const
    neff = beta.real / k0
    # Propagation length L = 1 / (2 Im beta)
    prop_nm = 1.0 / (2 * beta.imag) if beta.imag > 0 else float("inf")
    # Transverse decay into dielectric: kz_d = sqrt(beta^2 - ed k0^2)
    kz_d = cmath.sqrt(beta**2 - ed * k0**2)
    conf_nm = 1.0 / abs(kz_d.real) if kz_d.real != 0 else float("inf")
    return SPPResult(neff=neff, propagation_length_um=prop_nm / 1000.0,
                     confinement_nm=conf_nm)


def spp_resonance_energy(metal: str, eps_dielectric: float = 1.0) -> float:
    """Surface plasmon energy wsp ~ wp / sqrt(eps_inf + eps_d) (eV)."""
    m = get_metal(metal)
    return m.wp_ev / math.sqrt(m.eps_inf + eps_dielectric)


@dataclass
class LSPRResult:
    resonance_ev: float
    resonance_nm: float
    fwhm_ev: float
    quality_factor: float

    def as_dict(self) -> dict[str, Any]:
        return {"resonance_ev": round(self.resonance_ev, 4),
                "resonance_nm": round(self.resonance_nm, 2),
                "fwhm_ev": round(self.fwhm_ev, 4),
                "quality_factor": round(self.quality_factor, 2)}


def lspr_sphere(metal: str, eps_medium: float = 1.0,
                scan_ev: tuple[float, float, int] = (0.5, 6.0, 1101)) -> LSPRResult:
    """Quasistatic LSPR of a small metal sphere (Frohlich condition eps_m=-2 eps_d).

    Finds the peak of the polarizability Im(alpha) ~ Im((eps_m - eps_d)/(eps_m + 2 eps_d)).
    """
    lo, hi, n = scan_ev
    best_ev, best_val = lo, -1.0
    curve: list[tuple[float, float]] = []
    for i in range(n):
        ev = lo + (hi - lo) * i / (n - 1)
        em = drude_epsilon(metal, ev)
        alpha = (em - eps_medium) / (em + 2 * eps_medium)
        val = alpha.imag
        curve.append((ev, val))
        if val > best_val:
            best_val, best_ev = val, ev
    # FWHM from the curve.
    half = best_val / 2.0
    left = right = best_ev
    for ev, val in curve:
        if val >= half and ev < best_ev:
            left = ev
            break
    for ev, val in reversed(curve):
        if val >= half and ev > best_ev:
            right = ev
            break
    fwhm = max(right - left, 1e-6)
    return LSPRResult(resonance_ev=best_ev, resonance_nm=ev_to_nm(best_ev),
                      fwhm_ev=fwhm, quality_factor=best_ev / fwhm)


def mie_dipole_cross_sections(metal: str, radius_nm: float, photon_ev: float,
                              eps_medium: float = 1.0) -> dict[str, float]:
    """Dipole (quasistatic) extinction/scattering/absorption cross-sections (nm^2)."""
    import cmath

    em = drude_epsilon(metal, photon_ev)
    ed = eps_medium
    lam_nm = ev_to_nm(photon_ev)
    k = 2 * math.pi * math.sqrt(ed) / lam_nm  # 1/nm
    vol = (4.0 / 3.0) * math.pi * radius_nm**3
    alpha = 3 * vol * (em - ed) / (em + 2 * ed)  # polarizability, nm^3
    c_abs = k * alpha.imag
    c_sca = (k**4) / (6 * math.pi) * (abs(alpha) ** 2)
    c_ext = c_abs + c_sca
    return {"C_ext_nm2": round(c_ext, 4), "C_sca_nm2": round(c_sca, 6),
            "C_abs_nm2": round(c_abs, 4), "wavelength_nm": round(lam_nm, 2)}
