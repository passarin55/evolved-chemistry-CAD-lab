import pytest

from eccl.core import have_rdkit
from eccl.llm import EchoClient, Message, get_client, complete
from eccl.llm.manager import _extract_json
from eccl.search import DeepSearch
from eccl.lab import Workbench

rdkit_only = pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")


# ---- llm ----
def test_echo_client_always_available():
    c = EchoClient()
    assert c.available()
    r = c.chat([Message("user", "hello")])
    assert "offline-fallback" in r.text


def test_get_client_falls_back_to_echo():
    # No local model in CI -> auto should return echo
    c = get_client("auto")
    assert c.available()


def test_extract_json_from_fenced():
    assert _extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _extract_json("noise {\"b\": 2} tail") == {"b": 2}
    assert _extract_json("no json here") is None


# ---- search (offline-safe) ----
def test_deep_search_degrades_gracefully():
    ds = DeepSearch(llm=EchoClient())
    rep = ds.run("tungsten carbide hardness", per_provider=2, synthesise=False)
    # Either results came back (online) or every provider failed cleanly (offline).
    assert isinstance(rep.results, list)
    assert rep.providers_used or rep.providers_failed
    assert rep.subqueries[0] == "tungsten carbide hardness"


# ---- lab workbench ----
def test_workbench_semiconductor():
    wb = Workbench()
    out = wb.analyze_semiconductor("Si", temperature_k=300)
    assert out["bandgap_eV"] == pytest.approx(1.12, abs=0.02)
    assert out["classification"] == "semiconductor"


def test_workbench_plasmon():
    wb = Workbench()
    out = wb.analyze_plasmonic_sphere("Au", 20)
    assert 400 < out["lspr"]["resonance_nm"] < 700


@rdkit_only
def test_workbench_molecule_analysis():
    wb = Workbench()
    out = wb.analyze_molecule("CC(=O)Oc1ccccc1C(=O)O")
    assert out["formula"] == "C9H8O4"
    assert out["gate"]["accepted"] in (True, False)


@rdkit_only
def test_campaign_runs_offline():
    from eccl.lab import DiscoveryCampaign, druglike_objective
    from eccl.evolve import EvolutionConfig

    camp = DiscoveryCampaign()
    rep = camp.run("test lead", druglike_objective(250),
                   evo_config=EvolutionConfig(population_size=16, generations=5,
                                              random_seed=5))
    assert rep.winners
    assert "." not in rep.winners[0]["smiles"]
