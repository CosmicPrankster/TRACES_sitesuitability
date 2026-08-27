# Hydrocyclone + Membrane Site Screening

Give it a site. It tells you which hydrocyclone and membrane combinations are worth
investigating, and why.

```
USER            "Tilford, River Wey"
                        |
APPLICATION      site research  +  hydrocyclone catalogue  +  membrane catalogue
                        |
                 deterministic screening engine
                        |
OUTPUT           configuration matrix, useful window, reasoning, unknowns,
                 assumptions, sources, recommended next test
                        |
                 optional AI conversation
```

The defining characteristic: **the user provides very little, the application does the heavy
lifting.** You are never asked for a hydrocyclone diameter, a feed flow, a pressure, a
particle density, a solids concentration, a PSD or a membrane pore size. Those belong to the
application's data layer.

---

> **Editing this yourself?** Start with **[docs/TUNING.md](docs/TUNING.md)** — a
> plain-English guide to which five files control the answer, what each number
> means, and how the site search actually works. No codebase knowledge assumed.

## Quick start

```bash
npm install
cp .env.example .env.local     # optional - the app works without any keys
npm run dev                    # http://localhost:3000
```

Type `Tilford, River Wey`, press **Screen site**. That is the whole interaction.

```bash
npm test          # 105 tests, no API keys and no network required
npm run typecheck
npm run build
```

---

## What you get back

- **An overall verdict** with an explicit confidence level — never a fabricated probability.
- **A configuration matrix**: every hydrocyclone against every membrane rating. Select any
  cell for the full engineering reasoning behind it.
- **The useful membrane window** — the band of ratings where pre-treatment looks worthwhile.
- **Best, borderline, unlikely and cannot-be-assessed candidates**, each explained.
- **What this rests on**: known → published → calculated → inferred → assumed → conclusion,
  kept strictly separate.
- **What we don't know**, and which single unknown would most improve confidence.
- **Recommended next measurements** and a starting point for a pilot test.

---

## The engineering the app actually does

### A membrane pore size is not a hydrocyclone cut size

This is the distinction the whole application exists to enforce.

- A **membrane pore size** is a *retention* rating: what the membrane holds back.
- A **hydrocyclone cut size (d50)** is a *separation* characteristic: the size at which half
  the mass reports to the underflow, with a gradual curve either side of it.

A 5 µm membrane does not imply a cyclone removes everything above 5 µm. The engine models
the two separately and never substitutes one for the other.

### Fouling is not weighed by mass

The metric that decides each cell is not "how much solids mass did the cyclone remove". A
cyclone can strip most of the *mass* a fine membrane would retain and leave the fouling
essentially untouched, because what it leaves behind is the fine fraction.

The Carman–Kozeny relationship gives the specific resistance of a packed cake as
proportional to `1/d²`, so a kilogram of 2 µm material presents far more resistance than a
kilogram of 200 µm material. The engine therefore weights the retained mass by `1/d²` and
classifies on the **resistance-weighted relief fraction**. This is what makes a 1 µm rating
come out "unlikely" while 50 µm comes out "promising", from physics rather than a hard-coded
table.

The weighting is an approximation. It assumes an incompressible cake of size-segregated
spheres and ignores shape, cohesion, compressibility and pore-blocking, all of which matter
in a real filtration. Every cell says so in its limitations.

### Separation model

In descending order of trustworthiness, the engine uses:

1. a measured or published grade-efficiency curve from the catalogue;
2. a cut size plus sharpness exponent, fitted to the reduced grade-efficiency form
   `G'(d) = (d/d50)^m / (1 + (d/d50)^m)`, corrected for short-circuit as
   `G(d) = Rf + (1 − Rf)·G'(d)`;
3. **nothing** — in which case the cell is `insufficient_data`, not a guess. Absence of
   catalogue data is never reported as evidence of poor performance.

---

## Honesty rules

The application is built so that it cannot quietly invent engineering data.

- **Nothing is a bare number.** Every externally-sourced or derived quantity is an
  `Evidence<T>` carrying `provenance` (`measured` / `published` / `calculated` / `inferred` /
  `assumed`), `confidence`, `source`, `date` and a `verified` flag.
- **The weakest link governs.** A result can never be more confident than the weakest input
  in its chain. One unverified placeholder anywhere caps the whole report at low confidence.
- **No fake certainty.** No "94 % probability of success", no "+43 % filterable volume". The
  app says what mechanism could improve filterability and that the magnitude requires testing.
- **Missing data is reported, not filled in.** A provider that fails returns a failure
  report; it never returns a plausible-looking number.

### ⚠️ The catalogue currently holds placeholders, not equipment data

`data/hydrocyclones.ts` ships with `cutSize.d50Um` marked `provenance: "assumed"` and
`verified: false` for both units. **These are screening placeholders chosen only so the
matrix can be produced at all. They are not manufacturer, experimental or published data.**

While any placeholder is in use, the report prints a warning and caps confidence at low.
Replacing a placeholder with a sourced value is the single highest-value improvement you can
make — and confidence rises automatically when you do.

---

## Adding your own data

### A new hydrocyclone

Append one entry to `data/hydrocyclones.ts`. Nothing else changes: the assessment engine
contains no equipment-specific branching, and the UI discovers the catalogue at run time.

```ts
{
  id: "15mm",
  name: "15 mm Hydrocyclone",
  diameterMm: { value: 15, unit: "mm", provenance: "published", confidence: "high",
                source: "Datasheet rev 3, p.2", verified: true },
  cutSize: {
    d50Um: { value: 20, unit: "µm", provenance: "measured", confidence: "high",
             source: "Rig test 2026-03-14, silica in water", date: "2026-03-14",
             verified: true },
  },
  catalogueConfidence: "high",
  dataComplete: true,
}
```

Record only what you can source. Omit fields you do not know — the engine copes with missing
data and says so in the report. A full template is at the bottom of that file.

### A new membrane rating

Append to `data/membranes.ts`. Set `enabled: false` to exclude a rating temporarily rather
than deleting it.

### A new site-data source

Implement `SiteDataProvider` in `lib/providers/`, then add it to `remoteProviders` in
`lib/providers/index.ts`. That is the whole integration.

```ts
interface SiteDataProvider {
  id: string;
  name: string;
  getSiteData(location: string, ctx: SiteLookupContext): Promise<SiteDataFragment>;
}
```

A provider must never throw and must never invent a value. On failure it returns a report
with status `error` or `no_data`, and the assessment continues without it.

### Things you already know about a site

Add an entry to `data/sites.ts`. Prefer descriptive facts over numbers; if you have a number,
cite it.

### Pilot results

`PilotResult` in `types/index.ts` is already defined and hangs off each hydrocyclone, so
measured performance can be compared against the screening later. The experimental database
itself is deliberately not built yet.

---

## Site data sources

| Provider | Status | Notes |
|---|---|---|
| Field observations (`data/field-observations.ts`) | Working, offline | What you actually saw at a site. The strongest evidence held; outranks everything below. |
| Curated knowledge (`data/sites.ts`) | Working, offline | What you already know. No network needed. |
| OpenStreetMap Nominatim | Implemented | Geocoding. Set `SITE_DATA_USER_AGENT` — their usage policy asks for an identifiable one. |
| EA real-time flood monitoring | Implemented | Nearest river gauge and its trend, plus 72 h antecedent rainfall. England only, open, no key. |
| EA Water Quality Archive | Implemented | Archived suspended solids and turbidity near the site. England only, open, no key. |
| BGS geology | Implemented | Bedrock and superficial deposits via the Esri `identify` API. Lithology sets the solids character (sand/gravel → sandy load, mudstone → clay, and so on). Parses strictly: an unrecognised response records nothing and names the attribute keys it saw. |

The remote providers are written against the documented shapes of those APIs but have **not
been exercised against the live endpoints** — the development sandbox blocks outbound access
to them. Check the "Data lookups performed" panel in the report on your first real run: it
shows each provider's status, message and URL, so a schema mismatch will be visible
immediately rather than silently producing wrong data.

Set `ENABLE_REMOTE_SITE_DATA=false` to skip all outbound lookups. The app still produces a
full report from curated knowledge and declared assumptions.

**Note on suspended solids:** a concentration tells you *how much* solid material is present.
It says nothing about *particle size*, which is what determines whether a hydrocyclone can
remove it. The app states this wherever it uses such a figure.

---

## Version 2: the conversation

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and the chat panel activates. Both providers are
called over plain `fetch`; no vendor SDK is a dependency.

The AI orchestrates; it does not compute. It is given the deterministic functions as tools —
`get_site_data`, `get_hydrocyclones`, `get_membrane_options`, `analyse_psd`,
`run_configuration_matrix`, `compare_configurations`, `update_scenario`, `summarise_results`
— and instructed that any number it states must have come out of one of them.

Crucially, it cannot change the answer by reasoning. When you say *"actually the particles
are mostly clay"*, it calls `update_scenario`, the deterministic engine re-runs, and the AI
explains what actually moved — including "nothing moved", when that is what the tool reports.

Try:

> Why is 10 µm better than 5 µm here?
> Compare the 4 mm and 10 mm cyclones.
> What if the particles are mostly clay?
> I have a PSD: D10 2 µm, D50 25 µm, D90 150 µm.
> Which configuration would you test first?

**The app works fully without any AI key.** The screening report is produced entirely by the
deterministic engine; only the chat panel is disabled.

---

## Privacy and logging

**Do not enter confidential, personal or commercially sensitive information into this
prototype.**

- Every screening request and AI conversation is logged as a row in `data/query_log.csv`
  **in the configured GitHub repository**. That repository therefore accumulates historical
  assessment data, readable by anyone who can read the repository.
- AI queries are sent to whichever AI provider you configure (Anthropic or OpenAI).
- The GitHub token and AI keys are read **only** on the server. The browser calls this app's
  own API routes; those routes call GitHub and the AI provider. No secret ever reaches the
  client.
- If logging fails, **the assessment still succeeds** and a non-critical warning is shown.
- Logging is skipped entirely if `GITHUB_TOKEN`, `GITHUB_OWNER` and `GITHUB_REPO` are not all
  set. There is no database; the CSV is deliberately the whole persistence layer.

---

## Engineering disclaimer

This application provides preliminary engineering screening only. It does not constitute
final process design, equipment selection, safety advice or a guarantee of membrane
performance. Actual hydrocyclone and membrane performance should be validated using
appropriate site measurements and pilot/bench testing.

---

## Repository layout

```
app/
  page.tsx                    the only screen
  api/screen/route.ts         site in, report out
  api/chat/route.ts           stateless conversation turn
components/
  SiteInput.tsx               one field
  ScreeningResult.tsx         the report
  ConfigurationMatrix.tsx     the matrix; click a cell for reasoning
  Chat.tsx                    optional AI panel
data/
  hydrocyclones.ts            equipment knowledge, all of it
  field-observations.ts       what you actually saw at a site
  membranes.ts                filtration ratings screened
  sites.ts                    curated site knowledge
  query_log.csv               the persistence layer
lib/
  screening.ts                the deterministic engine
  psd.ts                      particle-size maths
  site.ts                     provider aggregation and assumption profiles
  providers/                  one file per data source
  ai.ts                       provider-agnostic agent loop
  tools.ts                    the functions the AI may call
  github-log.ts               CSV append via the GitHub API
types/index.ts                Evidence<T> and the domain model
tests/                        105 tests, no network, no API keys
```

## Environment variables

All server-side only. See `.env.example`.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Enables the chat layer via Anthropic. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Enables the chat layer via OpenAI. |
| `AI_PROVIDER` | Force `anthropic` or `openai`. Blank auto-detects. |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_LOG_PATH` | CSV logging target. |
| `SITE_DATA_USER_AGENT` | Identifiable UA for the open-data APIs. |
| `ENABLE_REMOTE_SITE_DATA` | `false` disables all outbound lookups. |
| `SITE_DATA_TIMEOUT_MS` | Per-lookup timeout, default 6000. |
| `BGS_MAPSERVER_URL` | Override the BGS geology service endpoint if it moves. |

## Intended research workflow

Research a hydrocyclone → add verified data to the catalogue → run sites → log results →
collect pilot data → improve the model. The codebase is built for that gradual evolution:
the confidence the report reports rises on its own as placeholders are replaced with sourced
values.
