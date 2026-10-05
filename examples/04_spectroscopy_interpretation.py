"""Example 4 — simulate and interpret spectra (IR / NMR / MS / XRD).

    python examples/04_spectroscopy_interpretation.py
"""
from eccl.core import Molecule
from eccl import spectro
from eccl.materials import crystal


def main() -> None:
    print("== Forward-simulate aspirin IR, then interpret the peaks ==")
    asp = Molecule.from_smiles("CC(=O)Oc1ccccc1C(=O)O", name="aspirin")
    sp = spectro.simulate_ir(asp)
    print(f"  simulated IR peaks (cm^-1): {sp.peaks}")
    interp = spectro.interpret_peaks(sp.peaks, "IR")
    print(f"  recovered functional groups: {interp.functional_groups}")

    print("\n== Interpret an unknown's IR + 1H NMR + MS jointly ==")
    ir = spectro.interpret_peaks([3000, 1715, 1250, 940], "IR")
    nmr = spectro.interpret_peaks([1.2, 2.1, 7.3, 11.6], "1H")
    print(f"  IR groups : {ir.functional_groups}")
    print(f"  NMR groups: {nmr.functional_groups}")
    cv = spectro.cross_validate([ir, nmr])
    print(f"  corroborated across modalities: {cv['corroborated_groups']}")

    ms = spectro.interpret_mass_spectrum(122, [105, 77, 51])  # benzoic-acid-like
    print(f"  MS: {ms['summary']}")

    print("\n== UV-Vis estimate by conjugation length ==")
    for name, smi in [("ethylene", "C=C"), ("butadiene", "C=CC=C"),
                      ("beta-carotene-like", "C=CC=CC=CC=CC=CC=CC=C")]:
        uv = spectro.estimate_uvvis_lambda_max(Molecule.from_smiles(smi))
        print(f"  {name:20s} lambda_max ~ {uv['lambda_max_nm']} nm "
              f"({uv['conjugated_bonds']} conjugated bonds)")

    print("\n== Powder XRD of silicon (Cu K-alpha) ==")
    xrd = spectro.simulate_powder_xrd(crystal.diamond_silicon())
    for refl in xrd["reflections"][:4]:
        print(f"  {refl['hkl']}  2theta={refl['two_theta']:.2f}  d={refl['d_spacing']} A")


if __name__ == "__main__":
    main()
