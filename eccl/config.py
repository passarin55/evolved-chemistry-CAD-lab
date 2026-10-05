"""Central configuration, read from environment with sane defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Config:
    # LLM
    llm_backend: str = field(default_factory=lambda: os.getenv("ECCL_LLM_BACKEND", "auto"))
    llm_base_url: str | None = field(default_factory=lambda: os.getenv("ECCL_LLM_BASE_URL"))
    llm_model: str | None = field(default_factory=lambda: os.getenv("ECCL_LLM_MODEL"))
    use_llm_critic: bool = field(
        default_factory=lambda: os.getenv("ECCL_USE_LLM_CRITIC", "0") in ("1", "true", "True"))

    # Critics gate
    harshness: str = field(default_factory=lambda: os.getenv("ECCL_HARSHNESS", "HARSH"))

    # Evolution
    population_size: int = field(
        default_factory=lambda: int(os.getenv("ECCL_POP", "40")))
    generations: int = field(
        default_factory=lambda: int(os.getenv("ECCL_GENERATIONS", "20")))
    random_seed: int | None = field(
        default_factory=lambda: _int_or_none(os.getenv("ECCL_SEED")))

    def as_dict(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


def _int_or_none(v: str | None) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except ValueError:
        return None


DEFAULT = Config()
