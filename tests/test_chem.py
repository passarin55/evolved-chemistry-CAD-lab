import pytest

from eccl.chem import balance, stoichiometry
from eccl.chem.reactions import BalancedReaction
from eccl.core import have_rdkit, Molecule

rdkit_only = pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")


def test_balance_combustion():
    r = balance(["C3H8", "O2"], ["CO2", "H2O"])
    assert r.equation() == "C3H8 + 5 O2 -> 3 CO2 + 4 H2O"
    assert r.mass_balance_error() == pytest.approx(0.0, abs=1e-6)


def test_balance_redox():
    r = balance(["KMnO4", "HCl"], ["KCl", "MnCl2", "H2O", "Cl2"])
    assert r.mass_balance_error() == pytest.approx(0.0, abs=1e-6)
    coeffs = {f: c for c, f in r.reactants + r.products}
    assert coeffs["KMnO4"] == 2 and coeffs["HCl"] == 16


def test_balance_iron_oxide():
    r = balance(["Fe", "O2"], ["Fe2O3"])
    assert {f: c for c, f in r.reactants + r.products} == {"Fe": 4, "O2": 3, "Fe2O3": 2}


def test_stoichiometry():
    r = balance(["C3H8", "O2"], ["CO2", "H2O"])
    s = stoichiometry(r, "C3H8", 2.0)
    assert s["O2"] == pytest.approx(10.0)
    assert s["CO2"] == pytest.approx(6.0)


@rdkit_only
def test_descriptors_and_druglike():
    from eccl.chem import assess, compute_descriptors

    asp = Molecule.from_smiles("CC(=O)Oc1ccccc1C(=O)O")
    d = compute_descriptors(asp)
    assert d.mol_weight == pytest.approx(180.16, abs=0.1)
    assert d.aromatic_rings == 1
    rep = assess(asp)
    assert 0.0 <= rep.qed_like <= 1.0
    assert rep.rules_passed >= 3


@rdkit_only
def test_similarity_self_is_one():
    from eccl.chem import tanimoto

    a = Molecule.from_smiles("c1ccccc1O")
    assert tanimoto(a, a) == pytest.approx(1.0)


@rdkit_only
def test_similarity_distinct_is_low():
    from eccl.chem import tanimoto

    a = Molecule.from_smiles("CCO")
    b = Molecule.from_smiles("c1ccc2ccccc2c1")
    assert tanimoto(a, b) < 0.3
