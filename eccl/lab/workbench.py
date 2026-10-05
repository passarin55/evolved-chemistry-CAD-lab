"""The Workbench: a single high-level handle over the whole lab.

It wires together the core registry, cheminformatics, materials physics,
spectroscopy, the critics gate, the LLM client, and deep search, so an
application (or the CLI) can do end-to-end work through one object.
"""
from __future__ import annotations

from typing import Any, Optional

from ..chem import druglike
from ..config import DEFAULT, Config
from ..core.material import Material
from ..core.molecule import Molecule, have_rdkit
from ..core.registry import LabNotebook
from ..critics.gate import CriticsGate, Harshness
from ..evolve.engine import EvolutionConfig, EvolutionResult, MolecularEvolver
from ..evolve.fitness import Objective
from ..llm.base import LLMClient
from ..llm.manager import get_client
from ..materials import photonics, plasmonics, quantum, semiconductor
from ..search.deep import DeepSearch


class Workbench:
    def __init__(self, config: Config | None = None,
                 llm: Optional[LLMClient] = None) -> None:
        self.config = config or DEFAULT
        self.notebook = LabNotebook("workbench")
        self._llm = llm

    # ---- lazy LLM ----
    @property
    def llm(self) -> LLMClient:
        if self._llm is None:
            self._llm = get_client(self.config.llm_backend,
                                   base_url=self.config.llm_base_url,
                                   model=self.config.llm_model)
        return self._llm

    def gate(self, harshness: str | None = None, use_llm: bool | None = None) -> CriticsGate:
        h = Harshness[(harshness or self.config.harshness).upper()]
        use = self.config.use_llm_critic if use_llm is None else use_llm
        return CriticsGate(harshness=h, llm=self.llm if use else None, use_llm=use)

    # ---- molecules ----
    def analyze_molecule(self, smiles: str, *, register: bool = True) -> dict[str, Any]:
        mol = Molecule.from_smiles(smiles)
        out: dict[str, Any] = {"smiles": mol.canonical_smiles(),
                               "formula": mol.formula,
                               "molar_mass": round(mol.molar_mass, 3)}
        if have_rdkit():
            out["inchi_key"] = mol.inchi_key()
            out["drug_likeness"] = druglike.assess(mol).as_dict()
        out["gate"] = self.gate().review_molecule(mol).as_dict()
        if register:
            out["record_id"] = self.notebook.add_molecule(mol, tags=["analyzed"])
        return out

    # ---- materials ----
    def analyze_semiconductor(self, name: str, *, temperature_k: float = 300.0,
                              n_donor: float = 0.0, n_acceptor: float = 0.0) -> dict[str, Any]:
        p = semiconductor.get_params(name)
        eg = semiconductor.varshni_bandgap(p, temperature_k)
        out = {
            "name": name,
            "bandgap_eV": round(eg, 4),
            "direct_gap": p.direct_gap,
            "classification": semiconductor.classify_by_gap(eg),
            "intrinsic_carrier_cm3": semiconductor.intrinsic_carrier_concentration(name, temperature_k),
            "absorption_edge_nm": round(semiconductor.absorption_edge_nm(name, temperature_k), 1),
            "shockley_queisser": semiconductor.shockley_queisser(eg).as_dict(),
        }
        if n_donor or n_acceptor:
            out["carriers"] = semiconductor.doped_carriers(
                name, n_donor, n_acceptor, temperature_k).as_dict()
            if n_donor and n_acceptor:
                out["pn_junction"] = {
                    "built_in_potential_V": round(
                        semiconductor.built_in_potential(name, n_donor, n_acceptor, temperature_k), 4),
                    "depletion_width_nm": round(
                        semiconductor.depletion_width(name, n_donor, n_acceptor, temperature_k) * 1e9, 2),
                }
        return out

    def analyze_plasmonic_sphere(self, metal: str, radius_nm: float,
                                 medium_eps: float = 1.77) -> dict[str, Any]:
        lspr = plasmonics.lspr_sphere(metal, eps_medium=medium_eps)
        mie = plasmonics.mie_dipole_cross_sections(metal, radius_nm,
                                                   lspr.resonance_ev, medium_eps)
        return {"metal": metal, "radius_nm": radius_nm, "medium_eps": medium_eps,
                "lspr": lspr.as_dict(), "mie_at_resonance": mie}

    def analyze_quantum_dot(self, semiconductor_name: str, radius_nm: float) -> dict[str, Any]:
        p = semiconductor.get_params(semiconductor_name)
        return quantum.quantum_dot_shift(p.eg_300k, radius_nm, p.me_eff, p.mh_eff, p.eps_r)

    # ---- evolution ----
    def evolve_molecules(self, objective: Objective, *,
                         seeds: list[str] | None = None,
                         use_gate: bool = True,
                         harshness: str | None = None,
                         config: EvolutionConfig | None = None) -> EvolutionResult:
        cfg = config or EvolutionConfig(
            population_size=self.config.population_size,
            generations=self.config.generations,
            random_seed=self.config.random_seed,
        )
        gate_cb = self.gate(harshness).as_evolver_gate() if use_gate else None
        evolver = MolecularEvolver(objective, cfg, gate=gate_cb)
        result = evolver.run(seeds=seeds)
        self.notebook.add_run({"type": "evolution", "best": result.best.as_dict(),
                               "history": result.history}, tags=["evolution"])
        return result

    # ---- deep search ----
    def deep_search(self, query: str, **kw: Any) -> dict[str, Any]:
        ds = DeepSearch(llm=self.llm)
        return ds.run(query, **kw).as_dict()

    # ---- persistence ----
    def save(self, path: str) -> str:
        return str(self.notebook.save(path))
