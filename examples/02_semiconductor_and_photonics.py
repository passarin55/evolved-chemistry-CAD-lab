"""Example 2 — semiconductor, photonic and plasmonic device triage.

    python examples/02_semiconductor_and_photonics.py
"""
from eccl.materials import photonics, plasmonics, quantum, semiconductor
from eccl.materials.crystal import goldschmidt_tolerance


def main() -> None:
    print("== Photovoltaic absorber screening (Shockley-Queisser) ==")
    for name in ("Si", "GaAs", "CdTe", "GaN"):
        p = semiconductor.get_params(name)
        eg = semiconductor.varshni_bandgap(p, 300)
        sq = semiconductor.shockley_queisser(eg)
        print(f"  {name:5s} Eg={eg:.2f} eV  edge={semiconductor.absorption_edge_nm(name):.0f} nm"
              f"  SQ={sq.sq_efficiency_pct:.1f}%  {sq.verdict}")

    print("\n== Si pn-junction (Na=Nd=1e17 cm^-3) ==")
    vbi = semiconductor.built_in_potential("Si", 1e17, 1e17)
    w = semiconductor.depletion_width("Si", 1e17, 1e17) * 1e9
    print(f"  built-in potential {vbi:.3f} V, depletion width {w:.1f} nm")

    print("\n== Photonics: a 1550 nm single-mode waveguide & DBR mirror ==")
    wg = photonics.slab_waveguide(core_index=3.48, clad_index=1.44,
                                  thickness_nm=220, wavelength_nm=1550)
    print(f"  SOI slab: V={wg.v_number:.2f}  modes~{wg.num_modes_estimate}  "
          f"single-mode={wg.single_mode}")
    R = photonics.dbr_reflectance(2.3, 1.46, 1.0, 1.5, pairs=12)
    print(f"  12-pair TiO2/SiO2 DBR peak reflectance: {R:.4f}")

    print("\n== Plasmonics: gold vs silver nanosphere LSPR (in water) ==")
    for metal in ("Au", "Ag"):
        lspr = plasmonics.lspr_sphere(metal, eps_medium=1.77)
        print(f"  {metal}: LSPR {lspr.resonance_nm:.0f} nm  Q={lspr.quality_factor:.1f}")

    print("\n== Quantum dots: CdTe emission tuning by size ==")
    p = semiconductor.get_params("CdTe")
    for r in (1.5, 2.0, 3.0, 4.0):
        qd = quantum.quantum_dot_shift(p.eg_300k, r, p.me_eff, p.mh_eff, p.eps_r)
        print(f"  r={r} nm -> gap {qd['confined_gap_ev']:.2f} eV, emit {qd['emission_nm']} nm")

    print("\n== Perovskite stability (Goldschmidt tolerance) ==")
    for a, b, x, label in [("Cs+", "Pb2+", "I-", "CsPbI3"),
                           ("MA+", "Pb2+", "I-", "MAPbI3"),
                           ("Sr2+", "Ti4+", "O2-", "SrTiO3")]:
        tf = goldschmidt_tolerance(a, b, x)
        print(f"  {label:8s} t={tf.t:.3f}  {tf.verdict}")


if __name__ == "__main__":
    main()
