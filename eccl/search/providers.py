"""Concrete search providers for chemistry/materials literature and data.

Every provider is best-effort: it raises :class:`ProviderError` on network or
parse failure, which the deep-search orchestrator catches so a run degrades
gracefully (e.g. offline or behind a restrictive egress policy) instead of
crashing.

Providers:
  * PubChemProvider   — compound properties by name (PUG REST)
  * WikipediaProvider — encyclopedic summaries (REST + OpenSearch)
  * ArxivProvider     — preprints (Atom API)
  * CrossrefProvider  — peer-reviewed works (Crossref REST)
  * DuckDuckGoProvider— general web (Instant Answer API)
"""
from __future__ import annotations

import re
from typing import Any

from .base import ProviderError, SearchResult, http_get, http_get_json, q


class PubChemProvider:
    name = "pubchem"
    BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        props = "MolecularFormula,MolecularWeight,CanonicalSMILES,IUPACName,XLogP"
        url = f"{self.BASE}/compound/name/{q(query)}/property/{props}/JSON"
        data = http_get_json(url)
        out: list[SearchResult] = []
        for row in data.get("PropertyTable", {}).get("Properties", [])[:limit]:
            cid = row.get("CID")
            out.append(SearchResult(
                title=row.get("IUPACName") or query,
                snippet=(f"Formula {row.get('MolecularFormula')}, "
                         f"MW {row.get('MolecularWeight')}, "
                         f"SMILES {row.get('CanonicalSMILES')}, "
                         f"XLogP {row.get('XLogP')}"),
                url=f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}" if cid else "",
                source=self.name, data=row,
            ))
        if not out:
            raise ProviderError(f"no PubChem compound named {query!r}")
        return out


class WikipediaProvider:
    name = "wikipedia"
    API = "https://en.wikipedia.org/w/api.php"

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        url = (f"{self.API}?action=query&list=search&srsearch={q(query)}"
               f"&srlimit={limit}&format=json")
        data = http_get_json(url)
        out: list[SearchResult] = []
        for hit in data.get("query", {}).get("search", []):
            title = hit.get("title", "")
            snippet = re.sub(r"<[^>]+>", "", hit.get("snippet", ""))
            out.append(SearchResult(
                title=title, snippet=snippet,
                url=f"https://en.wikipedia.org/wiki/{q(title.replace(' ', '_'))}",
                source=self.name, data={"size": hit.get("size")},
            ))
        if not out:
            raise ProviderError(f"no Wikipedia results for {query!r}")
        return out


class ArxivProvider:
    name = "arxiv"
    API = "https://export.arxiv.org/api/query"

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        url = f"{self.API}?search_query=all:{q(query)}&start=0&max_results={limit}"
        text = http_get(url)
        entries = re.findall(r"<entry>(.*?)</entry>", text, re.DOTALL)
        out: list[SearchResult] = []
        for e in entries[:limit]:
            title = _xml_tag(e, "title")
            summary = _xml_tag(e, "summary")
            link = _xml_tag(e, "id")
            out.append(SearchResult(
                title=" ".join(title.split()),
                snippet=" ".join(summary.split())[:400],
                url=link, source=self.name,
            ))
        if not out:
            raise ProviderError(f"no arXiv results for {query!r}")
        return out


class CrossrefProvider:
    name = "crossref"
    API = "https://api.crossref.org/works"

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        url = f"{self.API}?query={q(query)}&rows={limit}"
        data = http_get_json(url)
        out: list[SearchResult] = []
        for item in data.get("message", {}).get("items", [])[:limit]:
            title = (item.get("title") or ["(untitled)"])[0]
            authors = ", ".join(
                f"{a.get('given','')} {a.get('family','')}".strip()
                for a in item.get("author", [])[:3]
            )
            year = (item.get("published-print") or item.get("published-online")
                    or {}).get("date-parts", [[None]])[0][0]
            out.append(SearchResult(
                title=title,
                snippet=f"{authors} ({year}) — {item.get('container-title',[''])[0] if item.get('container-title') else ''}",
                url=item.get("URL", ""), source=self.name,
                data={"doi": item.get("DOI"), "cited_by": item.get("is-referenced-by-count")},
            ))
        if not out:
            raise ProviderError(f"no Crossref results for {query!r}")
        return out


class DuckDuckGoProvider:
    name = "duckduckgo"
    API = "https://api.duckduckgo.com/"

    def search(self, query: str, limit: int = 5) -> list[SearchResult]:
        url = f"{self.API}?q={q(query)}&format=json&no_html=1&skip_disambig=1"
        data = http_get_json(url)
        out: list[SearchResult] = []
        if data.get("AbstractText"):
            out.append(SearchResult(
                title=data.get("Heading", query),
                snippet=data["AbstractText"],
                url=data.get("AbstractURL", ""), source=self.name,
            ))
        for topic in data.get("RelatedTopics", []):
            if "Text" in topic and len(out) < limit:
                out.append(SearchResult(
                    title=topic.get("Text", "")[:80],
                    snippet=topic.get("Text", ""),
                    url=topic.get("FirstURL", ""), source=self.name,
                ))
        if not out:
            raise ProviderError(f"no DuckDuckGo instant answer for {query!r}")
        return out


def _xml_tag(blob: str, tag: str) -> str:
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", blob, re.DOTALL)
    return m.group(1).strip() if m else ""


DEFAULT_PROVIDERS: dict[str, type] = {
    "pubchem": PubChemProvider,
    "wikipedia": WikipediaProvider,
    "arxiv": ArxivProvider,
    "crossref": CrossrefProvider,
    "duckduckgo": DuckDuckGoProvider,
}
