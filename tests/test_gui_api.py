"""Tests for the GUI backend: route table, JSON API, HTTP server, security, jobs."""
from __future__ import annotations

import http.client
import json
import math
import threading
import time
from typing import Any, Callable

import numpy as np
import pytest

from eccl.core import have_rdkit
from eccl.gui import api, make_server
from eccl.gui.api import ROUTES, dispatch, to_jsonable
from eccl.gui.jobs import JobManager, UnknownJob
from eccl.gui.server import CSP, MAX_BODY_BYTES, SECURITY_HEADERS, STATIC_DIR, GUIRequestHandler
from eccl.materials import semiconductor

ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O"
TINY_EVOLVE = {"population": 8, "generations": 3, "seed": 7, "use_gate": False}
FINISHED = ("done", "error", "cancelled")

# Every endpoint listed in docs/gui.md section 2.
CONTRACT_ROUTES = {
    ("GET", "/api/health"), ("GET", "/api/info"),
    ("POST", "/api/molecule/analyze"), ("POST", "/api/molecule/depict"),
    ("POST", "/api/molecule/similarity"), ("POST", "/api/formula"),
    ("POST", "/api/reaction/balance"), ("POST", "/api/reaction/stoichiometry"),
    ("POST", "/api/semiconductor/analyze"), ("POST", "/api/semiconductor/curves"),
    ("POST", "/api/semiconductor/compare"),
    ("POST", "/api/photonics/dispersion"), ("POST", "/api/photonics/fresnel"),
    ("POST", "/api/photonics/waveguide"), ("POST", "/api/photonics/dbr"),
    ("POST", "/api/photonics/cavity"),
    ("POST", "/api/plasmonics/drude"), ("POST", "/api/plasmonics/sphere"),
    ("POST", "/api/plasmonics/spp"),
    ("POST", "/api/quantum/graphene"), ("POST", "/api/quantum/tb1d"),
    ("POST", "/api/quantum/well"), ("POST", "/api/quantum/qdot"),
    ("POST", "/api/crystal/tolerance"), ("POST", "/api/crystal/xrd"),
    ("POST", "/api/spectro/interpret"), ("POST", "/api/spectro/ms"),
    ("POST", "/api/spectro/crossvalidate"), ("POST", "/api/spectro/simulate_ir"),
    ("GET", "/api/spectro/tables"),
    ("POST", "/api/gate/screen"),
    ("POST", "/api/evolve/start"), ("POST", "/api/campaign/start"),
    ("POST", "/api/search/start"), ("GET", "/api/jobs"), ("GET", "/api/jobs/{job_id}"),
    ("POST", "/api/jobs/{job_id}/cancel"),
    ("GET", "/api/llm/status"), ("POST", "/api/llm/configure"), ("POST", "/api/llm/chat"),
    ("GET", "/api/notebook"), ("POST", "/api/notebook/note"),
    ("POST", "/api/notebook/molecule"), ("POST", "/api/notebook/delete"),
    ("GET", "/api/notebook/export"), ("POST", "/api/notebook/import"),
}


# ---------------------------------------------------------------- helpers
def call(method: str, path: str, body: dict | None = None,
         query: dict | None = None) -> dict[str, Any]:
    """dispatch() and assert the result is strict JSON."""
    out = dispatch(method, path, body, query)
    json.dumps(out, allow_nan=False)
    return out


def has_keys(d: dict, *keys: str) -> None:
    missing = set(keys) - set(d)
    assert not missing, f"missing keys {sorted(missing)}; got {sorted(d)}"


def wait_job(job_id: str, timeout: float = 60) -> dict[str, Any]:
    rec = api.JOBS.wait(job_id, timeout)
    assert rec["status"] in FINISHED, f"job {job_id} still {rec['status']}"
    return rec


class Client:
    """Minimal HTTP client that never goes through a proxy and keeps raw paths."""

    def __init__(self, server: Any) -> None:
        self.host, self.port = server.server_address[:2]

    def request(self, method: str, path: str, body: Any = None, *,
                headers: dict[str, str] | None = None, raw: bytes | None = None
                ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        hdrs = {"Host": f"127.0.0.1:{self.port}"}
        hdrs.update(headers or {})
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        try:
            conn.request(method, path, body=data, headers=hdrs)
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()

    def json(self, method: str, path: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
        status, _headers, payload = self.request(method, path, body, **kw)
        return status, (json.loads(payload) if payload else None)


@pytest.fixture(scope="module")
def gui(tmp_path_factory):
    root = tmp_path_factory.mktemp("gui")
    static = root / "static"
    (static / "lib").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>ECCL test shell</title>",
                                       encoding="utf-8")
    (static / "lib" / "ui.js").write_text("window.ECCL = window.ECCL || {};\n")
    (static / "styles.css").write_text("body { color: black; }\n")
    (static / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (static / ".hidden").write_text("dotfile")
    (root / "secret.txt").write_text("TOP-SECRET-OUTSIDE-STATIC")
    server, url = make_server(port=0, static_dir=static)

    class QuietHandler(GUIRequestHandler):
        def log_message(self, format, *args):  # noqa: A002 - request lines are test noise
            pass

    server.RequestHandlerClass = QuietHandler
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                              daemon=True)
    thread.start()
    yield server, url, root
    server.shutdown()
    server.server_close()


@pytest.fixture()
def client(gui) -> Client:
    return Client(gui[0])


# ---------------------------------------------------------------- route table
def test_route_table_matches_contract():
    assert set(ROUTES) == CONTRACT_ROUTES
    assert all(callable(h) for h in ROUTES.values())


def test_resolve_params_404_and_405():
    handler, params = api.resolve("GET", "/api/jobs/job-1234abcd")
    assert handler is api.job_get and params == {"job_id": "job-1234abcd"}
    handler, params = api.resolve("POST", "/api/jobs/job-1234abcd/cancel/")
    assert handler is api.job_cancel
    with pytest.raises(api.NotFound):
        api.resolve("GET", "/api/does/not/exist")
    with pytest.raises(api.MethodNotAllowed) as exc:
        api.resolve("GET", "/api/formula")
    assert exc.value.allowed == ["POST"]


# ---------------------------------------------------------------- sanitiser
def test_to_jsonable_handles_non_finite_tuples_and_numpy():
    data = {
        "inf": float("inf"), "ninf": -math.inf, "nan": float("nan"),
        "tuple": (1, (2.0, float("nan"))),
        "np_f": np.float64(2.5), "np_f32_nan": np.float32("nan"), "np_i": np.int64(7),
        "np_b": np.bool_(True), "arr": np.array([1.0, np.inf, np.nan]),
        5: {"set": {3}}, "cplx": complex(1, float("inf")),
    }
    out = to_jsonable(data)
    assert out["inf"] is None and out["ninf"] is None and out["nan"] is None
    assert out["tuple"] == [1, [2.0, None]]
    assert out["np_f"] == 2.5 and type(out["np_f"]) is float
    assert out["np_f32_nan"] is None
    assert out["np_i"] == 7 and type(out["np_i"]) is int
    assert out["np_b"] is True
    assert out["arr"] == [1.0, None, None]
    assert out["5"] == {"set": [3]}
    assert out["cplx"] == {"re": 1.0, "im": None}
    json.dumps(out, allow_nan=False)  # strict JSON


def test_http_responses_never_contain_infinity_or_nan(client, monkeypatch):
    def nonfinite(req):
        return {"x": float("inf"), "y": [float("nan"), (1, 2)], "z": np.float64("-inf")}

    monkeypatch.setitem(ROUTES, ("GET", "/api/test/nonfinite"), nonfinite)
    status, _h, raw = client.request("GET", "/api/test/nonfinite")
    assert status == 200
    assert b"Infinity" not in raw and b"NaN" not in raw
    assert json.loads(raw) == {"x": None, "y": [None, [1, 2]], "z": None}


# ---------------------------------------------------------------- HTTP server
def test_make_server_port_zero_and_round_trip(gui, client):
    server, url, _root = gui
    port = server.server_address[1]
    assert port != 0 and url == f"http://127.0.0.1:{port}"
    assert server.loopback is True
    status, headers, raw = client.request("GET", "/api/health")
    assert status == 200 and json.loads(raw) == {"ok": True}
    assert headers["content-type"] == "application/json; charset=utf-8"
    for key, value in SECURITY_HEADERS.items():
        assert headers[key.lower()] == value
    assert "frame-ancestors 'none'" in CSP
    # a POST round trip with a JSON body
    status, data = client.json("POST", "/api/formula", {"formula": "H2O"})
    assert status == 200 and data["counts"] == {"H": 2, "O": 1}


def test_make_server_defaults_to_package_static_dir():
    server, url = make_server(port=0)
    try:
        assert server.static_dir == STATIC_DIR
        assert url.endswith(f":{server.server_address[1]}")
    finally:
        server.server_close()


def test_static_files_and_index(client):
    status, headers, raw = client.request("GET", "/")
    assert status == 200 and b"ECCL test shell" in raw
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert headers["cache-control"] == "no-store"
    assert headers["x-frame-options"] == "DENY"
    for path, ctype in [("/static/lib/ui.js", "text/javascript"),
                        ("/static/styles.css", "text/css"),
                        ("/static/icon.svg", "image/svg+xml"),
                        ("/static/index.html", "text/html")]:
        status, headers, _raw = client.request("GET", path)
        assert status == 200, path
        assert headers["content-type"].startswith(ctype)
        assert headers["cache-control"] == "no-store"
    status, headers, raw = client.request("HEAD", "/static/lib/ui.js")
    assert status == 200 and raw == b"" and int(headers["content-length"]) > 0
    status, data = client.json("GET", "/static/missing.js")
    assert status == 404 and data["type"] == "NotFound"
    status, data = client.json("POST", "/")
    assert status == 405


@pytest.mark.parametrize("path", [
    "/static/../secret.txt",
    "/static/../../secret.txt",
    "/static/lib/../../secret.txt",
    "/static/%2e%2e/secret.txt",
    "/static/%2E%2E/secret.txt",
    "/static/..%2fsecret.txt",
    "/static/%2e%2e%2fsecret.txt",
    "/static/lib/%2e%2e/%2e%2e/secret.txt",
    "/static/%252e%252e/secret.txt",
    "/static/..\\secret.txt",
    "/static/%5c..%5csecret.txt",
    "/static//etc/passwd",
    "/static/%2fetc%2fpasswd",
    "/static/%00index.html",
    "/static/.hidden",
    "/static/",
    "/../secret.txt",
    "/%2e%2e/secret.txt",
])
def test_static_path_traversal_is_rejected(client, path):
    status, _h, raw = client.request("GET", path)
    assert status == 404
    assert b"TOP-SECRET" not in raw


def test_absolute_path_under_static_is_rejected(client, gui):
    secret = gui[2] / "secret.txt"
    status, _h, raw = client.request("GET", "/static/" + str(secret))
    assert status == 404 and b"TOP-SECRET" not in raw


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8765", "127.0.0.1.evil.example",
                                  "localhost.evil.example:80", ""])
def test_bad_host_header_is_forbidden(client, host):
    status, data = client.json("GET", "/api/health", headers={"Host": host})
    assert status == 403 and data["type"] == "Forbidden"


@pytest.mark.parametrize("host", ["localhost", "localhost:1234", "LOCALHOST:9", "127.0.0.1",
                                  "[::1]:8765"])
def test_local_host_headers_are_allowed(client, host):
    status, data = client.json("GET", "/api/health", headers={"Host": host})
    assert status == 200 and data == {"ok": True}


def test_origin_checks_on_non_get(client):
    port = client.port
    body = {"formula": "CO2"}
    for origin in ("http://evil.example", "null", f"http://127.0.0.1:{port + 1}",
                   f"http://localhost:{port}", "file://"):
        status, data = client.json("POST", "/api/formula", body, headers={"Origin": origin})
        assert status == 403, origin
        assert data["type"] == "Forbidden"
    status, _ = client.json("POST", "/api/formula", body,
                            headers={"Origin": f"http://127.0.0.1:{port}"})
    assert status == 200
    status, _ = client.json("POST", "/api/formula", body)  # no Origin header at all
    assert status == 200
    # GET is not subject to the Origin check
    status, _ = client.json("GET", "/api/health", headers={"Origin": "http://evil.example"})
    assert status == 200


@pytest.mark.parametrize("expect_continue", [False, True])
def test_oversized_body_is_rejected_with_413(client, expect_continue):
    conn = http.client.HTTPConnection(client.host, client.port, timeout=30)
    try:
        conn.putrequest("POST", "/api/formula", skip_host=True)
        conn.putheader("Host", f"127.0.0.1:{client.port}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
        if expect_continue:
            conn.putheader("Expect", "100-continue")
        conn.endheaders()  # the body is never sent: the server must refuse up front
        resp = conn.getresponse()
        data = json.loads(resp.read())
    finally:
        conn.close()
    assert resp.status == 413
    assert data["type"] == "PayloadTooLarge" and "limit" in data["error"]


def test_body_at_the_limit_is_accepted(client):
    prefix, suffix = b'{"formula": "H2O", "pad": "', b'"}'
    raw = prefix + b"x" * (MAX_BODY_BYTES - len(prefix) - len(suffix)) + suffix
    assert len(raw) == MAX_BODY_BYTES
    status, _h, payload = client.request("POST", "/api/formula", raw=raw)
    assert status == 200 and json.loads(payload)["hill"] == "H2O"


def test_json_errors_unknown_routes_and_methods(client):
    for raw in (b"{not json", b'{"a": }', b"\xff\xfe\x00", b"[1, 2]", b'"text"', b"42"):
        status, _h, payload = client.request("POST", "/api/formula", raw=raw)
        data = json.loads(payload)
        assert status == 400, raw
        has_keys(data, "error", "type")
    # empty POST body == {} -> defaults apply
    status, data = client.json("POST", "/api/photonics/fresnel")
    assert status == 200 and len(data["angle_deg"]) == 181
    status, data = client.json("GET", "/api/nope")
    assert status == 404 and data["type"] == "NotFound"
    status, data = client.json("GET", "/not-a-page")
    assert status == 404
    status, headers, payload = client.request("GET", "/api/formula")
    assert status == 405 and headers["allow"] == "POST"
    assert json.loads(payload)["type"] == "MethodNotAllowed"
    status, headers, _ = client.request("POST", "/api/health")
    assert status == 405 and headers["allow"] == "GET"
    status, _h, _p = client.request("DELETE", "/api/notebook")
    assert status == 405


def test_validation_errors_map_to_400(client):
    cases = [
        ("/api/semiconductor/analyze", {"name": "Unobtainium"}, "GaAs"),
        ("/api/plasmonics/drude", {"metal": "Pt"}, "Au"),
        ("/api/photonics/dispersion", {"material": "glass"}, "BK7"),
        ("/api/crystal/tolerance", {"a_ion": "Xx+", "b_ion": "Pb2+", "x_ion": "I-"}, "Cs+"),
        ("/api/crystal/xrd", {"structure": "hexagonal"}, "zincblende"),
        ("/api/spectro/interpret", {"modality": "UV", "peaks": [1]}, "raman"),
        ("/api/photonics/waveguide", {"core_index": 1.4, "clad_index": 1.5,
                                      "thickness_nm": 200, "wavelength_nm": 1550}, "core"),
        ("/api/photonics/waveguide", {}, "missing required field"),
        ("/api/photonics/cavity", {"reflectance": 1.0, "length_nm": 10, "wavelength_nm": 500},
         "reflectance"),
        ("/api/photonics/fresnel", {"n1": "abc"}, "must be a number"),
        ("/api/semiconductor/curves", {"name": "Si", "t_min": 500, "t_max": 100}, "t_max"),
        ("/api/formula", {"formula": "Qq2"}, "Qq"),
        ("/api/reaction/stoichiometry", {"reactants": ["H2", "O2"], "products": ["H2O"],
                                         "basis": "N2"}, "not in the reaction"),
        ("/api/evolve/start", {"population": 2}, "population"),
        ("/api/evolve/start", {"generations": 0}, "generations"),
        ("/api/evolve/start", {"mutation_rate": 1.5}, "mutation_rate"),
        ("/api/evolve/start", {"objectives": {"druglike": {"weight": 0}}}, "weight > 0"),
        ("/api/evolve/start", {"objectives": {"potency": {"weight": 1}}}, "druglike"),
        ("/api/evolve/start", {"objectives": {"similarity": {"weight": 1}}}, "reference"),
        ("/api/search/start", {"query": "x", "providers": ["google"]}, "pubchem"),
        ("/api/gate/screen", {"smiles": ["CCO"] * 501}, "500"),
        ("/api/gate/screen", {"smiles": []}, "at least one"),
        ("/api/llm/configure", {"backend": "gpt"}, "ollama"),
    ]
    if have_rdkit():
        cases.append(("/api/molecule/analyze", {"smiles": "C1CC(("}, "SMILES"))
        cases.append(("/api/evolve/start", {"seeds": ["CCO", "C(("]}, "C(("))
    for path, body, needle in cases:
        status, data = client.json("POST", path, body)
        assert status == 400, (path, body, data)
        has_keys(data, "error", "type")
        assert needle in data["error"], (path, data["error"])


def test_numbers_are_coerced_and_points_clamped():
    assert len(call("POST", "/api/photonics/fresnel", {"points": 1})["angle_deg"]) == 2
    assert len(call("POST", "/api/photonics/fresnel", {"points": 10 ** 7})["angle_deg"]) == 2000
    assert len(call("POST", "/api/photonics/fresnel", {"points": "7"})["angle_deg"]) == 7
    assert len(call("POST", "/api/plasmonics/drude", {"metal": "au", "points": 12.6})
               ["photon_ev"]) == 13
    out = call("POST", "/api/semiconductor/analyze",
               {"name": "si", "temperature_k": "300", "n_donor": "1e17", "n_acceptor": 1e16})
    assert out["name"] == "Si" and "pn_junction" in out and out["n_donor"] == 1e17


# ---------------------------------------------------------------- every endpoint
CASES: dict[tuple[str, str], tuple[Callable[[], None], bool]] = {}


def case(method: str, path: str, needs_rdkit: bool = False) -> Callable:
    def deco(fn: Callable[[], None]) -> Callable[[], None]:
        CASES[(method, path)] = (fn, needs_rdkit)
        return fn
    return deco


@case("GET", "/api/health")
def _case_health():
    assert call("GET", "/api/health") == {"ok": True}


@case("GET", "/api/info")
def _case_info():
    out = call("GET", "/api/info")
    has_keys(out, "version", "rdkit", "llm", "config", "libraries", "presets")
    has_keys(out["llm"], "backend", "model", "reachable")
    has_keys(out["libraries"], "semiconductors", "metals", "sellmeier", "ionic_radii",
             "structures", "spectro_modalities", "harshness", "search_providers",
             "llm_backends")
    has_keys(out["presets"], "molecules", "reactions", "spectra", "perovskites", "crystals")
    lib = out["libraries"]
    assert {s["name"] for s in lib["semiconductors"]} == set(semiconductor.LIBRARY)
    has_keys(lib["semiconductors"][0], "name", "eg_300k", "direct_gap", "me_eff", "mh_eff",
             "eps_r")
    has_keys(lib["metals"][0], "name", "wp_ev", "gamma_ev", "eps_inf")
    assert lib["sellmeier"] == ["Al2O3", "BK7", "MgF2", "SiO2", "TiO2"]
    assert lib["structures"] == ["diamond", "zincblende", "rocksalt", "fcc", "bcc",
                                 "perovskite", "simple"]
    assert lib["spectro_modalities"] == ["IR", "raman", "1H", "13C"]
    assert lib["harshness"] == ["LENIENT", "NORMAL", "HARSH", "BRUTAL"]
    assert lib["llm_backends"] == ["auto", "ollama", "openai", "echo"]
    assert out["presets"]["molecules"]["aspirin"] == ASPIRIN
    assert out["rdkit"] is have_rdkit()


@case("POST", "/api/molecule/analyze", needs_rdkit=True)
def _case_analyze():
    out = call("POST", "/api/molecule/analyze", {"smiles": ASPIRIN, "harshness": "lenient"})
    has_keys(out, "smiles", "formula", "molar_mass", "inchi_key", "svg", "descriptors",
             "drug_likeness", "gate", "ir", "ir_interpretation", "uvvis", "record_id")
    assert out["formula"] == "C9H8O4"
    has_keys(out["drug_likeness"], "rules", "alerts", "sa_proxy", "qed_like", "rules_passed")
    has_keys(out["drug_likeness"]["rules"][0], "name", "passed", "violations")
    assert out["gate"]["harshness"] == "LENIENT"
    assert out["svg"].startswith(("<svg", "<?xml"))
    assert 0 < len(out["ir"]["x"]) <= 600 and len(out["ir"]["x"]) == len(out["ir"]["y"])
    assert out["ir"]["peaks"]
    has_keys(out["uvvis"], "lambda_max_nm", "conjugated_bonds", "note")
    assert out["record_id"] in {r["id"] for r in call("GET", "/api/notebook")["records"]}


@case("POST", "/api/molecule/depict", needs_rdkit=True)
def _case_depict():
    svg = call("POST", "/api/molecule/depict", {"smiles": "c1ccccc1", "width": 200})["svg"]
    assert svg.startswith("<svg") and "</svg>" in svg and "<script" not in svg


@case("POST", "/api/molecule/similarity", needs_rdkit=True)
def _case_similarity():
    out = call("POST", "/api/molecule/similarity",
               {"query": "CCO", "library": ["CCCO", "c1ccccc1", "CCO", "C(("]})
    has_keys(out, "query", "results", "diversity")
    sims = [r["tanimoto"] for r in out["results"]]
    assert sims == sorted(sims, reverse=True) and sims[0] == 1.0
    assert out["invalid"] == ["C(("]


@case("POST", "/api/formula")
def _case_formula():
    out = call("POST", "/api/formula", {"formula": "Fe2(SO4)3"})
    has_keys(out, "formula", "hill", "counts", "molar_mass", "mass_fractions")
    assert out["counts"] == {"Fe": 2, "S": 3, "O": 12}
    assert sum(out["mass_fractions"].values()) == pytest.approx(1.0, abs=1e-4)
    assert out["molar_mass"] == pytest.approx(399.86, abs=0.05)


@case("POST", "/api/reaction/balance")
def _case_balance():
    out = call("POST", "/api/reaction/balance",
               {"reactants": ["C3H8", "O2"], "products": ["CO2", "H2O"]})
    assert out["equation"] == "C3H8 + 5 O2 -> 3 CO2 + 4 H2O"
    has_keys(out["reactants"][0], "coeff", "formula", "molar_mass")
    assert out["mass_balance_error"] < 1e-6
    for preset in call("GET", "/api/info")["presets"]["reactions"]:
        call("POST", "/api/reaction/balance", preset)


@case("POST", "/api/reaction/stoichiometry")
def _case_stoich():
    out = call("POST", "/api/reaction/stoichiometry",
               {"reactants": "C3H8 + O2", "products": "CO2 + H2O", "basis": "C3H8", "moles": 2})
    has_keys(out, "equation", "basis", "moles", "grams")
    assert out["moles"]["O2"] == pytest.approx(10.0)
    assert out["grams"]["C3H8"] == pytest.approx(2 * 44.097, rel=1e-3)


@case("POST", "/api/semiconductor/analyze")
def _case_sc_analyze():
    out = call("POST", "/api/semiconductor/analyze", {"name": "Si"})
    assert out["bandgap_eV"] == pytest.approx(1.12, abs=0.02)
    has_keys(out["params"], "eg_300k", "me_eff", "mh_eff", "eps_r", "direct_gap")


@case("POST", "/api/semiconductor/curves")
def _case_sc_curves():
    out = call("POST", "/api/semiconductor/curves", {"name": "GaAs", "points": 20})
    has_keys(out, "name", "temperature", "bandgap_ev", "ni_cm3", "eg_300k", "sq")
    assert len(out["temperature"]) == len(out["bandgap_ev"]) == len(out["ni_cm3"]) == 20
    assert out["bandgap_ev"][0] > out["bandgap_ev"][-1]  # Varshni: gap shrinks with T
    assert len(out["sq"]["bandgap_ev"]) == len(out["sq"]["efficiency_pct"])
    assert out["sq"]["bandgap_ev"][0] == pytest.approx(0.3)
    assert out["sq"]["bandgap_ev"][-1] == pytest.approx(3.5)


@case("POST", "/api/semiconductor/compare")
def _case_sc_compare():
    rows = call("POST", "/api/semiconductor/compare", {})["rows"]
    assert len(rows) == len(semiconductor.LIBRARY)
    has_keys(rows[0], "name", "bandgap_ev", "direct_gap", "absorption_edge_nm", "ni_cm3",
             "sq_efficiency_pct", "classification")


@case("POST", "/api/photonics/dispersion")
def _case_dispersion():
    out = call("POST", "/api/photonics/dispersion", {"material": "SiO2", "points": 50})
    assert len(out["wavelength_nm"]) == len(out["n"]) == len(out["group_index"]) == 50
    assert all(1.4 < n < 1.5 for n in out["n"])
    tio2 = call("POST", "/api/photonics/dispersion", {"material": "TiO2"})
    assert len(tio2["wavelength_nm"]) == len(tio2["n"]) == len(tio2["group_index"])


@case("POST", "/api/photonics/fresnel")
def _case_fresnel():
    out = call("POST", "/api/photonics/fresnel", {"n1": 1.0, "n2": 1.5})
    has_keys(out, "angle_deg", "Rs", "Rp", "R", "brewster_deg", "critical_deg")
    assert out["angle_deg"][0] == 0 and out["angle_deg"][-1] == 90
    assert out["brewster_deg"] == pytest.approx(56.31, abs=0.01)
    assert out["critical_deg"] is None
    assert call("POST", "/api/photonics/fresnel", {"n1": 1.5, "n2": 1.0})["critical_deg"] \
        == pytest.approx(41.81, abs=0.01)


@case("POST", "/api/photonics/waveguide")
def _case_waveguide():
    out = call("POST", "/api/photonics/waveguide", {"core_index": 3.48, "clad_index": 1.444,
                                                    "thickness_nm": 220, "wavelength_nm": 1550})
    has_keys(out, "v_number", "num_modes_estimate", "single_mode", "cutoff_wavelength_nm", "sweep")
    sw = out["sweep"]
    assert len(sw["thickness_nm"]) == len(sw["num_modes"])
    assert sw["thickness_nm"][0] == pytest.approx(11.0) and sw["thickness_nm"][-1] == pytest.approx(660)


@case("POST", "/api/photonics/dbr")
def _case_dbr():
    out = call("POST", "/api/photonics/dbr", {"n_high": 2.3, "n_low": 1.45})
    assert out["pairs"] == list(range(1, 21))
    assert out["reflectance"] == sorted(out["reflectance"])
    assert out["bragg_wavelength_nm"] == pytest.approx(1550)
    assert out["d_high_nm"] == pytest.approx(1550 / (4 * 2.3), abs=1e-3)
    huge = call("POST", "/api/photonics/dbr", {"n_high": 10, "n_low": 1, "max_pairs": 200})
    assert huge["reflectance"][-1] == 1.0  # overflowed power handled


@case("POST", "/api/photonics/cavity")
def _case_cavity():
    out = call("POST", "/api/photonics/cavity",
               {"reflectance": 0.99, "length_nm": 1e6, "wavelength_nm": 1550})
    has_keys(out, "finesse", "fsr_nm", "linewidth_nm", "Q")
    assert out["finesse"] == pytest.approx(312.6, abs=0.1)


@case("POST", "/api/plasmonics/drude")
def _case_drude():
    out = call("POST", "/api/plasmonics/drude", {"metal": "Au"})
    assert len(out["photon_ev"]) == len(out["wavelength_nm"]) == len(out["eps_real"]) \
        == len(out["eps_imag"]) == 221
    assert out["eps_real"][0] < 0 < out["eps_imag"][0]


@case("POST", "/api/plasmonics/sphere")
def _case_sphere():
    out = call("POST", "/api/plasmonics/sphere", {"metal": "Au", "points": 60})
    has_keys(out["lspr"], "resonance_ev", "resonance_nm", "fwhm_ev", "quality_factor")
    sp = out["spectrum"]
    assert len(sp["wavelength_nm"]) == len(sp["c_ext"]) == len(sp["c_sca"]) == len(sp["c_abs"]) == 60
    assert "C_ext_nm2" in out["at_resonance"]


@case("POST", "/api/plasmonics/spp")
def _case_spp():
    out = call("POST", "/api/plasmonics/spp", {"metal": "Ag"})
    has_keys(out["spp"], "neff", "propagation_length_um", "confinement_nm")
    has_keys(out, "resonance_ev", "resonance_nm", "dispersion")
    d = out["dispersion"]
    assert len(d["photon_ev"]) == len(d["neff"]) == len(d["propagation_length_um"])
    assert max(d["photon_ev"]) < out["resonance_ev"]


@case("POST", "/api/quantum/graphene")
def _case_graphene():
    out = call("POST", "/api/quantum/graphene", {"points": 40})
    assert len(out["k_index"]) == len(out["upper"]) == len(out["lower"]) == 120
    assert [t["label"] for t in out["ticks"]] == ["Γ", "K", "M", "Γ"]
    assert out["is_dirac_semimetal"] is True


@case("POST", "/api/quantum/tb1d")
def _case_tb1d():
    out = call("POST", "/api/quantum/tb1d", {})
    assert len(out["k"]) == len(out["energy"]) == 201
    assert out["bandwidth"] == pytest.approx(4.0)
    assert len(out["dos"]["energy"]) == len(out["dos"]["dos"])


@case("POST", "/api/quantum/well")
def _case_well():
    out = call("POST", "/api/quantum/well", {})
    has_keys(out, "levels_ev", "well_width_nm", "confinement_ev", "transitions")
    assert len(out["levels_ev"]) == 5 and len(out["transitions"]) == 10
    has_keys(out["transitions"][0], "from", "to", "energy_ev", "wavelength_nm")


@case("POST", "/api/quantum/qdot")
def _case_qdot():
    out = call("POST", "/api/quantum/qdot", {})
    assert out["semiconductor"] == "CdTe" and out["bulk_gap_ev"] == 1.5
    has_keys(out["single"], "confined_gap_ev", "confinement_shift_ev", "coulomb_ev", "emission_nm")
    assert len(out["curve"]["radius_nm"]) == len(out["curve"]["gap_ev"]) == 51


@case("POST", "/api/crystal/tolerance")
def _case_tolerance():
    out = call("POST", "/api/crystal/tolerance", {"a_ion": "Cs+", "b_ion": "Pb2+", "x_ion": "I-"})
    has_keys(out, "t", "octahedral_mu", "verdict", "radii")
    assert out["radii"] == {"a": 1.67, "b": 1.19, "x": 2.2}


@case("POST", "/api/crystal/xrd")
def _case_xrd():
    out = call("POST", "/api/crystal/xrd", {})
    has_keys(out, "reflections", "peaks_2theta", "pattern", "density_g_cm3")
    assert out["reflections"][0]["hkl"] == [1, 1, 1]  # tuples become lists
    assert out["density_g_cm3"] == pytest.approx(2.329, abs=0.01)
    pat = out["pattern"]
    assert len(pat["two_theta"]) == len(pat["intensity"])
    assert max(pat["intensity"]) == pytest.approx(100.0)
    for preset in call("GET", "/api/info")["presets"]["crystals"]:
        assert call("POST", "/api/crystal/xrd", preset)["reflections"]


@case("POST", "/api/spectro/interpret")
def _case_interpret():
    out = call("POST", "/api/spectro/interpret", {"modality": "IR", "peaks": [3000, 1715, 1280]})
    has_keys(out, "modality", "assignments", "unassigned", "functional_groups", "summary")
    assert "carboxylic acid" in out["functional_groups"]


@case("POST", "/api/spectro/ms")
def _case_ms():
    out = call("POST", "/api/spectro/ms", {"molecular_ion": 122, "fragments": [105, 77]})
    has_keys(out, "molecular_ion", "losses", "summary")
    assert out["losses"][0]["assignment"] == "OH / NH3"


@case("POST", "/api/spectro/crossvalidate")
def _case_crossvalidate():
    out = call("POST", "/api/spectro/crossvalidate", {"sets": [
        {"modality": "IR", "peaks": [3000, 1715]}, {"modality": "1H", "peaks": [11.6, 7.3]}]})
    assert len(out["interpretations"]) == 2
    has_keys(out["cross"], "modalities", "corroborated_groups", "all_groups", "evidence_counts")
    assert "carboxylic acid" in out["cross"]["corroborated_groups"]


@case("POST", "/api/spectro/simulate_ir", needs_rdkit=True)
def _case_simulate_ir():
    out = call("POST", "/api/spectro/simulate_ir", {"smiles": "CCO"})
    has_keys(out, "x", "y", "peaks", "interpretation")
    assert 0 < len(out["x"]) <= 600 and 3350 in out["peaks"]


@case("GET", "/api/spectro/tables")
def _case_tables():
    out = call("GET", "/api/spectro/tables")
    has_keys(out, "IR", "raman", "1H", "13C", "neutral_losses")
    has_keys(out["IR"][0], "low", "high", "assignment", "group", "intensity", "note")
    assert out["neutral_losses"]["18"] == "H2O"


@case("POST", "/api/gate/screen", needs_rdkit=True)
def _case_gate():
    smiles = ["CCO", ASPIRIN, "C1CC(("]
    out = call("POST", "/api/gate/screen", {"smiles": smiles, "harshness": "HARSH"})
    has_keys(out, "accepted", "rejected", "pass_rate", "verdicts")
    assert sorted(out["accepted"] + out["rejected"]) == sorted(smiles)
    assert out["verdicts"]["C1CC(("]["accepted"] is False and "error" in out["verdicts"]["C1CC(("]
    has_keys(out["verdicts"][ASPIRIN], "accepted", "harshness", "score", "critiques")


@case("POST", "/api/evolve/start", needs_rdkit=True)
def _case_evolve_start():
    job_id = call("POST", "/api/evolve/start", TINY_EVOLVE)["job_id"]
    rec = wait_job(job_id)
    assert rec["status"] == "done" and rec["kind"] == "evolve"


@case("POST", "/api/campaign/start", needs_rdkit=True)
def _case_campaign_start():
    out = call("POST", "/api/campaign/start", {**TINY_EVOLVE, "generations": 2,
                                               "title": "test campaign", "top_n": 2})
    rec = wait_job(out["job_id"])
    assert rec["status"] == "done", rec["error"]
    res = rec["result"]
    has_keys(res, "title", "grounding", "evolution", "winners", "notes")
    assert res["title"] == "test campaign" and 1 <= len(res["winners"]) <= 2
    assert all(w["svg"].startswith("<svg") for w in res["winners"])
    assert all("found_generation" in w and "lineage_depth" in w for w in res["winners"])
    assert rec["params"]["top_n"] == 2 and rec["params"]["title"] == "test campaign"
    # the evolution block has the evolve result's individual shape
    for ind in [res["evolution"]["best"], *res["evolution"]["hall_of_fame"]]:
        has_keys(ind, "smiles", "fitness", "lineage_depth", "found_generation", "breakdown", "svg")
        assert ind["svg"].startswith("<svg") and ind["breakdown"]
    assert any(j["id"] == rec["id"] and j["label"] == "test campaign"
               for j in call("GET", "/api/jobs")["jobs"])


@case("POST", "/api/search/start")
def _case_search_start():
    out = call("POST", "/api/search/start", {"query": "aspirin", "providers": ["pubchem"],
                                             "expand": False, "synthesise": False,
                                             "per_provider": 1})
    rec = wait_job(out["job_id"])
    assert rec["status"] == "done", rec["error"]  # offline providers fail gracefully
    has_keys(rec["result"], "query", "results", "providers_used", "providers_failed", "synthesis")
    assert rec["result"]["llm_backend"] is None  # synthesis was off
    assert [e["provider"] for e in rec["events"]] == ["pubchem"]
    assert rec["events"][0]["status"] in ("ok", "failed") and "detail" in rec["events"][0]


@case("GET", "/api/jobs")
def _case_jobs_list():
    job_id = call("POST", "/api/search/start", {"query": "x", "providers": "crossref",
                                                "expand": False, "synthesise": False})["job_id"]
    jobs = call("GET", "/api/jobs")["jobs"]
    assert jobs[0]["id"] == job_id  # newest first
    for job in jobs:
        has_keys(job, "id", "kind", "status", "created", "progress")
        assert "events" not in job and "result" not in job
    wait_job(job_id)


@case("GET", "/api/jobs/{job_id}", needs_rdkit=True)
def _case_job_get():
    job_id = call("POST", "/api/evolve/start", TINY_EVOLVE)["job_id"]
    wait_job(job_id)
    rec = call("GET", f"/api/jobs/{job_id}", query={"since": "1"})
    has_keys(rec, "id", "kind", "status", "created", "started", "finished", "progress",
             "events", "events_total", "params", "result", "error")
    assert rec["events_total"] == 3 and [e["generation"] for e in rec["events"]] == [2, 3]
    with pytest.raises(api.NotFound):
        call("GET", "/api/jobs/job-00000000")


@case("POST", "/api/jobs/{job_id}/cancel")
def _case_job_cancel():
    job_id = call("POST", "/api/search/start", {"query": "x", "providers": ["arxiv"],
                                                "expand": False, "synthesise": False})["job_id"]
    out = call("POST", f"/api/jobs/{job_id}/cancel")
    has_keys(out, "id", "status")
    assert out["id"] == job_id
    rec = wait_job(job_id)
    assert rec["status"] in ("cancelled", "done")
    with pytest.raises(api.NotFound):
        call("POST", "/api/jobs/job-00000000/cancel")


@case("GET", "/api/llm/status")
def _case_llm_status():
    has_keys(call("GET", "/api/llm/status"), "backend", "model", "reachable")


@case("POST", "/api/llm/configure")
def _case_llm_configure():
    out = call("POST", "/api/llm/configure", {"backend": "echo"})
    assert out["backend"] == "echo (offline, deterministic)" and out["reachable"] is False


@case("POST", "/api/llm/chat")
def _case_llm_chat():
    call("POST", "/api/llm/configure", {"backend": "echo"})
    out = call("POST", "/api/llm/chat", {"messages": [{"role": "user", "content": "hi"}]})
    has_keys(out, "text", "backend", "model")


@case("GET", "/api/notebook")
def _case_nb_list():
    out = call("GET", "/api/notebook")
    has_keys(out, "name", "count", "records")
    assert out["count"] == len(out["records"])


@case("POST", "/api/notebook/note")
def _case_nb_note():
    assert call("POST", "/api/notebook/note", {"text": "case note"})["id"].startswith("note-")


@case("POST", "/api/notebook/molecule", needs_rdkit=True)
def _case_nb_molecule():
    assert call("POST", "/api/notebook/molecule", {"smiles": "CCO"})["id"].startswith("mol-")


@case("POST", "/api/notebook/delete")
def _case_nb_delete():
    rid = call("POST", "/api/notebook/note", {"text": "to delete"})["id"]
    assert call("POST", "/api/notebook/delete", {"id": rid}) == {"ok": True}
    with pytest.raises(api.ValidationError):
        call("POST", "/api/notebook/delete", {"id": rid})


@case("GET", "/api/notebook/export")
def _case_nb_export():
    has_keys(call("GET", "/api/notebook/export"), "name", "version", "records")


@case("POST", "/api/notebook/import")
def _case_nb_import():
    before = call("GET", "/api/notebook")["count"]
    rec = {"kind": "note", "id": "note-imported1", "payload": {"text": "imported"},
           "tags": [], "created": time.time()}
    out = call("POST", "/api/notebook/import", {"data": {"records": [rec]}})
    assert out["count"] == before + 1 and out["imported"] == 1


def test_case_table_covers_every_route():
    assert set(CASES) == set(ROUTES)


@pytest.mark.parametrize("route", sorted(CASES), ids=lambda r: f"{r[0]} {r[1]}")
def test_endpoint(route):
    fn, needs_rdkit = CASES[route]
    if needs_rdkit and not have_rdkit():
        pytest.skip("needs rdkit")
    fn()


# ---------------------------------------------------------------- jobs over HTTP
def _poll(client: Client, job_id: str, timeout: float = 60
          ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Poll with ?since= like the frontend; returns (final record, all events)."""
    since, events = 0, []
    deadline = time.time() + timeout
    while True:
        status, rec = client.json("GET", f"/api/jobs/{job_id}?since={since}")
        assert status == 200
        events.extend(rec["events"])
        since = rec["events_total"]
        assert len(events) == since  # since-slicing never duplicates or drops events
        if rec["status"] in FINISHED:
            return rec, events
        assert time.time() < deadline, f"job {job_id} did not finish"
        time.sleep(0.05)


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_evolution_job_lifecycle_over_http(client):
    nb_before = call("GET", "/api/notebook")["count"]
    spec = {**TINY_EVOLVE, "objectives": {"druglike": {"weight": 1.0},
                                          "mol_weight": {"weight": 0.5, "target": 250},
                                          "logp": 0}}
    status, out = client.json("POST", "/api/evolve/start", spec)
    assert status == 200 and out["job_id"].startswith("job-")
    job_id = out["job_id"]
    rec, events = _poll(client, job_id)
    assert rec["status"] == "done", rec["error"]
    assert rec["kind"] == "evolve" and rec["finished"] >= rec["started"] >= rec["created"]
    assert rec["events_total"] == 3 and [e["generation"] for e in events] == [1, 2, 3]
    for e in events:
        has_keys(e, "generation", "best", "mean", "worst", "unique", "best_smiles")
        assert e["worst"] <= e["mean"] <= e["best"]
    assert rec["progress"]["current"] == rec["progress"]["total"] == 3
    assert rec["params"]["population"] == 8
    assert set(rec["params"]["objectives"]) == {"druglike", "mol_weight"}  # weight 0 dropped
    res = rec["result"]
    has_keys(res, "best", "hall_of_fame", "history", "evaluations")
    has_keys(res["best"], "smiles", "fitness", "generation", "breakdown", "svg")
    assert set(res["best"]["breakdown"]) == {"druglike", "mol_weight"}
    assert res["best"]["svg"].startswith("<svg")
    assert res["hall_of_fame"] and all("svg" in h for h in res["hall_of_fame"])
    assert len(res["history"]) == 3 and res["evaluations"] > 0
    # since-slicing edge cases
    status, tail = client.json("GET", f"/api/jobs/{job_id}?since=99")
    assert status == 200 and tail["events"] == [] and tail["events_total"] == 3
    status, neg = client.json("GET", f"/api/jobs/{job_id}?since=-4")
    assert status == 200 and len(neg["events"]) == 3
    status, _ = client.json("GET", f"/api/jobs/{job_id}?since=abc")
    assert status == 400
    # job list: summaries only
    status, jobs = client.json("GET", "/api/jobs")
    summary = next(j for j in jobs["jobs"] if j["id"] == job_id)
    assert summary["status"] == "done" and "events" not in summary and "result" not in summary
    # the Workbench registered the run in its notebook
    nb = call("GET", "/api/notebook")
    assert nb["count"] == nb_before + 1
    assert nb["records"][0]["kind"] == "run" and nb["records"][0]["summary"].startswith("evolution")
    # cancelling a finished job is a no-op
    status, out = client.json("POST", f"/api/jobs/{job_id}/cancel")
    assert status == 200 and out["status"] == "done"


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_evolution_job_cancellation_over_http(client):
    status, out = client.json("POST", "/api/evolve/start",
                              {"population": 40, "generations": 500, "seed": 3, "use_gate": False})
    assert status == 200
    job_id = out["job_id"]
    deadline = time.time() + 30
    while True:  # wait until the run is demonstrably under way
        status, rec = client.json("GET", f"/api/jobs/{job_id}")
        if rec["events_total"] >= 1:
            break
        assert rec["status"] in ("queued", "running") and time.time() < deadline
        time.sleep(0.05)
    status, out = client.json("POST", f"/api/jobs/{job_id}/cancel")
    assert status == 200 and out["id"] == job_id and out["status"] in ("running", "cancelled")
    rec, events = _poll(client, job_id, timeout=30)
    assert rec["status"] == "cancelled"
    assert rec["finished"] is not None and rec["result"] is None
    assert 1 <= rec["events_total"] < 500
    assert rec["progress"]["message"] == "cancelled"
    status, again = client.json("POST", f"/api/jobs/{job_id}/cancel")
    assert status == 200 and again["status"] == "cancelled"
    status, data = client.json("GET", "/api/jobs/job-ffffffff")
    assert status == 404 and data["type"] == "NotFound"
    status, data = client.json("POST", "/api/jobs/job-ffffffff/cancel")
    assert status == 404


def test_job_manager_queue_cancel_errors_and_retention():
    mgr = JobManager(max_workers=1, keep_finished=3)
    try:
        gate = threading.Event()
        blocker = mgr.submit("test", {}, lambda ctx: gate.wait(10) and {"ok": True})
        queued = mgr.submit("test", {}, lambda ctx: {"never": "runs"})
        assert mgr.get(queued)["status"] == "queued"
        assert mgr.cancel(queued)["status"] == "cancelled"  # queued: immediate
        gate.set()
        assert mgr.wait(blocker, 10)["result"] == {"ok": True}
        assert mgr.get(queued)["result"] is None

        def boom(ctx):
            ctx.emit({"step": 1})
            raise RuntimeError("kaboom")

        failed = mgr.wait(mgr.submit("test", {}, boom), 10)
        assert failed["status"] == "error" and failed["error"] == "kaboom"
        assert failed["error_type"] == "RuntimeError" and failed["events_total"] == 1

        for _ in range(4):
            mgr.wait(mgr.submit("test", {}, lambda ctx: None), 10)
        assert len(mgr.list()) == 3  # only the last 3 finished jobs are retained
        with pytest.raises(UnknownJob):
            mgr.get(blocker)
    finally:
        mgr.shutdown()


def test_cancel_signal_cannot_be_swallowed_by_except_exception():
    mgr = JobManager(max_workers=1)
    try:
        started = threading.Event()

        def stubborn(ctx):
            started.set()
            for _ in range(500):
                try:
                    ctx.check_cancel()
                except Exception:  # noqa: BLE001 - engine-style broad handler
                    pytest.fail("cancellation was caught as an ordinary Exception")
                time.sleep(0.01)
            return "finished"

        job_id = mgr.submit("test", {}, stubborn)
        assert started.wait(5)
        mgr.cancel(job_id)
        assert mgr.wait(job_id, 10)["status"] == "cancelled"
    finally:
        mgr.shutdown()


# ---------------------------------------------------------------- LLM
@pytest.fixture()
def restore_llm():
    cfg = api.WORKBENCH.config
    saved = (cfg.llm_backend, cfg.llm_base_url, cfg.llm_model, api.WORKBENCH._llm)
    yield
    cfg.llm_backend, cfg.llm_base_url, cfg.llm_model, api.WORKBENCH._llm = saved


def test_llm_configure_status_and_chat_via_echo(client, restore_llm):
    status, out = client.json("POST", "/api/llm/configure", {"backend": "echo"})
    assert status == 200
    assert out["backend"] == "echo (offline, deterministic)"
    assert out["model"] is None and out["reachable"] is False
    status, st = client.json("GET", "/api/llm/status")
    assert status == 200 and st["backend"] == out["backend"] and st["reachable"] is False
    status, chat = client.json("POST", "/api/llm/chat", {
        "messages": [{"role": "user", "content": "Is benzene aromatic?"},
                     {"role": "assistant", "content": "Yes."},
                     {"role": "user", "content": "Why exactly?"}],
        "system": "You are a chemist.", "temperature": 0.1, "max_tokens": 64})
    assert status == 200
    assert "offline-fallback" in chat["text"] and "You are a chemist." in chat["text"]
    assert chat["backend"] == "echo (offline, deterministic)" and chat["model"] == "echo"
    for bad in ({"messages": []}, {"messages": [{"role": "robot", "content": "x"}]},
                {"messages": [{"role": "user", "content": 5}]},
                {"messages": [{"role": "user", "content": "x"}], "temperature": 9}):
        status, err = client.json("POST", "/api/llm/chat", bad)
        assert status == 400, bad
    status, err = client.json("POST", "/api/llm/configure", {"backend": "ollama",
                                                              "base_url": "ftp://x"})
    assert status == 400 and "base_url" in err["error"]
    # what was requested survives the fallback to echo (status after a reload)
    status, out = client.json("POST", "/api/llm/configure", {
        "backend": "ollama", "base_url": "http://127.0.0.1:9", "model": "llama-test"})
    assert status == 200 and out["fallback"] is True and out["base_url"] is None
    status, st = client.json("GET", "/api/llm/status")
    assert st["configured_backend"] == "ollama"
    assert st["configured_base_url"] == "http://127.0.0.1:9" and st["configured_model"] == "llama-test"


# ---------------------------------------------------------------- notebook
@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_notebook_note_molecule_delete_export_import_round_trip(client):
    status, note = client.json("POST", "/api/notebook/note",
                               {"text": "first   note\nline two", "tags": ["t1", "t2"]})
    assert status == 200 and note["id"].startswith("note-")
    status, mol = client.json("POST", "/api/notebook/molecule",
                              {"smiles": "OCC", "name": "ethanol", "tags": "solvent"})
    assert status == 200 and mol["id"].startswith("mol-")

    status, nb = client.json("GET", "/api/notebook")
    assert status == 200 and nb["count"] == len(nb["records"])
    assert [r["id"] for r in nb["records"][:2]] == [mol["id"], note["id"]]  # newest first
    for r in nb["records"]:
        has_keys(r, "id", "kind", "tags", "created", "summary", "payload")
    by_id = {r["id"]: r for r in nb["records"]}
    assert by_id[note["id"]]["summary"] == "first note line two"
    assert by_id[note["id"]]["tags"] == ["t1", "t2"]
    assert "ethanol" in by_id[mol["id"]]["summary"] and "CCO" in by_id[mol["id"]]["summary"]
    assert by_id[mol["id"]]["tags"] == ["solvent"]

    status, ok = client.json("POST", "/api/notebook/delete", {"id": note["id"]})
    assert status == 200 and ok == {"ok": True}
    status, err = client.json("POST", "/api/notebook/delete", {"id": note["id"]})
    assert status == 400 and "unknown" in err["error"]
    status, err = client.json("POST", "/api/notebook/delete", {})
    assert status == 400

    status, exported = client.json("GET", "/api/notebook/export")
    assert status == 200
    has_keys(exported, "name", "version", "records")
    ids = [r["id"] for r in exported["records"]]
    assert mol["id"] in ids and note["id"] not in ids

    # replace everything with the export: identical content comes back
    status, out = client.json("POST", "/api/notebook/import", {"data": exported, "merge": False})
    assert status == 200 and out["count"] == len(ids)
    status, nb = client.json("GET", "/api/notebook")
    assert sorted(r["id"] for r in nb["records"]) == sorted(ids)

    # merge one more record
    extra = {"kind": "note", "id": "note-merged01", "payload": {"text": "merged in"},
             "tags": ["import"], "created": time.time() + 1}
    status, out = client.json("POST", "/api/notebook/import",
                              {"data": {"name": "other", "records": [extra]}})
    assert status == 200 and out["count"] == len(ids) + 1
    status, nb = client.json("GET", "/api/notebook")
    assert nb["records"][0]["id"] == "note-merged01"
    assert nb["records"][0]["summary"] == "merged in"

    for bad in ({"data": "nope"}, {"data": {"records": "x"}},
                {"data": {"records": [{"kind": "alien", "id": "a", "payload": {}}]}},
                {"data": {"records": [{"kind": "note", "id": "", "payload": {}}]}},
                {"data": {"records": [{"kind": "note", "id": "n1", "payload": []}]}}):
        status, err = client.json("POST", "/api/notebook/import", bad)
        assert status == 400, bad


def test_notebook_is_thread_safe_under_concurrent_writes():
    nb = api.WORKBENCH.notebook
    before = len(nb)
    errors: list[BaseException] = []

    def writer(i: int) -> None:
        try:
            for j in range(25):
                nb.add_note(f"thread {i} note {j}")
                call("GET", "/api/notebook")
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert not errors
    assert len(nb) == before + 150


# ---------------------------------------------------------------- integration fixes
def test_huge_integers_are_rejected_with_400_not_overflow_500(client):
    big = "1" + "0" * 400
    for path, raw in (("/api/evolve/start", f'{{"population": {big}}}'),
                      ("/api/semiconductor/analyze", f'{{"name": "Si", "temperature_k": {big}}}'),
                      ("/api/quantum/well", f'{{"n_levels": {big}}}'),
                      ("/api/quantum/graphene", f'{{"points": -{big}}}')):
        status, _h, payload = client.request("POST", path, raw=raw.encode(),
                                              headers={"Content-Type": "application/json"})
        assert status == 400, (path, payload)
        assert json.loads(payload)["type"] == "ValidationError"


def test_formula_without_atoms_is_rejected():
    for f in ("H0", "C0H0", "(H)0"):
        with pytest.raises(api.ValidationError, match="no atoms"):
            call("POST", "/api/formula", {"formula": f})


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_smiles_length_and_depiction_size_caps():
    with pytest.raises(api.ValidationError, match="too long"):
        call("POST", "/api/molecule/analyze", {"smiles": "C" * (api.MAX_SMILES_LEN + 1)})
    big = "C" * (api.MAX_DEPICT_ATOMS + 1)
    out = call("POST", "/api/molecule/depict", {"smiles": big})
    assert out["svg"] is None and "250" in out["note"]
    assert call("POST", "/api/molecule/depict", {"smiles": "CCO"})["svg"].startswith("<svg")


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_molecule_analyze_echoes_input_and_canonical_smiles_without_registering():
    before = len(api.WORKBENCH.notebook)
    raw = "OC(=O)c1ccccc1OC(C)=O"  # aspirin, written non-canonically
    out = call("POST", "/api/molecule/analyze", {"smiles": raw, "register": False})
    assert out["input_smiles"] == raw
    assert out["canonical_smiles"] == out["smiles"] == ASPIRIN
    assert out["record_id"] is None and len(api.WORKBENCH.notebook) == before


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_ir_interpretation_drops_groups_the_structure_cannot_have():
    for interp in (call("POST", "/api/molecule/analyze",
                        {"smiles": ASPIRIN, "register": False})["ir_interpretation"],
                   call("POST", "/api/spectro/simulate_ir", {"smiles": ASPIRIN})["interpretation"]):
        groups = {a["group"] for a in interp["assignments"]}
        assert not groups & {"fluoride", "chloride", "nitro", "amide", "amine/amide",
                             "amine (aliphatic)", "amine (aromatic)", "nitrile", "thiol"}
        assert set(interp["functional_groups"]) == groups
        assert "fluoride" not in interp["summary"]
        filt = interp["structure_filter"]
        assert filt["elements"] == ["C", "H", "O"]
        assert any(x["group"] == "fluoride" and x["missing_elements"] == ["F"]
                   for x in filt["excluded"])
        assert "carboxylic acid" in groups
    # a nitro compound keeps its nitro assignment
    nitro = call("POST", "/api/spectro/simulate_ir", {"smiles": "O=[N+]([O-])c1ccccc1"})
    assert not any(x["group"] == "nitro" for x in nitro["interpretation"]["structure_filter"]["excluded"])


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_uvvis_flags_where_the_kuhn_model_does_not_apply():
    uv = call("POST", "/api/molecule/analyze", {"smiles": ASPIRIN, "register": False})["uvvis"]
    assert uv["model_applicable"] is False and "overestimates" in uv["caveat"]
    poly = call("POST", "/api/molecule/analyze", {"smiles": "C=CC=CC=C", "register": False})["uvvis"]
    assert poly["model_applicable"] is True and poly["caveat"] is None
    assert poly["conjugated_systems"] == 1


@pytest.mark.parametrize("name,t,nd,na", [("GaAs", 300, 0, 1e17), ("Si", 300, 0, 1e17),
                                          ("GaN", 50, 0, 1e16), ("GaN", 300, 1e17, 0),
                                          ("Si", 300, 1e16, 0)])
def test_semiconductor_carriers_are_stable_for_p_type_and_wide_gaps(name, t, nd, na):
    c = call("POST", "/api/semiconductor/analyze",
             {"name": name, "temperature_k": t, "n_donor": nd, "n_acceptor": na})["carriers"]
    net = nd - na
    major, minor = (c["n"], c["p"]) if net > 0 else (c["p"], c["n"])
    assert major == pytest.approx(abs(net), rel=1e-9)  # charge neutrality, no cancellation
    assert minor is not None and 0 <= minor < major
    kt = 8.617333262e-5 * t
    ln_ni = math.log(semiconductor.effective_dos(semiconductor.get_params(name).me_eff, t)) / 2 \
        + math.log(semiconductor.effective_dos(semiconductor.get_params(name).mh_eff, t)) / 2 \
        - semiconductor.varshni_bandgap(semiconductor.get_params(name), t) / (2 * kt)
    expected = math.copysign(kt * (math.log(abs(net)) - ln_ni), net)
    assert c["fermi_offset_ev"] == pytest.approx(expected, abs=2e-4)
    if net > 0 and c["n_i"] > 1e-100:  # where the engine is stable, the two agree
        eng = semiconductor.doped_carriers(name, nd, na, t)
        assert c["n"] == pytest.approx(eng.n) and c["p"] == pytest.approx(eng.p)


def test_semiconductor_curves_place_the_sq_marker_at_temperature():
    at300 = call("POST", "/api/semiconductor/curves", {"name": "Si", "points": 5})["sq"]["material"]
    assert at300["temperature_k"] == 300 and at300["bandgap_ev"] == pytest.approx(1.12, abs=1e-3)
    hot = call("POST", "/api/semiconductor/curves",
               {"name": "Si", "points": 5, "temperature_k": 500})["sq"]["material"]
    p = semiconductor.get_params("Si")
    assert hot["temperature_k"] == 500
    assert hot["bandgap_ev"] == pytest.approx(semiconductor.varshni_bandgap(p, 500), rel=1e-3)


def test_dispersion_reports_reference_indices_and_abbe_number():
    out = call("POST", "/api/photonics/dispersion", {"material": "BK7", "points": 5})
    assert out["n_589nm"] == pytest.approx(1.5168, abs=2e-4)
    assert out["abbe_number"] == pytest.approx(64.2, abs=0.5)  # catalogue BK7: 64.17
    assert out["n_F"] > out["n_589nm"] > out["n_C"] > out["n_1550nm"]
    assert out["group_index_1550nm"] > out["n_1550nm"]


def test_dbr_leakage_survives_where_reflectance_rounds_to_one():
    out = call("POST", "/api/photonics/dbr", {"n_high": 3.48, "n_low": 1.45, "max_pairs": 14})
    leak, refl = out["leakage"], out["reflectance"]
    assert len(leak) == len(refl) == len(out["pairs"])
    assert refl[-1] == 1.0 and 0 < leak[-1] < 1e-8
    assert all(a > b for a, b in zip(leak, leak[1:]))
    for r, lk in zip(refl, leak):
        if r < 0.999:
            assert lk == pytest.approx(1 - r, rel=1e-4)


def test_lspr_scan_brackets_resonances_above_six_ev():
    from eccl.materials import plasmonics

    out = call("POST", "/api/plasmonics/sphere", {"metal": "Al", "medium_eps": 1.77})
    m = plasmonics.get_metal("Al")
    frohlich = m.wp_ev / math.sqrt(m.eps_inf + 2 * 1.77)
    assert out["lspr"]["resonance_ev"] > 6.0
    assert out["lspr"]["resonance_ev"] == pytest.approx(frohlich, rel=0.01)
    assert out["lspr"]["fwhm_ev"] == pytest.approx(m.gamma_ev, rel=0.2)  # not scan-quantised
    v = out["validity"]
    has_keys(v, "size_parameter", "dipole_limit_nm2", "exceeds_dipole_limit", "ok", "model")
    small = call("POST", "/api/plasmonics/sphere", {"metal": "Au", "radius_nm": 3})["validity"]
    assert small["ok"] is True and small["size_parameter"] < 0.3
    big = call("POST", "/api/plasmonics/sphere", {"metal": "Ag", "radius_nm": 40})["validity"]
    assert big["ok"] is False and big["exceeds_dipole_limit"] is True


def _xrd(formula: str, a: float, structure: str, z: int) -> dict[tuple[int, ...], float]:
    out = call("POST", "/api/crystal/xrd", {"formula": formula, "a": a, "structure": structure,
                                            "formula_units": z})
    assert "structure factors" in out["pattern"]["intensity_model"]
    for r in out["reflections"]:
        assert r["hkl"] == sorted(r["hkl"], reverse=True)  # conventional label, e.g. (2 0 0)
    return {tuple(r["hkl"]): r["rel_intensity"] for r in out["reflections"]}


def test_xrd_intensities_use_structure_factors():
    nacl = _xrd("NaCl", 5.64, "rocksalt", 4)
    assert nacl[(2, 0, 0)] == 100 and nacl[(1, 1, 1)] < 25 and nacl[(3, 1, 1)] < 10
    assert nacl[(2, 2, 0)] > nacl[(2, 2, 2)] > nacl[(1, 1, 1)]
    si = _xrd("Si", 5.431, "diamond", 8)
    assert si[(1, 1, 1)] == 100 and si[(2, 2, 0)] > si[(3, 1, 1)]
    assert (2, 0, 0) not in si and (2, 2, 2) not in si  # diamond-glide extinctions
    cu = _xrd("Cu", 3.615, "fcc", 4)
    assert cu[(1, 1, 1)] == 100 and (1, 0, 0) not in cu and (1, 1, 0) not in cu
    fe = _xrd("Fe", 2.866, "bcc", 2)
    assert fe[(1, 1, 0)] == 100 and (1, 0, 0) not in fe


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_notebook_import_reports_added_and_updated_and_rejects_deep_payloads():
    exported = call("GET", "/api/notebook/export")
    count = call("GET", "/api/notebook")["count"]
    again = call("POST", "/api/notebook/import", {"data": exported})
    assert again["added"] == 0 and again["updated"] == again["imported"] == len(exported["records"])
    assert again["count"] == count
    fresh = call("POST", "/api/notebook/import", {"data": {"records": [
        {"kind": "note", "id": "note-fresh0001", "payload": {"text": "x"}, "tags": []}]}})
    assert fresh["added"] == 1 and fresh["updated"] == 0 and fresh["count"] == count + 1
    deep: dict[str, Any] = {}
    cur = deep
    for _ in range(api.MAX_PAYLOAD_DEPTH + 5):
        cur["a"] = {}
        cur = cur["a"]
    with pytest.raises(api.ValidationError, match="nested too deeply"):
        call("POST", "/api/notebook/import", {"data": {"records": [
            {"kind": "note", "id": "deep-1", "payload": deep}]}})
    call("GET", "/api/notebook")  # still lists fine
    call("POST", "/api/notebook/delete", {"id": "note-fresh0001"})


def test_job_cap_returns_429_and_jobs_carry_labels(monkeypatch):
    from eccl.gui.jobs import TooManyJobs, job_label

    assert job_label("search", {"query": "  perovskite \n stability "}) == "perovskite stability"
    assert job_label("campaign", {"title": "t", "population": 4}) == "t"
    assert job_label("evolve", {"population": 30, "generations": 12}) == "30×12"
    assert len(job_label("search", {"query": "x" * 200})) == 80

    release = threading.Event()
    mgr = JobManager(max_workers=1, max_active=2)
    try:
        ids = [mgr.submit("evolve", {}, lambda ctx: release.wait(10)) for _ in range(2)]
        with pytest.raises(TooManyJobs):
            mgr.submit("evolve", {}, lambda ctx: None)
        monkeypatch.setattr(api, "JOBS", mgr)
        with pytest.raises(api.ApiError) as exc:
            call("POST", "/api/evolve/start", TINY_EVOLVE)
        assert exc.value.status == 429
        assert {j["label"] for j in call("GET", "/api/jobs")["jobs"]} == {"evolve"}
    finally:
        release.set()
        for jid in ids:
            mgr.wait(jid, 10)
        mgr.shutdown(wait=True)


@pytest.mark.skipif(not have_rdkit(), reason="needs rdkit")
def test_evolve_results_report_found_generation_separately_from_lineage_depth():
    rec = wait_job(call("POST", "/api/evolve/start", TINY_EVOLVE)["job_id"])
    assert rec["status"] == "done", rec["error"]
    res = rec["result"]
    gens = len(res["history"])
    for ind in [res["best"], *res["hall_of_fame"]]:
        has_keys(ind, "smiles", "fitness", "generation", "lineage_depth", "found_generation",
                 "breakdown", "svg")
        assert ind["lineage_depth"] == ind["generation"]
        assert 0 <= ind["found_generation"] <= gens
        assert (ind["found_generation"] == 0) == (ind["lineage_depth"] == 0)
    assert any(j["id"] == rec["id"] and j["label"] == "8×3" for j in call("GET", "/api/jobs")["jobs"])


def test_bound_loopback_alias_is_an_allowed_host():
    try:
        server, url = make_server(host="127.0.0.2", port=0)
    except OSError:
        pytest.skip("127.0.0.2 is not bindable here")
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                              daemon=True)
    thread.start()
    try:
        c = Client(server)
        port = server.server_address[1]
        assert c.json("GET", "/api/health", headers={"Host": f"127.0.0.2:{port}"})[0] == 200
        assert c.json("GET", "/api/health", headers={"Host": f"127.0.0.3:{port}"})[0] == 403
        assert c.json("GET", "/api/health", headers={"Host": "evil.example"})[0] == 403
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------- CLI / launch
def test_cli_gui_subcommand_calls_launch(monkeypatch, capsys):
    import eccl.gui
    from eccl.cli import main

    calls = []
    monkeypatch.setattr(eccl.gui, "launch", lambda **kw: calls.append(kw))
    assert main(["gui", "--host", "127.0.0.1", "--port", "0", "--no-browser"]) == 0
    assert calls == [{"host": "127.0.0.1", "port": 0, "open_browser": False}]
    assert capsys.readouterr().out == ""  # not routed through the JSON printer

    def busy(**kw):
        raise OSError(98, "Address already in use")

    monkeypatch.setattr(eccl.gui, "launch", busy)
    assert main(["gui", "--port", "8765"]) == 1
    assert "Address already in use" in capsys.readouterr().err


def test_python_m_entry_point_calls_launch(monkeypatch):
    import eccl.gui
    from eccl.gui.__main__ import main

    calls = []
    monkeypatch.setattr(eccl.gui, "launch", lambda **kw: calls.append(kw))
    assert main(["--port", "9999"]) == 0
    assert calls == [{"host": "127.0.0.1", "port": 9999, "open_browser": True}]


def test_launch_prints_url_and_shuts_down_on_ctrl_c(monkeypatch, capsys):
    from eccl.gui import server as srv

    def interrupted(self, poll_interval=0.5):
        raise KeyboardInterrupt

    shutdowns = []
    monkeypatch.setattr(srv.GUIServer, "serve_forever", interrupted)
    monkeypatch.setattr(api.JOBS, "shutdown", lambda wait=False: shutdowns.append(wait))
    srv.launch(port=0, open_browser=False)
    out = capsys.readouterr().out
    assert "http://127.0.0.1:" in out and shutdowns == [False]


# ---------------------------------------------------------------- signals
def test_gui_entry_points_restore_the_signal_mask(monkeypatch):
    # the entry points block SIGINT/SIGTERM while serving; they must restore the
    # caller's mask afterwards (otherwise Ctrl-C stays blocked, e.g. in pytest)
    import signal

    import eccl.gui
    from eccl.cli import main as cli_main
    from eccl.gui import _signals
    from eccl.gui.__main__ import main as gui_main

    monkeypatch.setattr(eccl.gui, "launch", lambda **kw: None)
    assert cli_main(["gui", "--port", "0", "--no-browser"]) == 0
    assert gui_main(["--port", "0", "--no-browser"]) == 0
    assert _signals.blocked_early() is False
    if hasattr(signal, "pthread_sigmask"):
        current = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        assert signal.SIGINT not in current and signal.SIGTERM not in current


@pytest.mark.skipif(not hasattr(__import__("signal"), "pthread_sigmask"),
                    reason="POSIX signal masks required")
@pytest.mark.parametrize("signame", ["SIGINT", "SIGTERM"])
def test_server_stops_on_signal_while_a_job_is_running(signame):
    """Regression: RDKit swaps the SIGINT handler during substructure matching,
    so a busy server used to ignore Ctrl-C. The entry point now blocks the
    signals early and takes them with sigwait()."""
    import os
    import re
    import signal
    import subprocess
    import sys

    proc = subprocess.Popen([sys.executable, "-u", "-m", "eccl.gui", "--port", "0", "--no-browser"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        line = proc.stdout.readline()
        m = re.search(r"http://127\.0\.0\.1:(\d+)/", line)
        assert m, f"no URL in {line!r}"
        conn = http.client.HTTPConnection("127.0.0.1", int(m.group(1)), timeout=10)
        conn.request("POST", "/api/evolve/start", body=json.dumps({
            "objectives": {"druglike": {"weight": 1}}, "population": 40,
            "generations": 500, "use_gate": True}),
            headers={"Content-Type": "application/json"})
        job_id = json.loads(conn.getresponse().read())["job_id"]
        for _ in range(100):  # wait until the job is inside the GA loop
            conn.request("GET", f"/api/jobs/{job_id}")
            if json.loads(conn.getresponse().read())["events_total"] > 0:
                break
            time.sleep(0.1)
        conn.close()
        os.kill(proc.pid, getattr(signal, signame))
        out, _ = proc.communicate(timeout=15)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert proc.returncode == 0
    assert "shutting down" in out
    assert "terminate called" not in out
