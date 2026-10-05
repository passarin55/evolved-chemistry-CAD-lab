"""Backend selection and a few high-level LLM helpers.

:func:`get_client` picks a backend from environment/config, probing for a
reachable local model and transparently falling back to the offline echo
client. Higher layers (critics gate, workbench) call the helpers here so they
never have to care which backend answered.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from .base import LLMClient, LLMResponse, Message, system, user
from .echo import EchoClient
from .local import OllamaClient, OpenAICompatibleClient


def get_client(backend: str | None = None, *, allow_fallback: bool = True,
               **kw: Any) -> LLMClient:
    """Return a ready LLM client.

    backend: "ollama" | "openai" | "echo" | None (auto). Auto tries the
    configured/most-likely local backend and falls back to echo if unreachable.
    """
    backend = (backend or os.getenv("ECCL_LLM_BACKEND") or "auto").lower()

    if backend == "echo":
        return EchoClient()
    if backend == "ollama":
        c = OllamaClient(**kw)
        if c.available() or not allow_fallback:
            return c
        return EchoClient()
    if backend in ("openai", "openai-compat", "lmstudio", "vllm"):
        c = OpenAICompatibleClient(**kw)
        if c.available() or not allow_fallback:
            return c
        return EchoClient()

    # auto: try ollama, then openai-compatible, then echo
    for ctor in (OllamaClient, OpenAICompatibleClient):
        try:
            c = ctor(**kw)
            if c.available():
                return c
        except Exception:
            continue
    return EchoClient()


def complete(client: LLMClient, prompt: str, *, system_prompt: str | None = None,
             temperature: float = 0.2, max_tokens: int = 1024) -> str:
    msgs: list[Message] = []
    if system_prompt:
        msgs.append(system(system_prompt))
    msgs.append(user(prompt))
    return client.chat(msgs, temperature=temperature, max_tokens=max_tokens).text


def ask_json(client: LLMClient, prompt: str, *, system_prompt: str | None = None,
             temperature: float = 0.0) -> dict[str, Any] | None:
    """Ask the model for JSON and parse the first JSON object found, or None."""
    sp = (system_prompt or "") + \
        " Respond ONLY with a single valid JSON object, no prose."
    text = complete(client, prompt, system_prompt=sp.strip(), temperature=temperature)
    return _extract_json(text)


def _extract_json(text: str) -> dict[str, Any] | None:
    # Try a fenced block first, then the first {...} span.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fence.group(1) if fence else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            candidate = text[start:end + 1]
    if candidate is None:
        return None
    try:
        obj = json.loads(candidate)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None
