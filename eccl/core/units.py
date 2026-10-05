"""Physical constants and unit conversions used across the lab.

All constants are in SI unless the name says otherwise. We keep a single
source of truth here so that every physics module (semiconductor, photonics,
plasmonics, quantum, spectroscopy) agrees on the numbers.
"""
from __future__ import annotations

import math

# --- Fundamental constants (CODATA-ish, good to ~6 sig figs) ---
H = 6.62607015e-34          # Planck constant, J*s
HBAR = H / (2.0 * math.pi)  # reduced Planck, J*s
C = 2.99792458e8            # speed of light, m/s
E_CHARGE = 1.602176634e-19  # elementary charge, C
K_B = 1.380649e-23          # Boltzmann constant, J/K
EPS0 = 8.8541878128e-12     # vacuum permittivity, F/m
MU0 = 1.25663706212e-6      # vacuum permeability, N/A^2
M_E = 9.1093837015e-31      # electron rest mass, kg
N_A = 6.02214076e23         # Avogadro, 1/mol
R_GAS = 8.314462618         # gas constant, J/(mol*K)

# --- Handy derived values ---
EV = E_CHARGE               # 1 eV in Joules
ROOM_T = 298.15             # K
KT_ROOM_EV = K_B * ROOM_T / EV  # ~0.0257 eV


def ev_to_joule(ev: float) -> float:
    return ev * EV


def joule_to_ev(j: float) -> float:
    return j / EV


def ev_to_nm(ev: float) -> float:
    """Photon energy (eV) -> wavelength (nm). E = hc/lambda."""
    if ev <= 0:
        raise ValueError("photon energy must be positive")
    return (H * C) / (ev * EV) * 1e9


def nm_to_ev(nm: float) -> float:
    """Wavelength (nm) -> photon energy (eV)."""
    if nm <= 0:
        raise ValueError("wavelength must be positive")
    return (H * C) / (nm * 1e-9) / EV


def nm_to_wavenumber(nm: float) -> float:
    """Wavelength (nm) -> wavenumber (cm^-1), the IR/Raman unit."""
    if nm <= 0:
        raise ValueError("wavelength must be positive")
    return 1.0e7 / nm


def wavenumber_to_nm(cm_inv: float) -> float:
    """Wavenumber (cm^-1) -> wavelength (nm)."""
    if cm_inv <= 0:
        raise ValueError("wavenumber must be positive")
    return 1.0e7 / cm_inv


def wavenumber_to_ev(cm_inv: float) -> float:
    """Wavenumber (cm^-1) -> energy (eV)."""
    return nm_to_ev(wavenumber_to_nm(cm_inv))


def thermal_voltage(temperature_k: float = ROOM_T) -> float:
    """kT/q in volts."""
    return K_B * temperature_k / E_CHARGE


def celsius_to_kelvin(c: float) -> float:
    return c + 273.15


def kelvin_to_celsius(k: float) -> float:
    return k - 273.15
