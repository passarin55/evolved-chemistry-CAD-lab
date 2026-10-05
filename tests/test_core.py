import math

import pytest

from eccl.core import Lattice, Material, Molecule, LabNotebook, have_rdkit
from eccl.core import formula


def test_formula_parsing_nested_and_hydrate():
    assert formula.parse_formula("Fe2(SO4)3") == {"Fe": 2.0, "S": 3.0, "O": 12.0}
    counts = formula.parse_formula("CuSO4.5H2O")
    assert counts["Cu"] == 1.0 and counts["O"] == 9.0 and counts["H"] == 10.0


def test_formula_fractional_stoichiometry():
    counts = formula.parse_formula("WO2.9")
    assert counts["O"] == pytest.approx(2.9)


def test_molar_mass_water():
    assert formula.molar_mass("H2O") == pytest.approx(18.015, abs=0.01)


def test_hill_formula():
    assert formula.hill_formula({"C": 6, "H": 12, "O": 6}) == "C6H12O6"


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_molecule_from_smiles():
    m = Molecule.from_smiles("CC(=O)Oc1ccccc1C(=O)O", name="aspirin")
    assert m.formula == "C9H8O4"
    assert m.molar_mass == pytest.approx(180.16, abs=0.1)
    assert m.inchi_key().startswith("BSYNRYMUTXBXSQ")


def test_molecule_from_formula_without_structure():
    m = Molecule.from_formula("C6H12O6")
    assert m.molar_mass == pytest.approx(180.16, abs=0.1)


def test_material_density_silicon():
    si = Material.from_formula("Si", lattice=Lattice(5.431, 5.431, 5.431),
                               formula_units_per_cell=8)
    assert si.density_g_cm3() == pytest.approx(2.329, abs=0.01)


def test_material_electronegativity_spread():
    nacl = Material.from_formula("NaCl")
    assert nacl.electronegativity_spread() == pytest.approx(3.16 - 0.93, abs=0.01)


def test_notebook_roundtrip(tmp_path):
    nb = LabNotebook("t")
    nb.add_material(Material.from_formula("Si"))
    p = nb.save(tmp_path / "nb.json")
    nb2 = LabNotebook.load(p)
    assert len(nb2) == 1
    assert nb2.all("material")[0].payload["formula"] == "Si"
