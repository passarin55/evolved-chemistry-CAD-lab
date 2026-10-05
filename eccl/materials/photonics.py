"""Photonics: refractive index, Fresnel optics, thin films, waveguides.

Dispersion uses Sellmeier equations for a few common optical materials. The
rest are standard wave-optics relations useful for designing photonic
structures (mirrors, waveguides, Bragg stacks, microcavities).
"""
from __future__ import annotations

import cmath
import math
from dataclasses import dataclass
from typing import Any

from ..core.units import C

# Sellmeier coefficients: n^2 - 1 = sum_i B_i lam^2 / (lam^2 - C_i), lam in um.
SELLMEIER: dict[str, dict[str, list[float]]] = {
    "SiO2": {"B": [0.6961663, 0.4079426, 0.8974794],
             "C": [0.0684043**2, 0.1162414**2, 9.896161**2]},
    "BK7": {"B": [1.03961212, 0.231792344, 1.01046945],
            "C": [0.00600069867, 0.0200179144, 103.560653]},
    "Al2O3": {"B": [1.4313493, 0.65054713, 5.3414021],
              "C": [0.0726631**2, 0.1193242**2, 18.028251**2]},
    "MgF2": {"B": [0.48755108, 0.39875031, 2.3120353],
             "C": [0.04338408**2, 0.09461442**2, 23.793604**2]},
    "TiO2": {"B": [3.2089, 3.4000], "C": [0.1**2, 0.3042**2]},
}


def sellmeier_index(material: str, wavelength_nm: float) -> float:
    """Real refractive index from Sellmeier dispersion."""
    if material not in SELLMEIER:
        raise KeyError(f"no Sellmeier data for {material!r}; known: {sorted(SELLMEIER)}")
    lam_um = wavelength_nm / 1000.0
    lam2 = lam_um * lam_um
    coeffs = SELLMEIER[material]
    n2 = 1.0
    for b, c in zip(coeffs["B"], coeffs["C"]):
        n2 += b * lam2 / (lam2 - c)
    if n2 <= 0:
        raise ValueError("Sellmeier gave non-physical index (out of valid range)")
    return math.sqrt(n2)


@dataclass
class FresnelResult:
    r_s: float          # amplitude reflection, s-pol
    r_p: float          # amplitude reflection, p-pol
    R_s: float          # power reflectance, s
    R_p: float          # power reflectance, p
    R_unpolarised: float

    def as_dict(self) -> dict[str, Any]:
        return {k: round(getattr(self, k), 5) for k in
                ("r_s", "r_p", "R_s", "R_p", "R_unpolarised")}


def fresnel(n1: float, n2: float, theta_i_deg: float = 0.0) -> FresnelResult:
    """Fresnel reflection at an interface for incidence angle theta_i (degrees)."""
    ti = math.radians(theta_i_deg)
    sin_tt = n1 * math.sin(ti) / n2
    if abs(sin_tt) > 1.0:
        # Total internal reflection: reflectance is 1.
        return FresnelResult(1.0, 1.0, 1.0, 1.0, 1.0)
    tt = math.asin(sin_tt)
    cos_i, cos_t = math.cos(ti), math.cos(tt)
    rs = (n1 * cos_i - n2 * cos_t) / (n1 * cos_i + n2 * cos_t)
    rp = (n2 * cos_i - n1 * cos_t) / (n2 * cos_i + n1 * cos_t)
    Rs, Rp = rs * rs, rp * rp
    return FresnelResult(rs, rp, Rs, Rp, 0.5 * (Rs + Rp))


def brewster_angle(n1: float, n2: float) -> float:
    """Brewster angle in degrees (p-pol reflection vanishes)."""
    return math.degrees(math.atan2(n2, n1))


def critical_angle(n1: float, n2: float) -> float | None:
    """Critical angle for total internal reflection (deg), or None if n1<=n2."""
    if n1 <= n2:
        return None
    return math.degrees(math.asin(n2 / n1))


def bragg_wavelength(n_high: float, d_high: float, n_low: float, d_low: float) -> float:
    """Center (Bragg) wavelength of a quarter-wave DBR stack (nm).

    Quarter-wave condition n_i d_i = lambda/4 => lambda = 4 n d (both layers).
    d_* in nm.
    """
    return 2.0 * (n_high * d_high + n_low * d_low)


def dbr_reflectance(n_high: float, n_low: float, n_in: float, n_out: float,
                    pairs: int) -> float:
    """Peak reflectance of a distributed Bragg reflector with N layer pairs."""
    ratio = (n_high / n_low) ** (2 * pairs)
    num = n_in * ratio - n_out  # arrangement n_in | (H L)^N | n_out, starts high
    # Standard DBR peak reflectance formula.
    a = n_out / n_in * (n_high / n_low) ** (2 * pairs)
    R = ((1 - a) / (1 + a)) ** 2
    return R


@dataclass
class WaveguideModes:
    v_number: float
    num_modes_estimate: int
    single_mode: bool
    cutoff_wavelength_nm: float

    def as_dict(self) -> dict[str, Any]:
        return {"v_number": round(self.v_number, 3),
                "num_modes_estimate": self.num_modes_estimate,
                "single_mode": self.single_mode,
                "cutoff_wavelength_nm": round(self.cutoff_wavelength_nm, 2)}


def slab_waveguide(core_index: float, clad_index: float,
                   thickness_nm: float, wavelength_nm: float) -> WaveguideModes:
    """Mode count of a symmetric planar slab waveguide via the V-number."""
    if core_index <= clad_index:
        raise ValueError("core index must exceed cladding index to guide")
    na = math.sqrt(core_index**2 - clad_index**2)
    v = math.pi * thickness_nm / wavelength_nm * na
    num_modes = max(1, int(math.floor(2 * v / math.pi)) + 1)
    # Single-mode cutoff at V = pi/2 for symmetric slab (TE0/TE1).
    cutoff = math.pi * thickness_nm * na / (math.pi / 2)
    return WaveguideModes(v_number=v, num_modes_estimate=num_modes,
                          single_mode=v < math.pi / 2, cutoff_wavelength_nm=cutoff)


def cavity_q_and_finesse(reflectance: float, length_nm: float,
                         wavelength_nm: float, n: float = 1.0) -> dict[str, float]:
    """Fabry-Perot finesse and Q-factor for a two-mirror cavity."""
    R = reflectance
    if not (0.0 < R < 1.0):
        raise ValueError("reflectance must be in (0,1)")
    finesse = math.pi * math.sqrt(R) / (1 - R)
    fsr_nm = wavelength_nm**2 / (2 * n * length_nm)
    linewidth_nm = fsr_nm / finesse
    q = wavelength_nm / linewidth_nm
    return {"finesse": round(finesse, 2), "fsr_nm": round(fsr_nm, 4),
            "linewidth_nm": round(linewidth_nm, 5), "Q": round(q, 1)}


def group_index(material: str, wavelength_nm: float, delta_nm: float = 1.0) -> float:
    """Group index n_g = n - lambda dn/dlambda via finite differences."""
    n0 = sellmeier_index(material, wavelength_nm)
    n_plus = sellmeier_index(material, wavelength_nm + delta_nm)
    n_minus = sellmeier_index(material, wavelength_nm - delta_nm)
    dn_dlam = (n_plus - n_minus) / (2 * delta_nm)
    return n0 - wavelength_nm * dn_dlam
