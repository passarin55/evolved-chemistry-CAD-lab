"""Example 3 — evolve drug-like molecules under the harsh critics gate.

    python examples/03_evolve_under_critics_gate.py
"""
from eccl.evolve import EvolutionConfig, MolecularEvolver, WeightedObjective, fitness
from eccl.critics import CriticsGate, Harshness
from eccl.core import Molecule
from eccl.chem import compute_descriptors


def main() -> None:
    objective = WeightedObjective({
        "druglike": (1.0, fitness.druglikeness()),
        "mw_target_320": (0.6, fitness.target_property("mol_weight", 320, 50)),
        "synthesizable": (0.5, fitness.synthesizability()),
        "novel": (0.4, fitness.novelty_against(["c1ccccc1", "CCO", "CC(=O)O"])),
    })

    gate = CriticsGate(Harshness.HARSH).as_evolver_gate()
    cfg = EvolutionConfig(population_size=40, generations=20, random_seed=2024,
                          patience=8)
    evolver = MolecularEvolver(objective, cfg, gate=gate)

    def report(gen, pop):
        if gen % 4 == 0 or gen == 1:
            print(f"  gen {gen:2d}: best={pop[0].fitness:.3f}  "
                  f"unique={len({i.genome.smiles for i in pop})}")

    print("Evolving under HARSH critics gate...")
    result = evolver.run(on_generation=report)

    print(f"\nTotal fitness evaluations: {result.evaluations}")
    print("\nHall of fame:")
    for i, ind in enumerate(result.hall_of_fame[:5], 1):
        mol = Molecule.from_smiles(ind.genome.smiles)
        d = compute_descriptors(mol)
        print(f"  {i}. {ind.genome.smiles}")
        print(f"     fitness={ind.fitness:.3f}  MW={d.mol_weight:.0f}  "
              f"logP={d.logp}  rings={d.rings}")
        print(f"     objective breakdown: {objective.breakdown(ind.genome)}")


if __name__ == "__main__":
    main()
