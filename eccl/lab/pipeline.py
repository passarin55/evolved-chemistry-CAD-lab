"""Discovery pipelines: compose the lab's stages into one campaign.

A pipeline runs: (optional) deep-search grounding -> evolutionary design under
the critics gate -> post-hoc analysis and spectral forward-simulation of the
winners -> a structured report. Each stage is optional and the whole thing runs
offline.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from ..chem import druglike
from ..core.molecule import Molecule, have_rdkit
from ..evolve.engine import EvolutionConfig
from ..evolve.fitness import Objective, WeightedObjective
from ..spectro import estimate_uvvis_lambda_max, interpret_peaks, simulate_ir
from .workbench import Workbench


@dataclass
class CampaignReport:
    title: str
    grounding: dict[str, Any] | None
    evolution: dict[str, Any]
    winners: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "grounding": self.grounding,
            "evolution": self.evolution,
            "winners": self.winners,
            "notes": self.notes,
        }


class DiscoveryCampaign:
    """A molecular-discovery campaign tying grounding, evolution, and analysis."""

    def __init__(self, workbench: Workbench | None = None) -> None:
        self.wb = workbench or Workbench()

    def run(self, title: str, objective: Objective, *,
            ground_query: str | None = None,
            seeds: list[str] | None = None,
            harshness: str | None = None,
            use_gate: bool = True,
            top_n: int = 3,
            evo_config: EvolutionConfig | None = None) -> CampaignReport:
        notes: list[str] = []

        grounding = None
        if ground_query:
            grounding = self.wb.deep_search(ground_query, synthesise=True)
            if not grounding.get("results"):
                notes.append("deep-search grounding returned no results "
                             "(offline or restricted egress); proceeding without it")

        result = self.wb.evolve_molecules(
            objective, seeds=seeds, use_gate=use_gate,
            harshness=harshness, config=evo_config)
        notes.append(f"evolution did {result.evaluations} fitness evaluations "
                     f"over {len(result.history)} generations")

        winners: list[dict[str, Any]] = []
        for ind in result.hall_of_fame[:top_n]:
            winners.append(self._analyze_winner(ind.genome.smiles, ind.fitness,
                                                objective))

        return CampaignReport(title=title, grounding=grounding,
                              evolution=result.as_dict(), winners=winners, notes=notes)

    def _analyze_winner(self, smiles: str, fitness: float,
                        objective: Objective) -> dict[str, Any]:
        entry: dict[str, Any] = {"smiles": smiles, "fitness": round(fitness, 4)}
        try:
            mol = Molecule.from_smiles(smiles)
        except Exception as e:
            entry["error"] = str(e)
            return entry
        if have_rdkit():
            entry["formula"] = mol.formula
            entry["molar_mass"] = round(mol.molar_mass, 2)
            entry["drug_likeness"] = druglike.assess(mol).as_dict()
            # forward-simulate IR and round-trip interpret it as a sanity demo
            try:
                sp = simulate_ir(mol)
                entry["ir_peaks"] = sp.peaks
                entry["ir_interpretation"] = interpret_peaks(sp.peaks, "IR").functional_groups
                entry["uvvis"] = estimate_uvvis_lambda_max(mol)
            except Exception as e:
                entry["spectra_error"] = str(e)
        entry["gate"] = self.wb.gate().review_molecule(mol).as_dict()
        if isinstance(objective, WeightedObjective):
            from ..evolve.genome import MoleculeGenome
            entry["objective_breakdown"] = objective.breakdown(MoleculeGenome(smiles))
        return entry


def druglike_objective(target_mw: float = 350.0,
                       reference_smiles: str | None = None) -> WeightedObjective:
    """A ready-made multi-objective for drug-like discovery campaigns."""
    from ..evolve import fitness

    terms = {
        "druglike": (1.0, fitness.druglikeness()),
        "mw": (0.5, fitness.target_property("mol_weight", target_mw, 60)),
        "synth": (0.5, fitness.synthesizability()),
    }
    if reference_smiles:
        terms["similarity"] = (0.7, fitness.similarity_to(reference_smiles))
    return WeightedObjective(terms)
