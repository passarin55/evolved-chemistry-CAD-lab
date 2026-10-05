import pytest

from eccl.materials import crystal, photonics, plasmonics, quantum, semiconductor


# ---- semiconductor ----
def test_silicon_bandgap_300k():
    eg = semiconductor.varshni_bandgap(semiconductor.get_params("Si"), 300)
    assert eg == pytest.approx(1.12, abs=0.02)


def test_bandgap_decreases_with_temperature():
    p = semiconductor.get_params("Si")
    assert semiconductor.varshni_bandgap(p, 400) < semiconductor.varshni_bandgap(p, 200)


def test_gaas_absorption_edge():
    assert semiconductor.absorption_edge_nm("GaAs", 300) == pytest.approx(871, abs=10)


def test_pn_built_in_potential_positive():
    vbi = semiconductor.built_in_potential("Si", 1e17, 1e17)
    assert 0.5 < vbi < 1.0


def test_shockley_queisser_peak():
    best = semiconductor.shockley_queisser(1.34)
    assert best.sq_efficiency_pct > 33
    worse = semiconductor.shockley_queisser(0.3)
    assert worse.sq_efficiency_pct < best.sq_efficiency_pct


def test_classify_by_gap():
    assert semiconductor.classify_by_gap(0.0) == "metal / semimetal"
    assert semiconductor.classify_by_gap(1.1) == "semiconductor"
    assert semiconductor.classify_by_gap(5.0) == "insulator"


# ---- photonics ----
def test_sellmeier_fused_silica():
    n = photonics.sellmeier_index("SiO2", 589)
    assert n == pytest.approx(1.458, abs=0.005)


def test_brewster_angle():
    assert photonics.brewster_angle(1.0, 1.5) == pytest.approx(56.31, abs=0.1)


def test_total_internal_reflection_critical_angle():
    assert photonics.critical_angle(1.5, 1.0) == pytest.approx(41.8, abs=0.3)
    assert photonics.critical_angle(1.0, 1.5) is None


def test_fresnel_normal_incidence():
    assert photonics.fresnel(1.0, 1.5).R_unpolarised == pytest.approx(0.04, abs=0.005)


def test_waveguide_single_mode():
    wg = photonics.slab_waveguide(1.5, 1.45, 300, 1550)
    assert isinstance(wg.single_mode, bool)


# ---- plasmonics ----
def test_drude_epsilon_negative_real_below_plasma():
    eps = plasmonics.drude_epsilon("Au", 2.0)
    assert eps.real < 0  # metallic response


def test_gold_lspr_visible():
    lspr = plasmonics.lspr_sphere("Au", eps_medium=1.0)
    assert 1.8 < lspr.resonance_ev < 3.0  # visible range


def test_silver_sharper_than_gold():
    ag = plasmonics.lspr_sphere("Ag")
    au = plasmonics.lspr_sphere("Au")
    assert ag.quality_factor > au.quality_factor  # Ag has lower damping


# ---- quantum ----
def test_graphene_is_dirac_semimetal():
    g = quantum.graphene_bands()
    assert g["is_dirac_semimetal"] is True
    assert g["min_direct_gap"] == pytest.approx(0.0, abs=1e-3)


def test_quantum_well_levels_increase():
    qw = quantum.infinite_well(5.0, 0.067)
    assert qw.levels_ev[1] == pytest.approx(4 * qw.levels_ev[0], rel=1e-3)


def test_quantum_dot_blue_shift():
    small = quantum.quantum_dot_shift(1.74, 1.5, 0.13, 0.45, 10.2)
    large = quantum.quantum_dot_shift(1.74, 4.0, 0.13, 0.45, 10.2)
    assert small["confined_gap_ev"] > large["confined_gap_ev"]


# ---- crystal ----
def test_goldschmidt_perovskite():
    tf = crystal.goldschmidt_tolerance("Sr2+", "Ti4+", "O2-")
    assert 0.8 <= tf.t <= 1.0
    assert "perovskite" in tf.verdict


def test_gaas_density():
    gaas = crystal.zincblende("GaAs", 5.653)
    assert gaas.density_g_cm3() == pytest.approx(5.32, abs=0.05)
