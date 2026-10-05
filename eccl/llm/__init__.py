"""Local-first LLM integration with an offline deterministic fallback."""
from __future__ import annotations

from .base import LLMClient, LLMResponse, Message, assistant, system, user
from .echo import EchoClient
from .local import OllamaClient, OpenAICompatibleClient
from .manager import ask_json, complete, get_client

__all__ = [
    "LLMClient",
    "LLMResponse",
    "Message",
    "system",
    "user",
    "assistant",
    "EchoClient",
    "OllamaClient",
    "OpenAICompatibleClient",
    "get_client",
    "complete",
    "ask_json",
]
