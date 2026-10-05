"""A compact periodic table.

This is deliberately self-contained (no external data files) so the core
works offline. Atomic weights are standard values; electronegativity is
Pauling scale. Only the fields the lab actually uses are stored.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Element:
    z: int
    symbol: str
    name: str
    mass: float            # standard atomic weight, g/mol
    group: int             # 0 if not well-defined (lanthanide/actinide block)
    period: int
    electronegativity: float | None  # Pauling, None if undefined
    valence_electrons: int

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.symbol}({self.z})"


# (z, symbol, name, mass, group, period, electronegativity, valence_e)
_RAW: list[tuple] = [
    (1, "H", "Hydrogen", 1.008, 1, 1, 2.20, 1),
    (2, "He", "Helium", 4.0026, 18, 1, None, 2),
    (3, "Li", "Lithium", 6.94, 1, 2, 0.98, 1),
    (4, "Be", "Beryllium", 9.0122, 2, 2, 1.57, 2),
    (5, "B", "Boron", 10.81, 13, 2, 2.04, 3),
    (6, "C", "Carbon", 12.011, 14, 2, 2.55, 4),
    (7, "N", "Nitrogen", 14.007, 15, 2, 3.04, 5),
    (8, "O", "Oxygen", 15.999, 16, 2, 3.44, 6),
    (9, "F", "Fluorine", 18.998, 17, 2, 3.98, 7),
    (10, "Ne", "Neon", 20.180, 18, 2, None, 8),
    (11, "Na", "Sodium", 22.990, 1, 3, 0.93, 1),
    (12, "Mg", "Magnesium", 24.305, 2, 3, 1.31, 2),
    (13, "Al", "Aluminium", 26.982, 13, 3, 1.61, 3),
    (14, "Si", "Silicon", 28.085, 14, 3, 1.90, 4),
    (15, "P", "Phosphorus", 30.974, 15, 3, 2.19, 5),
    (16, "S", "Sulfur", 32.06, 16, 3, 2.58, 6),
    (17, "Cl", "Chlorine", 35.45, 17, 3, 3.16, 7),
    (18, "Ar", "Argon", 39.948, 18, 3, None, 8),
    (19, "K", "Potassium", 39.098, 1, 4, 0.82, 1),
    (20, "Ca", "Calcium", 40.078, 2, 4, 1.00, 2),
    (21, "Sc", "Scandium", 44.956, 3, 4, 1.36, 3),
    (22, "Ti", "Titanium", 47.867, 4, 4, 1.54, 4),
    (23, "V", "Vanadium", 50.942, 5, 4, 1.63, 5),
    (24, "Cr", "Chromium", 51.996, 6, 4, 1.66, 6),
    (25, "Mn", "Manganese", 54.938, 7, 4, 1.55, 7),
    (26, "Fe", "Iron", 55.845, 8, 4, 1.83, 8),
    (27, "Co", "Cobalt", 58.933, 9, 4, 1.88, 9),
    (28, "Ni", "Nickel", 58.693, 10, 4, 1.91, 10),
    (29, "Cu", "Copper", 63.546, 11, 4, 1.90, 11),
    (30, "Zn", "Zinc", 65.38, 12, 4, 1.65, 12),
    (31, "Ga", "Gallium", 69.723, 13, 4, 1.81, 3),
    (32, "Ge", "Germanium", 72.630, 14, 4, 2.01, 4),
    (33, "As", "Arsenic", 74.922, 15, 4, 2.18, 5),
    (34, "Se", "Selenium", 78.971, 16, 4, 2.55, 6),
    (35, "Br", "Bromine", 79.904, 17, 4, 2.96, 7),
    (36, "Kr", "Krypton", 83.798, 18, 4, 3.00, 8),
    (37, "Rb", "Rubidium", 85.468, 1, 5, 0.82, 1),
    (38, "Sr", "Strontium", 87.62, 2, 5, 0.95, 2),
    (39, "Y", "Yttrium", 88.906, 3, 5, 1.22, 3),
    (40, "Zr", "Zirconium", 91.224, 4, 5, 1.33, 4),
    (41, "Nb", "Niobium", 92.906, 5, 5, 1.60, 5),
    (42, "Mo", "Molybdenum", 95.95, 6, 5, 2.16, 6),
    (44, "Ru", "Ruthenium", 101.07, 8, 5, 2.20, 8),
    (45, "Rh", "Rhodium", 102.91, 9, 5, 2.28, 9),
    (46, "Pd", "Palladium", 106.42, 10, 5, 2.20, 10),
    (47, "Ag", "Silver", 107.87, 11, 5, 1.93, 11),
    (48, "Cd", "Cadmium", 112.41, 12, 5, 1.69, 12),
    (49, "In", "Indium", 114.82, 13, 5, 1.78, 3),
    (50, "Sn", "Tin", 118.71, 14, 5, 1.96, 4),
    (51, "Sb", "Antimony", 121.76, 15, 5, 2.05, 5),
    (52, "Te", "Tellurium", 127.60, 16, 5, 2.10, 6),
    (53, "I", "Iodine", 126.90, 17, 5, 2.66, 7),
    (54, "Xe", "Xenon", 131.29, 18, 5, 2.60, 8),
    (55, "Cs", "Caesium", 132.91, 1, 6, 0.79, 1),
    (56, "Ba", "Barium", 137.33, 2, 6, 0.89, 2),
    (57, "La", "Lanthanum", 138.91, 3, 6, 1.10, 3),
    (72, "Hf", "Hafnium", 178.49, 4, 6, 1.30, 4),
    (73, "Ta", "Tantalum", 180.95, 5, 6, 1.50, 5),
    (74, "W", "Tungsten", 183.84, 6, 6, 2.36, 6),
    (77, "Ir", "Iridium", 192.22, 9, 6, 2.20, 9),
    (78, "Pt", "Platinum", 195.08, 10, 6, 2.28, 10),
    (79, "Au", "Gold", 196.97, 11, 6, 2.54, 11),
    (80, "Hg", "Mercury", 200.59, 12, 6, 2.00, 12),
    (81, "Tl", "Thallium", 204.38, 13, 6, 1.62, 3),
    (82, "Pb", "Lead", 207.2, 14, 6, 2.33, 4),
    (83, "Bi", "Bismuth", 208.98, 15, 6, 2.02, 5),
]

ELEMENTS: dict[str, Element] = {}
_BY_Z: dict[int, Element] = {}
for _row in _RAW:
    _el = Element(*_row)
    ELEMENTS[_el.symbol] = _el
    _BY_Z[_el.z] = _el


def by_symbol(symbol: str) -> Element:
    try:
        return ELEMENTS[symbol]
    except KeyError as exc:
        raise KeyError(f"unknown element symbol: {symbol!r}") from exc


def by_number(z: int) -> Element:
    try:
        return _BY_Z[z]
    except KeyError as exc:
        raise KeyError(f"no element with atomic number {z}") from exc


def known_symbols() -> list[str]:
    return sorted(ELEMENTS, key=lambda s: ELEMENTS[s].z)
