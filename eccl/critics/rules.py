"""Deterministic critic rules.

Each critic looks at a candidate from one angle and returns a :class:`Critique`
with a severity. The gate aggregates them. Critics are intentionally *harsh*:
their thresholds reject marginal candidates by default, because the whole point
of the gate is to keep the evolutionary search honest.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable

from ..chem import druglike
from ..core.molecule import Molecule


class Severity(IntEnum):
    OK = 0
    NOTE = 1       # minor, informational
    CONCERN = 2    # should be looked at
    MAJOR = 3      # likely disqualifying
    FATAL = 4      # hard reject


@dataclass
class Critique:
    critic: str
    severity: Severity
    message: str
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.severity <= Severity.NOTE

    def as_dict(self) -> dict[str, Any]:
        return {"critic": self.critic, "severity": int(self.severity),
                "severity_name": self.severity.name, "message": self.message,
                "passed": self.passed, "evidence": self.evidence}


# A molecular critic takes a Molecule and returns a Critique.
MolCritic = Callable[[Molecule], Critique]


def validity_critic(mol: Molecule) -> Critique:
    if mol.has_structure():
        return Critique("validity", Severity.OK, "parses to a valid structure")
    try:
        _ = mol.formula_counts
        return Critique("validity", Severity.NOTE,
                        "no 3-D/graph structure; only composition available")
    except Exception as e:
        return Critique("validity", Severity.FATAL, f"invalid molecule: {e}")


def connectivity_critic(mol: Molecule) -> Critique:
    """Reject disconnected structures (salts / mixtures / stray fragments).

    A single covalently-connected component is expected for a lead molecule;
    the evolutionary operators can occasionally emit multi-fragment SMILES.
    """
    smi = mol.smiles or ""
    if not mol.has_structure():
        # fall back to a textual check on the SMILES
        n = smi.count(".") + 1 if smi else 1
        if n > 1:
            return Critique("connectivity", Severity.MAJOR,
                            f"{n} disconnected components", {"components": n})
        return Critique("connectivity", Severity.OK, "single component")
    try:
        from rdkit import Chem

        frags = Chem.GetMolFrags(mol.rdmol)
        n = len(frags)
    except Exception:
        n = smi.count(".") + 1 if smi else 1
    if n > 1:
        return Critique("connectivity", Severity.MAJOR,
                        f"{n} disconnected components (salt/mixture)",
                        {"components": n})
    return Critique("connectivity", Severity.OK, "single connected component")


def druglikeness_critic(mol: Molecule, min_qed: float = 0.5,
                        max_rule_violations: int = 1) -> Critique:
    try:
        rep = druglike.assess(mol)
    except Exception as e:
        return Critique("druglikeness", Severity.CONCERN,
                        f"could not assess drug-likeness: {e}")
    failed_rules = [r.name for r in rep.rules if not r.passed]
    ev = {"qed_like": rep.qed_like, "failed_rules": failed_rules,
          "sa_proxy": rep.sa_proxy}
    if rep.qed_like < min_qed * 0.6:
        return Critique("druglikeness", Severity.MAJOR,
                        f"QED-like {rep.qed_like} well below target {min_qed}", ev)
    if rep.qed_like < min_qed or len(failed_rules) > max_rule_violations:
        return Critique("druglikeness", Severity.CONCERN,
                        f"borderline: QED-like {rep.qed_like}, "
                        f"{len(failed_rules)} rule failures", ev)
    return Critique("druglikeness", Severity.OK,
                    f"drug-like (QED-like {rep.qed_like})", ev)


def safety_critic(mol: Molecule, max_alerts: int = 0) -> Critique:
    """Flags structural-alert groups (reactive/unstable/toxicophore hints).

    This is a *triage heuristic*, not a safety determination.
    """
    try:
        alerts = druglike.structural_alerts(mol)
    except Exception as e:
        return Critique("safety", Severity.CONCERN, f"could not screen alerts: {e}")
    if not alerts:
        return Critique("safety", Severity.OK, "no structural alerts fired")
    sev = Severity.MAJOR if len(alerts) > max_alerts + 1 else Severity.CONCERN
    return Critique("safety", sev,
                    f"{len(alerts)} structural alert(s): {', '.join(alerts)}",
                    {"alerts": alerts})


def synthesizability_critic(mol: Molecule, max_sa: float = 6.0) -> Critique:
    try:
        d = druglike.compute_descriptors(mol)
        sa = druglike.synthetic_accessibility_proxy(d)
    except Exception as e:
        return Critique("synthesizability", Severity.CONCERN,
                        f"could not estimate synthesizability: {e}")
    ev = {"sa_proxy": sa, "rings": d.rings, "heavy_atoms": d.heavy_atoms}
    if sa > max_sa + 1.5:
        return Critique("synthesizability", Severity.MAJOR,
                        f"very hard to synthesise (SA {sa})", ev)
    if sa > max_sa:
        return Critique("synthesizability", Severity.CONCERN,
                        f"challenging synthesis (SA {sa})", ev)
    return Critique("synthesizability", Severity.OK, f"reasonable synthesis (SA {sa})", ev)


def size_sanity_critic(mol: Molecule, min_heavy: int = 4,
                       max_heavy: int = 70) -> Critique:
    try:
        d = druglike.compute_descriptors(mol)
        heavy = d.heavy_atoms
    except Exception:
        try:
            heavy = mol.num_atoms(include_h=False)
        except Exception as e:
            return Critique("size", Severity.CONCERN, f"unknown size: {e}")
    if heavy < min_heavy:
        return Critique("size", Severity.MAJOR, f"too small ({heavy} heavy atoms)",
                        {"heavy_atoms": heavy})
    if heavy > max_heavy:
        return Critique("size", Severity.CONCERN, f"too large ({heavy} heavy atoms)",
                        {"heavy_atoms": heavy})
    return Critique("size", Severity.OK, f"{heavy} heavy atoms", {"heavy_atoms": heavy})


def default_mol_critics() -> list[MolCritic]:
    return [
        validity_critic,
        connectivity_critic,
        size_sanity_critic,
        druglikeness_critic,
        safety_critic,
        synthesizability_critic,
    ]
