# ECCL GUI — architecture & API contract

The GUI is a **local web application**: a zero-dependency Python HTTP server
(stdlib `http.server`) serving a JSON API over the lab, plus a single-page
frontend written in plain JavaScript with its own SVG charting library. It runs
fully **offline** (no CDN, no web fonts, no external scripts) and binds to
`127.0.0.1` by default.

```
eccl gui [--host 127.0.0.1] [--port 8765] [--no-browser]
python -m eccl.gui [same flags]
```

```
eccl/gui/
  __init__.py      launch(), make_server()
  __main__.py      python -m eccl.gui
  server.py        HTTP server: routing, static files, security, JSON I/O
  api.py           endpoint handlers (dict in -> dict out), route table
  jobs.py          background JobManager (evolution / campaign / search)
  static/
    index.html     shell; loads scripts with `defer` (no inline JS — CSP)
    styles.css     theme (light/dark via CSS variables), layout, components
    app.js         ECCL core: panel registry, hash router, API client, bus, theme
    lib/ui.js      DOM helpers & components (ECCL.ui)
    lib/plot.js    SVG charts (ECCL.plot)
    panels/*.js    one file per panel; each calls ECCL.registerPanel(...)
```

---

## 1. Server contract (`eccl/gui/server.py`, `eccl/gui/__init__.py`)

- `eccl.gui.make_server(host="127.0.0.1", port=8765) -> (server, url)` — builds
  (does not start) a `ThreadingHTTPServer` (daemon threads). `port=0` picks a
  free port; `url` reflects the bound port. Used by tests.
- `eccl.gui.launch(host="127.0.0.1", port=8765, open_browser=True)` — prints the
  URL, optionally opens the browser (`webbrowser`), serves forever, shuts down
  cleanly on Ctrl-C.
- CLI: `eccl gui` subcommand in `eccl/cli.py` with `--host`, `--port`,
  `--no-browser`; `eccl/gui/__main__.py` provides the same via argparse.

**Routes**
- `GET /` → `static/index.html`.
- `GET /static/<path>` → file under `eccl/gui/static/`. Resolve and verify the
  real path stays inside the static dir (path-traversal safe, `..`, encoded
  `%2e%2e`, absolute paths rejected → 404). Correct `Content-Type` for
  `.html .js .css .svg .png .json .ico`. `Cache-Control: no-store`.
- `/api/...` → JSON endpoints (section 2). Unknown API route → 404 JSON;
  known route wrong method → 405 JSON.

**JSON I/O**
- Request bodies: JSON object, max **2 MB** (→ 413). Malformed JSON or non-object
  → 400. Empty body on POST is treated as `{}`.
- Responses: `application/json; charset=utf-8`. **Non-finite floats (inf/nan)
  must be converted to `null`** before encoding (browsers reject `Infinity`);
  tuples → lists; numpy scalars/arrays → Python numbers/lists.
- Errors: `{"error": "<message>", "type": "<ExceptionClass>"}`.
  `ValueError`, `KeyError`, `TypeError`, `MoleculeError` and explicit validation
  errors → **400**; any other exception → **500** (traceback logged to stderr,
  not sent to the client).

**Security**
- When bound to a loopback address, reject requests whose `Host` header is not
  `localhost`, `127.0.0.1` or `[::1]` (any port) → 403 (DNS-rebinding defense).
  The literal loopback address the server is bound to (e.g. `127.0.0.2` with
  `--host 127.0.0.2`) is accepted too: an IP literal cannot be re-pointed by DNS.
- For non-GET requests, if an `Origin` header is present and its host:port does
  not match the request `Host` → 403 (CSRF defense).
- Headers on every response: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- No endpoint reads or writes arbitrary filesystem paths supplied by the client
  (notebook export/import go through JSON bodies, not paths).
- Quiet logging (one concise line per request to stderr, or none for 2xx static).

**State**
- One process-wide `Workbench` (lazy LLM) and one `JobManager`. Notebook
  mutations guarded by a lock. Analyses that the Workbench already registers in
  its notebook (molecule analysis, evolution runs) keep doing so, so the
  Notebook panel shows lab history.

---

## 2. API endpoints (`eccl/gui/api.py`)

All POST bodies are JSON objects; omitted fields take the listed defaults.
Responses below list the required keys (extra keys are allowed).
Numeric fields reject non-finite values and integers beyond ±2⁶³ (400, never an
overflow 500). SMILES fields accept at most 1000 characters.

### General
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ok: true}` |
| GET | `/api/info` | – | see below |

`/api/info` →
```json
{
  "version": "0.1.0",
  "rdkit": true,
  "llm": {"backend": "echo (offline, deterministic)", "model": null, "reachable": false},
  "config": {...Config.as_dict()},
  "libraries": {
    "semiconductors": [{"name":"Si","eg_300k":1.12,"direct_gap":false,"me_eff":1.08,"mh_eff":0.81,"eps_r":11.7}],
    "metals": [{"name":"Au","wp_ev":9.03,"gamma_ev":0.071,"eps_inf":9.84}],
    "sellmeier": ["Al2O3","BK7","MgF2","SiO2","TiO2"],
    "ionic_radii": {"Cs+":1.67, "...": 0},
    "structures": ["diamond","zincblende","rocksalt","fcc","bcc","perovskite","simple"],
    "spectro_modalities": ["IR","raman","1H","13C"],
    "harshness": ["LENIENT","NORMAL","HARSH","BRUTAL"],
    "search_providers": ["pubchem","wikipedia","arxiv","crossref","duckduckgo"],
    "llm_backends": ["auto","ollama","openai","echo"]
  },
  "presets": {
    "molecules": {"aspirin":"CC(=O)Oc1ccccc1C(=O)O", "caffeine":"...", "ibuprofen":"...",
                  "paracetamol":"...", "penicillin G":"...", "benzene":"c1ccccc1",
                  "ethanol":"CCO", "nitrobenzene":"O=[N+]([O-])c1ccccc1",
                  "naphthalene":"c1ccc2ccccc2c1", "hexatriene":"C=CC=CC=C"},
    "reactions": [{"name":"Propane combustion","reactants":["C3H8","O2"],"products":["CO2","H2O"]},
                  {"name":"Permanganate + HCl","reactants":["KMnO4","HCl"],"products":["KCl","MnCl2","H2O","Cl2"]},
                  {"name":"Rusting","reactants":["Fe","O2"],"products":["Fe2O3"]},
                  {"name":"Photosynthesis","reactants":["CO2","H2O"],"products":["C6H12O6","O2"]},
                  {"name":"Thermite","reactants":["Al","Fe2O3"],"products":["Al2O3","Fe"]}],
    "spectra": [{"name":"Carboxylic acid (IR)","modality":"IR","peaks":[3000,1715,1280,940]},
                {"name":"Aromatic ester (IR)","modality":"IR","peaks":[3050,2950,1740,1600,1250,750]},
                {"name":"Graphene (Raman)","modality":"raman","peaks":[1350,1582,2690]},
                {"name":"Acid + aromatic (1H)","modality":"1H","peaks":[1.2,2.1,7.3,11.6]},
                {"name":"Ester (13C)","modality":"13C","peaks":[14,61,128,170]}],
    "perovskites": [{"name":"CsPbI3","a":"Cs+","b":"Pb2+","x":"I-"},
                    {"name":"MAPbI3","a":"MA+","b":"Pb2+","x":"I-"},
                    {"name":"FAPbI3","a":"FA+","b":"Pb2+","x":"I-"},
                    {"name":"SrTiO3","a":"Sr2+","b":"Ti4+","x":"O2-"},
                    {"name":"BaTiO3","a":"Ba2+","b":"Ti4+","x":"O2-"},
                    {"name":"CsSnBr3","a":"Cs+","b":"Sn2+","x":"Br-"}],
    "crystals": [{"name":"Silicon","formula":"Si","a":5.431,"structure":"diamond","formula_units":8},
                 {"name":"GaAs","formula":"GaAs","a":5.653,"structure":"zincblende","formula_units":4},
                 {"name":"NaCl","formula":"NaCl","a":5.640,"structure":"rocksalt","formula_units":4},
                 {"name":"SrTiO3","formula":"SrTiO3","a":3.905,"structure":"perovskite","formula_units":1},
                 {"name":"Copper","formula":"Cu","a":3.615,"structure":"fcc","formula_units":4},
                 {"name":"Iron (alpha)","formula":"Fe","a":2.866,"structure":"bcc","formula_units":2}]
  }
}
```

### Chemistry
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/molecule/analyze` | `{smiles, harshness="HARSH", register=true}` | `{smiles, input_smiles, canonical_smiles, formula, molar_mass, inchi_key, svg, descriptors{...}, drug_likeness{rules[{name,passed,violations}], alerts[], sa_proxy, qed_like, rules_passed}, gate{GateVerdict}, ir{x[],y[],peaks[]}, ir_interpretation{Interpretation, structure_filter}, uvvis{lambda_max_nm,conjugated_bonds,note,model_applicable,caveat,...}, record_id}` |
| POST | `/api/molecule/depict` | `{smiles, width=320, height=240}` | `{svg}` (+ `note` when the depiction was skipped) |
| POST | `/api/molecule/similarity` | `{query, library:[smiles]}` | `{query, results:[{smiles, tanimoto}] (desc), diversity}` |
| POST | `/api/formula` | `{formula}` | `{formula, hill, counts{el:n}, molar_mass, mass_fractions{el:f}}` |
| POST | `/api/reaction/balance` | `{reactants:[str], products:[str]}` | `{equation, reactants:[{coeff,formula,molar_mass}], products:[...], mass_balance_error}` |
| POST | `/api/reaction/stoichiometry` | `{reactants, products, basis, moles=1}` | `{equation, basis, moles{formula:mol}, grams{formula:g}}` |

Notes: invalid SMILES → 400. `svg` is an RDKit 2-D depiction (MolDraw2DSVG,
transparent background is fine — the frontend places it on a white "paper"
box); molecules with more than 250 atoms are not depicted (`svg: null`), since
layout time grows steeply and would stall the server. The IR trace is
downsampled to ≤ 600 points. If RDKit is unavailable the structure-dependent
keys are `null`.
- `input_smiles` echoes the request; `canonical_smiles` is RDKit's canonical
  form (`null` without RDKit). `smiles` is kept for compatibility.
- `register=false` analyses without writing a notebook record (previews).
- `ir_interpretation` is structure-aware: candidates whose group needs an
  element the molecule lacks (e.g. C–F without F) are dropped, groups and
  summary recomputed, and the dropped ones listed in
  `structure_filter{elements[], excluded[{peak,assignment,group,missing_elements}]}`.
  `/api/spectro/simulate_ir` returns the same filtered interpretation.
- `uvvis` adds `conjugated_systems`, `model_applicable` (the Kuhn box model is
  only meaningful for linear all-carbon polyenes) and a `caveat` string when it
  is not (aromatic rings, heteroatom conjugation, several π systems).
- `/api/formula`: a formula with no atoms (e.g. `H0`) → 400.

### Semiconductors
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/semiconductor/analyze` | `{name, temperature_k=300, n_donor=0, n_acceptor=0}` | Workbench.analyze_semiconductor output + `params{...}` |
| POST | `/api/semiconductor/curves` | `{name, t_min=50, t_max=600, points=111, temperature_k=null}` | `{name, temperature[], bandgap_ev[], ni_cm3[], eg_300k, sq{bandgap_ev[], efficiency_pct[], material{bandgap_ev, efficiency_pct, temperature_k}}}` (sq sweeps 0.3–3.5 eV; `material` is at `temperature_k` via Varshni, or the 300 K table gap when omitted) |
| POST | `/api/semiconductor/compare` | `{temperature_k=300}` | `{rows:[{name,bandgap_ev,direct_gap,absorption_edge_nm,ni_cm3,sq_efficiency_pct,classification}]}` (all library materials) |

`carriers` (when Nd or Na > 0) uses the engine's model (full ionisation,
n − p = Nd − Na, np = nᵢ²) but is solved without cancellation and in log space,
so p-type material and wide-gap materials at low temperature give the majority
carrier and E_F − Eᵢ; a minority carrier below ~10⁻³⁰⁸ cm⁻³ is reported as 0.

### Photonics
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/photonics/dispersion` | `{material, lambda_min_nm=300, lambda_max_nm=2000, points=171}` | `{material, wavelength_nm[], n[], group_index[], omitted, n_589nm, n_F, n_C, abbe_number, n_1550nm, group_index_1550nm}` — points where Sellmeier is non-physical are omitted (arrays stay equal length); reference values are `null` where the fit is non-physical |
| POST | `/api/photonics/fresnel` | `{n1=1.0, n2=1.5, points=181}` | `{angle_deg[], Rs[], Rp[], R[], brewster_deg, critical_deg|null}` (0–90°) |
| POST | `/api/photonics/waveguide` | `{core_index, clad_index, thickness_nm, wavelength_nm}` | `{v_number, num_modes_estimate, single_mode, cutoff_wavelength_nm, sweep{thickness_nm[], num_modes[]}}` (sweep 0.05×–3× thickness) |
| POST | `/api/photonics/dbr` | `{n_high, n_low, n_in=1.0, n_out=1.5, max_pairs=20, design_wavelength_nm=1550}` | `{pairs[], reflectance[], leakage[], bragg_wavelength_nm, d_high_nm, d_low_nm}` (quarter-wave d=λ/4n; `leakage` = 1 − R evaluated in log space, so it stays meaningful where R rounds to 1) |
| POST | `/api/photonics/cavity` | `{reflectance, length_nm, wavelength_nm, n=1}` | `{finesse, fsr_nm, linewidth_nm, Q}` |

### Plasmonics
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/plasmonics/drude` | `{metal, ev_min=0.5, ev_max=6, points=221}` | `{metal, photon_ev[], wavelength_nm[], eps_real[], eps_imag[]}` |
| POST | `/api/plasmonics/sphere` | `{metal, radius_nm=20, medium_eps=1.77, nm_min=300, nm_max=900, points=241}` | `{metal, lspr{resonance_ev,resonance_nm,fwhm_ev,quality_factor}, spectrum{wavelength_nm[], c_ext[], c_sca[], c_abs[]}, at_resonance{C_ext_nm2,...}, validity{size_parameter, dipole_limit_nm2, exceeds_dipole_limit, ok, model}}` |
| POST | `/api/plasmonics/spp` | `{metal, photon_ev=2.0, eps_dielectric=1.0}` | `{spp{neff,propagation_length_um,confinement_nm}, resonance_ev, resonance_nm, dispersion{photon_ev[], neff[], propagation_length_um[]}}` (dispersion sampled below the SPP resonance) |

`lspr` comes from the engine's `lspr_sphere` with a scan that brackets the
resonance (coarse pass up to 1.5× the Fröhlich estimate ωp/√(ε∞ + 2εm), then a
fine pass over ±4 FWHM), so resonances above 6 eV (Al) are not pinned to the
default scan edge and narrow lines are resolved. `validity` flags where the
quasi-static dipole (no radiative damping) stops being physical: size parameter
x = 2π√εm·r/λ and the single-dipole extinction limit 3λ²/2π (λ in the medium).

### Quantum
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/quantum/graphene` | `{hopping=2.7, points=120}` | `{k_index[], upper[], lower[], ticks[{index,label}], min_direct_gap, is_dirac_semimetal}` (ticks Γ, K, M, Γ) |
| POST | `/api/quantum/tb1d` | `{onsite=0, hopping=1, points=201}` | `{k[], energy[], bandwidth, e_min, e_max, dos{energy[], dos[]}}` |
| POST | `/api/quantum/well` | `{width_nm=5, m_eff=0.067, n_levels=5}` | `{levels_ev[], well_width_nm, confinement_ev, transitions[{from,to,energy_ev,wavelength_nm}]}` |
| POST | `/api/quantum/qdot` | `{semiconductor="CdTe", radius_nm=2.5, r_min=1, r_max=6, points=51}` | `{semiconductor, bulk_gap_ev, single{confined_gap_ev,confinement_shift_ev,coulomb_ev,emission_nm}, curve{radius_nm[], gap_ev[], emission_nm[]}}` |

### Crystals
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/crystal/tolerance` | `{a_ion, b_ion, x_ion}` | `{t, octahedral_mu, verdict, radii{a,b,x}}` |
| POST | `/api/crystal/xrd` | `{formula="Si", a=5.431, structure="diamond", formula_units=8, wavelength_ang=1.5406, max_2theta=90}` | simulate_powder_xrd output (`reflections[{hkl,two_theta,d_spacing,families,multiplicity,rel_intensity}]`, `peaks_2theta[]`, ...) + `pattern{two_theta[], intensity[], note, intensity_model}` (Gaussian-broadened, normalised to 100) + `density_g_cm3` |

Relative intensities are Σ m·|F_hkl|²·LP·exp(−2Bs²) over the {hkl} families
that coincide in 2θ (`families`, e.g. 511 and 333), with structure factors from
the structure's basis (A = first formula element, B = second, X = the element
with 3× the count) and Thomas–Fermi atomic form factors. A formula that does not
match the structure's sites uses a composition-averaged form factor (noted in
`intensity_model`). `hkl` is the conventional family label in descending order,
e.g. `[2,0,0]`.

### Spectroscopy
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/spectro/interpret` | `{modality, peaks:[num], tolerance=null}` | Interpretation.as_dict() |
| POST | `/api/spectro/ms` | `{molecular_ion, fragments:[num]}` | interpret_mass_spectrum output |
| POST | `/api/spectro/crossvalidate` | `{sets:[{modality, peaks}]}` | `{interpretations:[...], cross{modalities, corroborated_groups, all_groups, evidence_counts}}` |
| POST | `/api/spectro/simulate_ir` | `{smiles}` | `{x[], y[], peaks[], interpretation{...}}` |
| GET | `/api/spectro/tables` | – | `{IR:[band], raman:[band], "1H":[band], "13C":[band], neutral_losses{mass:label}}` with band = `{low,high,assignment,group,intensity,note}` |

### Critics gate
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/gate/screen` | `{smiles:[str], harshness="HARSH", use_llm=false}` | CriticsGate.screen output `{accepted[], rejected[], pass_rate, verdicts{smiles: GateVerdict \| {accepted:false,error}}}` |

Max 500 SMILES per request (→ 400 beyond).

### Background jobs (evolution, campaign, search)
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/evolve/start` | evolve spec (below) | `{job_id}` |
| POST | `/api/campaign/start` | evolve spec + `{title, ground_query=null, top_n=3}` | `{job_id}` |
| POST | `/api/search/start` | `{query, per_provider=4, expand=true, synthesise=true, providers=null}` | `{job_id}` |
| GET | `/api/jobs` | – | `{jobs:[{id,kind,label,status,created,progress}]}` (newest first, no events/result; `label` = search query, campaign title or "population×generations") |
| GET | `/api/jobs/<id>?since=N` | – | job record; `events` holds only events with index ≥ N |
| POST | `/api/jobs/<id>/cancel` | – | `{id, status}` |

Evolve spec:
```json
{
  "objectives": {
    "druglike":         {"weight": 1.0},
    "mol_weight":       {"weight": 0.6, "target": 320, "tolerance": 50},
    "logp":             {"weight": 0.0, "target": 2.5, "tolerance": 1.0},
    "tpsa":             {"weight": 0.0, "target": 80,  "tolerance": 30},
    "synthesizability": {"weight": 0.5},
    "similarity":       {"weight": 0.0, "reference": "<SMILES>"},
    "novelty":          {"weight": 0.0, "library": ["<SMILES>", "..."]}
  },
  "population": 40, "generations": 20, "seed": null, "elitism": 2,
  "mutation_rate": 0.6, "crossover_rate": 0.4, "patience": 0,
  "use_gate": true, "harshness": "HARSH", "seeds": null
}
```
Terms with `weight <= 0` (or missing) are dropped; no remaining term → 400.
Validation: population 4–500, generations 1–500, rates in [0,1].
At most 12 jobs may be queued or running at once; further start requests get
429 until one finishes or is cancelled.

Job record:
```json
{
  "id": "job-1a2b3c4d", "kind": "evolve|campaign|search",
  "status": "queued|running|done|error|cancelled",
  "created": 1759660000.0, "started": 1759660000.1, "finished": null,
  "progress": {"current": 3, "total": 20, "message": "generation 3/20"},
  "events": [{"generation":1,"best":0.61,"mean":0.42,"worst":0.10,"unique":38,"best_smiles":"..."}],
  "events_total": 3,
  "params": {...the request...},
  "result": null,
  "error": null
}
```
- evolve result: `{best{smiles,fitness,generation,lineage_depth,found_generation,breakdown,svg}, hall_of_fame[{...same}], history[], evaluations}`.
  `generation` / `lineage_depth` is the genome's lineage depth (mutation and
  crossover steps from a seed), **not** a GA generation; `found_generation` is
  the first GA generation whose population contained the molecule (0 = an
  unmodified seed).
- campaign result: CampaignReport.as_dict() with `svg`, `found_generation` and
  `lineage_depth` added to each winner, winners' `ir_interpretation` and
  `uvvis` made structure-aware as in `/api/molecule/analyze`,
  `evolution.best` / `evolution.hall_of_fame[*]` given the same individual shape
  as the evolve result, and `grounding.llm_backend` when grounding ran.
- search result: DeepSearchReport.as_dict() + `llm_backend` (the backend that
  wrote the synthesis, `null` when synthesis was off). Search emits events
  `{provider, status:"ok"|"failed", detail}` as providers complete if practical.
- Cancellation is cooperative (checked each generation); status → `cancelled`.
- Jobs run on a small thread pool (≤ 2 concurrent); finished jobs are retained
  (last 50).

### LLM
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/llm/status` | – | `{backend, model, reachable, base_url, configured_backend, configured_base_url, configured_model}` (`configured_*` keep what was requested even after a fallback to echo) |
| POST | `/api/llm/configure` | `{backend="auto", base_url=null, model=null}` | status |
| POST | `/api/llm/chat` | `{messages:[{role,content}], system=null, temperature=0.2, max_tokens=1024}` | `{text, backend, model}` |

### Notebook
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/notebook` | – | `{name, count, records:[{id,kind,tags,created,summary,payload}]}` (newest first; `summary` = short human string) |
| POST | `/api/notebook/note` | `{text, tags=[]}` | `{id}` |
| POST | `/api/notebook/molecule` | `{smiles, name=null, tags=[]}` | `{id}` |
| POST | `/api/notebook/delete` | `{id}` | `{ok: true}` (unknown id → 400) |
| GET | `/api/notebook/export` | – | full `LabNotebook.to_dict()` |
| POST | `/api/notebook/import` | `{data:<notebook dict>, merge=true}` | `{count, imported, added, updated, replaced, merge}` (records merge by id: `added` = new ids, `updated` = ids already present; `replaced` = records discarded by `merge=false`). Payloads nested deeper than 64 levels → 400 |

---

## 3. Frontend contract

### Loading
`index.html` contains **no inline script or inline event handlers** (CSP). It
loads, all with `defer`, in this order:
`static/lib/ui.js`, `static/lib/plot.js`, `static/app.js`, then
`static/panels/` `dashboard.js molecule.js reactions.js semiconductor.js
photonics.js plasmonics.js quantum.js crystal.js spectroscopy.js evolution.js
gate.js search.js llm.js notebook.js`.
Each file starts with `window.ECCL = window.ECCL || {};`. `app.js` starts the
app on `DOMContentLoaded` (which fires after all deferred scripts ran): fetch
`/api/info`, build the sidebar from registered panels, route to the hash.

### `ECCL` core (app.js)
- `ECCL.api.get(path)`, `ECCL.api.post(path, body)` → `Promise<object>`.
  Reject with an `Error` whose `.message` is the server's `error` string (or
  HTTP status text) and `.status` the HTTP status.
- `ECCL.api.pollJob(id, {onUpdate(job, newEvents), intervalMs=500})` →
  `Promise<job>`; resolves with the final job record once status is
  `done|error|cancelled` (never rejects on job error — caller checks
  `job.status`). Uses `?since=` so `newEvents` are only fresh events. Stops
  polling if the panel calls the returned promise's `.cancelPolling()`
  (attach as a property on the promise).
- `ECCL.api.cancelJob(id)` → POST cancel.
- `ECCL.info` — the `/api/info` object (available before any panel renders).
- `ECCL.registerPanel(def)` where
  `def = {id, title, group, icon, description, order, render(root, ctx), onShow?(params)}`.
  - `group` ∈ `"Overview" | "Chemistry" | "Materials" | "Analysis" | "Discovery" | "AI & Data"` (sidebar sections in this order; panels sorted by `order`).
  - `icon` is a name from `ECCL.ui.icon` (see below).
  - `render(root, ctx)` is called **once**, lazily, on first activation;
    `root` is an empty `<div class="panel-body">`; may return a Promise.
    `ctx = {info, navigate, bus, params}`.
  - `onShow(params)` (optional) is called every time the panel becomes active
    (after `render` the first time) with the route params.
- `ECCL.panels` — array of registered definitions (for the dashboard).
- `ECCL.navigate(id, params={})` → sets `location.hash = "#/" + id + "?" + query`.
  Routes: `#/<panelId>` with optional query string → `params` object of strings.
  Unknown/empty route → `dashboard`.
- `ECCL.bus.on(evt, fn)`, `.off(evt, fn)`, `.emit(evt, data)`.
  Standard events: `"notebook:changed"`, `"jobs:changed"`, `"llm:changed"`.
- Theme: light/dark toggle in the top bar; default follows
  `prefers-color-scheme`; choice persisted in `localStorage` (wrapped in
  try/catch); applied as `document.documentElement.dataset.theme`. Charts must
  re-render or restyle on `"theme:changed"` (they use CSS variables, so pure CSS
  restyling is preferred).
- Top bar shows: app name, status chips (RDKit ✓/✗, LLM backend + reachable),
  active-jobs count (poll `/api/jobs` every 3 s only while any job is
  running/queued, else every 15 s), theme toggle.
- Responsive: sidebar collapses into a toggleable drawer below 900 px; no
  horizontal page scroll at 360 px width. Below 900 px tab bars wrap onto more
  rows (no tab hides behind a scroll) and the jobs popover is pinned to the
  viewport.

### `ECCL.ui` (lib/ui.js) — every function returns a DOM node unless noted
- `el(tag, attrs?, ...children)`: attrs keys `class`, `style` (string or
  object), `on` (`{click: fn, ...}`), `dataset`, `html` (sets innerHTML — **only
  for trusted, server-generated SVG via `ui.molecule`**), any other attribute;
  children may be strings (text nodes — never parsed as HTML), Nodes, arrays,
  `null/false/undefined` (skipped). All user/server text goes in as text nodes.
- `svgEl(tag, attrs, ...children)` — same, SVG namespace.
- `card({title, subtitle, actions}, ...children)`.
- `grid(cols, opts?, ...children)` — responsive (cols 1–4, collapses on narrow
  screens). Optional plain-object `opts`: `min` (px column minimum, sets
  `--grid-min`), `fit` (auto-fit: empty tracks collapse, so few items stretch),
  `stats` (preset: min 130, fit), `class`.
- `section(title, ...children)`.
- `field(spec)` — labelled control. spec `{name, label, type, value, options,
  min, max, step, placeholder, help, rows, required}`; `type` ∈ `text | number |
  select | textarea | checkbox | range | sci` (`sci` = text accepting
  scientific notation like `1e17`, parsed to number). `options` = array of
  strings or `{value,label}`. Range shows its live value.
- `form({fields, submitLabel="Run", onSubmit, columns=2, live=false, toastErrors=!live, minColumn})` →
  `<form>`; `onSubmit(values, formEl)` gets values keyed by `name` (numbers for
  number/range/sci, booleans for checkbox). While the returned promise is
  pending the submit button shows a spinner and is disabled; a rejection is
  shown inline (error box) and, when `toastErrors`, toasted. Not toasted:
  live-form errors (by default), client-side input errors (`ui.inputError`),
  and a message already shown as a field error on the form (then no error box
  either). `live: true` re-submits (debounced 300 ms) on any input change.
  A submit while a run is pending (live or `form.submit()`, e.g. after
  `setValues`) is queued and re-runs once with the then-current values; its
  promise resolves with that re-run. `minColumn` sets the grid's column minimum
  (default 140 px when every field is number/sci/range/checkbox, so short
  numeric forms keep two columns on phones). Methods on the returned element:
  `form.getValues()`, `form.setValues(obj)`, `form.submit()`,
  `form.setLocked(bool)` (keeps the submit button disabled across busy states
  and ignores user submits), `form.isPending()`, `form.field(name)`.
- `button(label, {kind="secondary", onClick, icon, small, title})`, kinds
  `primary | secondary | ghost | danger`.
- `busy(buttonEl, promise)` → promise (disables + spinner until settled; gives
  keyboard focus back to the button if disabling it dropped focus).
- `segmented({options, value, onChange, fill?})` — segmented control; `fill`
  stretches it and its buttons to the container width.
- `table({columns:[{key,label,format?(v,row),align?,width?,sortValue?,sortable?}], rows, empty="No data", onRowClick?, maxHeight?, sortable=true, rowClass?, expand?(row), rowKey?})`.
  `format` may return a string or Node. `expand(row) → Node` makes rows toggle a
  full-width detail row (click / Enter / Space, `aria-expanded`); expanded rows
  are tracked by `rowKey` (key name or function) and survive re-sorting and
  `setRows`. Returned element methods: `setRows(rows)`, `toggleRow(key, open?)`,
  `collapseAll()`. Sort chevrons sit in the header padding (no extra width).
- `kv(objOrPairs, {format?})` — key/value grid.
- `badge(text, kind="neutral")`, kinds `ok | warn | bad | info | neutral`.
- `stat({label, value, unit, hint, kind})` — stat tile.
- `meter({value, min=0, max=1, label, kind, format?, compact=false})` —
  horizontal bar; `compact` puts the value left of the bar on one row with no
  visible label (table cells).
- `toast(message, kind="info", ms=4000)` (returns nothing).
- `spinner()`, `empty(message)`, `errorBox(errOrMessage)`, `notice(text, kind)`.
  `errorBox` titles: "Server unreachable" (status 0), "Server error" (5xx),
  "Request rejected" (4xx), "Check your input" for client-side input errors,
  else "Something went wrong".
- `inputError(message)` → an `Error` flagged `validation: true`;
  `isInputError(err)` is true for those, for errors named `ValidationError` and
  for plain `Error`s without an HTTP status (runtime bugs are
  TypeError/ReferenceError/…).
- `set(node, ...children)` — replace a node's children with el()-style
  children (null/false skipped, arrays flattened, strings as text nodes).
- `json(obj, {collapsed=true, title="Raw JSON"})` — `<details>` viewer.
- `tabs([{id, label, render: () => Node}], {initial})` — renders each tab's
  content lazily on first open, keeps it afterwards.
- `molecule(svgString, {caption, width})` — white "paper" box; inserts the SVG
  only if it starts with `<?xml` or `<svg`, after stripping `<script>`
  elements, `on*` attributes and `javascript:` URLs.
- `fmt(value, digits=3)` — smart formatting (scientific for |x|≥1e5 or
  0<|x|<1e-3; `null` → "—"). `fmtSci(value, digits=3)`. Display only:
  negatives use the typographic minus U+2212, as on chart ticks.
- `formula(text)` — node rendering digits in chemical formulae as subscripts
  (e.g. `C9H8O4`, `Fe2(SO4)3`).
- `download(filename, text, mime="application/json")`.
- `icon(name)` — inline SVG icon (stroke = currentColor). Names: `home flask
  atom chip beam sparkle wave grid spectrum dna shield search chat book play
  stop sun moon menu download upload trash plus refresh check x info`.
- `wavelengthToColor(nm)` → CSS color string for 380–780 nm (gray outside).

### Styles (static/styles.css)
All CSS lives in `styles.css`; panels do not inject `<style>` elements. Shared
utility classes: `.panel-intro` (intro paragraph), `.stack` (vertical flex
with `--gap`), `.badges` (wrapping badge row), `.muted`, `.label-caps`
(small uppercase sub-heading), `.swatch` / `.swatch-lg` (colour chip),
`.chart-loading` / `.inline-loading` (placeholders), `.dimmable` with
`.is-stale` / `.is-busy` (fade results while recomputing), `.chips` +
`.chip-btn` (pill buttons, `.is-active`), `.text-block` / `.text-block-accent`
(pre-wrapped prose box), `.log-list` (monospace event log). A disabled
checkbox field is dimmed automatically. Table cell side padding is the
`--cell-px` variable (default 12px; panels tighten it on phones without
squeezing the sort chevron), and table headers may wrap below 640 px.
Panel-specific rules are scoped by the panel root (`#panel-<id> …`) in the
"panels" section.

### `ECCL.plot` (lib/plot.js) — dependency-free SVG
Every chart: `ECCL.plot.<kind>(targetElement, spec)` clears the target, renders
a responsive SVG (re-renders on container resize via `ResizeObserver`), uses CSS
variables for colours (`--chart-1` … `--chart-8`, `--chart-axis`,
`--chart-grid`, `--chart-text`, `--chart-bg`) so theme switches restyle without
JS, and returns `{update(spec), destroy()}`.
- `lineChart(el, {series:[{name, x[], y[], color?, dash?, width?}], title?,
  xLabel, yLabel, xDomain?, yDomain?, logX?, logY?, xReverse?, markers?:
  [{x, label, color?}], hMarkers?: [{y, label}], points?: [{x, y, label}],
  xTicks?: [{x, label}], height=300, legend=true})` — `null`/`NaN` values
  break the line; hover crosshair + tooltip listing every series' value at
  the nearest x; nice ticks; legend.
- `stickChart(el, {sticks:[{x, y, label?, color?}], bands?: [{x0, x1, label,
  color?}], xLabel, yLabel, xDomain?, xReverse?, height=260})` — vertical
  lines (spectra peaks / XRD / MS) with optional labels and shaded bands;
  hover tooltip.
- `barChart(el, {bars:[{label, value, color?}], yLabel, height=260,
  horizontal=false, format?})`.
- `levelDiagram(el, {levels:[{e, label}], yLabel="Energy (eV)", height=300})`
  — energy levels in a well.

### Panels
| id | group | file | icon |
|---|---|---|---|
| `dashboard` | Overview | dashboard.js | home |
| `molecule` | Chemistry | molecule.js | flask |
| `reactions` | Chemistry | reactions.js | atom |
| `semiconductor` | Materials | semiconductor.js | chip |
| `photonics` | Materials | photonics.js | beam |
| `plasmonics` | Materials | plasmonics.js | sparkle |
| `quantum` | Materials | quantum.js | wave |
| `crystal` | Materials | crystal.js | grid |
| `spectroscopy` | Analysis | spectroscopy.js | spectrum |
| `evolution` | Discovery | evolution.js | dna |
| `gate` | Discovery | gate.js | shield |
| `search` | AI & Data | search.js | search |
| `llm` | AI & Data | llm.js | chat |
| `notebook` | AI & Data | notebook.js | book |

Panels open other panels via `ctx.navigate("molecule", {smiles})` (the
Molecule panel must honour a `smiles` param in `onShow`).

---

## 4. Verification recipe

```bash
pip install -e .                  # already installed in dev envs
eccl gui --port 8765 --no-browser &   # use your own port when working in parallel
curl -s localhost:8765/api/info | head
```
Browser automation (Chromium is preinstalled; Node Playwright is global):
```js
// save as /path/to/scratch/check.cjs, run: NODE_PATH=/opt/node-tools/node_modules node check.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto('http://localhost:8765/#/molecule');
  await p.waitForSelector('.panel-body');
  await p.screenshot({ path: 'molecule.png', fullPage: true });
  console.log('errors:', errors);
  await b.close();
})();
```
