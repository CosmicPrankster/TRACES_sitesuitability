# Hydrocyclone + membrane site screening

Enter a site and waterbody — "Tilford, River Wey" — and get back, per
membrane pore size: **how much water the filter alone is likely to pass
before it blinds**, and **how much more a hydrocyclone would buy on top of
that**. Every number carries a confidence and a plain-English reason, and a
pore size with no real calibration behind it honestly says so instead of
guessing.

**New here?** [HANDOFF.md](HANDOFF.md) has the core physics, the design
rationale, and the traps already found — refreshed alongside this README, so
both are current; [BUILD.md](BUILD.md) has the full historical build log,
including this project's live rebuild (`BUILD.md`'s "Rebuild phase 0–8"
sections) and predates some of what's below, by design — it's the record of
how things were probed and built, not a living status doc.

```bash
npm install
npm test                       # 366 tests, no network needed
npm run dev                    # the web app, http://localhost:3000
npm run build-query-log        # regenerate data/query-log.json's bench-validation entries
node --env-file=.env.local scripts/probe-new-sources.mjs   # needs internet + optional API keys
```

## The question

> Does removing what the hydrocyclone can remove meaningfully extend how
> long the membrane runs before it blinds?

Because filtered volume scales as 1/√load, and cake resistance goes as
1/d² (Carman-Kozeny), **removing most of the solids *mass* is not the same
as removing most of the *fouling***. A 56% cut in fouling load buys 1.5×
the volume; a 75% cut buys 2×. The fines a hydrocyclone cannot catch are
the ones that do the damage. If you take one thing from this project, take
that.

## What a result actually looks like

Real output from this tool, for a sand-character site (the exact numbers
`assessSite(psdForCharacter("sand"), ...)` computes today — the same code
path `tests/assessment.test.ts` exercises for this character, though the
tests check categories and confidence rather than asserting these precise
decimals):

```
5 µm membrane
  Baseline (filter alone):  96-298 mL  (confidence: low - MEASURED calibration, no measured concentration)
  + 5mm hydrocyclone:       1.50x      (marginal - worth a replicate trial)
  + 10mm hydrocyclone:      1.23x      (marginal)

10 µm membrane
  Baseline (filter alone):  228-398 mL (confidence: low - ESTIMATED, no trial at this pore size)
  + 5mm hydrocyclone:       2.09x      (likely - the best-supported option)
  + 10mm hydrocyclone:      1.52x      (likely)

Verdict: pretreatment looks worthwhile for membrane ratings from 10 to 20 µm.
```

Three things worth noticing. The baseline is a real, trial-calibrated
number only where a real bench trial calibrates that exact pore size
(`data/trials.json`) — today, only 5 µm. Everywhere else it is a
**literature-based estimate** (`data/sediment-properties.json`), not a
measurement and not a blank: a real bench trial cannot realistically exist
for every pore size at every UK site, so the tool infers from published
porosity/density data instead of leaving the cell empty — always capped at
`low` confidence, always clearly marked "ESTIMATED," and always superseded
outright the moment a real trial exists at that pore size (see
`lib/baseline.ts`'s `estimateBaselineVolume`). And the uplift is always a
multiplier *on top of* the baseline, never a self-contained verdict — a 2×
uplift on an estimated baseline is still "we don't know how much water for
sure," which is why both numbers are shown together, not collapsed into one.

## How a prediction gets built: the input hierarchy

Best evidence first; a weaker tier is only consulted when the one above it
doesn't resolve, or to double-check a result sitting near a category
boundary (see `lib/character.ts`'s `worthCorroboratingWithGeology`).

| Tier | Source | Status |
|---|---|---|
| 1 | On-site field reading (grain card / settle test / turbidity tube) | **live** — `lib/field-update.ts`, supersedes everything below for this session |
| 2 | EA Water Quality Archive (real measured suspended-solids concentration) | **live** — `lib/sources/water-quality.ts` |
| 3 | NRFA catchment properties + BGS point geology (bedrock, base flow, arable %) | **live** — `lib/character.ts`, `lib/geology.ts` |
| — | Tide state (estuaries: flood/ebb, spring/neap) — confidence context, not a verdict input | **live, verified against a real key** — `lib/sources/tide.ts` |
| — | Algae / organic-inhibition flags — independent of the mineral verdict | **live** — `lib/flags.ts` |
| — | Satellite turbidity (Sentinel-2 NDTI) — area-averaged context, gated to sites near a tide station, never a verdict input | **live, verified against a real key** — `lib/sources/satellite-turbidity.ts` |
| — | Soil texture (Soilscapes/UKSO) | **dropped** — no working source found; see BUILD.md |

Every tier names its own confidence and what would improve it. Nothing
here is presented as more certain than it is: a guessed particle size is
labelled `"guessed"`, a field read with an assumed spread is
`"field-adjusted"`, and only a genuine measurement is `"measured"` — these
three words travel with every number this tool produces.

## The baseline volume: measured vs. estimated

The table above decides the particle size distribution (PSD) — sand,
silt, clay, or something field-measured. Turning that PSD into an actual
**volume** (how many mL before the filter blinds) is a separate step, with
its own two-tier honesty split, `baselineSource` on every assessment:

| `baselineSource` | What it means | Confidence ceiling |
|---|---|---|
| `"measured"` | A real bench trial (or an exact-site trial, rarer and stronger still) calibrates this exact membrane pore size. | Up to `high`, with a measured PSD and a real concentration. |
| `"estimated"` | No trial calibrates this exact pore size, but at least one real trial exists at *some* pore size — so the volume is INFERRED from it, corrected for this site's own sediment class (sand/silt/clay, by its real PSD d50) using published porosity and particle-density literature (`data/sediment-properties.json`). | Always `low` — this stacks a PSD guess, a literature porosity range, and a cross-pore-size extrapolation, never more certain than any one of those alone. |
| `"insufficient-data"` | No real trial exists at *any* pore size to anchor even an estimate from (`baselineVolume` is `null`). | — |

This exists because a UK-wide tool cannot wait for a bench trial at every
pore size at every site — today, every real trial in `data/trials.json`
used a 5 µm filter, so without this tier every other pore size would show
a blank "insufficient data" forever. The estimate fills that gap honestly:
clearly labelled, always low confidence, and the moment a real trial
calibrates that pore size, it supersedes the estimate outright — "measured
beats modelled, always" (HANDOFF.md rule 7) applies here exactly as it
does to an exact-site trial. See `lib/baseline.ts`'s `estimateBaselineVolume`
and `data/sediment-properties.json`'s own header for the physics and the
real, checked sources behind the porosity ranges — clay's range is
deliberately the widest of the three, because published porosity for
freshly suspended/flocculated clay genuinely runs anywhere from about 0.47
to 0.9 depending on consolidation state, and this tool does not model floc
structure well enough to narrow that further (see HANDOFF.md's
floc-density reservation).

## Where things live

```
data/                        everything editable, no code required
  hydrocyclones.json          diameter, cut sizes d20/d50/d90, operating envelope
  membranes.json               0.45 / 1.2 / 5 / 10 / 20 µm, + product details
  particle-sizes.json          assumed PSD per solids character    ← all guesses
  screening-parameters.json    uplift category thresholds, the volume↔load maths
  trials.json                  real bench filtration trials  ← the baseline's only MEASURED calibration
  sediment-properties.json     published porosity/density by grain-size class  ← the baseline's ESTIMATED fallback, cited
  field-observations.json      what someone saw at a site, hand-curated
  validated-studies.json       real published river sediment figures, for sanity-checking
  query-log.json               predicted-vs-observed: real bench trials (written by scripts/build-query-log.ts) + real screened sites (none yet)

lib/
  data.ts                      load and validate every file in data/
  resolve.ts                   "Tilford, River Wey" → one specific NRFA reach, + deriveSiteIdentity for trials.ts
  character.ts                 catchment + geology → sand | mixed_mineral | silt | clay, tier-descent orchestrator
  geology.ts                   parse BGS geology at a point
  psd.ts                       character → particle size distribution
  baseline.ts                  real-trial-calibrated absolute filterable volume, + a literature-estimated fallback
  sediment-properties.ts       porosity/density correction factor behind that estimated fallback
  retention.ts                 membrane pore size → effective retention
  separation.ts                hydrocyclone grade-efficiency curve
  assessment.ts                baseline + per-method uplift + recommendation, per membrane
  report.ts                    the useful window + plain-English report sections
  validation.ts                leave-one-out predicted-vs-observed checks against data/trials.json
  trials.ts                    exact-site trial lookup, wired into assessSite/assessMembrane — fires on zero trials today, since none in trials.json has a real site recorded yet
  flags.ts                     algae / organic-inhibition risk, independent of the mineral verdict
  field-update.ts              on-site field reading → a real PSD for this session
  live-site.ts                 the live site-input flow: wires every source above together
  sources/
    water-quality.ts            EA Water Quality Archive fetcher
    tide.ts                     Admiralty UK Tidal API fetcher
    satellite-turbidity.ts      Copernicus/Sentinel Hub NDTI fetcher, gated on a nearby tide station

app/
  page.tsx, ReportView.tsx     the web app (Next.js)
  api/resolve, api/screen      the two-step confirm-before-screening flow
  api/field-update              the on-site field-reading endpoint

scripts/
  probe.mjs                    test NRFA/BGS/Nominatim live
  probe-new-sources.mjs        test EA/tide/satellite/COSMOS-UK live
  probe-small-catchments.mjs   candidate sources for ungauged catchments (not adopted)
  build-query-log.ts           regenerate data/query-log.json's bench-validation entries (npx tsx scripts/build-query-log.ts)
  lib/bng.mjs                  British National Grid ↔ WGS84, both directions

tests/            one file per lib/ module, 366 tests total, no network
```

## Running it

`npm run dev` works with zero configuration — NRFA, BGS, Nominatim, and the
EA Water Quality Archive are all keyless. Two optional tiers need a real
key; copy `.env.local.example` to `.env.local` and fill in what you have.
Missing a key means that tier is skipped, not broken:

- `ADMIRALTY_TIDE_API_KEY` — tide state for estuarine sites (free tier at
  [developer.admiralty.co.uk](https://developer.admiralty.co.uk/)); **verified live**
- `COPERNICUS_CLIENT_ID` / `COPERNICUS_CLIENT_SECRET` — satellite turbidity
  (`lib/sources/satellite-turbidity.ts`); **verified live**, only fetched for a
  site that already has a nearby tide station (see the file's own header for why)

## Adding your own data

**A filtration trial** (`data/trials.json`) — the most valuable thing you
can add, and the *only* thing that gives the baseline volume a real
calibration at a given pore size. Record the volumes before and after, the
feed's own measured concentration and particle size if you have them, the
filter pore size and diameter, and above all the **terminal condition** —
how you decided to stop. Without that the two volumes are not comparable.

**A field observation** (`data/field-observations.json`) — set `feed`
honestly. A cyclone separating deliberately disturbed bed material is close
to the easiest duty it will ever get, and that is not evidence about
normal running.

**A validated study** (`data/validated-studies.json`) — a real published
suspended-sediment figure for a named river, with its own citation and
confidence rating. Used to sanity-check this tool's assumptions against the
real world, not to calibrate it directly.

**A hydrocyclone** (`data/hydrocyclones.json`) — copy an entry, change the
values, append to `revisions` whenever you adjust a parameter from field
data.

**A membrane** (`data/membranes.json`) — give an agent the supplier URL and
ask it to fill in the `product` block.

## Next steps

Everything below is real, tracked work, not a vague roadmap — see the
Notion board ("TRACES Site Suitability tool") for status and the
plain-language log on each card.

1. ~~**Refresh HANDOFF.md**~~ — done. It now matches the rebuilt tool, with
   an up-to-date status table, pipeline diagram, and an honest point-by-
   point check of the 2026-09-27 outside critique against today's code.
2. ~~**Finish the validation loop**~~ — the bench half is done:
   `scripts/build-query-log.ts` checks every real bench trial leave-one-out
   against the model and writes the result to `data/query-log.json`. The
   result is itself a finding, not a clean pass — see `HANDOFF.md`'s cut-
   sizes reservation: the baseline volume prediction holds up (10/10 real
   trials fall inside their predicted range), but the uplift prediction
   doesn't (0/10) — the guessed hydrocyclone cut sizes under-predict the
   real benefit by roughly 3–10×. What's left is the "site-run" half: the
   same check for a real screened site, which needs a real site trial
   first (next step 7, new).
3. ~~**Verify the tide-state tier against a real key**~~ — done. Run live
   against a real `ADMIRALTY_TIDE_API_KEY` for Tilford: the real 607-station
   list and a real 7-day `TidalEvents` response both matched
   `lib/sources/tide.ts`'s types exactly, no code changes needed. Tilford
   itself correctly found no station within 5 km (it's the upper, non-tidal
   Wey) and skipped the tier - exactly the intended behaviour, not a bug.
4. ~~**Satellite turbidity**~~ — done, after three real probe rounds (v1:
   pixel-size error, bbox read in the wrong CRS units; v2: fixed that, hit
   a missing-`dataMask`-output error; v3: fixed that too, got a real HTTP
   200 with real NDTI data). `lib/sources/satellite-turbidity.ts` is built
   on that proven v3 shape and wired into `lib/live-site.ts`, gated behind
   an already-found nearby tide station (see the file's own header for
   why) - and reported as context only, like tide state, never blended
   into the mineral-character verdict: NDTI is a relative index averaged
   across a ~2.2 km box, not a point measurement or a concentration.
5. ~~**The chat/conversational layer**~~ — done. `lib/chat-intake.ts` is a
   deterministic free-text parser on top of `lib/field-update.ts`, wired
   into `/api/field-update` and a textarea in the UI - parses a message
   like "looks like fine sand, cleared within 10 minutes" into the same
   structured fields the form already takes, never scores anything itself.
   Verified live with Playwright against the running app.
6. ~~**`lib/trials.ts` is dead code**~~ — done. It's wired into
   `lib/assessment.ts`: a trial recorded against an exact site/waterbody
   now overrides both the calibrated baseline and that hydrocyclone's
   uplift outright, per "measured beats modelled, always." It fires on
   zero trials today, since no entry in `data/trials.json` has a real
   siteId/waterbodyId yet — the first real site trial, recorded using
   `lib/resolve.ts`'s `deriveSiteIdentity` convention, is what exercises it.
7. **A real measured grade-efficiency curve for either hydrocyclone** — now
   the highest-value thing this project could add, not just a nice-to-have:
   `data/query-log.json`'s validation loop shows the guessed cut sizes
   under-predict every real trial's uplift by roughly 3–10×. One real
   measurement would replace a guess with a fact exactly where it currently
   matters most.
8. ~~**The baseline only covers one pore size (5 µm)**~~ — done. Every pore
   size now gets a real volume: `"measured"` where a real trial calibrates
   it, `"estimated"` (always `low` confidence, clearly labelled, published
   literature cited) everywhere else — because a UK-wide tool cannot wait
   for a bench trial at every site. See "The baseline volume: measured vs.
   estimated" above. The estimate's own biggest acknowledged weakness: clay
   porosity is cited from real literature but genuinely spans 0.47-0.9
   depending on consolidation, which this tool does not model further - the
   same unmodelled floc-structure gap as `flocDensityPenalty`.

## Privacy and disclaimer

Do not enter confidential or commercially sensitive information. Runs are
logged to this repository.

This provides preliminary engineering screening only. It is not process
design, equipment selection, or a guarantee of membrane performance.
Validate with site measurements and bench or pilot testing.
