"""Deep multi-provider web search with graceful offline degradation."""
from __future__ import annotations

from . import providers
from .base import ProviderError, SearchResult
from .deep import DeepSearch, DeepSearchReport
from .providers import (
    ArxivProvider,
    CrossrefProvider,
    DuckDuckGoProvider,
    PubChemProvider,
    WikipediaProvider,
)

__all__ = [
    "providers",
    "SearchResult",
    "ProviderError",
    "DeepSearch",
    "DeepSearchReport",
    "PubChemProvider",
    "WikipediaProvider",
    "ArxivProvider",
    "CrossrefProvider",
    "DuckDuckGoProvider",
]
