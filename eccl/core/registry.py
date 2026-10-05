"""A lab notebook: a persistent registry of molecules, materials, and runs.

Everything is JSON-serialisable so a session can be saved and reopened, and so
results can be fed to the critics gate or an LLM for review.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .material import Material
from .molecule import Molecule


@dataclass
class Record:
    kind: str                 # "molecule" | "material" | "run" | "note"
    id: str
    payload: dict[str, Any]
    tags: list[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "id": self.id,
            "payload": self.payload,
            "tags": self.tags,
            "created": self.created,
        }


class LabNotebook:
    """In-memory registry with optional JSON persistence."""

    def __init__(self, name: str = "lab") -> None:
        self.name = name
        self._records: dict[str, Record] = {}

    # ---- adding ----
    def _new_id(self, prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:8]}"

    def add_molecule(self, mol: Molecule, tags: list[str] | None = None) -> str:
        rid = self._new_id("mol")
        self._records[rid] = Record("molecule", rid, mol.to_dict(), tags or [])
        return rid

    def add_material(self, mat: Material, tags: list[str] | None = None) -> str:
        rid = self._new_id("mat")
        self._records[rid] = Record("material", rid, mat.to_dict(), tags or [])
        return rid

    def add_run(self, payload: dict[str, Any], tags: list[str] | None = None) -> str:
        rid = self._new_id("run")
        self._records[rid] = Record("run", rid, payload, tags or [])
        return rid

    def add_note(self, text: str, tags: list[str] | None = None) -> str:
        rid = self._new_id("note")
        self._records[rid] = Record("note", rid, {"text": text}, tags or [])
        return rid

    # ---- querying ----
    def get(self, rid: str) -> Record:
        return self._records[rid]

    def all(self, kind: str | None = None) -> list[Record]:
        recs = list(self._records.values())
        if kind:
            recs = [r for r in recs if r.kind == kind]
        return sorted(recs, key=lambda r: r.created)

    def find_by_tag(self, tag: str) -> list[Record]:
        return [r for r in self._records.values() if tag in r.tags]

    def load_molecule(self, rid: str) -> Molecule:
        rec = self._records[rid]
        if rec.kind != "molecule":
            raise ValueError(f"{rid} is a {rec.kind}, not a molecule")
        return Molecule.from_dict(rec.payload)

    def load_material(self, rid: str) -> Material:
        rec = self._records[rid]
        if rec.kind != "material":
            raise ValueError(f"{rid} is a {rec.kind}, not a material")
        return Material.from_dict(rec.payload)

    def __len__(self) -> int:
        return len(self._records)

    # ---- persistence ----
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": 1,
            "records": [r.to_dict() for r in self.all()],
        }

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        path.write_text(json.dumps(self.to_dict(), indent=2))
        return path

    @classmethod
    def load(cls, path: str | Path) -> "LabNotebook":
        data = json.loads(Path(path).read_text())
        nb = cls(name=data.get("name", "lab"))
        for r in data.get("records", []):
            rec = Record(
                kind=r["kind"], id=r["id"], payload=r["payload"],
                tags=r.get("tags", []), created=r.get("created", time.time()),
            )
            nb._records[rec.id] = rec
        return nb
