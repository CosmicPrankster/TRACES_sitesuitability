# Hydrocyclone + membrane site screening

Enter a site and waterbody — "Tilford, River Wey" — and get a screening of which
hydrocyclone and membrane combinations are worth investigating, and why.

**New here? Read [HANDOFF.md](HANDOFF.md) first.** It covers where the project
stands, the physics that governs it, and the traps that have already caught us.

```bash
npm install
npm test                                    # 123 tests, no network needed
node scripts/probe.mjs "Tilford, River Wey" # needs internet
```

## The question

> Does removing what the hydrocyclone can remove meaningfully extend how long
> the membrane runs before it blinds?

**Meaningfully = about 1.5× the filterable volume.** Set in
`data/screening-parameters.json`.

Because filtered volume scales as 1/√load, and cake resistance goes as 1/d²,
**1.5× volume needs the fouling load cut by 56 %, and 2× needs 75 %.** Removing
most of the solids *mass* is not the same as removing most of the *fouling* —
the fines a hydrocyclone cannot catch are the ones that do the damage.

## Where things live

```
data/                      everything editable, no code required
  hydrocyclones.json       diameter, cut sizes d20/d50/d90, operating envelope
  membranes.json           0.45 / 1.2 / 5 / 10 / 20 µm, + product details
  particle-sizes.json      assumed PSD per solids character   ← all guesses
  screening-parameters.json  thresholds and the volume→load maths
  field-observations.json  what you saw at a site
  trials.json              filtration trials — the most valuable data here
  query-log.json           every run, keyed on site + waterbody

lib/
  data.ts        load and validate the data files
  resolve.ts     "Tilford, River Wey" → one specific reach
  character.ts   catchment + geology → sand | mixed_mineral | silt | clay
  geology.ts     parse BGS geology at a point
  psd.ts         character → particle size distribution  (+ the 5b–5e spec)

scripts/
  probe.mjs      test every live data source and show what it returns
  lib/bng.mjs    WGS84 → British National Grid
```

---

# Finishing this — plain English

Work in order. Do not start a step before the one above it passes its tests.
The detailed specification for steps 1–4 is written out at the bottom of
`lib/psd.ts`.

## Step 1 — how well a hydrocyclone removes a given sediment

Build `lib/separation.ts`.

A hydrocyclone does not have one performance curve. **It has a different one for
every kind of sediment fed to it** — crushed aquarium soil is not river silt. So
store performance per *(hydrocyclone × feed material)*, never per hydrocyclone.

Read the guessed cut sizes from `data/hydrocyclones.json` as the fallback. Three
points (d20/d50/d90) define the *shape* of the curve, which beats a single cut
size plus an assumed sharpness. Where `data/trials.json` holds a real before/
after result for that unit and a comparable feed, use it instead and say so.

Adding a hydrocyclone or a feed material must mean editing JSON only.

## Step 2 — what the membrane retains

A sharp cut at the pore size. State the caveat that a real nominal-rated element
passes some material coarser than its rating.

When `product.retentionUm` and `product.rating` are populated in
`data/membranes.json` from a supplier page, prefer those. That is why the fields
are there — hand an agent a Whatman URL and ask it to fill them in.

## Step 3 — the assessment (the important one)

For every hydrocyclone × membrane pair, integrate over the size bins:

```
retainedMass     mass fraction the membrane must retain, untreated
foulingLoad      the same mass, each bin weighted by 1/d²
foulingRemoved   the part of that load the cyclone takes out first
foulingReduction foulingRemoved / foulingLoad         ← decides the verdict
volumeRatio      1 / √(1 − foulingReduction)
```

Verdicts: **≥2.0× strong · ≥1.5× promising · ≥1.2× marginal · below that
unlikely.** If almost nothing is coarse enough for the membrane to retain, call
it marginal whatever the ratio — there is nothing there to remove. If there is
no separation data at all, that is **insufficient data**, which is not the same
as unlikely.

Confidence is the weakest link in the chain. A guessed cut size caps everything
at low, however good the geology is.

## Step 4 — the report

Group into best / marginal / unlikely / insufficient-data, and find the **useful
window**: the band of membrane ratings where pre-treatment looks worthwhile.
That window is the single most valuable output.

Sections: verdict, configuration list, WHY, WHAT WE KNOW, WHAT WE DON'T KNOW,
RECOMMENDED TEST. The recommended test should always be the cheapest measurement
that would most improve confidence — usually a filtration trial.

## Step 5 — the web app

Next.js, three screens, nothing more:

1. **Input** — one box for site + waterbody. Then confirm the resolved reach
   back to the user before screening, because the wrong reach is the worst
   silent failure available.
2. **Report** — the matrix, clickable for per-cell reasoning.
3. **Chat** — optional, to ask why and to supply field data conversationally.

Run the lookups server-side; NRFA and BGS have no CORS headers and the EA is
slow (3–18 s). Cache the NRFA station list — it is 200 kB and changes rarely.

## Step 6 — logging

Append each run to `data/query-log.json`, keyed on **siteId + waterbodyId**, not
on the text typed. Two spellings of one burn are one site. Increment `runs`
rather than adding a second entry.

## Step 7 — the AI layer

The agent orchestrates; it does not calculate. Give it the deterministic
functions as tools and require that every number it states came from one of
them. When the user says "actually it's mostly clay", it must update the
scenario and re-run — never reason its way to a different answer.

---

## Adding your own data

**A filtration trial** (`data/trials.json`) — the most valuable thing you can
add. Record the volumes before and after, the filter pore size *and diameter*,
and above all the **terminal condition**: how you decided to stop. Without that
the two volumes are not comparable.

**A field observation** (`data/field-observations.json`) — set `feed` honestly.
A cyclone separating deliberately disturbed bed material is close to the easiest
duty it will ever get, and that is not evidence about normal running.

**A hydrocyclone** (`data/hydrocyclones.json`) — copy an entry, change the
values, append to `revisions` whenever you adjust a parameter from field data.

**A membrane** (`data/membranes.json`) — give an agent the supplier URL and ask
it to fill in the `product` block.

## Privacy and disclaimer

Do not enter confidential or commercially sensitive information. Runs are logged
to this repository.

This provides preliminary engineering screening only. It is not process design,
equipment selection or a guarantee of membrane performance. Validate with site
measurements and bench or pilot testing.
