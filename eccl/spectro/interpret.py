"""Spectrometer interpretation: turn observed peaks into assignments.

Works for IR, Raman, 1H/13C NMR (peak→functional-group matching) and EI mass
spectra (neutral-loss analysis). The output is a structured, ranked list of
assignments with a transparent confidence score, plus a short natural-language
summary that the LLM layer or critics gate can consume.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import tables
from .tables import Band


@dataclass
class Assignment:
    peak: float
    assignment: str
    group: str
    confidence: float      # 0..1
    band: tuple[float, float]
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"peak": self.peak, "assignment": self.assignment,
                "group": self.group, "confidence": round(self.confidence, 3),
                "window": list(self.band), "note": self.note}


@dataclass
class Interpretation:
    modality: str
    assignments: list[Assignment]
    unassigned: list[float]
    functional_groups: list[str]
    summary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "modality": self.modality,
            "assignments": [a.as_dict() for a in self.assignments],
            "unassigned": self.unassigned,
            "functional_groups": self.functional_groups,
            "summary": self.summary,
        }


def _confidence(peak: float, band: Band, tol: float) -> float:
    """1.0 at band center, decaying to ~0.5 at the edges, lower just outside."""
    c = band.center()
    half = max((band.high - band.low) / 2.0, 1e-9)
    dist = abs(peak - c)
    if dist <= half:
        return 1.0 - 0.5 * (dist / half)
    # within tolerance beyond the edge
    over = dist - half
    return max(0.0, 0.5 - 0.5 * (over / max(tol, 1e-9)))


def interpret_peaks(peaks: list[float], modality: str,
                    tolerance: float | None = None,
                    min_confidence: float = 0.25) -> Interpretation:
    """Match a list of observed peaks to a modality's reference table.

    tolerance: extra window (same units as peaks) allowed outside a band before
    a peak is considered unassigned. Defaults scale with modality.
    """
    bands = tables.tables_for(modality)
    if tolerance is None:
        tolerance = 5.0 if modality.lower() in ("ir", "infrared", "ftir", "raman") else 0.3

    assignments: list[Assignment] = []
    unassigned: list[float] = []
    for pk in peaks:
        candidates: list[Assignment] = []
        for b in bands:
            lo, hi = b.low - tolerance, b.high + tolerance
            if lo <= pk <= hi:
                conf = _confidence(pk, b, tolerance)
                if conf >= min_confidence:
                    candidates.append(
                        Assignment(pk, b.assignment, b.group, conf, (b.low, b.high), b.note)
                    )
        if candidates:
            candidates.sort(key=lambda a: a.confidence, reverse=True)
            assignments.extend(candidates[:3])  # keep up to top-3 overlapping windows
        else:
            unassigned.append(pk)

    groups = sorted({a.group for a in assignments})
    summary = _summarise(modality, assignments, unassigned, groups)
    return Interpretation(modality=modality, assignments=assignments,
                          unassigned=unassigned, functional_groups=groups,
                          summary=summary)


def _summarise(modality: str, assignments: list[Assignment],
               unassigned: list[float], groups: list[str]) -> str:
    if not assignments:
        return f"No {modality.upper()} bands matched the reference tables."
    top = sorted(assignments, key=lambda a: a.confidence, reverse=True)[:5]
    lead = ", ".join(f"{a.peak:g}→{a.assignment}" for a in top)
    g = ", ".join(groups)
    extra = f" {len(unassigned)} peak(s) unassigned." if unassigned else ""
    return (f"{modality.upper()} suggests: {g}. Key bands: {lead}.{extra}")


def interpret_mass_spectrum(molecular_ion: float, fragments: list[float],
                            tolerance: float = 0.5) -> dict[str, Any]:
    """Explain EI-MS fragments as neutral losses from the molecular ion."""
    losses = []
    for f in fragments:
        delta = molecular_ion - f
        if delta <= 0:
            continue
        best = None
        for mass, label in tables.NEUTRAL_LOSSES.items():
            if abs(delta - mass) <= tolerance:
                best = (mass, label)
                break
        losses.append({
            "fragment": f,
            "loss_mass": round(delta, 3),
            "assignment": best[1] if best else "unassigned",
        })
    identified = [l for l in losses if l["assignment"] != "unassigned"]
    summary = (f"M+ = {molecular_ion:g}. "
               f"{len(identified)}/{len(losses)} fragments explained by common losses: "
               + ", ".join(f"-{l['loss_mass']:g} ({l['assignment']})" for l in identified))
    return {"molecular_ion": molecular_ion, "losses": losses, "summary": summary}


def cross_validate(interps: list[Interpretation]) -> dict[str, Any]:
    """Combine evidence across modalities: groups seen in >=2 are 'corroborated'."""
    counts: dict[str, int] = {}
    for it in interps:
        for g in set(it.functional_groups):
            counts[g] = counts.get(g, 0) + 1
    corroborated = sorted(g for g, c in counts.items() if c >= 2)
    all_groups = sorted(counts)
    return {
        "modalities": [it.modality for it in interps],
        "corroborated_groups": corroborated,
        "all_groups": all_groups,
        "evidence_counts": counts,
    }
