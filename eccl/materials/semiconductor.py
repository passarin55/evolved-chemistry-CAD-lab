"""Semiconductor physics: band gaps, carrier statistics, junctions.

Covers "normal" semiconductors (Si, Ge, GaAs, ...). Models are the standard
textbook ones (Varshni, effective-density-of-states, intrinsic carrier
concentration, built-in potential), good enough for design triage.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from ..core.units import K_B, EV, M_E, H, KT_ROOM_EV, ROOM_T, thermal_voltage
from ..core.units import ev_to_nm

# Reference room-temperature parameters for common semiconductors.
# eg0/alpha/beta are Varshni coefficients (eV, eV/K, K).
@dataclass
class SemiconductorParams:
    name: str
    eg_300k: float            # eV
    eg0: float                # eV at 0 K
    varshni_alpha: float      # eV/K
    varshni_beta: float       # K
    me_eff: float             # electron effective mass / m0
    mh_eff: float             # hole effective mass / m0
    eps_r: float              # static dielectric constant
    direct_gap: bool


LIBRARY: dict[str, SemiconductorParams] = {
    "Si": SemiconductorParams("Si", 1.12, 1.170, 4.73e-4, 636, 1.08, 0.81, 11.7, False),
    "Ge": SemiconductorParams("Ge", 0.66, 0.744, 4.77e-4, 235, 0.55, 0.37, 16.0, False),
    "GaAs": SemiconductorParams("GaAs", 1.42, 1.519, 5.41e-4, 204, 0.067, 0.45, 12.9, True),
    "GaN": SemiconductorParams("GaN", 3.39, 3.470, 9.09e-4, 830, 0.20, 1.40, 8.9, True),
    "InP": SemiconductorParams("InP", 1.34, 1.421, 3.63e-4, 162, 0.08, 0.60, 12.5, True),
    "InAs": SemiconductorParams("InAs", 0.354, 0.415, 2.76e-4, 93, 0.023, 0.41, 15.1, True),
    "GaP": SemiconductorParams("GaP", 2.26, 2.340, 5.77e-4, 372, 0.79, 0.83, 11.1, False),
    "SiC": SemiconductorParams("SiC-4H", 3.26, 3.330, 6.50e-4, 1200, 0.29, 1.00, 9.7, False),
    "CdTe": SemiconductorParams("CdTe", 1.50, 1.606, 3.08e-4, 104, 0.09, 0.40, 10.2, True),
    "ZnO": SemiconductorParams("ZnO", 3.37, 3.440, 5.05e-4, 900, 0.24, 0.59, 8.5, True),
}


def get_params(name: str) -> SemiconductorParams:
    if name not in LIBRARY:
        raise KeyError(f"unknown semiconductor {name!r}; known: {sorted(LIBRARY)}")
    return LIBRARY[name]


def varshni_bandgap(p: SemiconductorParams, temperature_k: float) -> float:
    """Temperature-dependent band gap Eg(T) via the Varshni relation (eV)."""
    T = temperature_k
    return p.eg0 - (p.varshni_alpha * T * T) / (T + p.varshni_beta)


def effective_dos(m_eff_ratio: float, temperature_k: float = ROOM_T) -> float:
    """Effective density of states (cm^-3): Nc or Nv = 2 (2*pi m* kT / h^2)^1.5."""
    m = m_eff_ratio * M_E
    val = 2.0 * (2.0 * math.pi * m * K_B * temperature_k / (H * H)) ** 1.5
    return val * 1e-6  # m^-3 -> cm^-3


def intrinsic_carrier_concentration(name: str, temperature_k: float = ROOM_T) -> float:
    """n_i (cm^-3) = sqrt(Nc Nv) exp(-Eg / 2kT)."""
    p = get_params(name)
    eg = varshni_bandgap(p, temperature_k)
    nc = effective_dos(p.me_eff, temperature_k)
    nv = effective_dos(p.mh_eff, temperature_k)
    kt_ev = K_B * temperature_k / EV
    return math.sqrt(nc * nv) * math.exp(-eg / (2.0 * kt_ev))


@dataclass
class CarrierState:
    n: float    # electron concentration, cm^-3
    p: float    # hole concentration, cm^-3
    n_i: float
    fermi_offset_ev: float  # E_F - E_i (eV), + for n-type

    def as_dict(self) -> dict[str, Any]:
        return {"n": self.n, "p": self.p, "n_i": self.n_i,
                "fermi_offset_ev": round(self.fermi_offset_ev, 4)}


def doped_carriers(name: str, n_donor: float = 0.0, n_acceptor: float = 0.0,
                   temperature_k: float = ROOM_T) -> CarrierState:
    """Equilibrium carriers under full ionisation and charge neutrality.

    Solves n - p = Nd - Na with n*p = n_i^2.
    """
    ni = intrinsic_carrier_concentration(name, temperature_k)
    net = n_donor - n_acceptor
    # n = (net + sqrt(net^2 + 4 ni^2)) / 2
    n = (net + math.sqrt(net * net + 4 * ni * ni)) / 2.0
    p = ni * ni / n if n > 0 else float("inf")
    kt_ev = K_B * temperature_k / EV
    # E_F - E_i = kT ln(n/ni)
    offset = kt_ev * math.log(n / ni) if n > 0 and ni > 0 else 0.0
    return CarrierState(n=n, p=p, n_i=ni, fermi_offset_ev=offset)


def built_in_potential(name: str, n_donor: float, n_acceptor: float,
                       temperature_k: float = ROOM_T) -> float:
    """Built-in potential of a pn junction (volts): Vbi = kT/q ln(Na Nd / ni^2)."""
    ni = intrinsic_carrier_concentration(name, temperature_k)
    if n_donor <= 0 or n_acceptor <= 0:
        raise ValueError("both Na and Nd must be positive for a pn junction")
    return thermal_voltage(temperature_k) * math.log(n_donor * n_acceptor / (ni * ni))


def depletion_width(name: str, n_donor: float, n_acceptor: float,
                    temperature_k: float = ROOM_T, applied_v: float = 0.0) -> float:
    """Total depletion width of an abrupt pn junction (meters)."""
    from ..core.units import EPS0, E_CHARGE

    p = get_params(name)
    vbi = built_in_potential(name, n_donor, n_acceptor, temperature_k)
    v = vbi - applied_v
    na = n_acceptor * 1e6  # cm^-3 -> m^-3
    nd = n_donor * 1e6
    eps = p.eps_r * EPS0
    w2 = (2 * eps * v / E_CHARGE) * (1.0 / na + 1.0 / nd)
    return math.sqrt(max(0.0, w2))


def absorption_edge_nm(name: str, temperature_k: float = ROOM_T) -> float:
    """Longest wavelength (nm) a semiconductor can absorb across its gap."""
    eg = varshni_bandgap(get_params(name), temperature_k)
    return ev_to_nm(eg)


@dataclass
class SolarCellEstimate:
    bandgap_ev: float
    sq_efficiency_pct: float   # Shockley-Queisser detailed-balance limit
    verdict: str

    def as_dict(self) -> dict[str, Any]:
        return {"bandgap_ev": round(self.bandgap_ev, 3),
                "sq_efficiency_pct": round(self.sq_efficiency_pct, 2),
                "verdict": self.verdict}


def shockley_queisser(bandgap_ev: float) -> SolarCellEstimate:
    """Approximate single-junction SQ efficiency vs band gap (AM1.5-ish).

    Uses a smooth analytic fit that peaks ~33% near 1.34 eV. This is a design
    heuristic, not a full detailed-balance integral.
    """
    eg = bandgap_ev
    # Gaussian-ish envelope around the known optimum.
    peak, center, width = 33.7, 1.34, 0.9
    eff = peak * math.exp(-((eg - center) ** 2) / (2 * width * width))
    # Penalise very small gaps harder (thermalisation dominates).
    if eg < 0.9:
        eff *= max(0.0, eg / 0.9)
    if eg < 0.5 or eg > 3.0:
        verdict = "poor single-junction PV absorber"
    elif 1.1 <= eg <= 1.6:
        verdict = "excellent single-junction PV absorber"
    else:
        verdict = "usable PV absorber"
    return SolarCellEstimate(bandgap_ev=eg, sq_efficiency_pct=eff, verdict=verdict)


def classify_by_gap(bandgap_ev: float) -> str:
    """Rough electronic classification from a band gap value."""
    if bandgap_ev <= 0.0:
        return "metal / semimetal"
    if bandgap_ev < 3.0:
        return "semiconductor"
    if bandgap_ev < 4.0:
        return "wide-bandgap semiconductor"
    return "insulator"
