# Build log

Honest status of every block. A block is "done" only when something has proven
it works, not when it has been written.

| # | Block | Status | Proven by |
|---|-------|--------|-----------|
| 1 | Data schemas + files | **done** | 24 tests, incl. 8 that feed the validator broken data |
| 2 | Data-source probe | **done** | v1 + v2 run live on two real sites |
| 3 | Site + waterbody resolution | **logic done** | 18 tests; live path in probe v3 |
| 4 | Geology + catchment providers | next | |
| 5 | Screening engine | not started | |
| 6 | UI | not started | |
| 7 | AI conversation layer | not started | |

## Probe results (run live, two sites)

"Tilford, River Wey" (England) and "Kinness Burn, St Andrews" (Scotland).

### Kept — returned real data on both sites

| Source | What it gives | Notes |
|---|---|---|
| **BGS geology via WMS GetFeatureInfo** | Bedrock, superficial deposits, artificial ground, mass movement at a point | **The foundation.** REST `identify` returns empty every time; WMS works. |
| **NRFA** (National River Flow Archive) | Nearest gauged catchment, area, river, catchment properties | **UK-wide** — the only catchment source covering Scotland |
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
