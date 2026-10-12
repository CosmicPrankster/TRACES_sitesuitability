# Build log

Honest status of every block. A block is "done" only when something has proven
it works, not when it has been written.

| # | Block | Status | Proven by |
|---|-------|--------|-----------|
| 1 | Data schemas + files | **done** | 24 tests, incl. 8 that feed the validator broken data |
| 2 | Data-source probe | **done** | v1 + v2 run live on two real sites |
| 3 | Site + waterbody resolution | **logic done** | 18 tests; live path in probe v3 |
| 4 | Catchment + geology → character | **logic done** | 32 tests against real NRFA + BGS records |
| 5 | Screening engine | **in progress (5a done, 5b started)** | 5a: 17 tests. 5b so far (fitted grade-efficiency curve only, no trial override yet): 11 tests |
| 6 | UI | **first screen built (Next.js, app/)** | Report screen: pass/marginal/fail grid + expandable full report. Site input is a character-select placeholder - not yet wired to live resolution (blocks 3/4) |
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
| EA WFD river water body catchments | 3 guessed ArcGIS REST paths | 200 OK, but `{"error":{"code":400,"message":"Invalid URL"}}` every time — the ArcGIS backend at `environment.data.gov.uk/arcgis/rest/services` is real, the exact service name isn't. Needs manual discovery via their catalogue UI, not blind guessing. |
| MAGIC (DEFRA) land cover WMS | 2 hosts (`magic.defra.gov.uk`, `environment.data.gov.uk/arcgis/services/MAGIC/...`) | Timeout / 404. Old domain likely decommissioned. |
| SEPA open data (catchments) | 2 hosts | Connection failed both times — consistent with the SEPA river-levels failure above. |
| DataMapWales WFS | 1 host | Timeout. |

Nothing is retried hopefully. A source that failed on both sites is gone, and
the model is smaller for it. The four small-catchment candidates above were
probed (`scripts/probe-small-catchments.mjs`) as a way to give an ungauged
site more than a single geocoded point; none proved out, so the fallback for
those sites stays what it is - BGS geology at the anchor point alone, low
confidence, honestly labelled as a point reading (see
`lib/character.ts`'s `inferCharacterFromGeologyOnly`).

### Rebuild phase 0: five candidate sources for the new input hierarchy

Run with `scripts/probe-new-sources.mjs` (requires real network, so run by
the user, not in this sandbox - see HANDOFF.md). First pass reported 4/5 as
"ok" by HTTP status alone; inspecting the actual bodies showed two of those
were soft-404s/error pages returned with a 200 status - the exact "never
report an empty response as a success" mistake this project was bitten by
once already. The probe's `get()` helper now rejects an HTML body when XML
was requested, regardless of status code, so this self-corrects on future
runs.

| Source | Result |
|---|---|
| **Admiralty UK Tidal API** (tide state) | **Kept.** Real 607-station GeoJSON list, then real high/low-water events (heights + times) for the nearest station once the station ID field was read correctly (`feature.properties.Id`, not `feature.id` - the OpenAPI spec's own prose was wrong on this point). Needs `ADMIRALTY_TIDE_API_KEY`. |
| **Copernicus Data Space** (satellite turbidity) | **OAuth2 proven**, full Sentinel-2/3 data fetch not yet attempted. Needs `COPERNICUS_CLIENT_ID`/`COPERNICUS_CLIENT_SECRET`. |
| **EA Water Quality Archive** | **Kept - alive again, different shape than before.** The old API this project dropped once already is gone, but a real OpenAPI spec exists at `/water-quality/api/swagger`, and `/sampling-point?latitude=&longitude=&radius=` (with `Accept: application/geo+json`) returns real points. Caveat found on the way: points near Tilford were all sewage-discharge/effluent monitoring, not ambient river stations - the right `samplingPointType` filter for ambient water quality still needs settling in Phase 4, not blocking. |
| **COSMOS-UK** (bonus, not land cover) | **Kept.** Real OGC EDR-style API (`cosmos-api.ceh.ac.uk`), real soil-moisture sensor site found near Tilford (station `ALIC1`). Answers a different question than texture or land cover - kept on its own merits. |
| Soil texture (Soilscapes, UKSO) | **Dropped as a dedicated tier.** Soilscapes (`landis.org.uk`): four real, independently-failing attempts, the last giving an explicit Cranfield server error - `"No Layer or Table was initialized"` - confirming their own data layer is broken, not a wrong URL. The one other independently-hosted candidate found, BGS's `UKSO_BGS_NSI`, came back real (160 KB, 101 layers) but turned out to be a geochemical survey (trace elements - silver, arsenic, cadmium, ...), not a texture/grain-size classification - a different question, like COSMOS-UK. The user independently confirmed Soilscapes' real-world coverage is thin anyway, so this isn't a significant loss. The hierarchy falls back to NRFA+BGS (reframed, demoted) for this tier - see HANDOFF.md. |
| UKCEH Land Cover Map | **Dropped, deliberately not just technically.** `catalogue.ceh.ac.uk/maps/wms` returns HTTP 200 but the body is a MapServer backend error - their service is misconfigured server-side. But it's cut on purpose, not just because it's broken: NRFA already supplies an arable-land-cover field for any gauged catchment (Block 4's own table above - `Arable (LCM2023): 0.261` for Tilford), so a dedicated UKCEH source would only extend arable-% coverage to ungauged small catchments - a secondary benefit not worth carrying the extra complexity for, per the user's own "if something is redundant we cut it" call. |

Phase 0 is now closed: tide, satellite-auth, EA water quality, and COSMOS-UK
are real and proven; soil texture and land cover are deliberately not built,
for the reasons above, not because the search was incomplete.

### Rebuild phase 2: the hierarchy-descent orchestrator (existing sources only)

Before this phase, `screenStation` always fetched BGS's point geology for
every confirmed NRFA station, in parallel with the NRFA record, and
`inferCharacter` always blended it in when present. That is not tier
descent - it is "fetch everything, every time" with the decision made
silently inside the blending math.

`lib/character.ts` now exposes `worthCorroboratingWithGeology(catchment)`,
computed from the NRFA record alone, before BGS is ever called. It says yes
in exactly two cases: the catchment-only reading sits near a category
boundary (`isNearCategoryBoundary`, margin 0.1 either side of the three
thresholds), or the catchment reads impermeable-bedrock-dominant - which
carries a known failure mode regardless of how confidently it reads (the
permeability trap: NRFA classes crystalline rock low-permeability, but
permeability is about water movement, not grain size - see the real Spey
fixture in `tests/character.test.ts`, which reads confidently "fine" from
the catchment alone and is only corrected once geology is consulted).
Everything else - a catchment that reads clearly and safely permeable, like
the real Wey at Tilford - never triggers a BGS call at all.

`lib/live-site.ts`'s `screenStation` now fetches NRFA first, decides, and
only then conditionally fetches BGS - sequential instead of parallel for the
cases that do descend, but zero BGS calls at all for the cases that don't.
`StationScreenSuccess` carries a new `geologyConsulted` flag so a caller can
tell "point geology wasn't checked" apart from "point geology was checked
and had nothing mapped there" - the two were indistinguishable before.

`inferCharacter`'s own blending logic (agreement/disagreement reasoning, the
permeability-trap override) is unchanged and still fully tested - this phase
only changes *whether* BGS gets called, not what happens once it answers.
6 new tests in `tests/character.test.ts`, all against real NRFA fixtures
already in the file; 217/217 tests pass, `tsc --noEmit` and `next build`
clean.

### Rebuild phase 3: EA Water Quality Archive, finding the real shape (in progress)

A wider (25 km) sampling-point search near Tilford turned up 20 real points
of six different types: `GROUNDWATER - BOREHOLE`, `GROUNDWATER - SPRING`,
`SEWAGE - CRUDE TO FURTHER TREATMENT - WATER COMPANY`,
`SEWAGE DISCHARGES - FINAL/TREATED EFFLUENT - NOT WATER COMPANY`,
`TRADE DISCHARGES - PROCESS EFFLUENT - WATER COMPANY (WTW)`, and
`FRESHWATER - UNSPECIFIED` - the last being the one that actually means
"ordinary river/stream reading" (real example: "DOWNSTREAM RUDGWICK
STW,RIVER ARUN"). `properties.type` carries this as a plain label string,
not a short code - the earlier guess that it would be under `@id`/`id` was
wrong, found by printing the real response's own keys rather than assuming.

The OpenAPI spec's real path list (printed directly now, not just saved to
a file) confirmed where readings actually live:
`/sampling-point/{pointNotation}/observation` for one point,
`/data/observation` (POST) for a filtered multi-point search including
lat/lon/radius - both accepting a `determinand` code filter. The
`/codelist/determinand` endpoint supports a `prefLabel` contains-search, so
the real codes for suspended solids and turbidity can be looked up by name
instead of guessed or scraped from a full listing.

One dead end, recorded so it isn't re-tried as a content problem: a broad
codelist request came back **403 from an Azure Application Gateway**, not
from the API itself (the body is generic Azure HTML, not a FastAPI
validation error). The narrower, targeted follow-up confirmed it's real
data behind it - the full freshwater-type codelist (9 real codes, including
`F6` "FRESHWATER - RIVERS" alongside the already-known `FZ` "FRESHWATER -
UNSPECIFIED" - both now accepted by the probe's point filter) and the
turbidity determinand codelist (6 real codes, `0068` "Turbidity" being the
obvious first choice) both came back real and 200 on a second run.

The gateway block turned out to be **flaky, not content-based**: in the
second run, the same kind of request (suspended-solids determinand lookup,
then the actual observation fetch) 403'd on one call and succeeded on
another moments later, with no pattern tying the failure to the request's
own content - looks like a bursty rate limiter at the gateway, not
anything wrong with the query. The probe now retries specifically that
signature (Azure gateway 403, body containing "Azure-Application-Gateway")
up to twice more with a short backoff - and ONLY that signature, so a real
403 from the API itself is never silently retried away.

A third run got past the gateway flakiness on the observation fetch (the
determinand-codelist calls still 403'd, all three attempts - but that
turned out not to matter, see below) and returned a real observation
record for SO-F0002057 (the real point on the River Rother found above):
`phenomenonTime` (ISO datetime of the actual sample, not the publish
date), `observedProperty.notation`/`prefLabel` (the determinand, self-
described on every record), `hasResult.numericValue` or `.upperBound`/
`.lowerBound` for a censored "less than" result (a real example: `BOD : 5
Day ATU`, `<3 mg/l`), and `hasResult.hasUnit.prefLabel`. The record's own
`hasSamplingPoint.geometry.asWKT` gave a second, independent real BNG
coordinate for the same point (`POINT(495650 120150)`), which matched the
search result's own lon/lat to within about 2 metres once run through a
new `bngToWgs84` inverse transform (`scripts/lib/bng.mjs`) - a free cross-
check that the new inverse transform is correct, not just that it round-
trips its own forward function.

**`lib/sources/water-quality.ts` built and wired in.** Decided NOT to
depend on the determinand codelist at all, given its flakiness: every
observation record already self-describes its own determinand label and
unit, so turbidity and suspended-solids-concentration readings are
classified client-side on that real text (`classifyReadings`) rather than
a memorised notation code - more robust, and sidesteps the gateway issue
entirely. Turbidity (optical, NTU/FNU) and suspended-solids concentration
(gravimetric, mg/L) are kept as two separate, honestly labelled lists -
never conflated, since `lib/baseline.ts`'s `siteConcentrationMgL` needs
the latter specifically. The real suspended-solids mg/L determinand's own
notation code is still unconfirmed (the codelist lookup for it never got
past the gateway in three attempts) - not blocking, since nothing here
depends on knowing it in advance.

Wired into the actual scoring path: `screenStation`/`screenPointGeology`
(`lib/live-site.ts`) now also fetch the nearest real river point's most
recent suspended-solids reading in parallel with the NRFA/BGS tiers, and
`assessSite`/`assessMembrane` (`lib/assessment.ts`) use it in place of the
calibration set's reference concentration when present - baseline
confidence now reaches `medium` with a real concentration alone (even with
a guessed PSD) and `high` when both PSD and concentration are real, per
the ceiling `lib/baseline.ts` already anticipated in its own comments
before this phase. A censored ("less than") reading is used at its upper
bound - the conservative direction, since it can only make the predicted
volume lower than reality, never overclaim.

12 new tests (`tests/water-quality.test.ts`, `tests/bng.test.ts`, plus 5
more in `tests/assessment.test.ts`) against real captured fixtures where
real data existed, clearly-labelled synthetic fixtures (built from real
determinand codes) where it didn't. 237/237 tests pass, `tsc --noEmit` and
`next build` both clean.

### Rebuild phase 4: organics/algae/inhibition flags (`lib/flags.ts`)

No new external source - built entirely from data already flowing through
the pipeline. Two independent flags, never blended into the mineral-
character verdict (the plan's own explicit requirement): a confident
"likely" for sand/silt fouling can sit right next to an "elevated" algae
flag without the flag dragging the category down, because the two fail by
different mechanisms (cake filtration vs. biological growth/gel-layer
formation vs. DOC adsorption) that a hydrocyclone, separating on density,
does little for either way.

**Algae risk** splits into two separate facts rather than one collapsed
flag: whether the catchment is nutrient-enriched enough to matter
(cropland/built-up fraction, already available from NRFA - reused the same
thresholds `character.ts` already uses for "heavy arable") - a fixed
catchment property - and whether the assessment is happening during the
UK's typical bloom season (April-September) - a fact about today, not the
catchment. A report read in January says the risk exists without implying
it's active right now.

**Inhibition risk** reads peat from the mapped BGS lithology at the same
point the character-inference tier-descent already fetched, rather than
adding a second BGS call - added a named `isPeat()` export to
`lib/geology.ts` alongside the existing `isCrystallineBedrock()`, reusing
the word-boundary pattern `LITHOLOGY_RULES` already matched peat on. This
only reports geology when the tier-5/6 descent (phase 2) actually fetched
it; deliberately does NOT force an extra fetch purely for this flag, since
peat catchments already tend to read impermeable-bedrock-dominant, which
phase 2's own trap-check rule already fetches for independently. Labelled
honestly as a peat proxy, not a dissolved-organic-carbon measurement - no
DOC source exists in this project.

Both flags have a real third state, `"insufficient-data"`, distinct from a
guessed `"low"` - no catchment land cover (ungauged site) or no geology
checked at all both report that honestly rather than defaulting silently.

14 new tests (`tests/flags.test.ts`, including `isPeat`). Wired into
`screenStation`/`screenPointGeology`
(`lib/live-site.ts`) and both API routes; a minimal but real UI surface
added to `ReportView.tsx` (a labelled risk pill + reasoning per flag,
reusing the existing colour tokens). 251/251 tests pass, `tsc --noEmit`
and `next build` both clean.

### Rebuild phase 5: tide-state modifier (`lib/sources/tide.ts`)

Built against the Admiralty UK Tidal API shapes already proven live in
phase 0 - a real 607-station list and a real 7-day high/low-water event
window for station 0068B (Bosham). One real quirk the real data itself
revealed and this module works around rather than papering over:
**LowWater events at this API tier carry a `Date` but no `DateTime` or
`Height` at all** - every real LowWater entry in the captured fixture is
missing both, consistently across the whole week, not a one-off gap. Every
calculation here uses HighWater events only; nothing invents a low-water
time to fill the hole.

Per the plan, tide state doesn't say what the sediment is - it says how
much to trust any reading taken right now - so, like `lib/flags.ts`'s
algae/inhibition flags, it's reported alongside the main result and never
blended into the mineral-character verdict or the baseline-volume number.

Two honesty calls worth recording:

- **"Gated to estuarine sites"** has no direct estuary/tidal-limit dataset
  to gate on, so proximity to a real tide station (within 5 km) is used as
  the only available proxy - a well-inland site never triggers this tier
  at all, not even a fetch. NRFA stations in particular rarely trigger it:
  NRFA gauges exclude tidal reaches by design, so the no-NRFA-gauge
  fallback path (`screenPointGeology`) is actually where a genuinely
  estuarine site tends to land.
- **Spring/neap is read relative to whatever window was actually fetched**
  (`duration=7` - the proven shape), not a full 14-day cycle or a harmonic
  calculation this API tier doesn't expose. The real Bosham fixture shows
  why this matters: heights decline monotonically all the way across the
  captured week (4.87 m down to 3.66 m) - only one direction is visible in
  any single week, so "closer to spring" / "closer to neap" is explicitly
  labelled as relative to the fetched window in its own reasoning text,
  not a precise astronomical phase.

Flood/ebb is read by bracketing the current time between the two real
HighWater times either side of it - the first half of that ~12.5-hour gap
reads as still falling (ebbing) from the previous high, the second half as
rising (flooding) toward the next one.

Needs a real `ADMIRALTY_TIDE_API_KEY` to actually fetch anything; with none
set, this tier is SKIPPED (not failed) - the same distinct outcome
`scripts/probe-new-sources.mjs` already uses for a missing key. No live
key was available in this sandbox for an end-to-end run, so this is built
and tested against the proven real shapes, same discipline as the tide
section of the original probe script, not live-verified end to end this
session.

10 new tests (`tests/tide.test.ts`) against the real Bosham fixture.
261/261 tests pass, `tsc --noEmit` and `next build` both clean.

### Rebuild phase 6: satellite turbidity - NOT built, genuinely blocked

Unlike every other phase this rebuild has shipped, **no `lib/sources/
satellite-turbidity.ts` was written**, and that's a deliberate call, not an
oversight. Phase 0 only ever proved the OAuth2 token exchange
(`identity.dataspace.copernicus.eu`) - the actual data query (fetching one
real turbidity figure for a point) has never been attempted against a real
response, at any point in this project's history. Per HANDOFF rule 1, a
source that hasn't been proven to respond is not built on, and this one
hasn't.

`scripts/probe-new-sources.mjs` section 5 now goes one step further than
before: if OAuth2 succeeds, it makes a real HTTP request to a **guessed**
Sentinel Hub Statistical API shape (`sh.dataspace.copernicus.eu/api/v1/
statistics`, a real published NDTI turbidity formula as the evalscript,
30-day aggregation over a small bbox) - the same kind of first-attempt
guess the original EA Water Quality probe made before its real spec was
found, clearly labelled as such in the script's own comments, and not
trusted for anything beyond "does this come back real."

This also fixed a real bug the OAuth2 check never caught before: the old
code checked `tokenRes.ok` but never parsed the token response body, so it
could never actually have used the token for a follow-up call even if one
had been attempted.

**Why this stops here rather than guessing further:** the plan's own
phase-0 reasoning already ranks this the lowest-certainty, highest-effort
tier ("needs an account/key, lowest certainty it's worth the cost"), and
unlike tide/EA-water-quality, there is no captured real response to build
parsing logic against - writing a production fetcher now would mean
inventing field names for a response shape nobody has seen, the exact
mistake this project keeps catching itself making with guessed shapes
elsewhere. This needs one more live probe round (an API key + a run of the
updated probe script) before any real code gets written - not marked done
until that happens.

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

## Validated against four UK rivers

Four geologically distinct sites were probed live and the results checked
against an independent prior written down beforehand. Three real defects came
out of it — all of them silent, all of them now fixed and pinned by tests.

| Site | BGS bedrock | NRFA | Outcome |
|---|---|---|---|
| Test at Romsey | Wittering Fm, "Sand, silt and clay" | BFI 0.63 | Resolved to the wrong river — see below |
| Tees at Middleton | Alston Fm, "Limestone, sandstone, siltstone and mudstone" | BFI 0.31, arable 0.0001, SAAR 1585 | Clean name match, 0.4 km |
| Great Ouse at Bedford | Great Oolite Gp, "Interbedded limestone and argillaceous rocks" | BFI 0.44, arable 0.444 | Geocoded to Pennsylvania — **fixed, now 0.4 km from *Bedford Ouse at Bedford*** |
| Spey at Boat of Garten | Grampian Group, "Micaceous psammite" | BFI 0.41, low-perm bedrock 1.0 | Exposed the permeability trap |

### Defect 1 — geocoding left the country

"Bedford" resolved to **Bedford County, Pennsylvania**, producing a British
National Grid easting of −6,034,632. Every lookup downstream was for the wrong
continent, and nothing said so.

Two fixes: `countrycodes=gb` on every geocode, and preferring a result whose
type is a populated place, since "Bedford, Great Ouse" carries no water word and
either half might be the settlement.

### Defect 2 — a name match 7,000 km away still counted

Anchored in Pennsylvania, the resolver still matched "Bedford Ouse at
Thornborough Mill" on name alone. A name that matches on the wrong continent is
not a match: matches beyond `MAX_MATCH_DISTANCE_KM` (40 km) are now rejected,
and a rejection is reported as evidence the anchor is wrong.

At Romsey the reverse happened — nearest-by-distance picked *Tadburn Lake*, a
19 km² tributary, over *Test at Timsbury* 2.2 km away. A river-name match now
beats raw proximity.

### Defect 3 — permeability is not grain size

The important one. NRFA classes the Spey's bedrock **low-permeability 1.0**,
which read as a fine-grained catchment. But BGS maps it as *Micaceous psammite*
under *Glaciofluvial sand, gravel and boulders*, and the Spey is in fact a
famously sandy, gravelly river.

Permeability describes how water moves **through** rock, not the size of the
grains it weathers **to**. Crystalline rock is impermeable and still weathers to
coarse sand — for granite and psammite the two come apart completely.

Where the bedrock is crystalline *and* the mapped superficial deposits are
coarse, the geology now overrides the permeability class, and the report says
why. `psammite` (metamorphosed sandstone, coarse) and `pelite` (metamorphosed
mudstone, fine) are also now distinguished, which a single "metamorphic" rule
could not do.

### Defect 4 — an interbedded sequence read as only its coarse half

Found on the Bedford re-run. BGS describes the Great Oolite Group there as
*"Interbedded limestone and [subequal/subordinate] argillaceous rocks"*. The
lithology rules matched "limestone" first and scored it neutral carbonate,
silently discarding the argillaceous half — while NRFA's own note for the same
station reads *"Predominantly clay"*.

Interbedded carbonate-and-clay sequences are now matched before the plain
carbonate rule, and `argillaceous` is recognised in its own right.

### Verification after the fixes

All four sites now resolve correctly:

| Site | NRFA match | Distance |
|---|---|---|
| Tees at Middleton | 25018 Tees at Middleton in Teesdale | 0.4 km |
| Great Ouse at Bedford | 33002 Bedford Ouse at Bedford | 0.4 km |
| Spey at Boat of Garten | 8005 Spey at Boat of Garten | 0.5 km |
| Wey at Tilford | 39011 Wey at Tilford | 0.7 km |

Bedford's catchment reading comes out **clay**, which agrees with NRFA's own
catchment description. Its point geology (river terrace sand and gravel)
disagrees with that, and the report says so rather than splitting the
difference: the abstraction point sits on a coarse terrace while the catchment
drains clay, and the catchment-wide reading is the one that governs.

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
