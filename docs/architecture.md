# Architecture

ECCL is a layered system. Lower layers never import upper layers, so each is
testable in isolation and the whole thing runs offline.

```
                        ┌─────────────────────────────┐
                        │            cli.py           │  command line
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │             lab/            │  orchestration
                        │  Workbench, DiscoveryCampaign│
                        └──┬───────┬───────┬───────┬───┘
            ┌──────────────┘       │       │       └──────────────┐
            │                      │       │                      │
   ┌────────▼───────┐   ┌──────────▼──┐ ┌──▼──────────┐  ┌────────▼───────┐
   │    evolve/     │   │  critics/   │ │   search/   │  │     llm/       │
   │  GA engine     │   │ harsh gate  │ │ deep search │  │ local-first    │
   └────────┬───────┘   └──────┬──────┘ └─────────────┘  └────────────────┘
            │                  │
   ┌────────▼──────────────────▼─────────────────────────────────────────┐
   │   chem/            materials/            spectro/                     │
   │ descriptors,     semiconductor,       simulate + interpret           │
   │ druglike,        photonics,           IR/Raman/NMR/UV-Vis/MS/XRD      │
   │ similarity,      plasmonics,                                          │
   │ reactions        quantum, crystal                                    │
   └────────┬──────────────────────────────────────────────────────────┬─┘
            │                                                            │
   ┌────────▼────────────────────────────────────────────────────────▼─┐
   │                              core/                                  │
   │   elements · units · formula · Molecule · Material · LabNotebook   │
   └────────────────────────────────────────────────────────────────────┘
```

## Design principles

1. **Offline-first.** The scientific core (chemistry + physics + evolution +
   spectroscopy) depends only on NumPy/SciPy and, where present, RDKit. The LLM
   and web search are *optional enhancements* behind interfaces with graceful
   fallbacks — nothing crashes when the network or a local model is absent.

2. **Local-first AI.** LLM access is designed around models running on the
   user's own machine (Ollama, LM Studio, llama.cpp, vLLM). An
   OpenAI-compatible client covers the rest. A deterministic `EchoClient` keeps
   every pipeline runnable with no model at all.

3. **The gate only gets stricter.** The harsh critics gate aggregates
   independent deterministic critics; an optional LLM "devil's advocate" can
   *add* a concern but can never *overturn* a rule-based rejection. The search
   cannot talk its way past the filter.

4. **Transparent heuristics.** Where a full ab-initio method is out of scope
   (SA score, QED, UV-Vis), ECCL uses an explicit, documented approximation
   rather than a black box, and labels it as qualitative.

5. **Everything is serialisable.** Molecules, materials, verdicts, runs and the
   lab notebook all round-trip through JSON, so results flow between the engine,
   the critics, the LLM, and disk.

## Module responsibilities

| Module       | Responsibility                                                        |
|--------------|----------------------------------------------------------------------|
| `core`       | Domain model: periodic table, units, formula algebra, Molecule, Material, notebook |
| `chem`       | Descriptors, drug-likeness rule sets, fingerprint similarity, reaction balancing |
| `materials`  | Semiconductor stats, photonics (Sellmeier/Fresnel/waveguide/DBR), plasmonics (Drude/LSPR/Mie), quantum (tight-binding/wells/dots), crystals |
| `spectro`    | Forward-simulate and interpret IR/Raman/NMR/UV-Vis/MS/XRD             |
| `evolve`     | Genomes, mutation/crossover operators, composable fitness, GA engine  |
| `critics`    | Deterministic critics + the harsh gate, pluggable into the GA         |
| `llm`        | Local-first client abstraction, backends, offline fallback            |
| `search`     | Multi-provider deep search with ranking and LLM synthesis             |
| `lab`        | Workbench facade and end-to-end discovery campaigns                   |

## Extending

- **New semiconductor / metal / optical material:** add a row to the relevant
  `LIBRARY` / `METALS` / `SELLMEIER` table.
- **New structural alert or spectral band:** add to `chem/druglike._ALERTS` or
  `spectro/tables.py`.
- **New critic:** write a `Molecule -> Critique` function and pass it in the
  `critics=[...]` list to `CriticsGate`.
- **New objective:** write a `MoleculeGenome -> float` and compose it in a
  `WeightedObjective`.
- **New search provider:** implement the `SearchProvider` protocol and pass it
  to `DeepSearch(providers=[...])`.
- **New LLM backend:** implement the `LLMClient` protocol.

## Validation

The physics is sanity-checked against known values in `tests/` — e.g. silicon
band gap 1.12 eV and density 2.329 g/cm³, GaAs absorption edge ~871 nm, fused
silica n≈1.458 at 589 nm, Brewster angle 56.3°, the silicon (111) XRD line at
28.44°, and graphene's gapless Dirac point.
