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
npm test                       # 308 tests, no network needed
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
  Baseline (filter alone):  96-298 mL  (confidence: low - no measured concentration)
  + 5mm hydrocyclone:       1.50x      (marginal - worth a replicate trial)
  + 10mm hydrocyclone:      1.23x      (marginal)

10 µm membrane
  Baseline:                 insufficient data - no trial has used this pore size
  + 5mm hydrocyclone:       2.09x      (likely - the best-supported option)
  + 10mm hydrocyclone:      1.52x      (likely)

Verdict: pretreatment looks worthwhile for membrane ratings from 10 to 20 µm.
```

Two things worth noticing: the baseline is only ever a real number where a
real bench trial calibrates that exact pore size (`data/trials.json`) —
everywhere else it is honestly "insufficient data," not a guess dressed up
as one. And the uplift is always a multiplier *on top of* the baseline,
never a self-contained verdict — a 2× uplift on an unknown baseline is
still "we don't know how much water," which is why both numbers are shown
together, not collapsed into one.

## How a prediction gets built: the input hierarchy

Best evidence first; a weaker tier is only consulted when the one above it
doesn't resolve, or to double-check a result sitting near a category
boundary (see `lib/character.ts`'s `worthCorroboratingWithGeology`).

| Tier | Source | Status |
|---|---|---|
| 1 | On-site field reading (grain card / settle test / turbidity tube) | **live** — `lib/field-update.ts`, supersedes everything below for this session |
| 2 | EA Water Quality Archive (real measured suspended-solids concentration) | **live** — `lib/sources/water-quality.ts` |
| 3 | NRFA catchment properties + BGS point geology (bedrock, base flow, arable %) | **live** — `lib/character.ts`, `lib/geology.ts` |
| — | Tide state (estuaries: flood/ebb, spring/neap) — confidence context, not a verdict input | **live, untested with a real key** — `lib/sources/tide.ts` |
| — | Algae / organic-inhibition flags — independent of the mineral verdict | **live** — `lib/flags.ts` |
| — | Satellite turbidity (Sentinel-2/3) | **not built** — only the OAuth step is proven; see BUILD.md |
| — | Soil texture (Soilscapes/UKSO) | **dropped** — no working source found; see BUILD.md |

Every tier names its own confidence and what would improve it. Nothing
here is presented as more certain than it is: a guessed particle size is
labelled `"guessed"`, a field read with an assumed spread is
`"field-adjusted"`, and only a genuine measurement is `"measured"` — these
three words travel with every number this tool produces.

## Where things live

```
data/                        everything editable, no code required
  hydrocyclones.json          diameter, cut sizes d20/d50/d90, operating envelope
  membranes.json               0.45 / 1.2 / 5 / 10 / 20 µm, + product details
  particle-sizes.json          assumed PSD per solids character    ← all guesses
  screening-parameters.json    uplift category thresholds, the volume↔load maths
  trials.json                  real bench filtration trials  ← the baseline's only calibration
  field-observations.json      what someone saw at a site, hand-curated
  validated-studies.json       real published river sediment figures, for sanity-checking
  query-log.json               predicted-vs-observed: real bench trials (written by scripts/build-query-log.ts) + real screened sites (none yet)

lib/
  data.ts                      load and validate every file in data/
  resolve.ts                   "Tilford, River Wey" → one specific NRFA reach, + deriveSiteIdentity for trials.ts
  character.ts                 catchment + geology → sand | mixed_mineral | silt | clay, tier-descent orchestrator
  geology.ts                   parse BGS geology at a point
  psd.ts                       character → particle size distribution
  baseline.ts                  real-trial-calibrated absolute filterable volume
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

tests/            one file per lib/ module, 308 tests total, no network
```

## Running it

`npm run dev` works with zero configuration — NRFA, BGS, Nominatim, and the
EA Water Quality Archive are all keyless. Two optional tiers need a real
key; copy `.env.local.example` to `.env.local` and fill in what you have.
Missing a key means that tier is skipped, not broken:

- `ADMIRALTY_TIDE_API_KEY` — tide state for estuarine sites (free tier at
  [developer.admiralty.co.uk](https://developer.admiralty.co.uk/))
- `COPERNICUS_CLIENT_ID` / `COPERNICUS_CLIENT_SECRET` — not yet used by any
  live tier (satellite turbidity isn't built); only `scripts/probe-new-sources.mjs` uses these today

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
3. **Verify the tide-state tier against a real key** — `lib/sources/tide.ts`
   is built and unit-tested against real captured data, but has never run
   end-to-end against the live Admiralty API in this project.
4. **One more live probe round for satellite turbidity** — `scripts/probe-new-sources.mjs`
   has a best-effort, clearly-labelled guess at the real Sentinel Hub
   endpoint; running it with real Copernicus credentials would say whether
   that guess is right, which is the one thing standing between "not
   built" and a real `lib/sources/satellite-turbidity.ts`.
5. **The chat/conversational layer** — the original plan's point 3 ("on-site
   update through the chat bot"). The deterministic structured-form version
   of this is built (`lib/field-update.ts`); a free-text/conversational
   front end on top of it, with AI only ever parsing words into those same
   structured fields, never scoring anything, is not.
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

## Privacy and disclaimer

Do not enter confidential or commercially sensitive information. Runs are
logged to this repository.

This provides preliminary engineering screening only. It is not process
design, equipment selection, or a guarantee of membrane performance.
Validate with site measurements and bench or pilot testing.
