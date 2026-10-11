"""JSON API for the ECCL GUI: plain handler functions plus a route table.

Every handler takes a :class:`Request` and returns a JSON-able dict; the HTTP
layer (:mod:`eccl.gui.server`) owns transport, security and status codes.
Chart curves are produced by *sampling the engine's own functions* - no physics
is re-implemented here. :func:`dispatch` resolves a route, calls the handler
and sanitises the result (inf/nan -> None, tuples -> lists, numpy -> Python),
so the API can be exercised without HTTP.

Process-wide state: one :class:`~eccl.lab.Workbench` (lazy LLM) whose notebook
is lock-guarded, and one :class:`~eccl.gui.jobs.JobManager`.
"""
from __future__ import annotations

import dataclasses
import enum
import functools
import math
import re
import threading
import time
from dataclasses import dataclass, field
from itertools import permutations, product
from typing import Any, Callable

import numpy as np

from .. import __version__
from ..chem.reactions import BalancedReaction, balance, stoichiometry
from ..chem.similarity import diversity, tanimoto
from ..config import DEFAULT
from ..core import formula as formula_mod
from ..core.elements import ELEMENTS
from ..core.material import Material
from ..core.molecule import Molecule, MoleculeError, have_rdkit
from ..core.registry import LabNotebook, Record
from ..core.units import EV, K_B, ev_to_nm, nm_to_ev
from ..critics.gate import Harshness
from ..evolve import fitness
from ..evolve.engine import EvolutionConfig, EvolutionResult, Individual
from ..evolve.fitness import WeightedObjective
from ..evolve.genome import MoleculeGenome
from ..lab import DiscoveryCampaign, Workbench
from ..llm.base import LLMClient, Message
from ..llm.echo import EchoClient
from ..llm.manager import get_client
from ..materials import crystal, photonics, plasmonics, quantum, semiconductor
from ..search.deep import DeepSearch
from ..search.providers import DEFAULT_PROVIDERS
from ..spectro import (
    cross_validate,
    estimate_uvvis_lambda_max,
    interpret_mass_spectrum,
    interpret_peaks,
    simulate_ir,
    simulate_powder_xrd,
    tables,
)
from ..spectro.interpret import Assignment, Interpretation, _summarise
from .jobs import JobContext, JobManager, TooManyJobs, UnknownJob


# --------------------------------------------------------------------------
# errors & request
# --------------------------------------------------------------------------
class ApiError(Exception):
    """An error carrying an explicit HTTP status."""

    status = 400

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        if status is not None:
            self.status = status


class ValidationError(ApiError):
    """Invalid client input (HTTP 400)."""

    status = 400


class Forbidden(ApiError):
    status = 403


class NotFound(ApiError):
    status = 404


class MethodNotAllowed(ApiError):
    status = 405

    def __init__(self, message: str, allowed: list[str]) -> None:
        super().__init__(message)
        self.allowed = allowed


class PayloadTooLarge(ApiError):
    status = 413


@dataclass
class Request:
    """What a handler sees: the JSON body, query-string values and path params."""

    body: dict[str, Any] = field(default_factory=dict)
    query: dict[str, str] = field(default_factory=dict)
    params: dict[str, str] = field(default_factory=dict)


Handler = Callable[[Request], dict[str, Any]]


# --------------------------------------------------------------------------
# JSON sanitiser
# --------------------------------------------------------------------------
def to_jsonable(obj: Any) -> Any:
    """Convert to strict-JSON-safe Python: inf/nan -> None, tuples/sets -> lists,
    numpy scalars/arrays -> Python numbers/lists, objects with ``as_dict``/``to_dict``
    -> dicts, non-string keys -> strings."""
    if obj is None or isinstance(obj, (str, bool)):
        return obj
    if isinstance(obj, int):  # includes IntEnum
        return int(obj)
    if isinstance(obj, float):  # includes np.float64
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, dict):
        return {(k if isinstance(k, str) else str(to_jsonable(k))): to_jsonable(v)
                for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return to_jsonable(obj.tolist())
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return to_jsonable(float(obj))
    if isinstance(obj, (complex, np.complexfloating)):
        return {"re": to_jsonable(float(obj.real)), "im": to_jsonable(float(obj.imag))}
    for attr in ("as_dict", "to_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            return to_jsonable(fn())
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_jsonable(dataclasses.asdict(obj))
    if isinstance(obj, enum.Enum):
        return obj.name
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    return str(obj)


# --------------------------------------------------------------------------
# input validation helpers
# --------------------------------------------------------------------------
_MISSING: Any = object()
MAX_POINTS = 2000
MIN_POINTS = 2
_MAX_INT = 2 ** 63
MAX_SMILES_LEN = 1000      # longer strings are rejected (400) before any RDKit work
MAX_DEPICT_ATOMS = 250     # 2-D depiction cost grows steeply with size; skip beyond this
MAX_PAYLOAD_DEPTH = 64     # nesting limit for imported notebook payloads


def _is_blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _coerce_num(raw: Any, label: str, lo: float | None, hi: float | None,
                integer: bool) -> float | int:
    if isinstance(raw, bool):
        raise ValidationError(f"'{label}' must be a number, not a boolean")
    if isinstance(raw, int) and abs(raw) > _MAX_INT:  # JSON allows arbitrarily long integers
        raise ValidationError(f"'{label}' is out of range")
    if integer and isinstance(raw, int):
        val: float | int = raw
    else:
        try:
            val = float(raw.strip() if isinstance(raw, str) else raw)
        except (TypeError, ValueError, OverflowError):
            raise ValidationError(f"'{label}' must be a number (got {str(raw)[:40]!r})") from None
        if not math.isfinite(val):
            raise ValidationError(f"'{label}' must be a finite number")
        if integer:
            if val != int(val):
                raise ValidationError(f"'{label}' must be an integer (got {val:g})")
            val = int(val)
    if (lo is not None and val < lo) or (hi is not None and val > hi):
        if lo is not None and hi is not None:
            rng = f"between {lo:g} and {hi:g}"
        elif lo is not None:
            rng = f">= {lo:g}"
        else:
            rng = f"<= {hi:g}"
        raise ValidationError(f"'{label}' must be {rng} (got {val:g})")
    return val


def _num(body: dict[str, Any], key: str, default: Any = _MISSING, *,
         lo: float | None = None, hi: float | None = None, integer: bool = False,
         label: str | None = None) -> Any:
    """Read a number (numeric strings like ``"1e17"`` accepted); blank -> default."""
    raw = body.get(key)
    if _is_blank(raw):
        if default is _MISSING:
            raise ValidationError(f"missing required field '{label or key}'")
        return default
    return _coerce_num(raw, label or key, lo, hi, integer)


def _points(body: dict[str, Any], default: int, key: str = "points") -> int:
    """Sample count, coerced to int and clamped to [MIN_POINTS, MAX_POINTS]."""
    raw = body.get(key)
    if _is_blank(raw):
        n = default
    else:
        n = int(round(_coerce_num(raw, key, None, None, False)))
    return max(MIN_POINTS, min(MAX_POINTS, n))


def _clamp_int(body: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    raw = body.get(key)
    n = default if _is_blank(raw) else int(round(_coerce_num(raw, key, None, None, False)))
    return max(lo, min(hi, n))


def _bool(body: dict[str, Any], key: str, default: bool) -> bool:
    raw = body.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)) and raw in (0, 1):
        return bool(raw)
    if isinstance(raw, str) and raw.strip().lower() in ("true", "1", "yes", "on"):
        return True
    if isinstance(raw, str) and raw.strip().lower() in ("false", "0", "no", "off", ""):
        return False
    raise ValidationError(f"'{key}' must be true or false (got {raw!r})")


def _str(body: dict[str, Any], key: str, default: Any = _MISSING, *,
         max_len: int = 5000) -> Any:
    raw = body.get(key)
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = str(raw)
    if _is_blank(raw):
        if default is _MISSING:
            raise ValidationError(f"missing required field '{key}'")
        return default
    if not isinstance(raw, str):
        raise ValidationError(f"'{key}' must be a string")
    raw = raw.strip()
    if len(raw) > max_len:
        raise ValidationError(f"'{key}' is too long (max {max_len} characters)")
    return raw


def _str_list(body: dict[str, Any], key: str, default: Any = _MISSING, *,
              max_items: int = 500, max_len: int = 5000) -> Any:
    """A list of non-empty strings; a single string is split on commas/whitespace."""
    raw = body.get(key)
    if raw is None:
        if default is _MISSING:
            raise ValidationError(f"missing required field '{key}'")
        return default
    if isinstance(raw, str):
        raw = [s for s in re.split(r"[\s,]+", raw) if s]
    if not isinstance(raw, list):
        raise ValidationError(f"'{key}' must be a list of strings")
    out: list[str] = []
    for i, item in enumerate(raw):
        if not isinstance(item, str):
            raise ValidationError(f"'{key}[{i}]' must be a string")
        item = item.strip()
        if not item:
            continue
        if len(item) > max_len:
            raise ValidationError(f"'{key}[{i}]' is too long (max {max_len} characters)")
        out.append(item)
    if len(out) > max_items:
        raise ValidationError(f"'{key}' has {len(out)} entries; the maximum is {max_items}")
    return out


def _choice(value: Any, options: list[str], label: str) -> str:
    """Case-insensitive match against ``options``; returns the canonical spelling."""
    if isinstance(value, str):
        wanted = value.strip().lower()
        for opt in options:
            if opt.lower() == wanted:
                return opt
    raise ValidationError(f"unknown {label} {value!r}; valid {label} values: "
                          f"{', '.join(options)}")


def _smiles(body: dict[str, Any], key: str = "smiles") -> str:
    return _str(body, key, max_len=MAX_SMILES_LEN)


def _harshness(body: dict[str, Any], default: str = "HARSH") -> str:
    raw = body.get("harshness")
    if _is_blank(raw):
        return default
    return _choice(raw, [h.name for h in Harshness], "harshness")


def _semiconductor(value: Any, label: str = "semiconductor") -> str:
    if _is_blank(value):
        raise ValidationError(f"missing required field '{label}'; valid: "
                              f"{', '.join(semiconductor.LIBRARY)}")
    # accept the library key ("SiC") or the long label ("SiC-4H")
    aliases = {p.name: k for k, p in semiconductor.LIBRARY.items()}
    if isinstance(value, str) and value.strip() in aliases:
        return aliases[value.strip()]
    return _choice(value, list(semiconductor.LIBRARY), label)


def _metal(value: Any) -> str:
    if _is_blank(value):
        raise ValidationError(f"missing required field 'metal'; valid: "
                              f"{', '.join(plasmonics.METALS)}")
    return _choice(value, list(plasmonics.METALS), "metal")


def _sellmeier(value: Any) -> str:
    if _is_blank(value):
        raise ValidationError(f"missing required field 'material'; valid: "
                              f"{', '.join(sorted(photonics.SELLMEIER))}")
    return _choice(value, sorted(photonics.SELLMEIER), "material")


def _ion(value: Any, label: str) -> str:
    if _is_blank(value):
        raise ValidationError(f"missing required field '{label}'; valid ions: "
                              f"{', '.join(crystal.IONIC_RADII)}")
    return _choice(value, list(crystal.IONIC_RADII), label)


_MODALITY_ALIASES = {
    "ir": "IR", "infrared": "IR", "ftir": "IR", "raman": "raman",
    "1h": "1H", "hnmr": "1H", "proton": "1H",
    "13c": "13C", "cnmr": "13C", "carbon": "13C",
}
SPECTRO_MODALITIES = ["IR", "raman", "1H", "13C"]


def _modality(value: Any) -> str:
    if isinstance(value, str) and value.strip().lower() in _MODALITY_ALIASES:
        return _MODALITY_ALIASES[value.strip().lower()]
    raise ValidationError(f"unknown modality {value!r}; valid modality values: "
                          f"{', '.join(SPECTRO_MODALITIES)}")


def _peaks(body: dict[str, Any], key: str, max_items: int = 500) -> list[float]:
    """A non-empty list of finite numbers (a string of numbers is split too)."""
    raw = body.get(key)
    if isinstance(raw, str):
        raw = [s for s in re.split(r"[\s,;]+", raw) if s]
    if not isinstance(raw, list) or not raw:
        raise ValidationError(f"'{key}' must be a non-empty list of numbers")
    if len(raw) > max_items:
        raise ValidationError(f"'{key}' has {len(raw)} values; the maximum is {max_items}")
    return [float(_coerce_num(v, f"{key}[{i}]", None, None, False)) for i, v in enumerate(raw)]


def _tags(body: dict[str, Any]) -> list[str]:
    return _str_list(body, "tags", [], max_items=20, max_len=60)


def _ordered(body: dict[str, Any], lo_key: str, hi_key: str, lo_default: float,
             hi_default: float, lo: float, hi: float) -> tuple[float, float]:
    a = _num(body, lo_key, lo_default, lo=lo, hi=hi)
    b = _num(body, hi_key, hi_default, lo=lo, hi=hi)
    if b <= a:
        raise ValidationError(f"'{hi_key}' must be greater than '{lo_key}'")
    return float(a), float(b)


# --------------------------------------------------------------------------
# numeric / sampling helpers
# --------------------------------------------------------------------------
def _sig(x: Any, digits: int = 6) -> float | None:
    """Round to ``digits`` significant figures; None/non-finite -> None."""
    if x is None:
        return None
    x = float(x)
    if not math.isfinite(x):
        return None
    if x == 0:
        return 0.0
    return float(f"{x:.{digits}g}")


def _sigs(xs: Any, digits: int = 6) -> list[float | None]:
    return [_sig(x, digits) for x in xs]


def _linspace(lo: float, hi: float, n: int) -> list[float]:
    return np.linspace(lo, hi, n).tolist()


def _downsample(x: list[float], y: list[float], max_points: int = 600
                ) -> tuple[list[float], list[float]]:
    n = len(x)
    if n <= max_points:
        return list(x), list(y)
    idx = np.unique(np.linspace(0, n - 1, max_points).round().astype(int))
    return [x[i] for i in idx], [y[i] for i in idx]


def _whole(v: float) -> float | int:
    return int(v) if float(v).is_integer() else v


# --------------------------------------------------------------------------
# depiction
# --------------------------------------------------------------------------
def mol_svg(smiles: str, width: int = 320, height: int = 240) -> str | None:
    """RDKit 2-D depiction as an SVG string (transparent background).

    None without RDKit, or when the molecule has more than ``MAX_DEPICT_ATOMS``
    atoms (layout time grows steeply and holds the GIL, stalling every request).
    """
    if not have_rdkit():
        return None
    from rdkit.Chem.Draw import rdMolDraw2D

    mol = Molecule.from_smiles(smiles)  # MoleculeError on bad input
    if mol.rdmol.GetNumAtoms() > MAX_DEPICT_ATOMS:
        return None
    drawer = rdMolDraw2D.MolDraw2DSVG(int(width), int(height))
    drawer.drawOptions().clearBackground = False
    rdMolDraw2D.PrepareAndDrawMolecule(drawer, mol.rdmol)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText()
    if svg.startswith("<?xml"):
        svg = svg[svg.index("?>") + 2:].lstrip()
    return svg


def _safe_svg(smiles: str, width: int = 260, height: int = 200) -> str | None:
    try:
        return mol_svg(smiles, width, height)
    except Exception:  # noqa: BLE001 - a depiction failure must not sink a job
        return None


# --------------------------------------------------------------------------
# process-wide state
# --------------------------------------------------------------------------
class LockedNotebook(LabNotebook):
    """A :class:`LabNotebook` whose reads and writes are serialised by a re-entrant lock."""

    def __init__(self, name: str = "lab") -> None:
        super().__init__(name)
        self.lock = threading.RLock()

    def add_molecule(self, mol: Molecule, tags: list[str] | None = None) -> str:
        with self.lock:
            return super().add_molecule(mol, tags)

    def add_material(self, mat: Material, tags: list[str] | None = None) -> str:
        with self.lock:
            return super().add_material(mat, tags)

    def add_run(self, payload: dict[str, Any], tags: list[str] | None = None) -> str:
        with self.lock:
            return super().add_run(payload, tags)

    def add_note(self, text: str, tags: list[str] | None = None) -> str:
        with self.lock:
            return super().add_note(text, tags)

    def get(self, rid: str) -> Record:
        with self.lock:
            return super().get(rid)

    def all(self, kind: str | None = None) -> list[Record]:
        with self.lock:
            return super().all(kind)

    def find_by_tag(self, tag: str) -> list[Record]:
        with self.lock:
            return super().find_by_tag(tag)

    def load_molecule(self, rid: str) -> Molecule:
        with self.lock:
            return super().load_molecule(rid)

    def load_material(self, rid: str) -> Material:
        with self.lock:
            return super().load_material(rid)

    def to_dict(self) -> dict[str, Any]:
        with self.lock:
            return super().to_dict()

    def __len__(self) -> int:
        with self.lock:
            return super().__len__()

    def delete(self, rid: str) -> None:
        with self.lock:
            if rid not in self._records:
                raise KeyError(rid)
            del self._records[rid]

    def import_records(self, records: list[Record], merge: bool = True) -> int:
        """Add (or, with ``merge=False``, replace everything with) ``records``."""
        with self.lock:
            if not merge:
                self._records.clear()
            for rec in records:
                self._records[rec.id] = rec
            return len(self._records)


WORKBENCH = Workbench(config=dataclasses.replace(DEFAULT))
WORKBENCH.notebook = LockedNotebook("workbench")
NOTEBOOK_LOCK = WORKBENCH.notebook.lock
JOBS = JobManager(max_workers=2, keep_finished=50, max_active=12)
_LLM_LOCK = threading.Lock()


def _submit(kind: str, params: dict[str, Any], fn: Callable[[JobContext], Any]) -> str:
    """Queue a background job; a full queue is HTTP 429 rather than unbounded growth."""
    try:
        return JOBS.submit(kind, params, fn)
    except TooManyJobs as e:
        raise ApiError(str(e), 429) from None


def _notebook() -> LockedNotebook:
    return WORKBENCH.notebook  # type: ignore[return-value]


def _llm() -> LLMClient:
    """The Workbench's (lazily created) LLM client."""
    with _LLM_LOCK:
        return WORKBENCH.llm


def _llm_status() -> dict[str, Any]:
    client = _llm()
    return {
        "backend": client.name,
        "model": getattr(client, "model", None),
        "reachable": not isinstance(client, EchoClient),
        "configured_backend": WORKBENCH.config.llm_backend,
        "base_url": getattr(client, "base_url", None),
        # what was requested, kept even when the client fell back to echo
        "configured_base_url": WORKBENCH.config.llm_base_url,
        "configured_model": WORKBENCH.config.llm_model,
    }


# --------------------------------------------------------------------------
# reference data
# --------------------------------------------------------------------------
STRUCTURES = ["diamond", "zincblende", "rocksalt", "fcc", "bcc", "perovskite", "simple"]
LLM_BACKENDS = ["auto", "ollama", "openai", "echo"]

PRESETS: dict[str, Any] = {
    "molecules": {
        "aspirin": "CC(=O)Oc1ccccc1C(=O)O",
        "caffeine": "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",
        "ibuprofen": "CC(C)Cc1ccc(cc1)C(C)C(=O)O",
        "paracetamol": "CC(=O)Nc1ccc(O)cc1",
        "penicillin G": "CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)Cc3ccccc3)C(=O)O)C",
        "benzene": "c1ccccc1",
        "ethanol": "CCO",
        "nitrobenzene": "O=[N+]([O-])c1ccccc1",
        "naphthalene": "c1ccc2ccccc2c1",
        "hexatriene": "C=CC=CC=C",
    },
    "reactions": [
        {"name": "Propane combustion", "reactants": ["C3H8", "O2"], "products": ["CO2", "H2O"]},
        {"name": "Permanganate + HCl", "reactants": ["KMnO4", "HCl"],
         "products": ["KCl", "MnCl2", "H2O", "Cl2"]},
        {"name": "Rusting", "reactants": ["Fe", "O2"], "products": ["Fe2O3"]},
        {"name": "Photosynthesis", "reactants": ["CO2", "H2O"], "products": ["C6H12O6", "O2"]},
        {"name": "Thermite", "reactants": ["Al", "Fe2O3"], "products": ["Al2O3", "Fe"]},
    ],
    "spectra": [
        {"name": "Carboxylic acid (IR)", "modality": "IR", "peaks": [3000, 1715, 1280, 940]},
        {"name": "Aromatic ester (IR)", "modality": "IR",
         "peaks": [3050, 2950, 1740, 1600, 1250, 750]},
        {"name": "Graphene (Raman)", "modality": "raman", "peaks": [1350, 1582, 2690]},
        {"name": "Acid + aromatic (1H)", "modality": "1H", "peaks": [1.2, 2.1, 7.3, 11.6]},
        {"name": "Ester (13C)", "modality": "13C", "peaks": [14, 61, 128, 170]},
    ],
    "perovskites": [
        {"name": "CsPbI3", "a": "Cs+", "b": "Pb2+", "x": "I-"},
        {"name": "MAPbI3", "a": "MA+", "b": "Pb2+", "x": "I-"},
        {"name": "FAPbI3", "a": "FA+", "b": "Pb2+", "x": "I-"},
        {"name": "SrTiO3", "a": "Sr2+", "b": "Ti4+", "x": "O2-"},
        {"name": "BaTiO3", "a": "Ba2+", "b": "Ti4+", "x": "O2-"},
        {"name": "CsSnBr3", "a": "Cs+", "b": "Sn2+", "x": "Br-"},
    ],
    "crystals": [
        {"name": "Silicon", "formula": "Si", "a": 5.431, "structure": "diamond", "formula_units": 8},
        {"name": "GaAs", "formula": "GaAs", "a": 5.653, "structure": "zincblende", "formula_units": 4},
        {"name": "NaCl", "formula": "NaCl", "a": 5.640, "structure": "rocksalt", "formula_units": 4},
        {"name": "SrTiO3", "formula": "SrTiO3", "a": 3.905, "structure": "perovskite",
         "formula_units": 1},
        {"name": "Copper", "formula": "Cu", "a": 3.615, "structure": "fcc", "formula_units": 4},
        {"name": "Iron (alpha)", "formula": "Fe", "a": 2.866, "structure": "bcc", "formula_units": 2},
    ],
}


def _libraries() -> dict[str, Any]:
    return {
        "semiconductors": [
            {"name": key, "label": p.name, "eg_300k": p.eg_300k, "direct_gap": p.direct_gap,
             "me_eff": p.me_eff, "mh_eff": p.mh_eff, "eps_r": p.eps_r}
            for key, p in semiconductor.LIBRARY.items()
        ],
        "metals": [
            {"name": key, "wp_ev": m.wp_ev, "gamma_ev": m.gamma_ev, "eps_inf": m.eps_inf}
            for key, m in plasmonics.METALS.items()
        ],
        "sellmeier": sorted(photonics.SELLMEIER),
        "ionic_radii": dict(crystal.IONIC_RADII),
        "structures": list(STRUCTURES),
        "spectro_modalities": list(SPECTRO_MODALITIES),
        "harshness": [h.name for h in Harshness],
        "search_providers": list(DEFAULT_PROVIDERS),
        "llm_backends": list(LLM_BACKENDS),
    }


# --------------------------------------------------------------------------
# general
# --------------------------------------------------------------------------
def health(req: Request) -> dict[str, Any]:
    return {"ok": True}


def info(req: Request) -> dict[str, Any]:
    return {
        "version": __version__,
        "rdkit": have_rdkit(),
        "llm": _llm_status(),
        "config": WORKBENCH.config.as_dict(),
        "libraries": _libraries(),
        "presets": PRESETS,
    }


# --------------------------------------------------------------------------
# chemistry
# --------------------------------------------------------------------------
# IR reference groups that need a heteroatom; used to drop structurally impossible
# candidates (e.g. "C-F stretch" for a molecule without fluorine).
_IR_GROUP_ELEMENTS: dict[str, tuple[str, ...]] = {
    "alcohol/phenol": ("O",), "alcohol/acid": ("O",), "carboxylic acid": ("O",),
    "carbonyl (general)": ("O",), "ester": ("O",), "ketone/aldehyde": ("O",),
    "alcohol/ether/ester": ("O",), "amine/amide": ("N",), "amide": ("N", "O"),
    "nitrile": ("N",), "cumulene/azide": ("N",), "nitro": ("N", "O"),
    "amine (aromatic)": ("N",), "amine (aliphatic)": ("N",), "thiol": ("S",),
    "fluoride": ("F",), "chloride": ("Cl",), "bromide": ("Br",),
}


def _structure_aware(interp: Interpretation, elements: set[str]) -> dict[str, Any]:
    """Drop IR assignments whose group needs an element the molecule lacks.

    The engine matches peaks against the reference table without seeing the
    structure; when the structure is known (simulated spectra) the impossible
    candidates are removed, the groups and summary recomputed, and the removed
    candidates reported under ``structure_filter.excluded``.
    """
    kept: list[Assignment] = []
    excluded: list[dict[str, Any]] = []
    for a in interp.assignments:
        missing = [e for e in _IR_GROUP_ELEMENTS.get(a.group, ()) if e not in elements]
        if missing:
            excluded.append({"peak": a.peak, "assignment": a.assignment, "group": a.group,
                             "missing_elements": missing})
        else:
            kept.append(a)
    assigned = {a.peak for a in kept}
    unassigned = sorted(set(interp.unassigned) | {a.peak for a in interp.assignments
                                                  if a.peak not in assigned})
    groups = sorted({a.group for a in kept})
    out = Interpretation(modality=interp.modality, assignments=kept, unassigned=unassigned,
                         functional_groups=groups,
                         summary=_summarise(interp.modality, kept, unassigned, groups)).as_dict()
    out["structure_filter"] = {"elements": sorted(elements), "excluded": excluded}
    return out


def _ir_block(mol: Molecule) -> tuple[dict[str, Any], dict[str, Any]]:
    sp = simulate_ir(mol)
    x, y = _downsample(sp.x, sp.y, 600)
    ir = {"x": _sigs(x), "y": _sigs(y, 5), "peaks": sp.peaks,
          "x_label": sp.x_label, "y_label": sp.y_label}
    return ir, _structure_aware(interpret_peaks(sp.peaks, "IR"), set(mol.formula_counts))


def _uvvis_block(mol: Molecule) -> dict[str, Any]:
    """The engine's Kuhn estimate plus an applicability flag and caveat.

    The free-electron (Kuhn) box model is calibrated for linear all-carbon
    polyenes. It counts every conjugated bond as one straight chain, so aromatic
    rings, heteroatom conjugation (C=O, N, O) and separate pi systems push the
    estimate far too long (aspirin ~830 nm, although it absorbs near 280 nm).
    """
    out = estimate_uvvis_lambda_max(mol)
    rd = mol.rdmol
    conj = [bd for bd in rd.GetBonds()
            if bd.GetIsConjugated() or bd.GetIsAromatic() or str(bd.GetBondType()) == "DOUBLE"]
    # connected pi systems (bonds joined through shared atoms)
    parent: dict[int, int] = {}

    def find(i: int) -> int:
        while parent.setdefault(i, i) != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for bd in conj:
        parent[find(bd.GetBeginAtomIdx())] = find(bd.GetEndAtomIdx())
    systems = len({find(bd.GetBeginAtomIdx()) for bd in conj})
    aromatic = any(bd.GetIsAromatic() for bd in conj)
    hetero = any(at.GetAtomicNum() != 6 for bd in conj
                 for at in (bd.GetBeginAtom(), bd.GetEndAtom()))
    reasons = []
    if aromatic:
        reasons.append("aromatic rings")
    if hetero:
        reasons.append("heteroatom conjugation")
    if systems > 1:
        reasons.append(f"{systems} separate conjugated systems counted as one chain")
    out["conjugated_systems"] = systems
    out["model_applicable"] = bool(conj) and not reasons
    out["caveat"] = (None if not reasons else
                     "Kuhn polyene model applied to " + ", ".join(reasons) +
                     "; it overestimates λmax here (benzenoid and carbonyl "
                     "chromophores typically absorb below 300 nm).")
    return out


def molecule_analyze(req: Request) -> dict[str, Any]:
    b = req.body
    smiles = _smiles(b)
    harshness = _harshness(b)
    register = _bool(b, "register", True)
    mol = Molecule.from_smiles(smiles)  # fail fast (400) before anything is registered
    if not have_rdkit():
        gate = WORKBENCH.gate(harshness).review_molecule(mol).as_dict()
        rid = _notebook().add_molecule(mol, tags=["analyzed"]) if register else None
        return {"smiles": smiles, "input_smiles": smiles, "canonical_smiles": None,
                "formula": None, "molar_mass": None, "inchi_key": None,
                "svg": None, "descriptors": None, "drug_likeness": None, "gate": gate,
                "ir": None, "ir_interpretation": None, "uvvis": None, "record_id": rid}
    out = WORKBENCH.analyze_molecule(smiles, register=register)  # notebook is lock-guarded
    if harshness != str(WORKBENCH.config.harshness).upper():
        out["gate"] = WORKBENCH.gate(harshness).review_molecule(mol).as_dict()
    out["input_smiles"] = smiles
    out["canonical_smiles"] = mol.canonical_smiles()
    out["descriptors"] = out["drug_likeness"]["descriptors"]
    out["svg"] = mol_svg(smiles)
    out["ir"], out["ir_interpretation"] = _ir_block(mol)
    out["uvvis"] = _uvvis_block(mol)
    out.setdefault("record_id", None)
    return out


def molecule_depict(req: Request) -> dict[str, Any]:
    b = req.body
    smiles = _smiles(b)
    width = _clamp_int(b, "width", 320, 64, 1600)
    height = _clamp_int(b, "height", 240, 64, 1600)
    svg = mol_svg(smiles, width, height)
    out: dict[str, Any] = {"svg": svg}
    if svg is None and have_rdkit():
        out["note"] = f"not depicted: more than {MAX_DEPICT_ATOMS} atoms"
    return out


def molecule_similarity(req: Request) -> dict[str, Any]:
    b = req.body
    query = Molecule.from_smiles(_smiles(b, "query"))
    library = _str_list(b, "library", [], max_items=500, max_len=MAX_SMILES_LEN)
    results: list[dict[str, Any]] = []
    invalid: list[str] = []
    mols: list[Molecule] = []
    for smi in library:
        try:
            m = Molecule.from_smiles(smi)
        except MoleculeError:
            invalid.append(smi)
            continue
        mols.append(m)
        results.append({"smiles": smi, "canonical": m.canonical_smiles(),
                        "tanimoto": round(tanimoto(query, m), 4)})
    results.sort(key=lambda r: r["tanimoto"], reverse=True)
    return {"query": query.canonical_smiles(), "results": results,
            "diversity": diversity(mols) if len(mols) >= 2 else 0.0, "invalid": invalid}


def formula_info(req: Request) -> dict[str, Any]:
    f = _str(req.body, "formula", max_len=300)
    counts = formula_mod.parse_formula(f)
    if not any(n > 0 for n in counts.values()):
        raise ValidationError(f"formula {f!r} contains no atoms")
    return {
        "formula": f,
        "hill": formula_mod.hill_formula(counts),
        "counts": {el: _whole(n) for el, n in counts.items()},
        "molar_mass": round(formula_mod.molar_mass(counts), 4),
        "mass_fractions": {el: round(v, 6) for el, v in formula_mod.mass_fractions(counts).items()},
    }


def _species(body: dict[str, Any], key: str) -> list[str]:
    raw = body.get(key)
    if isinstance(raw, str):
        raw = [s for s in re.split(r"\s*(?:\+|,)\s*", raw.strip()) if s]
    items = _str_list({key: raw}, key, max_items=20, max_len=200)
    if not items:
        raise ValidationError(f"'{key}' needs at least one formula")
    return items


def _reaction_dict(rx: BalancedReaction) -> dict[str, Any]:
    d = rx.as_dict()
    for side in ("reactants", "products"):
        for term in d[side]:
            term["molar_mass"] = round(formula_mod.molar_mass(term["formula"]), 4)
    return d


def reaction_balance(req: Request) -> dict[str, Any]:
    rx = balance(_species(req.body, "reactants"), _species(req.body, "products"))
    return _reaction_dict(rx)


def reaction_stoichiometry(req: Request) -> dict[str, Any]:
    b = req.body
    reactants, products = _species(b, "reactants"), _species(b, "products")
    rx = balance(reactants, products)
    basis = _str(b, "basis", reactants[0], max_len=200)
    if basis not in reactants + products:
        raise ValidationError(f"basis {basis!r} is not in the reaction; choose one of: "
                              f"{', '.join(reactants + products)}")
    moles_in = _num(b, "moles", 1.0, lo=0, hi=1e15)
    moles = stoichiometry(rx, basis, moles_in)
    grams = {f: n * formula_mod.molar_mass(f) for f, n in moles.items()}
    return {
        "equation": rx.equation(),
        "basis": basis,
        "basis_moles": moles_in,
        "coefficients": {f: c for c, f in rx.reactants + rx.products},
        "moles": {f: _sig(n, 8) for f, n in moles.items()},
        "grams": {f: _sig(g, 8) for f, g in grams.items()},
    }


# --------------------------------------------------------------------------
# semiconductors
# --------------------------------------------------------------------------
def _params_dict(key: str) -> dict[str, Any]:
    p = semiconductor.get_params(key)
    d = dataclasses.asdict(p)
    d["label"] = p.name
    d["name"] = key
    return d


def _carriers(name: str, t: float, nd: float, na: float) -> dict[str, Any]:
    """Equilibrium carriers under full ionisation: n - p = Nd - Na and n p = ni^2.

    The same model as ``semiconductor.doped_carriers``, solved stably: the
    majority carrier comes from the root without cancellation (the textbook
    n = (net + sqrt(net^2 + 4 ni^2)) / 2 gives n = 0, p = inf for p-type
    material once |net| >> ni), and ln(ni) is used throughout so wide-gap
    materials at low temperature keep the majority carrier and the Fermi offset
    even when ni underflows.
    """
    p = semiconductor.get_params(name)
    kt_ev = K_B * t / EV
    ln_ni = (0.5 * (math.log(semiconductor.effective_dos(p.me_eff, t))
                    + math.log(semiconductor.effective_dos(p.mh_eff, t)))
             - semiconductor.varshni_bandgap(p, t) / (2.0 * kt_ev))
    ni = math.exp(ln_ni)  # may underflow to 0.0; ln_ni stays exact
    net = nd - na
    if net == 0:
        return {"n": ni, "p": ni, "n_i": ni, "fermi_offset_ev": 0.0}
    major = (abs(net) + math.hypot(net, 2.0 * ni)) / 2.0  # no cancellation; hypot cannot overflow
    minor = math.exp(2.0 * ln_ni - math.log(major))       # ni^2 / major without underflowing ni^2
    n, p_ = (major, minor) if net > 0 else (minor, major)
    offset = kt_ev * (math.log(major) - ln_ni)             # E_F - E_i, + for n-type
    return {"n": n, "p": p_, "n_i": ni, "fermi_offset_ev": round(offset if net > 0 else -offset, 4)}


def semiconductor_analyze(req: Request) -> dict[str, Any]:
    b = req.body
    name = _semiconductor(b.get("name"), "name")
    t = _num(b, "temperature_k", 300.0, lo=1, hi=3000)
    nd = _num(b, "n_donor", 0.0, lo=0, hi=1e24)
    na = _num(b, "n_acceptor", 0.0, lo=0, hi=1e24)
    try:
        out = WORKBENCH.analyze_semiconductor(name, temperature_k=t, n_donor=nd, n_acceptor=na)
    except ArithmeticError as e:
        raise ValidationError(f"numerical failure for {name} at {t:g} K: {e}") from None
    if "carriers" in out:  # replace the engine's cancellation-prone solution
        out["carriers"] = _carriers(name, t, nd, na)
    out["temperature_k"] = t
    out["n_donor"] = nd
    out["n_acceptor"] = na
    out["params"] = _params_dict(name)
    return out


def semiconductor_curves(req: Request) -> dict[str, Any]:
    b = req.body
    name = _semiconductor(b.get("name"), "name")
    t_min, t_max = _ordered(b, "t_min", "t_max", 50.0, 600.0, 1, 3000)
    n = _points(b, 111)
    t_sq = _num(b, "temperature_k", None, lo=1, hi=3000)
    p = semiconductor.get_params(name)
    eg_sq = p.eg_300k if t_sq is None else semiconductor.varshni_bandgap(p, t_sq)
    temps = _linspace(t_min, t_max, n)
    gaps = [semiconductor.varshni_bandgap(p, t) for t in temps]
    ni: list[float | None] = []
    for t in temps:
        try:
            v = semiconductor.intrinsic_carrier_concentration(name, t)
        except (ArithmeticError, ValueError):
            v = None
        ni.append(v if v is not None and v > 0 else None)  # log-scale friendly
    sq_eg = _linspace(0.3, 3.5, 161)
    sq_eff = [semiconductor.shockley_queisser(e).sq_efficiency_pct for e in sq_eg]
    return {
        "name": name,
        "temperature": _sigs(temps),
        "bandgap_ev": _sigs(gaps),
        "ni_cm3": _sigs(ni),
        "eg_300k": p.eg_300k,
        "sq": {"bandgap_ev": _sigs(sq_eg), "efficiency_pct": _sigs(sq_eff),
               "material": {"bandgap_ev": _sig(eg_sq, 4), "efficiency_pct": _sig(
                   semiconductor.shockley_queisser(eg_sq).sq_efficiency_pct, 4),
                   "temperature_k": 300.0 if t_sq is None else t_sq}},
    }


def semiconductor_compare(req: Request) -> dict[str, Any]:
    t = _num(req.body, "temperature_k", 300.0, lo=1, hi=3000)
    rows = []
    for key, p in semiconductor.LIBRARY.items():
        eg = semiconductor.varshni_bandgap(p, t)
        row: dict[str, Any] = {"name": key, "label": p.name, "bandgap_ev": round(eg, 4),
                               "direct_gap": p.direct_gap,
                               "classification": semiconductor.classify_by_gap(eg)}
        try:
            row["absorption_edge_nm"] = round(semiconductor.absorption_edge_nm(key, t), 1)
        except ValueError:
            row["absorption_edge_nm"] = None
        try:
            row["ni_cm3"] = _sig(semiconductor.intrinsic_carrier_concentration(key, t), 4)
        except (ArithmeticError, ValueError):
            row["ni_cm3"] = None
        row["sq_efficiency_pct"] = round(semiconductor.shockley_queisser(eg).sq_efficiency_pct, 2)
        rows.append(row)
    return {"temperature_k": t, "rows": rows}


# --------------------------------------------------------------------------
# photonics
# --------------------------------------------------------------------------
def photonics_dispersion(req: Request) -> dict[str, Any]:
    b = req.body
    material = _sellmeier(b.get("material"))
    lo, hi = _ordered(b, "lambda_min_nm", "lambda_max_nm", 300.0, 2000.0, 100, 20000)
    wl, n, ng = [], [], []
    omitted = 0
    for lam in _linspace(lo, hi, _points(b, 171)):
        try:
            ni = photonics.sellmeier_index(material, lam)
            gi = photonics.group_index(material, lam)
        except (ValueError, ArithmeticError):  # non-physical Sellmeier region
            omitted += 1
            continue
        if not (math.isfinite(ni) and math.isfinite(gi)):
            omitted += 1
            continue
        wl.append(lam)
        n.append(ni)
        ng.append(gi)
    def at(fn: Callable[[str, float], float], lam: float) -> float | None:
        try:
            return fn(material, lam)
        except (ValueError, ArithmeticError):
            return None

    n_d = at(photonics.sellmeier_index, 589.3)
    n_f = at(photonics.sellmeier_index, 486.13)   # Fraunhofer F (H-beta)
    n_c = at(photonics.sellmeier_index, 656.27)   # Fraunhofer C (H-alpha)
    abbe = ((n_d - 1.0) / (n_f - n_c) if None not in (n_d, n_f, n_c) and n_f != n_c
            else None)
    return {"material": material, "wavelength_nm": _sigs(wl), "n": _sigs(n, 7),
            "group_index": _sigs(ng, 7), "omitted": omitted, "n_589nm": _sig(n_d, 7),
            "n_F": _sig(n_f, 7), "n_C": _sig(n_c, 7), "abbe_number": _sig(abbe, 5),
            "n_1550nm": _sig(at(photonics.sellmeier_index, 1550.0), 7),
            "group_index_1550nm": _sig(at(photonics.group_index, 1550.0), 7)}


def photonics_fresnel(req: Request) -> dict[str, Any]:
    b = req.body
    n1 = _num(b, "n1", 1.0, lo=0.01, hi=100)
    n2 = _num(b, "n2", 1.5, lo=0.01, hi=100)
    angles = _linspace(0.0, 90.0, _points(b, 181))
    rs, rp, r = [], [], []
    for a in angles:
        f = photonics.fresnel(n1, n2, a)
        rs.append(f.R_s)
        rp.append(f.R_p)
        r.append(f.R_unpolarised)
    crit = photonics.critical_angle(n1, n2)
    return {"n1": n1, "n2": n2, "angle_deg": _sigs(angles), "Rs": _sigs(rs), "Rp": _sigs(rp),
            "R": _sigs(r), "brewster_deg": round(photonics.brewster_angle(n1, n2), 4),
            "critical_deg": round(crit, 4) if crit is not None else None}


def photonics_waveguide(req: Request) -> dict[str, Any]:
    b = req.body
    core = _num(b, "core_index", lo=0.01, hi=100)
    clad = _num(b, "clad_index", lo=0.01, hi=100)
    thickness = _num(b, "thickness_nm", lo=0.1, hi=1e7)
    lam = _num(b, "wavelength_nm", lo=1, hi=1e7)
    out = photonics.slab_waveguide(core, clad, thickness, lam).as_dict()  # ValueError if core<=clad
    ts = _linspace(0.05 * thickness, 3.0 * thickness, 120)
    sweep = [photonics.slab_waveguide(core, clad, t, lam) for t in ts]
    out["sweep"] = {"thickness_nm": _sigs(ts),
                    "num_modes": [w.num_modes_estimate for w in sweep],
                    "v_number": _sigs([w.v_number for w in sweep])}
    return out


def photonics_dbr(req: Request) -> dict[str, Any]:
    b = req.body
    n_high = _num(b, "n_high", lo=0.01, hi=100)
    n_low = _num(b, "n_low", lo=0.01, hi=100)
    n_in = _num(b, "n_in", 1.0, lo=0.01, hi=100)
    n_out = _num(b, "n_out", 1.5, lo=0.01, hi=100)
    max_pairs = _num(b, "max_pairs", 20, lo=1, hi=200, integer=True)
    lam = _num(b, "design_wavelength_nm", 1550.0, lo=1, hi=1e7)
    d_high, d_low = lam / (4 * n_high), lam / (4 * n_low)  # quarter-wave layers
    pairs = list(range(1, max_pairs + 1))
    refl = []
    for n in pairs:
        try:
            refl.append(photonics.dbr_reflectance(n_high, n_low, n_in, n_out, n))
        except OverflowError:  # (nH/nL)^2N overflowed: reflectance has saturated at 1
            refl.append(1.0)
    # 1 - R = 4a / (1 + a)^2 with a = (n_out/n_in) (nH/nL)^2N, evaluated in log space so
    # the leakage survives where R itself rounds (or overflows) to exactly 1.
    leakage = []
    for n in pairs:
        ln_a = math.log(n_out / n_in) + 2 * n * math.log(n_high / n_low)
        q = math.exp(-abs(ln_a))  # the expression is symmetric under a -> 1/a
        leakage.append(4.0 * q / (1.0 + q) ** 2)
    return {"pairs": pairs, "reflectance": _sigs(refl, 8), "leakage": _sigs(leakage, 6),
            "bragg_wavelength_nm": round(photonics.bragg_wavelength(n_high, d_high, n_low, d_low), 4),
            "d_high_nm": round(d_high, 4), "d_low_nm": round(d_low, 4)}


def photonics_cavity(req: Request) -> dict[str, Any]:
    b = req.body
    r = _num(b, "reflectance", lo=0, hi=1)
    length = _num(b, "length_nm", lo=1e-3, hi=1e15)
    lam = _num(b, "wavelength_nm", lo=1e-3, hi=1e9)
    n = _num(b, "n", 1.0, lo=0.01, hi=100)
    return photonics.cavity_q_and_finesse(r, length, lam, n)  # ValueError unless 0<R<1


# --------------------------------------------------------------------------
# plasmonics
# --------------------------------------------------------------------------
def plasmonics_drude(req: Request) -> dict[str, Any]:
    b = req.body
    metal = _metal(b.get("metal"))
    lo, hi = _ordered(b, "ev_min", "ev_max", 0.5, 6.0, 0.01, 100)
    evs = _linspace(lo, hi, _points(b, 221))
    eps = [plasmonics.drude_epsilon(metal, e) for e in evs]
    m = plasmonics.get_metal(metal)
    return {"metal": metal, "photon_ev": _sigs(evs), "wavelength_nm": _sigs([ev_to_nm(e) for e in evs]),
            "eps_real": _sigs([e.real for e in eps]), "eps_imag": _sigs([e.imag for e in eps]),
            "params": {"wp_ev": m.wp_ev, "gamma_ev": m.gamma_ev, "eps_inf": m.eps_inf}}


def _lspr(metal: str, medium: float) -> plasmonics.LSPRResult:
    """LSPR from the engine's scan, with a scan that brackets the resonance.

    ``lspr_sphere`` defaults to 0.5-6 eV in 5 meV steps, which pins resonances above
    6 eV (Al) to the scan edge and quantises narrow lines (Na, Ag). A coarse pass
    up to 1.5x the Frohlich estimate wp / sqrt(eps_inf + 2 eps_m) finds the peak; a
    fine pass over +-4 FWHM around it resolves the peak, FWHM and Q.
    """
    m = plasmonics.get_metal(metal)
    est = m.wp_ev / math.sqrt(m.eps_inf + 2.0 * medium)
    coarse = plasmonics.lspr_sphere(metal, eps_medium=medium,
                                    scan_ev=(0.5, max(6.0, 1.5 * est), 4001))
    step = (max(6.0, 1.5 * est) - 0.5) / 4000
    half = 4.0 * coarse.fwhm_ev + 2.0 * step
    return plasmonics.lspr_sphere(metal, eps_medium=medium,
                                  scan_ev=(max(0.05, coarse.resonance_ev - half),
                                           coarse.resonance_ev + half, 4001))


def plasmonics_sphere(req: Request) -> dict[str, Any]:
    b = req.body
    metal = _metal(b.get("metal"))
    radius = _num(b, "radius_nm", 20.0, lo=0.1, hi=1000)
    medium = _num(b, "medium_eps", 1.77, lo=1.0, hi=100)
    lo, hi = _ordered(b, "nm_min", "nm_max", 300.0, 900.0, 50, 100000)
    lspr = _lspr(metal, medium)
    at_res = plasmonics.mie_dipole_cross_sections(metal, radius, lspr.resonance_ev, medium)
    wls = _linspace(lo, hi, _points(b, 241))
    ext, sca, ab = [], [], []
    for wl in wls:
        cs = plasmonics.mie_dipole_cross_sections(metal, radius, nm_to_ev(wl), medium)
        ext.append(cs["C_ext_nm2"])
        sca.append(cs["C_sca_nm2"])
        ab.append(cs["C_abs_nm2"])
    # validity of the quasi-static dipole (no radiative damping): size parameter and the
    # single-dipole extinction limit 3 lambda^2 / (2 pi) (lambda in the medium)
    lam_med = lspr.resonance_nm / math.sqrt(medium)
    x = 2 * math.pi * radius / lam_med
    limit = 3 * lam_med ** 2 / (2 * math.pi)
    over = at_res["C_ext_nm2"] > limit
    return {"metal": metal, "radius_nm": radius, "medium_eps": medium, "lspr": lspr.as_dict(),
            "spectrum": {"wavelength_nm": _sigs(wls), "c_ext": _sigs(ext), "c_sca": _sigs(sca),
                         "c_abs": _sigs(ab)},
            "at_resonance": at_res,
            "validity": {"size_parameter": _sig(x, 4), "dipole_limit_nm2": _sig(limit, 4),
                         "exceeds_dipole_limit": over, "ok": x <= 0.3 and not over,
                         "model": "quasi-static dipole (no radiative damping)"}}


def plasmonics_spp(req: Request) -> dict[str, Any]:
    b = req.body
    metal = _metal(b.get("metal"))
    ev = _num(b, "photon_ev", 2.0, lo=0.01, hi=100)
    eps_d = _num(b, "eps_dielectric", 1.0, lo=1.0, hi=100)
    spp = plasmonics.surface_plasmon(metal, ev, eps_d).as_dict()
    res = plasmonics.spp_resonance_energy(metal, eps_d)
    evs = _linspace(0.1 * res, 0.98 * res, 150)  # bound SPP branch, below resonance
    branch = [plasmonics.surface_plasmon(metal, e, eps_d) for e in evs]
    return {"metal": metal, "photon_ev": ev, "wavelength_nm": round(ev_to_nm(ev), 2),
            "eps_dielectric": eps_d, "spp": spp, "bound": ev < res,
            "resonance_ev": round(res, 4), "resonance_nm": round(ev_to_nm(res), 2),
            "dispersion": {"photon_ev": _sigs(evs), "neff": _sigs([s.neff for s in branch]),
                           "propagation_length_um": _sigs([s.propagation_length_um for s in branch])}}


# --------------------------------------------------------------------------
# quantum
# --------------------------------------------------------------------------
def quantum_graphene(req: Request) -> dict[str, Any]:
    b = req.body
    t = _num(b, "hopping", 2.7, lo=0.01, hi=50)
    n = _points(b, 120)
    g = quantum.graphene_bands(t, n_k=n)  # path G-K, K-M, M-G with n points each
    total = len(g["upper_band"])
    return {"hopping": t, "k_index": list(range(total)),
            "upper": _sigs(g["upper_band"]), "lower": _sigs(g["lower_band"]),
            "ticks": [{"index": 0, "label": "Γ"}, {"index": n - 1, "label": "K"},
                      {"index": 2 * n - 1, "label": "M"}, {"index": total - 1, "label": "Γ"}],
            "min_direct_gap": g["min_direct_gap"], "is_dirac_semimetal": g["is_dirac_semimetal"]}


def quantum_tb1d(req: Request) -> dict[str, Any]:
    b = req.body
    onsite = _num(b, "onsite", 0.0, lo=-1000, hi=1000)
    hopping = _num(b, "hopping", 1.0, lo=-1000, hi=1000)
    n = _points(b, 201)
    band = quantum.tight_binding_1d(onsite, hopping, n_k=n)
    dense = quantum.tight_binding_1d(onsite, hopping, n_k=max(n, 4001))  # smooth DOS
    dos = quantum.density_of_states_1d(dense["energy"], n_bins=60)
    return {"onsite": onsite, "hopping": hopping, "k": _sigs(band["k"]),
            "energy": _sigs(band["energy"]), "bandwidth": band["bandwidth"],
            "e_min": band["e_min"], "e_max": band["e_max"],
            "dos": {"energy": _sigs(dos["energy"]), "dos": dos["dos"]}}


def quantum_well(req: Request) -> dict[str, Any]:
    b = req.body
    width = _num(b, "width_nm", 5.0, lo=0.05, hi=10000)
    m_eff = _num(b, "m_eff", 0.067, lo=1e-4, hi=100)
    n_levels = _num(b, "n_levels", 5, lo=1, hi=20, integer=True)
    qw = quantum.infinite_well(width, m_eff, n_levels)
    out = qw.as_dict()
    levels = qw.levels_ev
    out["transitions"] = [
        {"from": i + 1, "to": j + 1, "energy_ev": round(levels[j] - levels[i], 5),
         "wavelength_nm": round(ev_to_nm(levels[j] - levels[i]), 2)}
        for i in range(len(levels)) for j in range(i + 1, len(levels))
    ]
    out["m_eff"] = m_eff
    return out


def quantum_qdot(req: Request) -> dict[str, Any]:
    b = req.body
    name = _semiconductor(b.get("semiconductor") or "CdTe")
    radius = _num(b, "radius_nm", 2.5, lo=0.1, hi=1000)
    r_min, r_max = _ordered(b, "r_min", "r_max", 1.0, 6.0, 0.1, 1000)
    p = semiconductor.get_params(name)
    radii = _linspace(r_min, r_max, _points(b, 51))
    curve = [quantum.quantum_dot_shift(p.eg_300k, r, p.me_eff, p.mh_eff, p.eps_r) for r in radii]
    return {"semiconductor": name, "bulk_gap_ev": p.eg_300k, "radius_nm": radius,
            "single": WORKBENCH.analyze_quantum_dot(name, radius),
            "curve": {"radius_nm": _sigs(radii), "gap_ev": [c["confined_gap_ev"] for c in curve],
                      "emission_nm": [c["emission_nm"] for c in curve]}}


# --------------------------------------------------------------------------
# crystals
# --------------------------------------------------------------------------
def crystal_tolerance(req: Request) -> dict[str, Any]:
    b = req.body
    a = _ion(b.get("a_ion"), "a_ion")
    bb = _ion(b.get("b_ion"), "b_ion")
    x = _ion(b.get("x_ion"), "x_ion")
    out = crystal.goldschmidt_tolerance(a, bb, x).as_dict()
    out["radii"] = {"a": crystal.IONIC_RADII[a], "b": crystal.IONIC_RADII[bb],
                    "x": crystal.IONIC_RADII[x]}
    out["ions"] = {"a": a, "b": bb, "x": x}
    return out


def _multiplicity(hkl: Any) -> int:
    """Number of symmetry-equivalent cubic planes in the {hkl} family."""
    return len({tuple(s * v for s, v in zip(signs, perm))
                for perm in permutations(tuple(hkl))
                for signs in product((1, -1), repeat=3)})


def _lorentz_polarisation(two_theta_deg: float) -> float:
    th = math.radians(two_theta_deg / 2.0)
    denom = math.sin(th) ** 2 * math.cos(th)
    return (1 + math.cos(2 * th) ** 2) / denom if denom > 1e-9 else 0.0


def _form_factor(z: int, s: float) -> float:
    """Approximate X-ray atomic form factor f(sin(theta)/lambda) of a neutral atom.

    Thomas-Fermi atom with Moliere's screening function: f = Z sum a_i k_i^2 /
    (k_i^2 + q^2), q = 4 pi s, k_i = b_i / (0.8853 a0 Z^-1/3). Needs only Z and is
    within ~10 % of tabulated values in the range used for powder patterns.
    """
    q2 = (4.0 * math.pi * s) ** 2
    screen = 0.8853 * 0.529177 * z ** (-1.0 / 3.0)  # Angstrom
    return z * sum(a * (bb / screen) ** 2 / ((bb / screen) ** 2 + q2)
                   for a, bb in ((0.10, 6.0), (0.55, 1.2), (0.35, 0.3)))


_FCC = ((0.0, 0.0, 0.0), (0.0, 0.5, 0.5), (0.5, 0.0, 0.5), (0.5, 0.5, 0.0))


def _shifted(sites: tuple[tuple[float, float, float], ...], d: tuple[float, float, float]
             ) -> tuple[tuple[float, float, float], ...]:
    return tuple(tuple((p + q) % 1.0 for p, q in zip(site, d)) for site in sites)  # type: ignore[misc]


# Basis of each structure type: (role, fractional positions). Roles map to the
# formula's elements (A = first, B = second, X = the element with 3x the count).
_BASIS: dict[str, list[tuple[str, tuple[tuple[float, float, float], ...]]]] = {
    "simple": [("A", ((0.0, 0.0, 0.0),))],
    "bcc": [("A", ((0.0, 0.0, 0.0), (0.5, 0.5, 0.5)))],
    "fcc": [("A", _FCC)],
    "diamond": [("A", _FCC), ("A", _shifted(_FCC, (0.25, 0.25, 0.25)))],
    "zincblende": [("A", _FCC), ("B", _shifted(_FCC, (0.25, 0.25, 0.25)))],
    "rocksalt": [("A", _FCC), ("B", _shifted(_FCC, (0.5, 0.0, 0.0)))],
    "perovskite": [("A", ((0.0, 0.0, 0.0),)), ("B", ((0.5, 0.5, 0.5),)),
                   ("X", ((0.5, 0.5, 0.0), (0.5, 0.0, 0.5), (0.0, 0.5, 0.5)))],
}
_DEBYE_WALLER_B = 0.5  # isotropic displacement parameter, Angstrom^2 (typical at 300 K)


def _site_species(structure: str, composition: dict[str, float]
                  ) -> tuple[dict[str, dict[str, float]], bool]:
    """Map each basis role to {element: occupancy}; False if a virtual-crystal average is used."""
    roles = sorted({r for r, _ in _BASIS[structure]})
    els = [e for e, n in composition.items() if n > 0]
    counts = [composition[e] for e in els]
    exact: dict[str, str] | None = None
    if roles == ["A"] and len(els) == 1:
        exact = {"A": els[0]}
    elif roles == ["A", "B"] and len(els) == 2 and counts[0] == counts[1]:
        exact = {"A": els[0], "B": els[1]}
    elif roles == ["A", "B", "X"] and len(els) == 3:
        x = [e for e, n in zip(els, counts) if all(n == 3 * m for f, m in zip(els, counts) if f != e)]
        if len(x) == 1:
            a, bb = [e for e in els if e != x[0]]
            exact = {"A": a, "B": bb, "X": x[0]}
    if exact is not None:
        return {r: {e: 1.0} for r, e in exact.items()}, True
    total = sum(counts) or 1.0
    avg = {e: n / total for e, n in zip(els, counts)}
    return {r: avg for r in roles}, False


def _families(s: int) -> list[tuple[int, int, int]]:
    """All {hkl} families (h >= k >= l >= 0) with h^2 + k^2 + l^2 == s."""
    top = math.isqrt(s)
    return [(h, k, l) for h in range(top, -1, -1) for k in range(h, -1, -1)
            for l in range(k, -1, -1) if h * h + k * k + l * l == s]


def _xrd_intensities(structure: str, composition: dict[str, float], a: float,
                     wavelength: float, refl: list[dict[str, Any]]) -> tuple[list[float], str]:
    """Unnormalised powder intensities: sum over coincident families of m |F|^2 LP DW."""
    zs = {e: ELEMENTS[e].z for e in composition if e in ELEMENTS}
    if structure not in _BASIS or len(zs) != len(composition):
        return ([_multiplicity(r["hkl"]) * _lorentz_polarisation(r["two_theta"]) for r in refl],
                "multiplicity × Lorentz-polarisation only (no structure-factor model for this "
                "structure/composition)")
    species, exact = _site_species(structure, composition)
    basis = _BASIS[structure]
    out = []
    for r in refl:
        h0, k0, l0 = r["hkl"]
        sq = h0 * h0 + k0 * k0 + l0 * l0
        stl = math.sqrt(sq) / (2.0 * a)  # sin(theta)/lambda = 1/(2d)
        f = {e: _form_factor(z, stl) for e, z in zs.items()}
        total = 0.0
        for fam in _families(sq):
            amp = 0j
            for role, sites in basis:
                f_site = sum(occ * f[e] for e, occ in species[role].items())
                for x, y, z in sites:
                    amp += f_site * complex(math.cos(2 * math.pi * (fam[0] * x + fam[1] * y + fam[2] * z)),
                                            math.sin(2 * math.pi * (fam[0] * x + fam[1] * y + fam[2] * z)))
            total += _multiplicity(fam) * abs(amp) ** 2
        dw = math.exp(-2.0 * _DEBYE_WALLER_B * stl * stl)
        out.append(total * _lorentz_polarisation(r["two_theta"]) * dw)
    model = ("structure factors |F|² from the " + structure + " basis" +
             ("" if exact else " (virtual-crystal average: the formula does not match the "
              "structure's site stoichiometry)"))
    return out, model


def crystal_xrd(req: Request) -> dict[str, Any]:
    b = req.body
    formula = _str(b, "formula", "Si", max_len=100)
    a = _num(b, "a", 5.431, lo=0.5, hi=100)
    structure = _choice(b.get("structure") or "diamond", STRUCTURES, "structure")
    fu = _num(b, "formula_units", 8, lo=1, hi=256, integer=True)
    wavelength = _num(b, "wavelength_ang", 1.5406, lo=0.05, hi=10)
    max_2theta = _num(b, "max_2theta", 90.0, lo=5, hi=180)
    mat = Material.from_formula(formula, lattice=crystal.cubic(a), formula_units_per_cell=fu,
                                properties={"structure": structure})
    out = simulate_powder_xrd(mat, wavelength_ang=wavelength, max_2theta=max_2theta)
    refl = out["reflections"]
    raw, model = _xrd_intensities(structure, mat.composition, a, wavelength, refl)
    top = max(raw, default=0.0) or 1.0
    for r, v in zip(refl, raw):
        # conventional family label: indices in descending order, e.g. (2 0 0) not (0 0 2)
        r["hkl"] = sorted(r["hkl"], reverse=True)
        sq = sum(i * i for i in r["hkl"])
        r["families"] = [list(fam) for fam in _families(sq)] if structure in _BASIS else [r["hkl"]]
        r["multiplicity"] = _multiplicity(r["hkl"])
        r["rel_intensity"] = round(100.0 * v / top, 2)
    lo = 5.0 if max_2theta > 10 else 0.0
    grid = np.linspace(lo, max_2theta, 1501)
    sigma = 0.25 / 2.3548
    y = np.zeros_like(grid)
    for r in refl:
        y += r["rel_intensity"] * np.exp(-0.5 * ((grid - r["two_theta"]) / sigma) ** 2)
    if y.max() > 0:
        y = y / y.max() * 100.0
    note = (f"Peak positions from Bragg's law (engine). Relative intensities: {model}, "
            f"Thomas-Fermi atomic form factors, Lorentz-polarisation and a Debye-Waller "
            f"factor (B = {_DEBYE_WALLER_B} Å²); no absorption, texture or anomalous "
            f"dispersion. Gaussian-broadened (FWHM 0.25°) and normalised to 100.")
    out["pattern"] = {"two_theta": _sigs(grid), "intensity": [round(float(v), 3) for v in y],
                      "fwhm_deg": 0.25, "note": note, "intensity_model": model}
    density = mat.density_g_cm3()
    out["density_g_cm3"] = round(density, 4) if density is not None else None
    out["formula"] = mat.formula
    out["formula_units"] = fu
    return out


# --------------------------------------------------------------------------
# spectroscopy
# --------------------------------------------------------------------------
def spectro_interpret(req: Request) -> dict[str, Any]:
    b = req.body
    modality = _modality(b.get("modality"))
    peaks = _peaks(b, "peaks")
    tol = _num(b, "tolerance", None, lo=0, hi=10000)
    return interpret_peaks(peaks, modality, tolerance=tol).as_dict()


def spectro_ms(req: Request) -> dict[str, Any]:
    b = req.body
    ion = _num(b, "molecular_ion", lo=1, hi=1e6)
    fragments = _peaks(b, "fragments")
    tol = _num(b, "tolerance", 0.5, lo=0, hi=100)
    return interpret_mass_spectrum(ion, fragments, tolerance=tol)


def spectro_crossvalidate(req: Request) -> dict[str, Any]:
    sets = req.body.get("sets")
    if not isinstance(sets, list) or not sets:
        raise ValidationError("'sets' must be a non-empty list of {modality, peaks}")
    if len(sets) > 12:
        raise ValidationError("'sets' has too many entries (max 12)")
    interps = []
    for i, s in enumerate(sets):
        if not isinstance(s, dict):
            raise ValidationError(f"'sets[{i}]' must be an object with modality and peaks")
        tol = _num(s, "tolerance", None, lo=0, hi=10000, label=f"sets[{i}].tolerance")
        interps.append(interpret_peaks(_peaks(s, "peaks"), _modality(s.get("modality")),
                                       tolerance=tol))
    return {"interpretations": [it.as_dict() for it in interps], "cross": cross_validate(interps)}


def spectro_simulate_ir(req: Request) -> dict[str, Any]:
    mol = Molecule.from_smiles(_smiles(req.body))
    ir, interp = _ir_block(mol)  # MoleculeError (400) without RDKit
    ir["smiles"] = mol.canonical_smiles()
    ir["interpretation"] = interp
    return ir


def spectro_tables(req: Request) -> dict[str, Any]:
    def bands(rows: list[tables.Band]) -> list[dict[str, Any]]:
        return [dataclasses.asdict(r) for r in rows]

    return {"IR": bands(tables.IR_BANDS), "raman": bands(tables.RAMAN_BANDS),
            "1H": bands(tables.PROTON_NMR), "13C": bands(tables.CARBON_NMR),
            "neutral_losses": {str(k): v for k, v in tables.NEUTRAL_LOSSES.items()}}


# --------------------------------------------------------------------------
# critics gate
# --------------------------------------------------------------------------
def gate_screen(req: Request) -> dict[str, Any]:
    b = req.body
    smiles = _str_list(b, "smiles", max_items=500, max_len=MAX_SMILES_LEN)
    if not smiles:
        raise ValidationError("'smiles' needs at least one SMILES string")
    gate = WORKBENCH.gate(_harshness(b), use_llm=_bool(b, "use_llm", False))
    return gate.screen(smiles)


# --------------------------------------------------------------------------
# background jobs: evolution, campaign, search
# --------------------------------------------------------------------------
OBJECTIVE_DEFAULTS: dict[str, dict[str, Any]] = {
    "druglike": {"weight": 1.0},
    "mol_weight": {"weight": 0.6, "target": 320.0, "tolerance": 50.0},
    "logp": {"weight": 0.0, "target": 2.5, "tolerance": 1.0},
    "tpsa": {"weight": 0.0, "target": 80.0, "tolerance": 30.0},
    "synthesizability": {"weight": 0.5},
    "similarity": {"weight": 0.0, "reference": None},
    "novelty": {"weight": 0.0, "library": []},
}


@dataclass
class EvolveSpec:
    """A validated evolve request: the objective, GA config and normalised params."""

    objective: WeightedObjective
    config: EvolutionConfig
    use_gate: bool
    harshness: str
    seeds: list[str] | None
    params: dict[str, Any]


def _build_objective(raw: Any) -> tuple[WeightedObjective, dict[str, Any]]:
    if raw is None:
        raw = {k: dict(v) for k, v in OBJECTIVE_DEFAULTS.items()}
    if not isinstance(raw, dict):
        raise ValidationError("'objectives' must be an object mapping term names to settings")
    unknown = sorted(set(raw) - set(OBJECTIVE_DEFAULTS))
    if unknown:
        raise ValidationError(f"unknown objective term(s) {', '.join(unknown)}; valid terms: "
                              f"{', '.join(OBJECTIVE_DEFAULTS)}")
    terms: dict[str, tuple[float, Callable[[MoleculeGenome], float]]] = {}
    norm: dict[str, Any] = {}
    for name, defaults in OBJECTIVE_DEFAULTS.items():
        cfg = raw.get(name)
        if cfg is None:
            continue
        if isinstance(cfg, (int, float, str)) and not isinstance(cfg, bool):
            cfg = {"weight": cfg}
        if not isinstance(cfg, dict):
            raise ValidationError(f"objective '{name}' must be an object like {{\"weight\": 1.0}}")
        weight = _num(cfg, "weight", 0.0, label=f"objectives.{name}.weight")
        if weight <= 0:
            continue
        entry: dict[str, Any] = {"weight": weight}
        if name == "druglike":
            fn = fitness.druglikeness()
        elif name == "synthesizability":
            fn = fitness.synthesizability()
        elif name in ("mol_weight", "logp", "tpsa"):
            entry["target"] = _num(cfg, "target", defaults["target"],
                                   label=f"objectives.{name}.target")
            entry["tolerance"] = _num(cfg, "tolerance", defaults["tolerance"], lo=1e-6,
                                      label=f"objectives.{name}.tolerance")
            fn = fitness.target_property(name, entry["target"], entry["tolerance"])
        elif name == "similarity":
            ref = cfg.get("reference")
            if _is_blank(ref) or not isinstance(ref, str):
                raise ValidationError("objective 'similarity' needs a 'reference' SMILES")
            entry["reference"] = Molecule.from_smiles(ref.strip()).canonical_smiles()
            fn = fitness.similarity_to(entry["reference"])
        else:  # novelty
            lib = _str_list(cfg, "library", [], max_items=2000, max_len=MAX_SMILES_LEN)
            valid = []
            for smi in lib:
                try:
                    valid.append(Molecule.from_smiles(smi).canonical_smiles())
                except MoleculeError:
                    continue
            if not valid:
                raise ValidationError("objective 'novelty' needs a non-empty 'library' of "
                                      "valid SMILES")
            entry["library"] = valid
            fn = fitness.novelty_against(valid)
        terms[name] = (float(weight), fn)
        norm[name] = entry
    if not terms:
        raise ValidationError("no objective term has weight > 0; enable at least one of: "
                              f"{', '.join(OBJECTIVE_DEFAULTS)}")
    return WeightedObjective(terms), norm


def parse_evolve_spec(b: dict[str, Any]) -> EvolveSpec:
    """Validate an evolve spec (see docs/gui.md) into an :class:`EvolveSpec`."""
    objective, norm = _build_objective(b.get("objectives"))
    pop = _num(b, "population", 40, lo=4, hi=500, integer=True)
    gens = _num(b, "generations", 20, lo=1, hi=500, integer=True)
    cfg = EvolutionConfig(
        population_size=pop,
        generations=gens,
        elitism=_num(b, "elitism", 2, lo=0, hi=pop, integer=True),
        tournament_size=_num(b, "tournament_size", 3, lo=1, hi=pop, integer=True),
        mutation_rate=float(_num(b, "mutation_rate", 0.6, lo=0, hi=1)),
        crossover_rate=float(_num(b, "crossover_rate", 0.4, lo=0, hi=1)),
        random_seed=_num(b, "seed", None, lo=-(2 ** 63), hi=2 ** 63, integer=True),
        patience=_num(b, "patience", 0, lo=0, hi=500, integer=True),
    )
    seeds = _str_list(b, "seeds", None, max_items=500, max_len=MAX_SMILES_LEN) or None
    if seeds and have_rdkit():
        bad = []
        for smi in seeds:
            try:
                Molecule.from_smiles(smi)
            except MoleculeError:
                bad.append(smi)
        if bad:
            raise ValidationError(f"invalid seed SMILES: {', '.join(bad[:10])}")
    use_gate = _bool(b, "use_gate", True)
    harshness = _harshness(b)
    params = {"objectives": norm, "population": pop, "generations": gens,
              "seed": cfg.random_seed, "elitism": cfg.elitism,
              "tournament_size": cfg.tournament_size, "mutation_rate": cfg.mutation_rate,
              "crossover_rate": cfg.crossover_rate, "patience": cfg.patience,
              "use_gate": use_gate, "harshness": harshness, "seeds": seeds}
    return EvolveSpec(objective, cfg, use_gate, harshness, seeds, params)


class _GenerationTracker:
    """``on_generation`` hook: streams stats, honours cancel, remembers discovery generations.

    ``first_seen`` maps each SMILES to the first GA generation whose population
    contained it, i.e. when the molecule was found. (``Individual.generation`` is
    the genome's lineage depth - operator steps from a seed - not a GA generation.)
    """

    def __init__(self, ctx: JobContext, total: int) -> None:
        self.ctx = ctx
        self.total = total
        self.first_seen: dict[str, int] = {}

    def __call__(self, gen: int, pop: list[Individual]) -> None:
        self.ctx.check_cancel()
        for ind in pop:
            self.first_seen.setdefault(ind.genome.smiles, gen)
        fits = [ind.fitness for ind in pop]
        best = max(pop, key=lambda ind: ind.fitness)
        self.ctx.emit({"generation": gen, "best": round(max(fits), 5),
                       "mean": round(sum(fits) / len(fits), 5), "worst": round(min(fits), 5),
                       "unique": len({ind.genome.smiles for ind in pop}),
                       "best_smiles": best.genome.smiles})
        self.ctx.progress(gen, self.total, f"generation {gen}/{self.total}")

    def found(self, smiles: str, lineage_depth: int | None) -> int | None:
        """GA generation in which ``smiles`` first appeared (0 = an unmodified seed)."""
        if lineage_depth == 0:
            return 0
        return self.first_seen.get(smiles)


def _breakdown(objective: WeightedObjective, smiles: str) -> dict[str, Any]:
    try:
        return objective.breakdown(MoleculeGenome(smiles))
    except Exception:  # noqa: BLE001 - a scoring failure must not sink a job
        return {}


def _individual_dict(smiles: str, fitness_value: float, depth: int | None,
                     objective: WeightedObjective, tracker: _GenerationTracker) -> dict[str, Any]:
    return {"smiles": smiles, "fitness": round(fitness_value, 5), "generation": depth,
            "lineage_depth": depth, "found_generation": tracker.found(smiles, depth),
            "breakdown": _breakdown(objective, smiles), "svg": _safe_svg(smiles)}


def _individual(ind: Individual, objective: WeightedObjective,
                tracker: _GenerationTracker) -> dict[str, Any]:
    return _individual_dict(ind.genome.smiles, ind.fitness, ind.genome.generation,
                            objective, tracker)


def _evolution_result(res: EvolutionResult, objective: WeightedObjective,
                      tracker: _GenerationTracker) -> dict[str, Any]:
    return {"best": _individual(res.best, objective, tracker),
            "hall_of_fame": [_individual(i, objective, tracker) for i in res.hall_of_fame],
            "history": res.history, "evaluations": res.evaluations}


def _finished_message(done: int, total: int) -> str:
    if done < total:
        return f"finished: stopped early after {done}/{total} generations (no improvement)"
    return f"finished: {done} generations"


def _run_evolution(ctx: JobContext, spec: EvolveSpec) -> dict[str, Any]:
    total = spec.config.generations
    tracker = _GenerationTracker(ctx, total)
    ctx.progress(0, total, "seeding population")
    res = WORKBENCH.evolve_molecules(
        spec.objective, seeds=spec.seeds, use_gate=spec.use_gate, harshness=spec.harshness,
        config=spec.config, on_generation=tracker)
    ctx.progress(len(res.history), total, _finished_message(len(res.history), total))
    return to_jsonable(_evolution_result(res, spec.objective, tracker))


def evolve_start(req: Request) -> dict[str, Any]:
    spec = parse_evolve_spec(req.body)
    job_id = _submit("evolve", spec.params, lambda ctx: _run_evolution(ctx, spec))
    return {"job_id": job_id}


def _run_campaign(ctx: JobContext, spec: EvolveSpec, title: str, ground: str | None,
                  top_n: int) -> dict[str, Any]:
    total = spec.config.generations
    tracker = _GenerationTracker(ctx, total)
    ctx.progress(0, total, "grounding: deep search" if ground else "seeding population")
    report = DiscoveryCampaign(WORKBENCH).run(
        title, spec.objective, ground_query=ground, seeds=spec.seeds,
        harshness=spec.harshness, use_gate=spec.use_gate, top_n=top_n,
        evo_config=spec.config, on_generation=tracker)
    out = report.as_dict()
    if isinstance(out.get("grounding"), dict):  # which backend wrote the grounding synthesis
        out["grounding"]["llm_backend"] = _llm().name
    # give the evolution block the same individual shape as an evolve result
    evo = out.get("evolution") or {}

    def enrich(ind: dict[str, Any]) -> dict[str, Any]:
        return {**ind, **_individual_dict(ind["smiles"], ind.get("fitness") or 0.0,
                                          ind.get("generation"), spec.objective, tracker)}

    if isinstance(evo.get("best"), dict) and evo["best"].get("smiles"):
        evo["best"] = enrich(evo["best"])
    evo["hall_of_fame"] = [enrich(ind) for ind in evo.get("hall_of_fame") or []
                           if isinstance(ind, dict) and ind.get("smiles")]
    depth = {ind["smiles"]: ind.get("lineage_depth") for ind in evo["hall_of_fame"]}
    for winner in out["winners"]:
        smi = winner["smiles"]
        winner["svg"] = _safe_svg(smi)
        winner["lineage_depth"] = depth.get(smi)
        winner["found_generation"] = tracker.found(smi, depth.get(smi))
        try:  # same structure-aware IR groups and UV-Vis caveat as /api/molecule/analyze
            mol = Molecule.from_smiles(smi)
            if winner.get("ir_peaks"):
                winner["ir_interpretation"] = _structure_aware(
                    interpret_peaks(winner["ir_peaks"], "IR"),
                    set(mol.formula_counts))["functional_groups"]
            if winner.get("uvvis"):
                winner["uvvis"] = _uvvis_block(mol)
        except Exception:  # noqa: BLE001 - keep the engine's values on any failure
            pass
    _notebook().add_run({"type": "campaign", "title": title,
                         "winners": [{"smiles": w["smiles"], "fitness": w.get("fitness")}
                                     for w in out["winners"]],
                         "notes": out["notes"]}, tags=["campaign"])
    done = len(evo.get("history", []))
    ctx.progress(done, total, _finished_message(done, total))
    return to_jsonable(out)


def campaign_start(req: Request) -> dict[str, Any]:
    b = req.body
    spec = parse_evolve_spec(b)
    title = _str(b, "title", "Discovery campaign", max_len=200)
    ground = _str(b, "ground_query", None, max_len=500)
    top_n = _num(b, "top_n", 3, lo=1, hi=10, integer=True)
    params = {**spec.params, "title": title, "ground_query": ground, "top_n": top_n}
    job_id = _submit("campaign", params,
                         lambda ctx: _run_campaign(ctx, spec, title, ground, top_n))
    return {"job_id": job_id}


class _SearchTracker:
    """Turns per-provider search calls into job events/progress and honours cancel."""

    def __init__(self, ctx: JobContext, names: list[str], calls_per_provider: int) -> None:
        self.ctx = ctx
        self.names = names
        self.calls = calls_per_provider
        self.stats: dict[str, dict[str, Any]] = {}
        self.done: list[str] = []

    def begin(self, name: str) -> None:
        self.ctx.check_cancel()
        if name not in self.stats:
            self.stats[name] = {"calls": 0, "ok": 0, "results": 0, "error": None}
            self.ctx.progress(len(self.done), len(self.names),
                              f"querying {name} ({len(self.done) + 1}/{len(self.names)})")

    def record(self, name: str, n: int = 0, error: str | None = None) -> None:
        s = self.stats[name]
        s["calls"] += 1
        if error is None:
            s["ok"] += 1
            s["results"] += n
        elif s["error"] is None:
            s["error"] = error
        if s["calls"] >= self.calls:
            self.finalize(name)

    def finalize(self, name: str) -> None:
        if name in self.done or name not in self.stats:
            return
        s = self.stats[name]
        self.done.append(name)
        if s["ok"]:
            self.ctx.emit({"provider": name, "status": "ok", "detail": f"{s['results']} result(s)"})
        else:
            self.ctx.emit({"provider": name, "status": "failed",
                           "detail": s["error"] or "no results"})
        self.ctx.progress(len(self.done), len(self.names),
                          f"{len(self.done)}/{len(self.names)} providers done")

    def finish(self) -> None:
        for name in list(self.stats):
            self.finalize(name)


class _TrackedProvider:
    """Wraps a search provider so the tracker sees each call's outcome."""

    def __init__(self, inner: Any, tracker: _SearchTracker) -> None:
        self._inner = inner
        self._tracker = tracker
        self.name = inner.name

    def search(self, query: str, limit: int = 5) -> list[Any]:
        self._tracker.begin(self.name)
        try:
            results = self._inner.search(query, limit=limit)
        except Exception as e:  # noqa: BLE001 - re-raised for DeepSearch to classify
            self._tracker.record(self.name, error=str(e) or type(e).__name__)
            raise
        self._tracker.record(self.name, n=len(results))
        return results


def _run_search(ctx: JobContext, query: str, per_provider: int, expand: bool,
                synthesise: bool, names: list[str]) -> dict[str, Any]:
    ds = DeepSearch(providers=[], llm=_llm() if synthesise else None)
    calls = 1 + (len(ds._expand(query)) if expand else 0)
    tracker = _SearchTracker(ctx, names, calls)
    ds.providers = [_TrackedProvider(DEFAULT_PROVIDERS[n](), tracker) for n in names]
    ctx.progress(0, len(names), "starting search")
    report = ds.run(query, per_provider=per_provider, expand=expand, synthesise=synthesise)
    tracker.finish()
    ctx.progress(len(names), len(names),
                 f"finished: {len(report.results)} result(s) from "
                 f"{len(report.providers_used)}/{len(names)} provider(s)")
    out = to_jsonable(report.as_dict())
    out["llm_backend"] = ds.llm.name if synthesise and ds.llm is not None else None
    return out


def search_start(req: Request) -> dict[str, Any]:
    b = req.body
    query = _str(b, "query", max_len=500)
    per_provider = _num(b, "per_provider", 4, lo=1, hi=20, integer=True)
    expand = _bool(b, "expand", True)
    synthesise = _bool(b, "synthesise", _bool(b, "synthesize", True))
    raw = b.get("providers")
    if raw is None:
        names = list(DEFAULT_PROVIDERS)
    else:
        if isinstance(raw, str):
            raw = [s for s in re.split(r"[\s,]+", raw) if s]
        if not isinstance(raw, list) or not raw:
            raise ValidationError("'providers' must be null or a non-empty list of provider names")
        names = []
        for p in raw:
            name = _choice(p, list(DEFAULT_PROVIDERS), "provider")
            if name not in names:
                names.append(name)
    params = {"query": query, "per_provider": per_provider, "expand": expand,
              "synthesise": synthesise, "providers": names}
    job_id = _submit("search", params, lambda ctx: _run_search(
        ctx, query, per_provider, expand, synthesise, names))
    return {"job_id": job_id}


def jobs_list(req: Request) -> dict[str, Any]:
    return {"jobs": JOBS.list()}


def job_get(req: Request) -> dict[str, Any]:
    job_id = req.params["job_id"]
    since = max(0, _num(req.query, "since", 0, integer=True))
    try:
        return JOBS.get(job_id, since=since)
    except UnknownJob:
        raise NotFound(f"unknown job id {job_id!r}") from None


def job_cancel(req: Request) -> dict[str, Any]:
    job_id = req.params["job_id"]
    try:
        return JOBS.cancel(job_id)
    except UnknownJob:
        raise NotFound(f"unknown job id {job_id!r}") from None


# --------------------------------------------------------------------------
# LLM
# --------------------------------------------------------------------------
def llm_status(req: Request) -> dict[str, Any]:
    return _llm_status()


def llm_configure(req: Request) -> dict[str, Any]:
    b = req.body
    backend = _choice(b.get("backend") or "auto", LLM_BACKENDS, "backend")
    base_url = _str(b, "base_url", None, max_len=500)
    if base_url and not re.match(r"^https?://", base_url, re.IGNORECASE):
        raise ValidationError("'base_url' must start with http:// or https://")
    model = _str(b, "model", None, max_len=200)
    client = get_client(backend, base_url=base_url, model=model)  # probes; may fall back to echo
    with _LLM_LOCK:
        cfg = WORKBENCH.config
        cfg.llm_backend, cfg.llm_base_url, cfg.llm_model = backend, base_url, model
        WORKBENCH._llm = client  # Workbench has no public setter; reset its lazy client
    status = _llm_status()
    status["requested_backend"] = backend
    status["fallback"] = backend not in ("auto", "echo") and isinstance(client, EchoClient)
    return status


def llm_chat(req: Request) -> dict[str, Any]:
    b = req.body
    raw = b.get("messages")
    if not isinstance(raw, list) or not raw:
        raise ValidationError("'messages' must be a non-empty list of {role, content}")
    if len(raw) > 200:
        raise ValidationError("too many messages (max 200)")
    msgs: list[Message] = []
    system = _str(b, "system", None, max_len=50_000)
    if system:
        msgs.append(Message("system", system))
    total = 0
    for i, m in enumerate(raw):
        if not isinstance(m, dict):
            raise ValidationError(f"'messages[{i}]' must be an object with role and content")
        role, content = m.get("role"), m.get("content")
        if role not in ("system", "user", "assistant"):
            raise ValidationError(f"'messages[{i}].role' must be one of system, user, assistant")
        if not isinstance(content, str):
            raise ValidationError(f"'messages[{i}].content' must be a string")
        total += len(content)
        msgs.append(Message(role, content))
    if total > 500_000:
        raise ValidationError("conversation too long (max 500000 characters)")
    temperature = _num(b, "temperature", 0.2, lo=0, hi=2)
    max_tokens = _num(b, "max_tokens", 1024, lo=1, hi=65536, integer=True)
    client = _llm()
    resp = client.chat(msgs, temperature=float(temperature), max_tokens=max_tokens)
    return {"text": resp.text, "backend": client.name, "model": resp.model, "usage": resp.usage}


# --------------------------------------------------------------------------
# notebook
# --------------------------------------------------------------------------
def _summary(rec: Record) -> str:
    """A short human-readable line for a notebook record."""
    try:
        p = rec.payload or {}
        if rec.kind == "molecule":
            label = " ".join(str(x) for x in (p.get("name"), p.get("smiles")) if x) or "molecule"
            extra = []
            if p.get("formula"):
                extra.append(str(p["formula"]))
            if isinstance(p.get("molar_mass"), (int, float)):
                extra.append(f"{p['molar_mass']:.2f} g/mol")
            return label + (f" ({', '.join(extra)})" if extra else "")
        if rec.kind == "material":
            return f"{p.get('name') or p.get('formula') or 'material'} ({p.get('formula', '?')})"
        if rec.kind == "note":
            text = " ".join(str(p.get("text", "")).split())
            return text if len(text) <= 120 else text[:117] + "..."
        if rec.kind == "run":
            kind = p.get("type", "run")
            if kind == "evolution":
                best = p.get("best") or {}
                fit = best.get("fitness")
                fit_s = f"{fit:.3f}" if isinstance(fit, (int, float)) else "?"
                return (f"evolution: best {best.get('smiles', '?')} (fitness {fit_s}) "
                        f"over {len(p.get('history') or [])} generation(s)")
            if kind == "campaign":
                return f"campaign '{p.get('title', '')}': {len(p.get('winners') or [])} winner(s)"
            return str(kind)
    except Exception:  # noqa: BLE001 - imported payloads can be arbitrary
        pass
    return rec.kind


def notebook_list(req: Request) -> dict[str, Any]:
    nb = _notebook()
    with nb.lock:
        records = list(reversed(nb.all()))  # all() is oldest-first
        name = nb.name
    return {"name": name, "count": len(records),
            "records": [{"id": r.id, "kind": r.kind, "tags": r.tags, "created": r.created,
                         "summary": _summary(r), "payload": r.payload} for r in records]}


def notebook_note(req: Request) -> dict[str, Any]:
    text = _str(req.body, "text", max_len=200_000)
    return {"id": _notebook().add_note(text, tags=_tags(req.body))}


def notebook_molecule(req: Request) -> dict[str, Any]:
    b = req.body
    mol = Molecule.from_smiles(_smiles(b), name=_str(b, "name", None, max_len=200))
    return {"id": _notebook().add_molecule(mol, tags=_tags(b))}


def notebook_delete(req: Request) -> dict[str, Any]:
    rid = _str(req.body, "id", max_len=200)
    try:
        _notebook().delete(rid)
    except KeyError:
        raise ValidationError(f"unknown notebook record id {rid!r}") from None
    return {"ok": True}


def notebook_export(req: Request) -> dict[str, Any]:
    return _notebook().to_dict()


_RECORD_KINDS = ("molecule", "material", "run", "note")


def _check_depth(obj: Any, where: str, limit: int = MAX_PAYLOAD_DEPTH) -> None:
    """Reject JSON nested deeper than ``limit`` (iteratively, so it cannot recurse out).

    Deeply nested payloads import fine but would later make every notebook list
    and export fail with RecursionError in the (recursive) JSON sanitiser.
    """
    stack: list[tuple[Any, int]] = [(obj, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > limit:
            raise ValidationError(f"'{where}' is nested too deeply (max {limit} levels)")
        if isinstance(node, dict):
            stack.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            stack.extend((v, depth + 1) for v in node)


def notebook_import(req: Request) -> dict[str, Any]:
    b = req.body
    data = b.get("data")
    if not isinstance(data, dict):
        raise ValidationError("'data' must be a notebook object (as returned by "
                              "/api/notebook/export)")
    raw = data.get("records")
    if not isinstance(raw, list):
        raise ValidationError("'data.records' must be a list")
    if len(raw) > 20_000:
        raise ValidationError("too many records (max 20000)")
    merge = _bool(b, "merge", True)
    records: list[Record] = []
    for i, r in enumerate(raw):
        where = f"data.records[{i}]"
        if not isinstance(r, dict):
            raise ValidationError(f"'{where}' must be an object")
        kind = r.get("kind")
        if kind not in _RECORD_KINDS:
            raise ValidationError(f"'{where}.kind' must be one of {', '.join(_RECORD_KINDS)}")
        rid = r.get("id")
        if not isinstance(rid, str) or not rid.strip() or len(rid) > 200:
            raise ValidationError(f"'{where}.id' must be a non-empty string (max 200 chars)")
        payload = r.get("payload")
        if not isinstance(payload, dict):
            raise ValidationError(f"'{where}.payload' must be an object")
        _check_depth(payload, f"{where}.payload")
        tags = r.get("tags") or []
        if not isinstance(tags, list):
            raise ValidationError(f"'{where}.tags' must be a list of strings")
        created = _num(r, "created", time.time(), label=f"{where}.created")
        records.append(Record(kind=kind, id=rid.strip(), payload=payload,
                              tags=[str(t) for t in tags], created=float(created)))
    nb = _notebook()
    with nb.lock:
        before = {r.id for r in nb.all()}
        count = nb.import_records(records, merge=merge)
    ids = {r.id for r in records}
    added = len(ids - before) if merge else len(ids)
    return {"count": count, "imported": len(records), "added": added,
            "updated": len(ids & before) if merge else 0,
            "replaced": 0 if merge else len(before), "merge": merge}


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------
ROUTES: dict[tuple[str, str], Handler] = {
    ("GET", "/api/health"): health,
    ("GET", "/api/info"): info,
    # chemistry
    ("POST", "/api/molecule/analyze"): molecule_analyze,
    ("POST", "/api/molecule/depict"): molecule_depict,
    ("POST", "/api/molecule/similarity"): molecule_similarity,
    ("POST", "/api/formula"): formula_info,
    ("POST", "/api/reaction/balance"): reaction_balance,
    ("POST", "/api/reaction/stoichiometry"): reaction_stoichiometry,
    # semiconductors
    ("POST", "/api/semiconductor/analyze"): semiconductor_analyze,
    ("POST", "/api/semiconductor/curves"): semiconductor_curves,
    ("POST", "/api/semiconductor/compare"): semiconductor_compare,
    # photonics
    ("POST", "/api/photonics/dispersion"): photonics_dispersion,
    ("POST", "/api/photonics/fresnel"): photonics_fresnel,
    ("POST", "/api/photonics/waveguide"): photonics_waveguide,
    ("POST", "/api/photonics/dbr"): photonics_dbr,
    ("POST", "/api/photonics/cavity"): photonics_cavity,
    # plasmonics
    ("POST", "/api/plasmonics/drude"): plasmonics_drude,
    ("POST", "/api/plasmonics/sphere"): plasmonics_sphere,
    ("POST", "/api/plasmonics/spp"): plasmonics_spp,
    # quantum
    ("POST", "/api/quantum/graphene"): quantum_graphene,
    ("POST", "/api/quantum/tb1d"): quantum_tb1d,
    ("POST", "/api/quantum/well"): quantum_well,
    ("POST", "/api/quantum/qdot"): quantum_qdot,
    # crystals
    ("POST", "/api/crystal/tolerance"): crystal_tolerance,
    ("POST", "/api/crystal/xrd"): crystal_xrd,
    # spectroscopy
    ("POST", "/api/spectro/interpret"): spectro_interpret,
    ("POST", "/api/spectro/ms"): spectro_ms,
    ("POST", "/api/spectro/crossvalidate"): spectro_crossvalidate,
    ("POST", "/api/spectro/simulate_ir"): spectro_simulate_ir,
    ("GET", "/api/spectro/tables"): spectro_tables,
    # critics gate
    ("POST", "/api/gate/screen"): gate_screen,
    # background jobs
    ("POST", "/api/evolve/start"): evolve_start,
    ("POST", "/api/campaign/start"): campaign_start,
    ("POST", "/api/search/start"): search_start,
    ("GET", "/api/jobs"): jobs_list,
    ("GET", "/api/jobs/{job_id}"): job_get,
    ("POST", "/api/jobs/{job_id}/cancel"): job_cancel,
    # LLM
    ("GET", "/api/llm/status"): llm_status,
    ("POST", "/api/llm/configure"): llm_configure,
    ("POST", "/api/llm/chat"): llm_chat,
    # notebook
    ("GET", "/api/notebook"): notebook_list,
    ("POST", "/api/notebook/note"): notebook_note,
    ("POST", "/api/notebook/molecule"): notebook_molecule,
    ("POST", "/api/notebook/delete"): notebook_delete,
    ("GET", "/api/notebook/export"): notebook_export,
    ("POST", "/api/notebook/import"): notebook_import,
}


@functools.lru_cache(maxsize=None)
def _compile(pattern: str) -> re.Pattern[str]:
    """``/api/jobs/{job_id}`` -> a regex with a named group per ``{param}``."""
    parts = []
    for seg in pattern.split("/"):
        m = re.fullmatch(r"\{(\w+)\}", seg)
        parts.append(f"(?P<{m.group(1)}>[A-Za-z0-9_-]+)" if m else re.escape(seg))
    return re.compile("^" + "/".join(parts) + "$")


def resolve(method: str, path: str) -> tuple[Handler, dict[str, str]]:
    """Find the handler for ``method path``; raise NotFound / MethodNotAllowed."""
    method = method.upper()
    if len(path) > 1:
        path = path.rstrip("/")
    allowed: set[str] = set()
    for (m, pattern), handler in ROUTES.items():
        match = _compile(pattern).match(path)
        if match is None:
            continue
        if m == method:
            return handler, match.groupdict()
        allowed.add(m)
    if allowed:
        raise MethodNotAllowed(f"method {method} not allowed for {path}; "
                               f"allowed: {', '.join(sorted(allowed))}", sorted(allowed))
    raise NotFound(f"no API endpoint at {path}")


def invoke(handler: Handler, body: dict[str, Any] | None = None,
           query: dict[str, str] | None = None,
           params: dict[str, str] | None = None) -> dict[str, Any]:
    """Call a handler and return its sanitised (strict-JSON-safe) result."""
    if body is not None and not isinstance(body, dict):
        raise ValidationError("request body must be a JSON object")
    return to_jsonable(handler(Request(dict(body or {}), dict(query or {}), dict(params or {}))))


def dispatch(method: str, path: str, body: dict[str, Any] | None = None,
             query: dict[str, str] | None = None) -> dict[str, Any]:
    """Resolve ``method path`` and invoke its handler (HTTP-free entry point)."""
    handler, params = resolve(method, path)
    return invoke(handler, body, query, params)
