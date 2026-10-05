"""Local-LLM backends: Ollama and OpenAI-compatible HTTP servers.

Designed for models running on the user's own machine (privacy-preserving, no
data leaves the host). Uses httpx if installed, else the stdlib. Endpoints and
model names are configurable via constructor args or environment variables:

    ECCL_LLM_BACKEND   = "ollama" | "openai"
    ECCL_LLM_BASE_URL  = e.g. "http://localhost:11434" or "http://localhost:1234/v1"
    ECCL_LLM_MODEL     = e.g. "llama3.1", "qwen2.5", "mistral"
    ECCL_LLM_API_KEY   = optional (local servers usually ignore it)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from .base import LLMResponse, Message

_DEFAULT_TIMEOUT = 120


def _http_post_json(url: str, payload: dict, headers: dict, timeout: int) -> dict:
    """POST JSON via httpx if present, else stdlib urllib. Returns parsed JSON."""
    try:
        import httpx  # type: ignore

        resp = httpx.post(url, json=payload, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except ImportError:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={**headers,
                                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            return json.loads(r.read().decode("utf-8"))


def _http_get(url: str, timeout: int = 5) -> dict | None:
    try:
        import httpx  # type: ignore

        resp = httpx.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except ImportError:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            return None
    except Exception:
        return None


class OllamaClient:
    """Client for a local Ollama server (default http://localhost:11434)."""

    def __init__(self, base_url: str | None = None, model: str | None = None,
                 timeout: int = _DEFAULT_TIMEOUT) -> None:
        self.base_url = (base_url or os.getenv("ECCL_LLM_BASE_URL")
                         or "http://localhost:11434").rstrip("/")
        self.model = model or os.getenv("ECCL_LLM_MODEL") or "llama3.1"
        self.timeout = timeout
        self.name = f"ollama:{self.model}"

    def available(self) -> bool:
        tags = _http_get(f"{self.base_url}/api/tags", timeout=3)
        return tags is not None

    def chat(self, messages: list[Message], *, temperature: float = 0.2,
             max_tokens: int = 1024, **kw: Any) -> LLMResponse:
        payload = {
            "model": self.model,
            "messages": [m.as_dict() for m in messages],
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        data = _http_post_json(f"{self.base_url}/api/chat", payload, {}, self.timeout)
        text = data.get("message", {}).get("content", "")
        return LLMResponse(text=text, model=self.model, backend="ollama",
                           usage={"eval_count": data.get("eval_count")}, raw=data)


class OpenAICompatibleClient:
    """Client for any OpenAI-compatible /v1/chat/completions endpoint.

    Works with LM Studio, vLLM, llama.cpp server, text-generation-webui, and the
    OpenAI API itself (set base_url to https://api.openai.com/v1 + api key).
    """

    def __init__(self, base_url: str | None = None, model: str | None = None,
                 api_key: str | None = None, timeout: int = _DEFAULT_TIMEOUT) -> None:
        self.base_url = (base_url or os.getenv("ECCL_LLM_BASE_URL")
                         or "http://localhost:1234/v1").rstrip("/")
        self.model = model or os.getenv("ECCL_LLM_MODEL") or "local-model"
        self.api_key = api_key or os.getenv("ECCL_LLM_API_KEY") or "not-needed"
        self.timeout = timeout
        self.name = f"openai-compat:{self.model}"

    def available(self) -> bool:
        return _http_get(f"{self.base_url}/models", timeout=3) is not None

    def chat(self, messages: list[Message], *, temperature: float = 0.2,
             max_tokens: int = 1024, **kw: Any) -> LLMResponse:
        payload = {
            "model": self.model,
            "messages": [m.as_dict() for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = _http_post_json(f"{self.base_url}/chat/completions", payload,
                               headers, self.timeout)
        text = data["choices"][0]["message"]["content"]
        return LLMResponse(text=text, model=self.model, backend="openai-compat",
                           usage=data.get("usage", {}), raw=data)
