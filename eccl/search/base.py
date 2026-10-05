"""Search abstractions shared by all providers."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class SearchResult:
    title: str
    snippet: str
    url: str = ""
    source: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"title": self.title, "snippet": self.snippet, "url": self.url,
                "source": self.source, "data": self.data}


class SearchProvider(Protocol):
    name: str

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        ...


class ProviderError(RuntimeError):
    """Raised when a provider cannot complete a request (network/parse)."""


def http_get(url: str, *, headers: dict[str, str] | None = None,
             timeout: int = 15) -> str:
    """GET text, honouring the environment proxy. Raises ProviderError on failure."""
    hdrs = {"User-Agent": "ECCL/0.1 (research tool)"}
    if headers:
        hdrs.update(headers)
    try:
        import httpx  # type: ignore

        resp = httpx.get(url, headers=hdrs, timeout=timeout, follow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except ImportError:
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            raise ProviderError(f"GET {url} failed: {e}") from e
    except Exception as e:  # noqa: BLE001
        raise ProviderError(f"GET {url} failed: {e}") from e


def http_get_json(url: str, **kw: Any) -> Any:
    text = http_get(url, **kw)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ProviderError(f"non-JSON response from {url}: {e}") from e


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")
