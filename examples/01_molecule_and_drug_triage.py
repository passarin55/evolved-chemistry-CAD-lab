"""Example 1 — analyse a molecule and run drug-likeness triage.

    python examples/01_molecule_and_drug_triage.py
"""
from eccl.core import Molecule
from eccl.chem import assess, compute_descriptors
from eccl.critics import CriticsGate, Harshness

MOLECULES = {
    "aspirin": "CC(=O)Oc1ccccc1C(=O)O",
    "caffeine": "Cn1cnc2c1c(=O)n(C)c(=O)n2C",
    "ibuprofen": "CC(C)Cc1ccc(C(C)C(=O)O)cc1",
    "penicillin G": "CC1(C)SC2C(NC(=O)Cc3ccccc3)C(=O)N2C1C(=O)O",
}


def main() -> None:
    gate = CriticsGate(Harshness.HARSH)
    for name, smi in MOLECULES.items():
        mol = Molecule.from_smiles(smi, name=name)
        d = compute_descriptors(mol)
        rep = assess(mol)
        verdict = gate.review_molecule(mol)
        print(f"\n== {name} ({mol.formula}, MW {mol.molar_mass:.1f}) ==")
        print(f"  logP={d.logp}  TPSA={d.tpsa}  HBD={d.h_donors}  HBA={d.h_acceptors}")
        print(f"  QED-like={rep.qed_like}  SA-proxy={rep.sa_proxy}  alerts={rep.alerts}")
        print(f"  rules passed: {rep.rules_passed}/{len(rep.rules)}")
        print(f"  HARSH gate: {'ACCEPT' if verdict.accepted else 'REJECT'} "
              f"(score {verdict.score}) -> {verdict.reasons[0]}")


if __name__ == "__main__":
    main()
