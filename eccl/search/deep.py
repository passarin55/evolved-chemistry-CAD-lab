"""Deep search: fan out across providers, dedupe, rank, and (optionally) let a
local LLM synthesise a briefing with citations.

'Deep' here means: multi-provider breadth, iterative query expansion, result
de-duplication and a relevance ranking — then an optional LLM synthesis step
that is explicitly grounded in the retrieved snippets (so it cites, not
hallucinates). The whole thing degrades to 'return whatever providers answered'
when the network or the LLM is unavailable.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from ..llm.base import LLMClient
from ..llm.manager import complete
from .base import ProviderError, SearchResult, SearchProvider
from .providers import DEFAULT_PROVIDERS


@dataclass
class DeepSearchReport:
    query: str
    results: list[SearchResult]
    providers_used: list[str]
    providers_failed: dict[str, str]
    synthesis: str | None = None
    subqueries: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "subqueries": self.subqueries,
            "results": [r.as_dict() for r in self.results],
            "providers_used": self.providers_used,
            "providers_failed": self.providers_failed,
            "synthesis": self.synthesis,
        }


class DeepSearch:
    def __init__(self, providers: list[SearchProvider] | None = None,
                 llm: Optional[LLMClient] = None) -> None:
        if providers is None:
            providers = [cls() for cls in DEFAULT_PROVIDERS.values()]
        self.providers = providers
        self.llm = llm

    def run(self, query: str, *, per_provider: int = 4,
            expand: bool = True, synthesise: bool = True,
            max_results: int = 20) -> DeepSearchReport:
        subqueries = [query]
        if expand:
            subqueries += self._expand(query)

        used: list[str] = []
        failed: dict[str, str] = {}
        collected: list[SearchResult] = []
        for provider in self.providers:
            got_any = False
            for sq in subqueries:
                try:
                    results = provider.search(sq, limit=per_provider)
                    collected.extend(results)
                    got_any = True
                except ProviderError as e:
                    failed.setdefault(provider.name, str(e))
                except Exception as e:  # noqa: BLE001
                    failed.setdefault(provider.name, f"unexpected: {e}")
            if got_any:
                used.append(provider.name)
                failed.pop(provider.name, None)

        ranked = self._rank_and_dedupe(collected, query)[:max_results]
        synthesis = None
        if synthesise and self.llm is not None and ranked:
            synthesis = self._synthesise(query, ranked)

        return DeepSearchReport(query=query, results=ranked, providers_used=used,
                                providers_failed=failed, synthesis=synthesis,
                                subqueries=subqueries)

    def _expand(self, query: str) -> list[str]:
        """Deterministic query expansion with domain-aware modifiers."""
        mods = ["properties", "synthesis", "review", "mechanism", "applications"]
        base = query.strip()
        return [f"{base} {m}" for m in mods[:3]]

    def _rank_and_dedupe(self, results: list[SearchResult],
                         query: str) -> list[SearchResult]:
        terms = set(re.findall(r"\w+", query.lower()))
        seen: set[str] = set()
        scored: list[tuple[float, SearchResult]] = []
        for r in results:
            key = (r.url or r.title).lower().strip()
            if key in seen:
                continue
            seen.add(key)
            text = f"{r.title} {r.snippet}".lower()
            overlap = sum(1 for t in terms if t in text)
            # prefer data-rich sources slightly
            bonus = 0.5 if r.source in ("pubchem", "crossref") else 0.0
            scored.append((overlap + bonus, r))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [r for _, r in scored]

    def _synthesise(self, query: str, results: list[SearchResult]) -> str:
        context = "\n".join(
            f"[{i+1}] ({r.source}) {r.title}: {r.snippet}"
            for i, r in enumerate(results[:10])
        )
        prompt = (
            f"Research question: {query}\n\n"
            f"Retrieved sources:\n{context}\n\n"
            "Write a concise, skeptical briefing (<=200 words) that answers the "
            "question using ONLY these sources. Cite source numbers like [1]. "
            "If the sources are insufficient or offline, say so plainly."
        )
        system = ("You are a careful scientific research assistant. Never invent "
                  "facts beyond the provided sources; cite by number.")
        return complete(self.llm, prompt, system_prompt=system,
                        temperature=0.1, max_tokens=500)
