import pytest

from eccl.core import have_rdkit, Molecule
from eccl.critics import CriticsGate, Harshness, Severity
from eccl.evolve import EvolutionConfig, MolecularEvolver, WeightedObjective, fitness

rdkit_only = pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")


# ---- critics ----
def test_gate_accepts_aspirin():
    v = CriticsGate(Harshness.HARSH).review_molecule(
        Molecule.from_smiles("CC(=O)Oc1ccccc1C(=O)O"))
    assert v.accepted


def test_gate_rejects_tiny_molecule_harsh():
    v = CriticsGate(Harshness.HARSH).review_molecule(Molecule.from_smiles("C"))
    assert not v.accepted


def test_gate_rejects_disconnected():
    v = CriticsGate(Harshness.HARSH).review_molecule(Molecule.from_smiles("CCO.O"))
    assert not v.accepted
    assert any(c.critic == "connectivity" and c.severity >= Severity.MAJOR
               for c in v.critiques)


def test_harshness_monotonicity():
    mol = Molecule.from_smiles("O=[N+]([O-])c1ccccc1")  # nitrobenzene (alert)
    lenient = CriticsGate(Harshness.LENIENT).review_molecule(mol).accepted
    harsh = CriticsGate(Harshness.HARSH).review_molecule(mol).accepted
    assert lenient and not harsh


def test_gate_screen_batch():
    res = CriticsGate(Harshness.HARSH).screen(["CCO", "CC(=O)Oc1ccccc1C(=O)O"])
    assert "CC(=O)Oc1ccccc1C(=O)O" in res["accepted"]
    assert 0.0 <= res["pass_rate"] <= 1.0


# ---- evolution ----
@rdkit_only
def test_evolution_improves_fitness():
    obj = WeightedObjective({
        "druglike": (1.0, fitness.druglikeness()),
        "mw": (0.5, fitness.target_property("mol_weight", 250, 40)),
    })
    ev = MolecularEvolver(obj, EvolutionConfig(population_size=20, generations=8,
                                               random_seed=1))
    res = ev.run()
    assert res.history[-1]["best"] >= res.history[0]["best"]
    assert res.best.fitness > 0.5


@rdkit_only
def test_evolution_with_gate_produces_connected_molecules():
    obj = fitness.druglikeness()
    gate = CriticsGate(Harshness.HARSH).as_evolver_gate()
    ev = MolecularEvolver(obj, EvolutionConfig(population_size=20, generations=6,
                                               random_seed=3), gate=gate)
    res = ev.run()
    assert "." not in res.best.genome.smiles


@rdkit_only
def test_target_property_objective():
    obj = fitness.target_property("mol_weight", 180, 5)
    from eccl.evolve import MoleculeGenome
    asp = MoleculeGenome("CC(=O)Oc1ccccc1C(=O)O")  # MW ~180
    assert obj(asp) > 0.9
