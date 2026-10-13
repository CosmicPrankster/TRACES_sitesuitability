# Handoff

For whoever picks this up next, human or agent. Read this before touching
anything.

**This file was rewritten 2026-10-12** to match the rebuilt tool (see
`README.md`'s "Next steps", which used to flag this file as stale — it no
longer is). `BUILD.md` stays the historical probe/build log; this file stays
the living design-philosophy doc: why things are built the way they are, the
traps already found, and what's still open.

## What this is

A screening tool. You give it a site and a waterbody — "Tilford, River Wey" —
and it tells you, per membrane pore size, **how much water the filter alone
is likely to pass before it blinds**, and **how much more each pretreatment
method would buy on top of that**. See `README.md` for a real worked example
and the full input-hierarchy table; this file goes underneath that.

## The question it exists to answer

> Does removing what the hydrocyclone can remove meaningfully extend how long
> the membrane runs before it blinds?

"Meaningfully" is **about 1.5× the filterable volume** versus the baseline
(filter alone). That threshold, and the marginal/likely category cutoffs, are
set in `data/screening-parameters.json`, not hard-coded.

## The one piece of physics that governs everything

**Mass removed is not fouling removed.**

Specific cake resistance goes as **1/d²** (Carman–Kozeny), so a gram of 2 µm
silt resists roughly **100×** as hard as a gram of 20 µm sand. A hydrocyclone
strips the coarse end. It can therefore remove most of the *mass* while barely
touching the *fouling*.

And because filtered volume scales as **1 / √load**, the reduction needed is
much larger than the volume target:

| Volume target | Fouling load must fall by |
|---|---|
| 1.5× | **56 %** |
| 2.0× | **75 %** |

Halving the fouling load buys about 1.4×, not 2×. If you take one thing from
this document, take that. It is exactly as true of the rebuilt baseline+
uplift output as it was of the old `volumeRatio` — the physics never
changed, only how it's presented and what feeds it.

## The baseline estimate: inferring what a UK-wide tool can't bench-test everywhere

Rebuild phase 10, direct from the user's own framing: "it will be
impossible to collect trial data for everywhere in the UK... so we need to
infer to a certain degree." Before this phase, the baseline volume (not
the uplift - see the fouling physics above, unaffected) was a real number
*only* at 5 µm, the one pore size every real `data/trials.json` entry
happens to have used; every other pore size was an honest, permanent blank.

**The insight that makes an estimate defensible without inventing new
apparatus constants:** `volumeMl = k / sqrt(c * alpha)`. `alpha` (the
PSD-shape term, mass-weighted 1/d²) is already computed purely from
geology/field data, no trial needed. The real trial-calibrated `k` silently
lumps together everything else: filter area, pressure, the Kozeny
constant, unit conversions, AND the trial feed's own particle porosity and
density (Carman-Kozeny: true specific resistance is proportional to
`(1-porosity) / (porosity³ × density)`, not just the shape term). Crucially,
if you express a NEW site's `k` as a *ratio* against the trial's own `k`,
every one of those apparatus/unit constants is identical on both sides and
cancels out exactly - leaving only porosity and particle density, which
are real, citable, published quantities, unlike the apparatus constants.

`lib/sediment-properties.ts` classifies a PSD by its own d50 against the
real Udden-Wentworth boundaries (reusing `lib/field-update.ts`'s existing
clay/silt/sand boundaries, not a new invented threshold) and looks up a
published porosity/density range per class from `data/sediment-
properties.json` (sources checked live via WebSearch this session, not
recalled from training - see that file's own `_README`). `lib/baseline.ts`'s
`estimateBaselineVolume` then rescales the one real trial-calibrated `k`
(today: the 5 µm calibration, 10 real trials) by the ratio between the
trial feed's own measured grain-size class (consistently silt-class, d50
22-31 µm across all 10 trials - a real finding, not an assumption) and the
target site's class, giving an estimated volume range at ANY pore size.

**A real, amusing cross-check this surfaced**: the classifier, built purely
from the real Wentworth boundary independently of this project's own
character-naming convention, correctly flags that the guessed "sand"
*character* profile (`data/particle-sizes.json`, d50=60 µm) is actually
silt-grade by real grain-size boundaries (the 63 µm sand threshold) - which
is exactly the file's own long-standing "suspended load is finer than bed
material" warning, now independently confirmed rather than just asserted.

**Honesty rules this tier follows, same as everywhere else in this
project:** `baselineSource` is `"measured" | "estimated" | "insufficient-
data"`, never silently conflated. An estimate is ALWAYS capped at `low`
confidence (it stacks a PSD guess, a literature porosity range, and a
cross-pore-size apparatus-constant extrapolation). Every estimated figure
is prefixed "ESTIMATED" in the report and highlighted differently in the
UI (`cell-marginal`, not `cell-strong`). A real trial - general calibration
or exact-site - supersedes the estimate outright, never averaged with it
(HANDOFF rule 7). Clay's porosity range is deliberately the widest of the
three classes (0.47-0.9), because real literature says freshly
suspended/flocculated clay genuinely varies that much depending on
consolidation state - the same unmodelled floc-structure gap
`flocDensityPenalty` already names, carried through honestly here rather
than hidden behind a falsely-precise single number.

Known limitation, stated plainly: Kozeny-Carman's own theoretical
prediction is documented in the filtration literature to deviate from real
MEASURED specific cake resistance, especially for fine/compressible cakes
(see `data/sediment-properties.json`'s cited sources) - this estimate
inherits that same real limitation. It is a genuine order-of-magnitude
inference, not a disguised measurement, and says so in its own reasoning
text every time it fires.

## Where the project stands

The output model and the input pipeline were both rebuilt this project
(2026-10, "rebuild phases 0–9" in `BUILD.md`). In one line: the old tool gave
one falsely-precise `volumeRatio` multiplier per hydrocyclone × membrane
cell, inferred almost entirely from NRFA bedrock catchment properties; the
rebuilt tool gives a **baseline filterable volume range** (filter alone,
calibrated against real bench trials) plus a **per-pretreatment-method
uplift range** on top of it, each with its own confidence, fed by a
hierarchy of sources that stops at the first tier with usable data. See
`README.md`'s "How a prediction gets built" table for the full tier list and
each tier's live/untested/dropped status — it is not repeated here to avoid
the two files drifting apart again.

`npm test` — 366 tests, no network, no API keys.
`npx tsc --noEmit` / `npx next build` — both clean.
`node --env-file=.env.local scripts/probe-new-sources.mjs` — needs internet,
optional API keys for the tide and satellite tiers.

**Verified live since the above was written**, all against real
`"Tilford, River Wey"` probe runs (2026-10-12):
- The chat/conversational layer (`lib/chat-intake.ts`) is built and wired
  into `/api/field-update` and the UI - a deterministic parser, not an LLM
  call (this project has no AI SDK dependency), on the standing rule that
  parsing never scores.
- **The tide tier is proven end-to-end against a real Admiralty API key.**
  The real 607-station list and a real 7-day `TidalEvents` response both
  matched `lib/sources/tide.ts`'s types exactly - no code changes needed.
  Tilford itself correctly found no station within 5 km and skipped the
  tier, which is the correct behaviour for an inland, non-tidal reach, not
  a bug.
- **Satellite turbidity is proven and built, after three real probe
  rounds, each surfacing a real, different, fixable error - never a repeat
  of the last one, which is what "converging" actually looks like.** v1
  (bbox in EPSG:4326, bare `resx`/`resy`): a pixel-size HTTP 400 - `resx`/
  `resy` was being read in the bbox's own CRS units (degrees), not metres.
  v2 (bbox switched to EPSG:3857): that error vanished, replaced by
  `"Output dataMask requested but missing from function setup()"` - the
  Statistical API requires an evalscript to declare an EXPLICIT `dataMask`
  output, not just take it as an input. v3 (explicit `data`+`dataMask`
  outputs): a real HTTP 200, real NDTI statistics (mean -0.049, 48,400
  valid pixels, 0 no-data, for a 30-day window around Tilford).
  `lib/sources/satellite-turbidity.ts` is built on that proven v3 shape,
  with the real captured response as its test fixture
  (`tests/satellite-turbidity.test.ts`), and wired into `lib/live-site.ts`
  - but deliberately gated behind an already-found nearby tide station
  (reusing that proven "estuarine" signal as a proxy for "the aggregation
  box is plausibly water-dominated," rather than inventing a second,
  unproven land/water classifier) and reported as CONTEXT ONLY, exactly
  like tide state: NDTI is a relative turbidity index averaged across a
  ~2.2 km box, not a point reading or a concentration, and is never
  blended into the mineral-character verdict. See the module's own header
  comment for the full reasoning.

**Still genuinely open**, not yet built:
- `data/query-log.json`'s "site-run" half (a real screened site's prediction
  checked against reality) - the "bench-validation" half, checked against
  every real trial in `data/trials.json`, is built (`scripts/build-query-
  log.ts`) and its result is itself worth reading: see the cut-sizes
  reservation below.

## How the pipeline fits together

```
"Tilford, River Wey"
   │
   ├─ lib/resolve.ts        split the query, anchor on the SETTLEMENT,
   │                        match NRFA station names ("Wey at Tilford"),
   │                        propose the reach and ask the user to confirm
   │
   ├─ lib/live-site.ts      wires every source below together, stopping at
   │                        the first tier with usable data (see
   │                        lib/character.ts's worthCorroboratingWithGeology
   │                        for the one deliberate exception: a near-
   │                        boundary result is corroborated one tier deeper)
   │     ├─ on-site field reading (lib/field-update.ts)    tier 1, session-only
   │     ├─ EA Water Quality Archive (lib/sources/water-quality.ts)  tier 2
   │     ├─ NRFA catchment properties (lib/character.ts)  tier 3
   │     ├─ BGS point geology (lib/geology.ts)             tier 4, corroborates only
   │     ├─ tide state (lib/sources/tide.ts)               confidence context, estuaries
   │     ├─ satellite turbidity (lib/sources/           confidence context, gated on
   │     │     satellite-turbidity.ts)                    a nearby tide station
   │     └─ algae/inhibition flags (lib/flags.ts)          independent of the mineral verdict
   │
   ├─ lib/psd.ts            character → assumed particle size distribution
   │                        (superseded by a field or trial-measured PSD
   │                        wherever one exists)
   │
   ├─ lib/baseline.ts       real-trial-calibrated absolute filterable volume
   │                        per membrane pore size - falls back to a
   │                        literature-estimated volume (lib/sediment-
   │                        properties.ts) where no trial calibrates that
   │                        exact pore size, "insufficient data" only when
   │                        no trial exists at ANY pore size to anchor from
   ├─ lib/trials.ts         an EXACT-site trial (same siteId+waterbodyId)
   │                        overrides the calibrated baseline/uplift outright
   │                        - wired into lib/assessment.ts, fires on zero
   │                        trials today since none in data/trials.json has
   │                        a real site recorded yet
   ├─ lib/separation.ts     hydrocyclone grade-efficiency curve
   ├─ lib/retention.ts      membrane pore size → effective retention
   ├─ lib/assessment.ts     baseline + per-method uplift + recommendation
   └─ lib/report.ts         the useful window + plain-English report sections
```

## Rules this project runs on

These were learned the hard way. The first version of this repository looked
finished and was useless — it produced a confident screening for every site
from placeholder values, because the data lookups it depended on had never
actually been run. It was deleted and restarted. They held up through the
2026-10 rebuild unchanged — the rebuild is evidence they work, not a reason
to relax them.

1. **A source that has not been proven to respond is not built on.** Every
   tier this project has ever added (EA Water Quality, tide, satellite) was
   probed live with `scripts/probe*.mjs` before a line of production code
   was written against it - satellite turbidity took three real rounds
   (see "Where the project stands" above) before its request shape was
   actually proven, and no production code existed for it until it was.
2. **Never report an empty response as a success.** The v1 probe did, and it
   hid the single most important failure for days.
3. **Every number carries its status** — `guessed`, `field-adjusted`,
   `measured` — in the data itself, not in a comment. A guess must never be
   silently promoted to a fact. (Widened from two tiers to three this
   rebuild, for a field reading with an assumed spread — see `lib/psd.ts`'s
   `Psd.status`.)
4. **Confidence is the weakest link in the chain.** A guessed cut size caps the
   whole verdict at low confidence however good the geology is.
5. **A disagreement between sources is reported, never averaged away.** It is
   information. See the Spey case below, and the grain-card/settle-test
   disagreement handling in `lib/field-update.ts`.
6. **Absence of data is not a negative verdict.** "insufficient data" is a
   distinct outcome from "unlikely". This now spans the baseline volume, the
   algae/inhibition flags, and the validated-studies entries (the River Dee
   has none, honestly).
7. **Measured beats modelled, always.** A filtration trial in `data/trials.json`
   supersedes every estimate in this repository — and since this rebuild,
   an exact-site trial supersedes even the general bench-trial calibration
   (`lib/trials.ts`'s `findSiteBaselineTrial`/`findSiteTrial`, wired into
   `lib/assessment.ts`).

## Things that will bite you

**Geocoding silently changes the question.** "Bedford" resolved to Bedford
County, Pennsylvania and everything downstream was for the wrong continent, with
nothing reporting it. Geocoding is now GB-restricted and prefers a populated
place; NRFA matches beyond 40 km are rejected. Do not remove either guard.

**A river is a line, a town is a point.** "Tilford, River Wey" means the Wey
*where it runs through Tilford*. Anchor on the settlement. Geocoding the river
alone put us 4 km out.

**A generic shared word is not a place match.** "Battersea Bridge" (no water
word, so a settlement-only query) matched a totally unrelated gauge 12 km
away, because `matchedPlace` only required ONE settlement token to match
(`.some()`) - and "bridge" alone, a word many genuinely unrelated UK gauge
names happen to contain ("X at Y Bridge"), was enough. `matchedRiver` already
required EVERY water token to match (`.every()`); `matchedPlace` now does
too (fixed 2026-10-13, Notion card 10) - a station's place name has to
contain the DISTINCTIVE word, not just share one it has in common with half
the gauges in the country. The exact-match confirmation statement also now
always states the real distance from the geocoded point, never silently
drops it, so a bad-but-not-rejected match is at least visibly far away
rather than presented with unwarranted confidence.

**Permeability is not grain size.** NRFA classes the Spey's bedrock
low-permeability, which reads as fine — but it is psammite under glaciofluvial
sand and gravel, and the Spey is a famously sandy river. Permeability describes
how water moves *through* rock, not the size of grains it weathers *to*. There
is an explicit override for crystalline bedrock with coarse superficial cover.

**BGS JSON is empty.** `INFO_FORMAT=application/json` returns a 200 with an
empty FeatureCollection at every location. `text/xml` carries the data. This is
not a fallback; it is the only format that works on that service.

**Read the whole lithology string.** "Interbedded limestone and argillaceous
rocks" was being read as limestone, silently discarding the clay half.

**Suspended load is finer than bed material.** A sandy riverbed does not mean
sandy suspended solids. This is the likeliest source of over-optimism in
`data/particle-sizes.json` — and the same trap `lib/field-update.ts` warns
about explicitly when a grain-card reading comes back "gravel": that is
almost always bed material, not the suspended load, and the reading should
be retaken.

**EA Water Quality Archive point types matter.** Only `"FRESHWATER -
UNSPECIFIED"` and `"FRESHWATER - RIVERS"` point types are usable
(`lib/sources/water-quality.ts`'s `RIVER_POINT_TYPES`) — the Archive carries
many other monitoring purposes at the same API shape that are not ordinary
river points, and including them would attribute readings to the wrong kind
of site.

**A "less than" censored water-quality result is used at its upper bound.**
Conservative on purpose: it can only ever make the predicted baseline *lower*
than the true figure, never let the tool overclaim a site it has under-read.

## Reservations — be honest about these with the user

**The cut sizes are guesses, and the validation loop now shows by how much
that matters.** Both entries in `data/hydrocyclones.json` are marked
`guessed`. `scripts/build-query-log.ts` (`lib/validation.ts`) checks every
real recorded bench trial's measured uplift against what the model predicts
from that same trial's own measured feed PSD, using the 10mm hydrocyclone's
guessed grade-efficiency curve - and the model is consistently, substantially
too conservative: predicted uplift sits around 1.2-1.9x across all 10 real
trials, while the real measured uplift is 3.7x-15x. **Every single trial's
real result falls outside the model's predicted range** - see
`data/query-log.json`. This does not mean the physics is wrong (the baseline
side of the same check, which doesn't depend on the guessed cut sizes, is
accurate - the real baseline volume falls inside the leave-one-out predicted
range for all 10 trials). It means the guessed d20/d50/d90 cut sizes in
`data/hydrocyclones.json` assume a coarser cut than the real 10mm unit
achieves on this feed. Until a real grade-efficiency measurement replaces
the guess, the uplift is reliable for **relative** comparisons - which
membrane sizes look better, where 4 mm beats 10 mm - and not for absolute
verdicts, and should be read as a floor on the real benefit, not a ceiling.
(An exact-site trial, when one exists, bypasses this entirely — see rule 7
above.)

**Character → PSD is the weakest link, when nothing better exists.** Weaker
than the geology, weaker than the cut sizes. A field reading
(`lib/field-update.ts`) or a real EA Water Quality Archive concentration
narrows this; absent both, every verdict still inherits it.

**The addressable window may be narrow.** Small hydrocyclones cut somewhere
around 5–20 µm. Below that they do little. So the product plausibly works for
coarse-solids waters at coarse membrane ratings, and plausibly does not for
clay-dominated waters or fine ratings. **The screening should be allowed to
return "unlikely" often.** If it returns "likely" everywhere, it is broken —
that was the failure mode of the first version, and `tests/assessment.test.ts`
has an explicit test guarding against it.

**Floc density is not modelled.** Cohesive clay flocs entrain water, so their
effective density is far below the mineral density, and centrifugal separation
depends on density difference rather than size alone. This should make clay
worse than size alone predicts. It is deliberately left out rather than
invented: it needs a defensible source, and none has been checked
(`data/screening-parameters.json`'s `flocDensityPenalty`, `applied: false`).
The Mekong entry in `data/validated-studies.json` is a real, citable case
where this matters — a feed concentrated enough to flocculate, which this
tool's hydrocyclone math does not represent.

**Bench data is not site data.** Crushed aquarium soil characterises the
hydrocyclone, not any river. Every entry in `data/trials.json` says so in its
own `feed.note`.

**The model assumes the cyclone never makes fouling worse.** In
`lib/assessment.ts`, `foulingReduction` is clamped to `[0, 1]`, so the floor
on a method's uplift is always 1× ("no benefit"), never "worse than
untreated." Literature raises at least four real mechanisms by which
pretreatment could speed up fouling instead: shear in the vortex/apex
breaking friable flocs or algal colonies into finer fragments than the
natural feed (fouling resistance goes as 1/d², so breakage can manufacture
fouling potential, not just fail to remove it); loss of a "filter aid"
effect, where stripping the coarse fraction leaves a fine-skewed cake that
packs denser per gram than the natural mixed-size feed would have (the model
sums `massFraction / d²` independently per size bin, which can't represent
this); weaker shear-induced back-transport at the membrane if this ever runs
crossflow, since coarse particles self-scour a crossflow surface far more
effectively than fines (back-transport scales roughly with particle size
cubed) - not applicable to the dead-end bench trials run so far, but worth
remembering if crossflow is ever tried; and shear releasing NOM or
biopolymer-bound organics into solution, causing irreversible/pore-blocking
fouling that this model - which only ever tracks particulate PSD mass - does
not represent at all. None of these are built in: no measured basis exists
yet for how much worse, from which mechanism, at which site, and a guessed
fouling *penalty* would be worse than the current honest silence on it.
`lib/flags.ts`'s algae/inhibition flags are adjacent to this gap but do not
close it: they flag a risk independently, they don't quantify a fouling-
worsening mechanism.

## Outside critique (2026-09-27) — status after the rebuild

An external reviewer raised eight points against the pre-rebuild tool. Most
are now addressed; three residual wording/naming issues the rebuild missed
were fixed alongside this file. None of the eight needed a second review
round to confirm — each is checked against the actual current code below,
not assumed fixed because a phase touched the area.

1. **Suspended vs bedload.** *Largely addressed.* The EA Water Quality
   Archive tier (`lib/sources/water-quality.ts`) now supplies a real
   measured suspended-solids concentration where one exists nearby, ranked
   ahead of bedrock/catchment inference in the hierarchy (README's input
   table). Where no measured concentration exists, bedrock/catchment
   evidence is still used, and the baseline reasoning now explicitly frames
   it as context about storm-flow and bed material, not a calm-day
   suspended-load measurement.
2. **"Two independent datasets agree."** *Fixed.* `lib/character.ts`'s
   agreement reasoning no longer uses that phrase - it now says explicitly
   that one mapped BGS polygon agreeing with a catchment-wide reading is a
   nudge, not two independently collected datasets, and does not confirm
   the result the way a real measurement would.
3. **"Coarser and lighter."** *Fixed.* The high-permeability-bedrock
   reasoning in `lib/character.ts` now says "coarser, and present at a lower
   overall concentration" and spells out that "lighter" means less loaded,
   not lower-density grains - quartz is not lighter than clay minerals.
4. **No validation.** *Addressed, and the result is itself a finding.*
   `data/validated-studies.json` (rebuild phase 8) seeds real published
   suspended-sediment figures for named rivers (Thames, Mersey, Mekong),
   each with its own citation, and honestly records no figure found for the
   Dee rather than inventing one. `scripts/build-query-log.ts`
   (`lib/validation.ts`, rebuild phase 9) now does what this point
   specifically asked for - predicted vs observed, leave-one-out against
   this project's own 10 real bench trials - and the result is not a clean
   pass: the baseline volume prediction holds up (10/10 trials fall inside
   their predicted range), but the uplift prediction does not (0/10) - see
   the cut-sizes reservation above. This is the validation loop doing its
   job, not the validation loop failing. What's still missing is the same
   check for a real SITE trial (not a bench trial) - none exists yet, since
   none in `data/trials.json` has a real siteId/waterbodyId.
5. **Unsupported thresholds.** *Partially moot, partially addressed.* The
   old ≥10 mm/72 h rainfall trigger this point referred to no longer exists
   - it was part of the pre-rebuild output surface, deleted in the rebuild,
   not carried forward. The medium/high confidence labels now have an
   explicit, documented basis: confidence is always the WEAKEST input in the
   chain (never an average - see rule 4 above), computed from named,
   comment-documented tiers (`psdLevel`, `cutLevel`, `membraneLevel` in
   `lib/assessment.ts`) rather than a single unexplained number.
6. **Organics and colloids.** *Addressed.* `lib/flags.ts` (rebuild phase 4)
   flags algae risk (season + cropland as a nutrient-runoff proxy) and
   organic-inhibition risk (peat as a dissolved-organic-carbon proxy)
   independently of the mineral verdict, exactly as the critique asked -
   never blended into the sand/silt/clay category.
7. **Naming clash.** *Fixed.* The pre-rebuild "settle-bottle proxy" output
   label this point referred to no longer exists (replaced by the rebuilt
   output surface). A residual inconsistency was found and fixed while
   writing this update: `lib/character.ts`'s desk-based recommendation to
   run a field test said "settle-bottle test," while the live field-update
   path (`lib/field-update.ts`) calls the same real test a "settle test" -
   now consistent throughout.
8. **Output uncertainty.** *Addressed.* This was rebuild phase 1's whole
   premise: every baseline and uplift is a range with a named confidence
   tier, never a single point multiplier. See README's worked example.

## What would most improve this, in order

1. **One measured grade-efficiency curve for either hydrocyclone.** No
   longer just "would be nice" - the validation loop now shows the guessed
   10mm curve under-predicts every real trial's uplift by roughly 3-10x.
   This is the single highest-value piece of real data this project could
   add next.
2. **A filtration trial recorded against a real siteId/waterbodyId.** Every
   trial in `data/trials.json` today has both set to `null` - bench data
   only. `lib/trials.ts`'s exact-site override is wired into
   `lib/assessment.ts` and tested, but has never fired against real data.
   One real site trial, recorded with the siteId/waterbodyId
   `lib/resolve.ts`'s `deriveSiteIdentity` would derive for that station,
   would be the first time it does.
3. **A real site-run entry in the validation loop.** The bench-validation
   half (`scripts/build-query-log.ts`) is built and run; the site-run half
   needs #2 above to exist first.
4. **A real trial at a SECOND pore size.** Every real trial today used
   5 µm, so `lib/baseline.ts`'s literature-estimated tier
   (rebuild phase 10) has never been checked against a real measurement -
   only its sibling, the general 5 µm calibration, has (via the validation
   loop). One real trial at any OTHER pore size would, for the first time,
   let `scripts/build-query-log.ts` actually check whether the Carman-
   Kozeny porosity correction is in the right ballpark, not just internally
   consistent.
