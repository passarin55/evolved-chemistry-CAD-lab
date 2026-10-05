# Evolved Chemistry CAD Lab (ECCL)

> A modular, deliberately over‑engineered computational workbench for
> **materials experimentation, drug discovery, and "normal" chemistry** — with
> dedicated engines for **semiconductors (photonics / plasmonics / quantum /
> conventional)**, an **evolutionary designer** that invents new molecules and
> materials, a **harsh critics gate** that keeps the search honest,
> **local‑LLM** integration, **deep web search**, and **spectrometer
> interpretation** across IR / Raman / NMR / UV‑Vis / MS / XRD.

Everything runs **offline**. RDKit powers real cheminformatics; NumPy/SciPy
power the physics. Local LLMs and live web search are optional enhancements with
graceful fallbacks, so no pipeline ever hard‑depends on a network.

---

## Why this exists

Designing a new material or molecule is a loop: *propose → predict properties →
criticise → search the literature → refine → characterise.* ECCL implements that
whole loop as composable Python, so you can drive it from a REPL, a script, or
the `eccl` CLI.

## Capabilities at a glance

| Domain | What you get |
|---|---|
| **Chemistry** | Formula algebra (hydrates, nested groups, fractional stoichiometry), molar mass, exact **reaction balancing** via rational null‑space (handles redox), molecular descriptors, fingerprint similarity |
| **Drug discovery** | Lipinski / Veber / Ghose / Egan rule sets, structural alerts, a transparent QED‑like score and synthetic‑accessibility proxy |
| **Materials** | Crystallographic density, Goldschmidt tolerance factor (perovskites), electronegativity/ionicity descriptors |
| **Semiconductors (normal)** | Varshni band gap vs T, intrinsic carrier conc., doping & Fermi level, pn‑junction built‑in potential & depletion width, Shockley‑Queisser PV screening |
| **Photonics** | Sellmeier dispersion, group index, Fresnel/Brewster/TIR, DBR mirrors, slab‑waveguide mode count, Fabry‑Pérot Q & finesse |
| **Plasmonics** | Drude dielectric functions, surface‑plasmon‑polariton dispersion, quasistatic **LSPR**, dipole **Mie** cross‑sections |
| **Quantum** | 1‑D/2‑D tight‑binding, graphene Dirac bands, quantum‑well sub‑bands, **quantum‑dot** Brus shift & emission |
| **Evolved chemistry** | A genetic algorithm over molecules (and alloy compositions) with mutation, fragment crossover, multi‑objective fitness, elitism, novelty pressure, and a pluggable gate |
| **Critics gate** | A panel of skeptical critics (validity, connectivity, size, drug‑likeness, safety alerts, synthesizability) with four **harshness** levels; optional LLM devil's‑advocate that can only *tighten* the verdict |
| **Spectroscopy** | Forward‑**simulate** IR / UV‑Vis / powder‑XRD from structures, and **interpret** observed IR / Raman / ¹H / ¹³C / MS peaks into functional groups with confidences and cross‑modality corroboration |
| **Local LLM** | Ollama + OpenAI‑compatible backends (LM Studio / llama.cpp / vLLM), auto‑discovery, deterministic offline fallback |
| **Deep search** | Multi‑provider (PubChem, Wikipedia, arXiv, Crossref, DuckDuckGo) fan‑out, query expansion, dedupe/rank, optional grounded LLM synthesis with citations |

See [`docs/architecture.md`](docs/architecture.md) for the layering.

---

## Install

```bash
pip install -e ".[all]"      # core + rdkit + httpx
# or minimal:
pip install -e .             # numpy + scipy only (many chem features need rdkit)
pytest                       # 58 tests
```

Requires Python ≥ 3.10. RDKit is strongly recommended (chemistry features
degrade gracefully without it, physics does not need it).

---

## Quick start — CLI

```bash
eccl info                                            # capabilities & LLM status

# chemistry
eccl molecule "CC(=O)Oc1ccccc1C(=O)O"                # analyse aspirin
eccl react "KMnO4,HCl" "KCl,MnCl2,H2O,Cl2"           # balance a redox reaction

# materials / semiconductors
eccl semiconductor GaAs --temp 300 --nd 1e17 --na 1e17
eccl plasmon Au --radius 20 --medium-eps 1.77        # gold nanosphere LSPR
eccl qdot CdTe --radius 2.5                           # quantum-dot emission
eccl perovskite Cs+ Pb2+ I-                           # Goldschmidt tolerance

# spectroscopy
eccl spectrum IR 3000 1715 1280                       # interpret IR peaks

# evolved chemistry under the harsh gate
eccl evolve --target-mw 300 --generations 15 --gate --harshness HARSH
eccl campaign "antioxidant lead" --target-mw 300 --ground "ferulic acid antioxidant"

# gate screening & deep search
eccl gate "CCO" "CC(=O)Oc1ccccc1C(=O)O" --harshness BRUTAL
eccl search "perovskite solar cell stability"
```

Add `--json` to any command for machine‑readable output.

---

## Quick start — Python

```python
from eccl import Workbench
from eccl.evolve import WeightedObjective, fitness
from eccl.critics import Harshness

wb = Workbench()

# 1) Characterise a semiconductor for photovoltaics
print(wb.analyze_semiconductor("GaAs", n_donor=1e17, n_acceptor=1e17))

# 2) Evolve a drug-like lead under the harsh critics gate
objective = WeightedObjective({
    "druglike":  (1.0, fitness.druglikeness()),
    "mw":        (0.6, fitness.target_property("mol_weight", 320, 50)),
    "synth":     (0.5, fitness.synthesizability()),
})
result = wb.evolve_molecules(objective, use_gate=True, harshness="HARSH")
print(result.best.genome.smiles, result.best.fitness)

# 3) Interpret a spectrum
from eccl import spectro
print(spectro.interpret_peaks([3000, 1715, 1250], "IR").functional_groups)
```

### A full discovery campaign

```python
from eccl.lab import DiscoveryCampaign, druglike_objective

camp = DiscoveryCampaign()
report = camp.run(
    title="COX-2-like scaffold",
    objective=druglike_objective(target_mw=320, reference_smiles="O=C(O)c1ccccc1O"),
    ground_query="salicylate anti-inflammatory mechanism",  # deep search (if online)
    harshness="HARSH",
)
for w in report.winners:
    print(w["smiles"], w["fitness"], w["ir_interpretation"])
```

The campaign: (optionally) grounds itself with deep search → evolves candidates
under the gate → forward‑simulates each winner's IR/UV‑Vis and round‑trips the
interpretation → emits a structured JSON report.

---

## Using a local LLM

Point ECCL at any local model; nothing leaves your machine.

```bash
# Ollama
ollama serve && ollama pull llama3.1
export ECCL_LLM_BACKEND=ollama ECCL_LLM_MODEL=llama3.1

# or an OpenAI-compatible server (LM Studio / llama.cpp / vLLM)
export ECCL_LLM_BACKEND=openai ECCL_LLM_BASE_URL=http://localhost:1234/v1 ECCL_LLM_MODEL=local-model

export ECCL_USE_LLM_CRITIC=1    # enable the LLM devil's-advocate in the gate
```

With no model reachable, ECCL transparently uses the offline deterministic
client and all scientific judgement falls back to the rule‑based engines.

---

## The harsh critics gate

The gate runs a panel of independent critics and rejects under a configurable
harshness:

| Harshness | Rejects on |
|---|---|
| `LENIENT` | only fatal errors (unparseable) |
| `NORMAL`  | major problems |
| `HARSH` *(default)* | any concern — marginal candidates are cut |
| `BRUTAL`  | anything not strictly perfect |

Critics ship for validity, connectivity (no salts/mixtures), size sanity,
drug‑likeness, structural‑alert safety, and synthesizability. Plug it straight
into the evolutionary engine so only candidates that survive scrutiny reproduce.
The optional LLM critic can raise a new concern but **never** rescues a
rule‑based rejection.

> **Scope & honesty.** ECCL's property models are fast, transparent
> approximations for *design triage and education*, not substitutes for DFT/MD,
> wet‑lab validation, or regulatory assessment. Structural "safety" alerts are
> coarse medicinal‑chemistry heuristics, not toxicity or safety determinations.

---

## Examples

Runnable scripts in [`examples/`](examples/):

1. `01_molecule_and_drug_triage.py` — descriptors + drug‑likeness + gate
2. `02_semiconductor_and_photonics.py` — PV screening, waveguides, LSPR, QDs, perovskites
3. `03_evolve_under_critics_gate.py` — a gated evolutionary run with a hall of fame
4. `04_spectroscopy_interpretation.py` — simulate ↔ interpret IR/NMR/MS/XRD
5. `05_local_llm_and_deep_search.py` — wire in a local model and grounded search

---

## Project layout

```
eccl/
  core/       elements, units, formula, Molecule, Material, LabNotebook
  chem/       descriptors, druglike, similarity, reactions
  materials/  semiconductor, photonics, plasmonics, quantum, crystal
  evolve/     genome, operators, fitness, engine
  spectro/    tables, simulate, interpret
  critics/    rules, gate
  llm/        base, local, echo, manager
  search/     base, providers, deep
  lab/        workbench, pipeline
  cli.py
tests/        58 tests (physics sanity-checked vs known values)
examples/     5 runnable demos
docs/         architecture
```

## License

Apache‑2.0. See [`LICENSE`](LICENSE).
