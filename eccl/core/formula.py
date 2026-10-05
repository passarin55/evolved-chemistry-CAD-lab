"""Chemical formula parsing and arithmetic.

Handles nested parentheses and bracket groups, e.g.::

    Fe2(SO4)3
    Ca10(PO4)6(OH)2
    CsPbI3
    CH3(CH2)4CH3

and hydrate dot-notation like ``CuSO4.5H2O`` or ``CuSO4·5H2O``.
"""
from __future__ import annotations

import re
from collections import Counter

from .elements import by_symbol

_TOKEN = re.compile(r"([A-Z][a-z]?|\(|\)|\[|\]|\d+\.?\d*|·|\.)")
_CLOSE = {")": "(", "]": "["}


def parse_formula(formula: str) -> dict[str, float]:
    """Parse a formula string into {element_symbol: count}.

    Counts can be fractional (useful for non-stoichiometric materials, e.g.
    ``WO2.9``). Raises ValueError on malformed input.
    """
    formula = formula.strip().replace(" ", "")
    if not formula:
        raise ValueError("empty formula")

    # Split hydrate / adduct segments joined by a dot or middle dot, but keep
    # decimal counts intact (a dot flanked by digits is a decimal, not a join).
    segments = _split_adducts(formula)
    total: Counter[str] = Counter()
    for mult, seg in segments:
        for sym, cnt in _parse_segment(seg).items():
            total[sym] += cnt * mult
    if not total:
        raise ValueError(f"no elements parsed from {formula!r}")
    return dict(total)


def _split_adducts(formula: str) -> list[tuple[float, str]]:
    # Replace middle dot with ASCII dot; then split on dots that separate
    # whole sub-formulae (a dot not surrounded by digits).
    f = formula.replace("·", ".")
    parts = re.split(r"(?<!\d)\.(?!\d)|\.(?=\d+[A-Z])", f)
    segments: list[tuple[float, str]] = []
    for part in parts:
        if not part:
            continue
        m = re.match(r"^(\d+\.?\d*)([A-Za-z(\[].*)$", part)
        if m and m.group(2)[0].isalpha() or (m and m.group(2)[0] in "(["):
            segments.append((float(m.group(1)), m.group(2)))
        else:
            segments.append((1.0, part))
    return segments


def _parse_segment(seg: str) -> dict[str, float]:
    tokens = _TOKEN.findall(seg)
    if "".join(tokens) != seg:
        bad = seg
        for t in tokens:
            bad = bad.replace(t, "", 1)
        raise ValueError(f"unrecognised characters in formula: {bad!r}")

    stack: list[Counter[str]] = [Counter()]
    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if tok in "([":
            stack.append(Counter())
            i += 1
        elif tok in ")]":
            group = stack.pop()
            if not stack:
                raise ValueError("unbalanced brackets")
            mult = 1.0
            if i + 1 < n and _is_number(tokens[i + 1]):
                mult = float(tokens[i + 1])
                i += 1
            for k, v in group.items():
                stack[-1][k] += v * mult
            i += 1
        elif re.fullmatch(r"[A-Z][a-z]?", tok):
            by_symbol(tok)  # validates element exists
            count = 1.0
            if i + 1 < n and _is_number(tokens[i + 1]):
                count = float(tokens[i + 1])
                i += 1
            stack[-1][tok] += count
            i += 1
        else:
            raise ValueError(f"unexpected token {tok!r} in {seg!r}")
    if len(stack) != 1:
        raise ValueError("unbalanced brackets")
    return dict(stack[0])


def _is_number(tok: str) -> bool:
    return bool(re.fullmatch(r"\d+\.?\d*", tok))


def molar_mass(formula: str | dict[str, float]) -> float:
    """Molar mass in g/mol."""
    counts = formula if isinstance(formula, dict) else parse_formula(formula)
    return sum(by_symbol(sym).mass * cnt for sym, cnt in counts.items())


def hill_formula(counts: dict[str, float]) -> str:
    """Render counts in Hill notation (C, then H, then others alphabetically)."""
    def fmt(c: float) -> str:
        if abs(c - round(c)) < 1e-9:
            c = int(round(c))
            return "" if c == 1 else str(c)
        return f"{c:g}"

    parts: list[str] = []
    remaining = dict(counts)
    if "C" in remaining:
        parts.append("C" + fmt(remaining.pop("C")))
        if "H" in remaining:
            parts.append("H" + fmt(remaining.pop("H")))
    for sym in sorted(remaining):
        parts.append(sym + fmt(remaining[sym]))
    return "".join(parts)


def mass_fractions(formula: str | dict[str, float]) -> dict[str, float]:
    """Elemental mass fractions (sum to 1.0)."""
    counts = formula if isinstance(formula, dict) else parse_formula(formula)
    total = molar_mass(counts)
    return {sym: (by_symbol(sym).mass * cnt) / total for sym, cnt in counts.items()}
