# Editing this app — the plain-English guide

You do not need to understand the whole codebase. Almost everything you will
want to change lives in **six files**, and five of them are just lists you can
edit like a spreadsheet.

**How to edit anything here:** open the file on GitHub, click the pencil icon,
change it, commit. Or edit locally and `git push`. After any change, run
`npm test` — if it passes, you have not broken anything structural.

---

## FIRST: if every site gives the same answer

Go to **http://localhost:3000/diagnose**, type the site, press Diagnose.

It runs every lookup for real and tells you in plain English which step failed
and what to do. It also prints a **matrix fingerprint** — diagnose two different
sites, and if that string is identical, nothing site-specific is reaching the
engine.

### The most common cause: geocoding failed

Every lookup except your own notes needs coordinates. If geocoding fails, the
river gauges, the water-quality archive and the geology lookup **all skip**, so
nothing is known about the solids and every site returns the default. One
failure, everything downstream dead.

The usual fixes, in order:

1. **Set a User-Agent.** Create a file called `.env.local` in the project root:

   ```
   SITE_DATA_USER_AGENT=my-research-tool (your.name@example.com)
   ```

   Nominatim rejects generic User-Agents with HTTP 403. Restart after saving.

2. **Check Node can reach the internet.** A corporate proxy, VPN or firewall can
   block it even when your browser is fine. The diagnostic prints the exact URL
   it tried — paste that into a browser. If it works there but failed in the app,
   it is a network problem, not a code problem.

3. **Try a simpler place name.** The app now tries the full phrase, then the last
   comma-separated part, then the first — so "Kinness Burn, St Andrews" falls
   back to "St Andrews" automatically. If all three fail, try just the town.

### Outside England

The two Environment Agency lookups are **England-only**. In Scotland, Wales or
Northern Ireland they will never return anything, by design — so Kinness Burn
will never get gauge or water-quality data. Geology is the one that should still
work there.

---

## The 30-second mental model

The app produces its answer from exactly **three** things:

```
   1. What the particles are like   ──┐
      (the size distribution)         │
                                      ├──►  the matrix you see
   2. What the hydrocyclone does    ──┤
      (its cut size)                  │
                                      │
   3. Which membranes to check     ──┘
      (the list of pore sizes)
```

That is the whole engine. **Everything else — geology, rainfall, river gauges,
turbidity — only matters insofar as it changes #1.** If it does not change the
particle distribution, it does not change your answer.

This is the single most important thing to understand, and it explains the
problem you hit: the app was showing you river names and rainfall figures, none
of which touched #1, so the matrix never moved.

---

## Why you were getting the same answer every time

For a river, the app genuinely does not know what the suspended solids are like.
Catchment geology is what would settle it, and the geology lookup is not built
yet (see `lib/providers/bgs-geology.ts`).

It now does one of two things, and never anything else:

- **It tells you it doesn't know**, with a banner and a row of buttons asking
  what the water is like. One click re-runs everything.
- **Or it uses evidence it actually has** — see the table further down.

It will **not** quietly assume "mixed mineral" for every river in the country.
That would hand you a confident-looking identical matrix, which is precisely the
thing that wasted your time.

**So: if you see the banner, click a button.** That is the fix for 90 % of
"it keeps saying the same thing".

---

## File 1 — the hydrocyclones

**`data/hydrocyclones.ts`** — this is where equipment knowledge lives, all of it.

### ⚠️ The numbers in here right now are made up

Both units ship with a **placeholder** cut size. They are not from a datasheet,
a paper, or a test. They exist only so the app produces *something*. This is why
every report is stamped "confidence: low".

**Replacing these with real numbers is the single most valuable change you can
make.** Confidence rises automatically when you do.

### Changing a cut size

Find this block and change `value`:

```ts
cutSize: {
  d50Um: {
    value: 15,              // ← the number. Units: micrometres.
    provenance: "assumed",  // ← change to "measured" or "published"
    confidence: "low",      // ← change to "high"
    source: "SCREENING PLACEHOLDER - ...",   // ← say where it came from
    verified: false,        // ← change to true ONLY when you've checked it
  },
```

**What `d50Um` means:** the particle size at which the cyclone sends **half** the
mass out of the bottom. Not "the smallest thing it catches" — half. Bigger
particles: more than half. Smaller: less than half.

**What happens when you change it:** a *smaller* d50 means a finer cut, so the
cyclone helps at finer membranes. Try 8 vs 30 and watch the matrix shift left or
right.

**The four fields that matter:**

| Field | What it does |
|---|---|
| `value` | The number itself |
| `provenance` | `measured` / `published` / `calculated` / `inferred` / `assumed` |
| `verified` | `true` only once a human checked it against the source |
| `confidence` | `high` / `medium` / `low` |

Set `verified: true` and `dataComplete: true` and the warnings disappear and
confidence rises. **Only do that when it is actually true** — the whole point of
these flags is that the report cannot overstate what you know.

### Adding a new hydrocyclone (6 mm, 15 mm, 20 mm…)

Copy an existing block, paste it inside the `[ ]`, change `id`, `name`,
`diameterMm` and `cutSize`. **That is all.** The matrix grows a row, the UI picks
it up, the AI can discuss it. No other file changes.

There is a fully commented template at the bottom of the file.

### Also worth knowing

`sharpness` (the `m` value) controls how *crisp* the cut is. Higher = sharper.
2.5 is a middling guess. If you ever measure a real efficiency curve, put it in
`gradeEfficiencyCurve` instead and the app will use that over the cut size.

---

## File 2 — the membranes

**`data/membranes.ts`** — the list of filtration ratings screened, i.e. the
columns of the matrix.

```ts
{ id: "30um", poreSizeUm: 30, unit: "µm", label: "30 µm", rating: "unspecified", enabled: true },
```

Add a line, get a column. Set `enabled: false` to hide one without deleting it.
That is the entire file.

---

## File 3 — what the particles are assumed to be

**`lib/site.ts`**, near the top — `ASSUMED_PSD_PROFILES`.

**This is the most powerful knob in the whole app.** When no real distribution
exists, this is what gets used, and it drives every cell.

```ts
sand: {
  d10Um: 8,     // 10% of the mass is finer than this
  d50Um: 60,    // half the mass is finer than this  ← the big one
  d90Um: 250,   // 90% of the mass is finer than this
  rationale: "...",
},
```

**These are placeholders too.** If you know your river runs finer than this, edit
the numbers. Lower `d50Um` = finer solids = hydrocyclone helps less. Raise it =
coarser = helps more.

**A trap worth knowing:** the *suspended* load of a sandy river is usually far
finer than its *bed*. A sandy riverbed does not mean sandy suspended solids. If
your numbers look too optimistic, this is usually why.

Right below it, `ASSUMED_PARTICLE_DENSITY_KG_M3` sets how heavy each type is.
2650 for quartz is a real textbook constant; the clay and organic figures are
placeholders for waterlogged flocs.

---

## File 4 — what you actually saw at a site

**`data/field-observations.ts`** — the strongest evidence the app holds.
Everything else is a catalogue value, an open-data lookup or an assumption.
These are things that *happened*.

An observation can raise a configuration's confidence, set the solids character,
and add its own reasoning to the cells it bears on.

```ts
{
  id: "somewhere-2026-04-trial",
  siteMatches: ["somewhere"],       // matched against what's typed
  siteName: "Somewhere, River Whatever",
  kind: "separation_confirmed",     // or no_separation | blockage | hydraulic |
                                    //    solids_character | membrane_behaviour
  feed: "natural_suspended_load",   // ← READ THE NEXT PARAGRAPH
  hydrocycloneIds: ["10mm"],
  observation: "What you actually saw, in your own words.",
  demonstrates: ["What this genuinely establishes."],
  doesNotDemonstrate: ["What it does NOT. Be strict with yourself here."],
  provenance: "measured",
  confidence: "medium",
}
```

### The two fields that matter

**`feed` — what the unit was actually fed.** This governs how much weight the
observation carries, and it is the difference between a result that transfers to
the real duty and one that does not:

| Value | Weight | Why |
|---|---|---|
| `natural_suspended_load` | High | The water as it normally runs — the actual duty |
| `disturbed_bed_sediment` | Partial | Far coarser and more concentrated than normal; close to the easiest duty the unit will ever get |
| `spiked_or_synthetic` | Partial | The particle population was chosen, not encountered |
| `unknown` | Low | Can't be judged — fill this in and it counts for more |

**`doesNotDemonstrate` — the limits of what you saw.** Filling this in is what
stops a good field result being over-read later, by you or by the AI. Leave it
empty and the engine will say so in the report.

### What an observation can and cannot do

It can raise confidence **by one step, never above medium**. Reaching high
confidence requires a measured grade-efficiency curve in the catalogue — a
qualitative field result, however encouraging, cannot substitute for one.

It can never manufacture a number. Seeing separation does not produce a cut size,
so the catalogue stays flagged as unverified regardless.

**Negative results count too.** A blockage or a no-separation observation is
weighed exactly as a success would be, and counts against the configuration.

---

## File 5 — things you know about specific sites

**`data/sites.ts`** — your own notebook. If you know something about a site,
put it here and the app will use it every time.

```ts
{
  id: "my-site",
  name: "My Site, River Whatever",
  matches: ["whatever", "my site"],   // lowercase; matched against what's typed
  waterBody: "River Whatever",
  waterBodyType: "river",

  particleCharacter: "sand",          // ← THIS is what moves the matrix
  particleCharacterProvenance: "inferred",
  particleCharacterBasis: "Why you believe this. Shown to the user.",

  data: [ /* individual facts, each with a source */ ],
}
```

`particleCharacter` is the line that matters. Options: `sand`,
`mixed_mineral`, `silt`, `clay`, `organic`. Setting it makes that site
site-specific and stops the banner appearing.

Copy the Tilford entry as your template.

---

## File 6 — where the judgement calls live

**`lib/screening.ts`** — the engine. You mostly should not need this, but three
constants near the top decide the colours:

```ts
const RELIEF_PROMISING = 0.6;            // above this → green "Promising"
const RELIEF_WORTH_INVESTIGATING = 0.35; // above this → green "Worth a look"
const RELIEF_MARGINAL = 0.15;            // above this → amber; below → red
```

If you think the app is too generous, raise these. Too harsh, lower them. They
are honest judgement calls about where to draw a line, not measured physics.

Also here: `NEGLIGIBLE_LOAD_FRACTION = 0.02` — below 2 % of solids being coarse
enough for the membrane to catch, the app calls it marginal regardless, because
removing almost nothing is not a benefit.

---

## How the site search actually works

When you type a place, the app runs these **in order**, in
`lib/providers/`. Each one either returns data or reports honestly that it
couldn't.

| # | File | What it does | Does it change your answer? |
|---|---|---|---|
| 1 | `local-knowledge.ts` | Reads your `data/sites.ts` notes | **YES** — if you set `particleCharacter` |
| 2 | `geocode.ts` | Name → coordinates (Open-Meteo, then Nominatim) | No — **but everything below dies without it** |
| 3 | `ea-flood.ts` | Nearest river gauge, level trend, 72 h rainfall | **No** — context only |
| 4 | `ea-water-quality.ts` | Archived suspended solids + turbidity | **YES** — if it finds *both* |
| 5 | `bgs-geology.ts` | Bedrock + superficial deposits from BGS | **YES** — lithology sets the solids character |

Your field observations in `data/field-observations.ts` are checked before any
of these and outrank all of them.

### If the geology lookup comes back empty

The BGS query is built against the standard Esri `identify` API, but the exact
attribute names BGS returns could not be verified from the build environment.
The parser is deliberately strict: if it does not recognise the attributes, it
records **nothing** rather than guessing, and its status message lists the
attribute keys the service actually returned.

If you see that, it is a two-minute fix: copy those key names into
`ATTRIBUTE_KEYS` at the top of `lib/providers/bgs-geology.ts`. If BGS has moved
the service entirely, set `BGS_MAPSERVER_URL` in `.env.local`.

### Checking what actually happened

Every report has a **"Data lookups performed"** panel at the bottom. It shows
each provider's status (`ok` / `no_data` / `error` / `skipped`) and its URL.

**When something seems wrong, open this panel first.** It will tell you whether
the lookups worked, and the URL lets you paste it into a browser to see the raw
response.

### Turning the lookups off

Create `.env.local` with `ENABLE_REMOTE_SITE_DATA=false` to skip all network
calls — useful when you are testing changes and don't want to wait.

### How the app decides the solids character

In priority order, in `lib/site.ts`:

1. **A field observation** from `data/field-observations.ts` — a measurement,
   so it outranks everything else.
2. **What you typed** in the notes box, or clicked in the banner.
3. **Your `data/sites.ts` entry** for that site.
4. **Catchment geology** from BGS. Sand and gravel → sandy load; mudstone and
   clay → clay load; chalk → fine carbonate. An inference, and labelled as one.
5. **Turbidity ÷ suspended solids** from the EA archive, if both were found.
   High turbidity per unit mass = fine particles (they scatter more light).
   Thresholds are `FINES_RATIO_HIGH` / `FINES_RATIO_LOW`.
6. **The type of water body** — standing water settles its coarse fraction;
   estuaries are cohesive fines; groundwater is filtered by the aquifer.
7. **Rivers with none of the above: nothing.** Deliberately. See above.

---

## The three fastest ways to make it useful

1. **Click a button in the banner.** Instant, no code.
2. **Add your sites to `data/sites.ts`** with `particleCharacter` set. Ten minutes.
3. **Put real cut sizes in `data/hydrocyclones.ts`.** This is the one that lifts
   confidence off the floor.

If you get a real particle-size distribution, just paste it into the notes box
or the chat — *"D10 2 µm, D50 25 µm, D90 150 µm"* — and everything re-runs from
measured data instead of placeholders.

---

## If you break something

```bash
npm test          # 111 tests — tells you what broke
npm run typecheck # catches typos in the data files
git checkout .    # throw away your changes and start again
```

The most common mistake is a missing comma between `{ }` blocks in the data
files. `npm run typecheck` will point straight at it.
