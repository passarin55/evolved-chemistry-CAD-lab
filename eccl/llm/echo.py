"""A deterministic, offline fallback 'LLM'.

When no local model is reachable, the lab still needs the LLM-shaped calls to
return *something* structured and honest rather than crashing. EchoClient does
no generation: it returns a clearly-labelled deterministic response that
summarises the prompt and defers substantive judgement to the rule-based
critics. This keeps every pipeline runnable fully offline.
"""
from __future__ import annotations

from typing import Any

from .base import LLMResponse, Message


class EchoClient:
    name = "echo (offline, deterministic)"

    def available(self) -> bool:
        return True

    def chat(self, messages: list[Message], *, temperature: float = 0.2,
             max_tokens: int = 1024, **kw: Any) -> LLMResponse:
        last_user = next((m.content for m in reversed(messages)
                          if m.role == "user"), "")
        sys = next((m.content for m in messages if m.role == "system"), "")
        n_words = len(last_user.split())
        text = (
            "[offline-fallback] No local LLM was reachable, so this is a "
            "deterministic placeholder rather than generated text. "
            f"Received a {n_words}-word prompt"
            + (f" under role guidance: '{sys[:80]}'. " if sys else ". ")
            + "Substantive scientific judgement in this run comes from the "
            "rule-based critics and the physics/cheminformatics engines, not "
            "from a language model. Configure a local model (ECCL_LLM_BACKEND, "
            "ECCL_LLM_BASE_URL, ECCL_LLM_MODEL) to enable LLM reasoning."
        )
        return LLMResponse(text=text, model="echo", backend="offline",
                           usage={"prompt_words": n_words})
