"""The harsh critics gate.

Runs a panel of critics against a candidate and issues an accept/reject verdict
under a configurable *harshness*. An optional LLM 'devil's advocate' critic can
be plugged in; its textual critique is parsed for a severity but the gate never
*weakens* a rule-based rejection on the strength of an LLM opinion — the gate
only gets stricter, never more lenient, from adding the LLM. This is deliberate:
the whole point is a skeptical filter the search cannot talk its way past.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Optional

from ..core.molecule import Molecule
from ..evolve.genome import MoleculeGenome
from ..llm.base import LLMClient
from ..llm.manager import complete
from . import rules
from .rules import Critique, MolCritic, Severity


class Harshness(IntEnum):
    LENIENT = 0     # reject only on FATAL
    NORMAL = 1      # reject on MAJOR or worse
    HARSH = 2       # reject on CONCERN or worse (default)
    BRUTAL = 3      # reject unless every critic is strictly OK


@dataclass
class GateVerdict:
    accepted: bool
    harshness: str
    critiques: list[Critique]
    score: float                 # 0..1 (1 = all critics OK)
    worst_severity: int
    reasons: list[str] = field(default_factory=list)
    llm_note: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "accepted": self.accepted,
            "harshness": self.harshness,
            "score": round(self.score, 3),
            "worst_severity": self.worst_severity,
            "reasons": self.reasons,
            "critiques": [c.as_dict() for c in self.critiques],
            "llm_note": self.llm_note,
        }


_REJECT_THRESHOLD = {
    Harshness.LENIENT: Severity.FATAL,
    Harshness.NORMAL: Severity.MAJOR,
    Harshness.HARSH: Severity.CONCERN,
    Harshness.BRUTAL: Severity.NOTE,  # anything above OK fails
}

_LLM_CRITIC_SYSTEM = (
    "You are a ruthless, senior computational-chemistry reviewer. Given a "
    "candidate molecule and its computed properties, point out the single most "
    "likely reason it would FAIL in practice (stability, synthesizability, "
    "toxicity liability, or physical implausibility). Be specific and skeptical. "
    "End your reply with a line exactly of the form 'SEVERITY: X' where X is one "
    "of OK, NOTE, CONCERN, MAJOR, FATAL."
)


class CriticsGate:
    def __init__(self, harshness: Harshness = Harshness.HARSH,
                 critics: list[MolCritic] | None = None,
                 llm: Optional[LLMClient] = None,
                 use_llm: bool = False) -> None:
        self.harshness = harshness
        self.critics = critics or rules.default_mol_critics()
        self.llm = llm
        self.use_llm = use_llm and llm is not None

    def review_molecule(self, mol: Molecule) -> GateVerdict:
        critiques = [c(mol) for c in self.critics]
        llm_note = None
        if self.use_llm and self.llm is not None:
            llm_crit, llm_note = self._llm_critique(mol)
            if llm_crit is not None:
                critiques.append(llm_crit)

        worst = max((c.severity for c in critiques), default=Severity.OK)
        threshold = _REJECT_THRESHOLD[self.harshness]
        accepted = worst < threshold
        n = len(critiques)
        passed = sum(1 for c in critiques if c.passed)
        score = passed / n if n else 0.0
        reasons = [f"{c.critic}: {c.message}" for c in critiques
                   if c.severity >= threshold]
        if not reasons and accepted:
            reasons = ["all critics within tolerance"]
        return GateVerdict(accepted=accepted, harshness=self.harshness.name,
                           critiques=critiques, score=score,
                           worst_severity=int(worst), reasons=reasons,
                           llm_note=llm_note)

    def _llm_critique(self, mol: Molecule) -> tuple[Critique | None, str | None]:
        try:
            from ..chem import druglike
            rep = druglike.assess(mol)
            prompt = (
                f"SMILES: {mol.canonical_smiles()}\n"
                f"Formula: {mol.formula}  MW: {mol.molar_mass:.1f}\n"
                f"Descriptors: {rep.descriptors.as_dict()}\n"
                f"Structural alerts: {rep.alerts}\n"
                f"SA proxy: {rep.sa_proxy}  QED-like: {rep.qed_like}\n"
                "Give your single most important skeptical critique."
            )
            text = complete(self.llm, prompt, system_prompt=_LLM_CRITIC_SYSTEM,
                            temperature=0.1, max_tokens=300)
            sev = _parse_severity(text)
            return Critique("llm_reviewer", sev, text.strip().splitlines()[0][:200],
                            {"backend": getattr(self.llm, "name", "?")}), text
        except Exception as e:
            return None, f"llm critic unavailable: {e}"

    # ---- integration with the evolutionary engine ----
    def as_evolver_gate(self):
        """Return a callback usable as MolecularEvolver(gate=...)."""
        def gate(genome: MoleculeGenome) -> bool:
            try:
                mol = genome.to_molecule()
            except Exception:
                return False
            return self.review_molecule(mol).accepted
        return gate

    def screen(self, smiles_list: list[str]) -> dict[str, Any]:
        """Screen a batch; return accepted/rejected partition and verdicts."""
        accepted, rejected = [], []
        verdicts = {}
        for smi in smiles_list:
            try:
                mol = Molecule.from_smiles(smi)
            except Exception as e:
                rejected.append(smi)
                verdicts[smi] = {"accepted": False, "error": str(e)}
                continue
            v = self.review_molecule(mol)
            verdicts[smi] = v.as_dict()
            (accepted if v.accepted else rejected).append(smi)
        return {"accepted": accepted, "rejected": rejected,
                "pass_rate": round(len(accepted) / len(smiles_list), 3) if smiles_list else 0.0,
                "verdicts": verdicts}


def _parse_severity(text: str) -> Severity:
    import re

    m = re.search(r"SEVERITY:\s*(OK|NOTE|CONCERN|MAJOR|FATAL)", text, re.IGNORECASE)
    if not m:
        return Severity.NOTE
    return Severity[m.group(1).upper()]
