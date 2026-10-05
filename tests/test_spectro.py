import pytest

from eccl.core import have_rdkit, Molecule
from eccl import spectro
from eccl.materials import crystal

rdkit_only = pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")


def test_interpret_carbonyl():
    it = spectro.interpret_peaks([1715], "IR")
    groups = " ".join(it.functional_groups)
    assert "carbonyl" in groups or "ketone" in groups


def test_interpret_nmr_aromatic():
    it = spectro.interpret_peaks([7.3], "1H")
    assert "aromatic" in it.functional_groups


def test_mass_spectrum_losses():
    ms = spectro.interpret_mass_spectrum(60, [45, 43, 15])
    labels = [l["assignment"] for l in ms["losses"]]
    assert any("CH3" in x for x in labels)
    assert any("COOH" in x or "OC2H5" in x for x in labels)


def test_cross_validate_corroboration():
    ir = spectro.interpret_peaks([1715, 3000], "IR")
    nmr = spectro.interpret_peaks([11.5], "1H")
    cv = spectro.cross_validate([ir, nmr])
    assert "carboxylic acid" in cv["corroborated_groups"]


def test_xrd_silicon_peaks():
    xrd = spectro.simulate_powder_xrd(crystal.diamond_silicon())
    first = xrd["peaks_2theta"][0]
    assert first == pytest.approx(28.44, abs=0.3)  # Si (111)


@rdkit_only
def test_simulate_ir_detects_carbonyl():
    asp = Molecule.from_smiles("CC(=O)Oc1ccccc1C(=O)O")
    sp = spectro.simulate_ir(asp)
    assert any(1700 <= p <= 1780 for p in sp.peaks)


@rdkit_only
def test_uvvis_conjugation_redshift():
    short = spectro.estimate_uvvis_lambda_max(Molecule.from_smiles("C=C"))
    long = spectro.estimate_uvvis_lambda_max(Molecule.from_smiles("C=CC=CC=CC=C"))
    assert long["lambda_max_nm"] > short["lambda_max_nm"]
