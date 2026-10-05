"""Drug-likeness filters and a lightweight synthetic-accessibility proxy.

Implements the classic medicinal-chemistry rule sets (Lipinski Ro5, Veber,
Ghose, Egan) plus a few structural alerts (PAINS-lite / toxicophore hints).
These are *heuristics for triage*, not safety or efficacy claims.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core.molecule import Molecule, MoleculeError, have_rdkit
from .descriptors import DescriptorSet, compute_descriptors

if have_rdkit():  # pragma: no cover
    from rdkit import Chem


@dataclass
class RuleResult:
    name: str
    passed: bool
    violations: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "violations": self.violations}


def lipinski_ro5(d: DescriptorSet) -> RuleResult:
    """Lipinski's rule of five: oral bioavailability triage."""
    v = []
    if d.mol_weight > 500:
        v.append(f"MW {d.mol_weight} > 500")
    if d.logp > 5:
        v.append(f"logP {d.logp} > 5")
    if d.h_donors > 5:
        v.append(f"HBD {d.h_donors} > 5")
    if d.h_acceptors > 10:
        v.append(f"HBA {d.h_acceptors} > 10")
    # Ro5 traditionally tolerates one violation.
    return RuleResult("Lipinski Ro5", len(v) <= 1, v)


def veber(d: DescriptorSet) -> RuleResult:
    v = []
    if d.rotatable_bonds > 10:
        v.append(f"rotatable bonds {d.rotatable_bonds} > 10")
    if d.tpsa > 140:
        v.append(f"TPSA {d.tpsa} > 140")
    return RuleResult("Veber", not v, v)


def ghose(d: DescriptorSet) -> RuleResult:
    v = []
    if not (160 <= d.mol_weight <= 480):
        v.append(f"MW {d.mol_weight} outside [160, 480]")
    if not (-0.4 <= d.logp <= 5.6):
        v.append(f"logP {d.logp} outside [-0.4, 5.6]")
    if not (20 <= d.heavy_atoms <= 70):
        v.append(f"heavy atoms {d.heavy_atoms} outside [20, 70]")
    return RuleResult("Ghose", not v, v)


def egan(d: DescriptorSet) -> RuleResult:
    v = []
    if d.tpsa > 131.6:
        v.append(f"TPSA {d.tpsa} > 131.6")
    if d.logp > 5.88:
        v.append(f"logP {d.logp} > 5.88")
    return RuleResult("Egan", not v, v)


# A small set of structural alerts (SMARTS). Intentionally conservative.
_ALERTS: list[tuple[str, str]] = [
    ("nitro_aromatic", "[a][N+](=O)[O-]"),
    ("aldehyde", "[CX3H1](=O)[#6]"),
    ("michael_acceptor", "[CX3]=[CX3][CX3]=O"),
    ("epoxide", "C1OC1"),
    ("thiol", "[#6][SX2H]"),
    ("acyl_halide", "[CX3](=O)[F,Cl,Br,I]"),
    ("azide", "[N-]=[N+]=N"),
    ("isocyanate", "N=C=O"),
    ("peroxide", "[OX2][OX2]"),
    ("hydrazine", "[NX3][NX3]"),
]


def structural_alerts(mol: Molecule) -> list[str]:
    """Return names of fired structural alerts (possible liabilities)."""
    if not have_rdkit():
        raise MoleculeError("structural alerts require RDKit")
    rd = mol.rdmol
    fired = []
    for name, smarts in _ALERTS:
        patt = Chem.MolFromSmarts(smarts)
        if patt is not None and rd.HasSubstructMatch(patt):
            fired.append(name)
    return fired


def synthetic_accessibility_proxy(d: DescriptorSet) -> float:
    """A rough 1 (easy) .. 10 (hard) synthetic-accessibility proxy.

    Not Ertl's SAscore (which needs a fragment database); this is a transparent
    penalty model from size, ring complexity and saturation so the evolutionary
    engine has a differentiable-ish synthesizability pressure offline.
    """
    score = 1.0
    score += max(0.0, (d.heavy_atoms - 15) * 0.08)
    score += d.rings * 0.35
    score += max(0.0, d.rotatable_bonds - 6) * 0.1
    score += (1.0 - d.fraction_csp3) * 0.8  # flat aromatic systems => a bit easier
    score += max(0.0, d.num_heteroatoms - 6) * 0.1
    return round(min(10.0, max(1.0, score)), 2)


def qed_like(d: DescriptorSet) -> float:
    """A 0..1 desirability score blending desirable property windows.

    A transparent stand-in for RDKit's QED (whose ADS weights are not bundled
    here); higher is more 'drug-like'. Uses smooth triangular desirabilities.
    """
    def tri(x: float, lo: float, best_lo: float, best_hi: float, hi: float) -> float:
        if x <= lo or x >= hi:
            return 0.0
        if best_lo <= x <= best_hi:
            return 1.0
        if x < best_lo:
            return (x - lo) / (best_lo - lo)
        return (hi - x) / (hi - best_hi)

    parts = [
        tri(d.mol_weight, 150, 250, 400, 550),
        tri(d.logp, -1.5, 1.0, 3.0, 5.5),
        tri(d.tpsa, 10, 40, 100, 150),
        tri(d.h_donors, -0.5, 0, 3, 6),
        tri(d.h_acceptors, -0.5, 1, 7, 11),
        tri(d.rotatable_bonds, -0.5, 0, 7, 11),
        tri(d.aromatic_rings, -0.5, 0, 3, 5),
    ]
    return round(sum(parts) / len(parts), 3)


@dataclass
class DrugLikeReport:
    descriptors: DescriptorSet
    rules: list[RuleResult]
    alerts: list[str]
    sa_proxy: float
    qed_like: float

    @property
    def rules_passed(self) -> int:
        return sum(1 for r in self.rules if r.passed)

    def as_dict(self) -> dict[str, Any]:
        return {
            "descriptors": self.descriptors.as_dict(),
            "rules": [r.as_dict() for r in self.rules],
            "alerts": self.alerts,
            "sa_proxy": self.sa_proxy,
            "qed_like": self.qed_like,
            "rules_passed": self.rules_passed,
        }


def assess(mol: Molecule) -> DrugLikeReport:
    """Full drug-likeness triage for one molecule."""
    d = compute_descriptors(mol)
    rules = [lipinski_ro5(d), veber(d), ghose(d), egan(d)]
    return DrugLikeReport(
        descriptors=d,
        rules=rules,
        alerts=structural_alerts(mol),
        sa_proxy=synthetic_accessibility_proxy(d),
        qed_like=qed_like(d),
    )
