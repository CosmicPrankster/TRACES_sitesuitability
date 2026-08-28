# Build log

Honest status of every block. A block is "done" only when something has proven
it works, not when it has been written.

| # | Block | Status | Proven by |
|---|-------|--------|-----------|
| 1 | Data schemas + files | **done** | 24 tests, incl. 8 that feed the validator broken data |
| 2 | Data-source probe | **done** | v1 + v2 run live on two real sites |
| 3 | Site + waterbody resolution | **logic done** | 18 tests; live path in probe v3 |
| 4 | Catchment + geology → character | **logic done** | 32 tests against real NRFA + BGS records |
| 5 | Screening engine | not started | |
| 6 | UI | not started | |
| 7 | AI conversation layer | not started | |

## Probe results (run live, two sites)

"Tilford, River Wey" (England) and "Kinness Burn, St Andrews" (Scotland).

### Kept — returned real data on both sites

| Source | What it gives | Notes |
|---|---|---|
| **NRFA** catchment properties | Bedrock permeability, base flow index, land cover — enough to infer particle character | **The foundation.** UK-wide, 201 fields, fast. |
| **BGS geology via WMS** | Bedrock and superficial deposits at a point | Corroborates NRFA. `INFO_FORMAT=application/json` returns an empty FeatureCollection; `text/xml` carries the data. |
| Nominatim geocoding | Coordinates and candidate places | The only geocoder that resolves river names |
| EA real-time level + rainfall | Stage trend, antecedent rainfall | England only. Slow (3–8 s). Context, not foundation. |

### Dropped — failed comprehensively on both sites

| Source | Attempts | Result |
|---|---|---|
| EA Water Quality Archive | 5 URL forms | All 404/403. API moved or withdrawn. |
| EA Catchment Data Explorer | 5 URL forms | All 404. Same. |
| BGS REST `identify` | 6 variants, inc. BNG coords, explicit layer ids, wide extents | Always `results: []`. Superseded by WMS. |
| SEPA river levels | 2 hosts | `ENOTFOUND`. |
| Open-Meteo geocoding | every query | 0 items — a settlement gazetteer, holds no river names. |

Nothing is retried hopefully. A source that failed on both sites is gone, and
the model is smaller for it.

### Two findings that mattered more than the pass/fail list

**The v1 probe reported empty responses as "ok".** That hid the BGS failure
entirely, and made an empty Scottish EA result look like a success. The probe
now separates *responded* from *responded with data*.

**Geocoding silently changed the question.** "Tilford, River Wey" matched
nothing, fell back to "River Wey", and returned a generic Surrey point about
4 km from Tilford. A screening would have been produced for the wrong reach with
no indication at all. Block 3 must confirm the waterbody with the user; the
probe now lists every candidate place rather than silently taking the first.

## Block 3: resolving to one stretch of water

"Tilford, River Wey" means the Wey **where it runs through Tilford**. Tilford is
a village the river passes; the river is 70 km long. Geocoding the whole phrase
matches nothing, and geocoding "River Wey" alone lands anywhere along it — about
4 km from Tilford, as the probe showed.

So the rule is: **generalise to the neighbourhood, then name the exact point
back to the user.**

The two halves arrive in either order, and both are handled:

```
"Tilford, River Wey"        settlement, waterbody
"Kinness Burn, St Andrews"  waterbody, settlement
```

`lib/resolve.ts` splits the query on water words (river, burn, beck, brook,
water, afon, loch, …), then:

1. **Anchor on the settlement.** A town is a point; a river is a line.
2. **Match against NRFA station names.** NRFA names its gauges
   "`<River>` at `<Place>`" — station 39011 is *"Wey at Tilford"*, which is
   exactly the shape of the query. A name match gives an authoritative point
   **and** the catchment properties in one step.
3. **Require both halves to line up.** Matching the river alone scores 0.5, not
   1.0, because it would put us anywhere along it — the precise failure this
   exists to prevent.
4. **Propose, never assume.** A single exact match is put to the user for
   confirmation. Screening the wrong reach silently is the worst outcome
   available, and it has already happened once.
5. **Fall back cleanly.** An ungauged burn like the Kinness matches nothing in
   NRFA, which is normal; the geology is then read from the map at the
   geocoded place instead. No forced match.

## Block 4: catchment properties → particle character

NRFA carries 201 fields per station, and the sediment-relevant ones separate the
two test sites cleanly. This is the inference that decides whether hydrocyclone
pre-treatment can help, so it is the most important one in the application — and
it is an *inference*, labelled as one wherever it appears.

Real values, from the probe:

| | Wey at Tilford (39011) | Motray Water at St Michaels (14005) |
|---|---|---|
| High-perm bedrock | **0.778** | `null` |
| Low-perm bedrock | 0.0001 | **0.738** |
| BFIHOST19 | **0.773** | 0.573 |
| Arable (LCM2023) | 0.261 | **0.568** |
| Result | **sand**, medium confidence | **clay**, low confidence |

The reasoning, in order of weight:

1. **Bedrock permeability** — the strongest signal. Permeable means sandstone,
   chalk or greensand, weathering to sand-grade quartz, with water infiltrating
   rather than running off. Impermeable means mudstone, clay or crystalline
   rock, weathering to silt and clay and shedding water at the surface.
2. **Base flow index** — corroborates it and says how flashy the river is. High
   BFI means groundwater-fed and stable: less suspended sediment, less of it
   storm-mobilised fines.
3. **Arable land** — the strongest anthropogenic term. Cultivated ground is bare
   for part of the year and sheds fine silt and clay, shifting the load finer
   than geology alone would suggest.
4. **Urban land** — finer again, and flashier.

Confidence reaches "medium" only when bedrock and base flow point the same way,
and never reaches "high": this is not a measurement. The Wey scores medium
(permeable *and* groundwater-fed, agreeing); the Motray scores low (impermeable
bedrock but a middling BFI, disagreeing).

**Why NRFA rather than the EA:** NRFA covers the whole UK. The Environment
Agency has no data for Scotland at all, so an EA-based inference could never
have screened Kinness Burn.

## Block 4b: BGS geology, and why JSON was empty

The BGS WMS returns `INFO_FORMAT=application/json` as an **empty
FeatureCollection** — 200 OK, 441 bytes, no features, at every location.
`text/xml` returns the data. That is not a fallback; it is the only format that
works on this service.

Tilford, verbatim from the probe:

```
bedrock       LEX_D    Folkestone Formation
              RCS_D    Sandstone
              GP_EQ_D  Lower Greensand Group
              LEX_WEB  .../lexicon.cfm?pub=FO

superficial   LEX_D    Alluvium
              RCS_D    Clay, silt, sand and gravel
              LEX_WEB  .../lexicon.cfm?pub=ALV
```

`RCS_D` is the field that matters — it is the rock composition, and it maps
directly onto what the rock weathers to. `LEX_WEB` gives a citable BGS Lexicon
page per unit, so every geological claim in a report carries a link a geologist
can check.

Three judgements are built into the reading:

- **A composite lithology is not its first word.** "Clay, silt, sand and gravel"
  is mixed, and must not be read as clay.
- **Alluvium is partly circular evidence.** At a river site the superficial
  deposit is usually the river's own alluvium, which describes what it has been
  carrying rather than what the catchment supplies. So bedrock is weighted
  higher when the superficial is alluvium, and lower when it is not.
- **Peat is a density problem, not a fineness problem.** Separation depends on
  the density difference, and peat has almost none.

**BGS corroborates; NRFA drives.** A river integrates its whole catchment, so
catchment-wide properties beat the one polygon the abstraction point sits on.
Where the two disagree the disagreement is reported rather than averaged away,
the catchment-wide reading is kept, and confidence drops to low.

## The model, now that it is narrowed

```
site + waterbody
      |
      v
Nominatim  ->  candidate places  ->  user confirms which one
      |
      v
BGS geology at that point        <- foundation: what the catchment sheds
(bedrock + superficial)
      +
NRFA catchment properties        <- catchment size, responsiveness
      +
EA level / rainfall              <- England only, context
      |
      v
particle character  ->  screening
```

Geology is the foundation because it is the only source that both works
everywhere in the UK and genuinely predicts what the suspended mineral load is
made of. Everything else is context around it.

## What v3 does

v3 stops asking which sources work and extracts the exact field names from the
four that do, so the providers are written against reality rather than guesses:

- every BGS WMS layer at the point, with all attribute names and values printed;
- the full NRFA field list, highlighting anything bearing on sediment character
  (geology, aquifer, BFI, permeability, soil, land cover);
- all 21 services in the BGS `GeoIndex_Onshore` folder, so far unexamined;
- every candidate place from the geocoder, for the disambiguation step.

## Decisions taken, and why

**Everything guessed is labelled `"guessed"` in the data itself**, not in a
comment. The screening cannot silently promote a guess to a fact, because the
label travels with the value.

**Hydrocyclone parameters carry a `revisions` array.** Adjusting a parameter
from field data appends to it, so the provenance of every number is readable
from the file itself.

**The query log is keyed on `siteId` + `waterbodyId`.** Not on the text the user
typed. Two spellings of the same burn are the same site, and must not produce
two log entries.

**A source that fails is dropped, not retried hopefully.** The previous version
of this project shipped providers for four sources that had never returned
anything, and produced a confident screening regardless. Smaller and working
beats larger and hopeful.
