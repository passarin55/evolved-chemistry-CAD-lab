"""Spectroscopy: simulate and interpret IR, Raman, NMR, UV-Vis, MS, XRD."""
from __future__ import annotations

from . import tables
from .interpret import (
    Assignment,
    Interpretation,
    cross_validate,
    interpret_mass_spectrum,
    interpret_peaks,
)
from .simulate import (
    Spectrum,
    estimate_uvvis_lambda_max,
    simulate_ir,
    simulate_powder_xrd,
)

__all__ = [
    "tables",
    "Assignment",
    "Interpretation",
    "interpret_peaks",
    "interpret_mass_spectrum",
    "cross_validate",
    "Spectrum",
    "simulate_ir",
    "estimate_uvvis_lambda_max",
    "simulate_powder_xrd",
]
