"""Reaction balancing and stoichiometry via linear algebra.

Balancing a reaction is finding the integer null-space vector of the element
conservation matrix. We use a rational (Fraction) Gaussian elimination so the
result is exact, then scale to the smallest positive integers.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from fractions import Fraction
from math import gcd
from typing import Any

from ..core.formula import molar_mass, parse_formula


@dataclass
class BalancedReaction:
    reactants: list[tuple[int, str]]   # (coeff, formula)
    products: list[tuple[int, str]]

    def equation(self) -> str:
        def side(terms: list[tuple[int, str]]) -> str:
            return " + ".join((f"{c} {f}" if c != 1 else f) for c, f in terms)
        return f"{side(self.reactants)} -> {side(self.products)}"

    def mass_balance_error(self) -> float:
        """Absolute g/mol difference between the two sides (should be ~0)."""
        lhs = sum(c * molar_mass(f) for c, f in self.reactants)
        rhs = sum(c * molar_mass(f) for c, f in self.products)
        return abs(lhs - rhs)

    def as_dict(self) -> dict[str, Any]:
        return {
            "equation": self.equation(),
            "reactants": [{"coeff": c, "formula": f} for c, f in self.reactants],
            "products": [{"coeff": c, "formula": f} for c, f in self.products],
            "mass_balance_error": round(self.mass_balance_error(), 9),
        }


def _lcm(a: int, b: int) -> int:
    return abs(a * b) // gcd(a, b) if a and b else 0


def balance(reactants: list[str], products: list[str]) -> BalancedReaction:
    """Balance a reaction given reactant and product formula strings."""
    species = reactants + products
    if not reactants or not products:
        raise ValueError("need at least one reactant and one product")

    comps = [parse_formula(s) for s in species]
    elements = sorted({e for c in comps for e in c})

    # Element-conservation matrix A (rows=elements, cols=species). Products
    # enter with negative sign so A x = 0 enforces conservation.
    n_r = len(reactants)
    A: list[list[Fraction]] = []
    for el in elements:
        row = []
        for j, comp in enumerate(comps):
            val = Fraction(comp.get(el, 0)).limit_denominator(10**6)
            row.append(val if j < n_r else -val)
        A.append(row)

    coeffs = _nullspace_vector(A, len(species))
    if coeffs is None:
        raise ValueError("reaction cannot be balanced (no 1-D solution found)")

    # Scale fractions to smallest positive integers.
    denoms = [c.denominator for c in coeffs]
    mult = 1
    for d in denoms:
        mult = _lcm(mult, d) or mult
    ints = [int(c * mult) for c in coeffs]
    g = 0
    for v in ints:
        g = gcd(g, abs(v))
    if g == 0:
        raise ValueError("degenerate (all-zero) solution")
    ints = [v // g for v in ints]
    if any(v <= 0 for v in ints):
        # Flip sign if the free variable produced negatives.
        if all(v <= 0 for v in ints):
            ints = [-v for v in ints]
        if any(v <= 0 for v in ints):
            raise ValueError("no all-positive balancing exists for this reaction")

    return BalancedReaction(
        reactants=[(ints[i], reactants[i]) for i in range(n_r)],
        products=[(ints[n_r + j], products[j]) for j in range(len(products))],
    )


def _nullspace_vector(A: list[list[Fraction]], ncols: int) -> list[Fraction] | None:
    """Exact 1-D null space via rational RREF; returns a vector or None."""
    M = [row[:] for row in A]
    nrows = len(M)
    pivot_cols: list[int] = []
    r = 0
    for c in range(ncols):
        pivot = None
        for i in range(r, nrows):
            if M[i][c] != 0:
                pivot = i
                break
        if pivot is None:
            continue
        M[r], M[pivot] = M[pivot], M[r]
        pv = M[r][c]
        M[r] = [x / pv for x in M[r]]
        for i in range(nrows):
            if i != r and M[i][c] != 0:
                factor = M[i][c]
                M[i] = [a - factor * b for a, b in zip(M[i], M[r])]
        pivot_cols.append(c)
        r += 1
        if r == nrows:
            break

    free_cols = [c for c in range(ncols) if c not in pivot_cols]
    if len(free_cols) != 1:
        return None  # not a unique (up to scale) solution

    free = free_cols[0]
    x = [Fraction(0)] * ncols
    x[free] = Fraction(1)
    for i, pc in enumerate(pivot_cols):
        x[pc] = -M[i][free]
    return x


def stoichiometry(reaction: BalancedReaction, basis_formula: str,
                  basis_moles: float = 1.0) -> dict[str, float]:
    """Given moles of one species, return moles of every other species."""
    all_terms = reaction.reactants + reaction.products
    coeff_of = {f: c for c, f in all_terms}
    if basis_formula not in coeff_of:
        raise ValueError(f"{basis_formula} is not in the reaction")
    scale = basis_moles / coeff_of[basis_formula]
    return {f: c * scale for c, f in all_terms}
