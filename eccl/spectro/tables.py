"""Reference tables for spectroscopic interpretation.

Characteristic IR/Raman bands, approximate 1H/13C NMR shift ranges, and common
mass-spec neutral losses. Values are typical textbook ranges; the interpreter
matches observed peaks against these windows and reports assignments with a
confidence derived from how centrally the peak falls.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Band:
    low: float
    high: float
    assignment: str
    group: str
    intensity: str = ""     # strong/medium/weak/variable
    note: str = ""

    def center(self) -> float:
        return 0.5 * (self.low + self.high)

    def contains(self, x: float) -> bool:
        return self.low <= x <= self.high


# --- Infrared absorption bands (cm^-1) ---
IR_BANDS: list[Band] = [
    Band(3584, 3700, "O-H stretch (free)", "alcohol/phenol", "variable, sharp"),
    Band(3200, 3550, "O-H stretch (H-bonded)", "alcohol/acid", "strong, broad"),
    Band(3300, 3500, "N-H stretch", "amine/amide", "medium"),
    Band(3267, 3333, "≡C-H stretch", "terminal alkyne", "strong, sharp"),
    Band(3000, 3100, "=C-H stretch", "alkene/aromatic", "medium"),
    Band(2500, 3300, "O-H stretch (carboxylic acid)", "carboxylic acid", "strong, very broad"),
    Band(2840, 3000, "C-H stretch (sp3)", "alkane", "strong"),
    Band(2550, 2600, "S-H stretch", "thiol", "weak"),
    Band(2220, 2260, "C≡N stretch", "nitrile", "medium"),
    Band(2100, 2260, "C≡C stretch", "alkyne", "weak"),
    Band(2100, 2170, "N=C=O / azide / diazo", "cumulene/azide", "strong"),
    Band(1700, 1780, "C=O stretch", "carbonyl (general)", "strong"),
    Band(1735, 1750, "C=O stretch (ester)", "ester", "strong"),
    Band(1700, 1725, "C=O stretch (ketone/aldehyde)", "ketone/aldehyde", "strong"),
    Band(1680, 1725, "C=O stretch (carboxylic acid)", "carboxylic acid", "strong"),
    Band(1630, 1700, "C=O stretch (amide I)", "amide", "strong"),
    Band(1620, 1680, "C=C stretch", "alkene", "variable"),
    Band(1500, 1600, "C=C aromatic ring stretch", "aromatic", "medium"),
    Band(1550, 1650, "N-H bend (amide II)", "amide", "medium"),
    Band(1500, 1570, "N-O asym stretch", "nitro", "strong"),
    Band(1350, 1470, "C-H bend (CH2/CH3)", "alkane", "variable"),
    Band(1320, 1390, "N-O sym stretch", "nitro", "strong"),
    Band(1180, 1360, "C-N stretch", "amine (aromatic)", "medium"),
    Band(1000, 1300, "C-O stretch", "alcohol/ether/ester", "strong"),
    Band(1020, 1250, "C-N stretch", "amine (aliphatic)", "medium"),
    Band(900, 1300, "C-F stretch", "fluoride", "strong"),
    Band(690, 900, "=C-H bend (aromatic oop)", "aromatic", "strong"),
    Band(600, 800, "C-Cl stretch", "chloride", "strong"),
    Band(500, 680, "C-Br stretch", "bromide", "strong"),
]


# --- Raman-active characteristic bands (cm^-1); complements IR ---
RAMAN_BANDS: list[Band] = [
    Band(1340, 1360, "D band (disordered carbon)", "carbon", "variable",
         "sp2 defects/edges"),
    Band(1570, 1600, "G band (graphitic sp2)", "carbon", "strong",
         "in-plane C=C"),
    Band(2650, 2700, "2D band", "carbon", "variable",
         "layer count fingerprint in graphene"),
    Band(1000, 1010, "ring breathing", "aromatic (mono-sub benzene)", "strong"),
    Band(2100, 2260, "C≡C / C≡N", "alkyne/nitrile", "strong"),
    Band(1600, 1680, "C=C stretch", "alkene", "strong"),
    Band(480, 525, "Si-Si (crystalline Si TO phonon)", "silicon", "strong",
         "c-Si ~520 cm^-1; a-Si broad ~480"),
    Band(2550, 2600, "S-S / S-H", "disulfide/thiol", "medium"),
]


# --- 1H NMR chemical-shift windows (ppm) ---
PROTON_NMR: list[Band] = [
    Band(0.0, 0.9, "alkyl CH3", "alkane"),
    Band(0.9, 1.6, "alkyl CH2/CH", "alkane"),
    Band(1.6, 2.6, "allylic / alpha to C=O / benzylic", "activated CH"),
    Band(2.0, 3.0, "C≡C-H (terminal alkyne)", "alkyne"),
    Band(2.2, 2.9, "amine N-H / Ar-CH3", "amine/toluene"),
    Band(3.3, 4.5, "O-CH (ethers/alcohols/esters)", "O-alkyl"),
    Band(4.5, 6.5, "vinylic =CH", "alkene"),
    Band(6.5, 8.5, "aromatic H", "aromatic"),
    Band(9.5, 10.1, "aldehyde CHO", "aldehyde"),
    Band(10.0, 13.0, "carboxylic acid O-H", "carboxylic acid"),
]


# --- 13C NMR chemical-shift windows (ppm) ---
CARBON_NMR: list[Band] = [
    Band(0, 40, "sp3 alkyl C", "alkane"),
    Band(40, 70, "C-N / C-O (sp3)", "amine/alcohol/ether"),
    Band(60, 90, "C-O (sp3, oxygenated)", "alcohol/ether"),
    Band(70, 95, "alkyne C", "alkyne"),
    Band(100, 150, "aromatic / alkene C", "aromatic/alkene"),
    Band(150, 185, "ester/acid/amide carbonyl C", "carbonyl (COOR/COOH/CONH)"),
    Band(185, 220, "ketone/aldehyde carbonyl C", "ketone/aldehyde"),
]


# --- Common neutral losses in EI mass spectrometry (Da) ---
NEUTRAL_LOSSES: dict[int, str] = {
    15: "CH3 (methyl)",
    17: "OH / NH3",
    18: "H2O",
    28: "CO / C2H4 / N2",
    29: "CHO / C2H5",
    31: "OCH3 (methoxy)",
    35: "Cl",
    43: "C3H7 / CH3CO (acetyl)",
    44: "CO2",
    45: "COOH / OC2H5",
    46: "NO2 / C2H5OH",
    77: "C6H5 (phenyl)",
}


def tables_for(modality: str) -> list[Band]:
    modality = modality.lower()
    if modality in ("ir", "infrared", "ftir"):
        return IR_BANDS
    if modality == "raman":
        return RAMAN_BANDS
    if modality in ("1h", "hnmr", "proton"):
        return PROTON_NMR
    if modality in ("13c", "cnmr", "carbon"):
        return CARBON_NMR
    raise KeyError(f"no table for modality {modality!r}")
