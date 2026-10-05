"""LLM client abstraction.

The lab talks to language models through this small interface so that a local
model (Ollama, llama.cpp, LM Studio, vLLM, text-generation-webui — anything
exposing an OpenAI-compatible or Ollama HTTP API) and a deterministic offline
fallback are interchangeable. Nothing in the scientific core depends on a
network LLM being available.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class Message:
    role: str   # "system" | "user" | "assistant"
    content: str

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class LLMResponse:
    text: str
    model: str
    backend: str
    usage: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


class LLMClient(Protocol):
    """Minimal protocol every backend implements."""

    name: str

    def available(self) -> bool:
        """Whether this backend can currently serve requests."""
        ...

    def chat(self, messages: list[Message], *, temperature: float = 0.2,
             max_tokens: int = 1024, **kw: Any) -> LLMResponse:
        ...


def system(content: str) -> Message:
    return Message("system", content)


def user(content: str) -> Message:
    return Message("user", content)


def assistant(content: str) -> Message:
    return Message("assistant", content)
