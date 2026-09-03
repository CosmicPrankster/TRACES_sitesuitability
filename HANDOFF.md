# Handoff

For whoever picks this up next, human or agent. Read this before touching
anything.

## What this is

A screening tool. You give it a site and a waterbody — "Tilford, River Wey" —
and it tells you which hydrocyclone and membrane combinations are worth
investigating, and why.

## The question it exists to answer

> Does removing what the hydrocyclone can remove meaningfully extend how long
> the membrane runs before it blinds?

"Meaningfully" is **about 1.5× the filterable volume** versus no pre-treatment.
That is the user's threshold, set in `data/screening-parameters.json`.

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
this document, take that.

## Where the project stands

| Block | Status | Where |
|---|---|---|
| 1 Data files | done, tested | `data/*.json`, `lib/data.ts` |
| 2 Source probe | done, run live | `scripts/probe.mjs` |
| 3 Site resolution | done, tested | `lib/resolve.ts` |
| 4 Character inference | done, validated on 5 rivers | `lib/character.ts`, `lib/geology.ts` |
| **5a PSD** | **done, tested** | `lib/psd.ts` |
| 5b Separation | **in progress - fitted curve only, no trial override yet** | `lib/separation.ts` |
| 5c Membrane retention | not started | same |
| 5d Assessment | not started | same |
| 5e Report | not started | same |
| 6 UI | not started | — |
| 7 AI layer | not started | — |

`npm test` — 123 tests, no network, no API keys.
`node scripts/probe.mjs "Tilford, River Wey"` — needs internet.

**5b so far:** `lib/separation.ts` fits a grade-efficiency curve
`G(d) = (d/d50)^m / (1 + (d/d50)^m)` to the guessed d20/d50/d90 cut sizes in
`data/hydrocyclones.json`, with `m` fitted against d20 and d90 and averaged.
That is the whole increment. It deliberately does NOT yet read
`data/trials.json` to override the fitted curve when real before/after
evidence exists — that needs a judgement call (what counts as "a comparable
feed material") that should be confirmed before it is coded, so it is left
for the next step rather than guessed at. See the "NOT YET BUILT" block at
the foot of `lib/separation.ts`.

**The specification for 5b–5e is written out in plain English at the bottom of
`lib/psd.ts`.** Start there.

## How the pipeline fits together

```
"Tilford, River Wey"
   │
   ├─ lib/resolve.ts     split the query, anchor on the SETTLEMENT,
   │                     match NRFA station names ("Wey at Tilford"),
   │                     propose the reach and ask the user to confirm
   │
   ├─ NRFA               catchment properties: bedrock permeability,
   │                     base flow index, land cover              [UK-wide]
   ├─ BGS WMS            bedrock + superficial geology at the point
   │
   ├─ lib/character.ts   catchment + geology → sand | mixed_mineral | silt | clay
   ├─ lib/psd.ts         character → assumed particle size distribution   ← 5a
   │
   └─ [5b–5e, not built] → hydrocyclone × membrane matrix
```

## Rules this project runs on

These were learned the hard way. The first version of this repository looked
finished and was useless — it produced a confident screening for every site
from placeholder values, because the data lookups it depended on had never
actually been run. It was deleted and restarted.

1. **A source that has not been proven to respond is not built on.** Run
   `scripts/probe.mjs` first. Five candidate sources were dropped for failing
   on two real sites.
2. **Never report an empty response as a success.** The v1 probe did, and it
   hid the single most important failure for days.
3. **Every number carries its status** — `guessed`, `measured`, `published` —
   in the data itself, not in a comment. A guess must never be silently
   promoted to a fact.
4. **Confidence is the weakest link in the chain.** A guessed cut size caps the
   whole verdict at low confidence however good the geology is.
5. **A disagreement between sources is reported, never averaged away.** It is
   information. See the Spey case below.
6. **Absence of data is not a negative verdict.** "insufficient data" is a
   distinct outcome from "unlikely".
7. **Measured beats modelled, always.** A filtration trial in `data/trials.json`
   supersedes every estimate in this repository.

## Things that will bite you

**Geocoding silently changes the question.** "Bedford" resolved to Bedford
County, Pennsylvania and everything downstream was for the wrong continent, with
nothing reporting it. Geocoding is now GB-restricted and prefers a populated
place; NRFA matches beyond 40 km are rejected. Do not remove either guard.

**A river is a line, a town is a point.** "Tilford, River Wey" means the Wey
*where it runs through Tilford*. Anchor on the settlement. Geocoding the river
alone put us 4 km out.

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
`data/particle-sizes.json`.

## Reservations — be honest about these with the user

**The cut sizes are guesses.** Both entries in `data/hydrocyclones.json` are
marked `guessed`. Until one real grade-efficiency measurement exists, the matrix
shows *the shape of the argument*, not a prediction. It is reliable for
**relative** comparisons — which membrane sizes look better, where 4 mm beats
10 mm — and not for absolute verdicts.

**Character → PSD is the weakest link.** Weaker than the geology, weaker than
the cut sizes. Every verdict inherits it.

**The addressable window may be narrow.** Small hydrocyclones cut somewhere
around 5–20 µm. Below that they do little. So the product plausibly works for
coarse-solids waters at coarse membrane ratings, and plausibly does not for
clay-dominated waters or fine ratings. **The screening should be allowed to
return "unlikely" often.** If it returns "promising" everywhere, it is broken —
that was the failure mode of the first version.

**Floc density is not modelled.** Cohesive clay flocs entrain water, so their
effective density is far below the mineral density, and centrifugal separation
depends on density difference rather than size alone. This should make clay
worse than size alone predicts. It is deliberately left out rather than
invented: it needs a defensible source, and none has been checked.

**Bench data is not site data.** Crushed aquarium soil characterises the
hydrocyclone, not any river.

**The model assumes the cyclone never makes fouling worse.** In
`lib/assessment.ts`, `foulingReduction` is clamped to `[0, 1]` and
`volumeRatio = 1/sqrt(1-foulingReduction)`, so the floor is always 1x - "no
benefit," never "worse than untreated." Literature raises at least four real
mechanisms by which pretreatment could speed up fouling instead: shear in the
vortex/apex breaking friable flocs or algal colonies into finer fragments
than the natural feed (fouling resistance goes as 1/d², so breakage can
manufacture fouling potential, not just fail to remove it); loss of a
"filter aid" effect, where stripping the coarse fraction leaves a fine-skewed
cake that packs denser per gram than the natural mixed-size feed would have
(the model sums `massFraction / d²` independently per size bin, which can't
represent this); weaker shear-induced back-transport at the membrane if this
ever runs crossflow, since coarse particles self-scour a crossflow surface
far more effectively than fines (back-transport scales roughly with particle
size cubed) - not applicable to the dead-end bench trials run so far, but
worth remembering if crossflow is ever tried; and shear releasing NOM or
biopolymer-bound organics into solution, causing irreversible/pore-blocking
fouling that this model - which only ever tracks particulate PSD mass - does
not represent at all. None of these are built in: no measured basis exists
yet for how much worse, from which mechanism, at which site, and a guessed
fouling *penalty* would be worse than the current honest silence on it. Left
here so a future reader does not have to rediscover the gap from scratch.

## What would most improve this, in order

1. **One filtration trial** — raw water and hydrocyclone overflow through the
   same membrane, volumes compared. It measures the target quantity directly
   instead of inferring it through three layers of assumption.
2. **One measured grade-efficiency curve** for either hydrocyclone.
3. **A measured PSD** at any site, to check `data/particle-sizes.json`.
