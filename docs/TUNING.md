# Editing this app — the plain-English guide

You do not need to understand the whole codebase. Almost everything you will
want to change lives in **five files**, and four of them are just lists you can
edit like a spreadsheet.

**How to edit anything here:** open the file on GitHub, click the pencil icon,
change it, commit. Or edit locally and `git push`. After any change, run
`npm test` — if it passes, you have not broken anything structural.

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

## File 4 — things you know about specific sites

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

## File 5 — where the judgement calls live

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
| 2 | `geocode.ts` | Turns the name into coordinates (OpenStreetMap) | No, but everything below needs it |
| 3 | `ea-flood.ts` | Nearest river gauge, level trend, 72 h rainfall | **No** — context only |
| 4 | `ea-water-quality.ts` | Archived suspended solids + turbidity | **YES** — if it finds *both* |
| 5 | `bgs-geology.ts` | **Not built.** Returns a link to check manually | No — this is the big gap |

**Read that last column again.** Only #1 and #4 move the numbers. This is why
the app can show you a page of river data and still produce the default matrix.

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

1. **What you typed** in the notes box, or clicked in the banner — always wins.
2. **Your `data/sites.ts` entry** for that site.
3. **Turbidity ÷ suspended solids** from the EA archive, if both were found.
   High turbidity per unit mass = fine particles (they scatter more light).
   Thresholds are `FINES_RATIO_HIGH` / `FINES_RATIO_LOW`.
4. **The type of water body** — standing water settles its coarse fraction;
   estuaries are cohesive fines; groundwater is filtered by the aquifer.
5. **Rivers: nothing.** Deliberately. See above.

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
npm test          # 84 tests — tells you what broke
npm run typecheck # catches typos in the data files
git checkout .    # throw away your changes and start again
```

The most common mistake is a missing comma between `{ }` blocks in the data
files. `npm run typecheck` will point straight at it.
